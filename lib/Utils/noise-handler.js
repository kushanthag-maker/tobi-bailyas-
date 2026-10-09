'use strict'
/**
 * tobi - Noise Protocol (Noise_XX_25519_AESGCM_SHA256) transport for the
 * WhatsApp Web socket, plus the 3-byte length framing.
 *
 * The handshake is the standard XX pattern:
 *
 *   -> e                                   (clientHello)
 *   <- e, ee, s, es                        (serverHello + certificate chain)
 *   -> s, se                               (clientFinish + encrypted payload)
 *
 * After `finishInit()` the handler switches to transport mode where every
 * frame is AES-256-GCM encrypted with a rolling counter IV.
 */
const { sha256, hkdf, aesEncryptGCM, aesDecryptGCM, x25519 } = require('./crypto')
const { encodeBinaryNode } = require('../WABinary/encode')
const { decodeWireFrame } = require('../WABinary/decode')
const { proto } = require('../Proto')
const { NOISE_MODE, NOISE_WA_HEADER, WA_CERT_DETAILS } = require('../Defaults')

const IV_LENGTH = 12
const EMPTY_BUFFER = Buffer.alloc(0)

/** 12 byte IV whose last 4 bytes are the big endian counter */
const generateIV = (counter) => {
	const iv = Buffer.alloc(IV_LENGTH)
	iv.writeUInt32BE(counter >>> 0, 8)
	return iv
}

class TransportState {
	constructor(encKey, decKey) {
		this.encKey = encKey
		this.decKey = decKey
		this.readCounter = 0
		this.writeCounter = 0
	}

	encrypt(plaintext) {
		return aesEncryptGCM(plaintext, this.encKey, generateIV(this.writeCounter++), EMPTY_BUFFER)
	}

	decrypt(ciphertext) {
		return aesDecryptGCM(ciphertext, this.decKey, generateIV(this.readCounter++), EMPTY_BUFFER)
	}
}

const makeNoiseHandler = ({ keyPair, logger, routingInfo, prologuePublicKey }) => {
	const publicKey = keyPair.public
	const privateKey = keyPair.private
	// the prologue always authenticates the CLIENT's static public key.
	// when acting as the server side (tests, tooling) pass it explicitly.
	const prologueKey = prologuePublicKey || publicKey

	const noiseMode = Buffer.from(NOISE_MODE, 'binary')
	let hash = noiseMode.length === 32 ? noiseMode : sha256(noiseMode)
	let salt = hash
	let encKey = hash
	let decKey = hash
	let counter = 0
	let sentIntro = false

	let inBytes = Buffer.alloc(0)
	let transport = null

	// 'WA' 0x06 0x03 (+ optional routing info for edge connections)
	let introHeader
	if (routingInfo && routingInfo.length) {
		introHeader = Buffer.alloc(7 + routingInfo.length + NOISE_WA_HEADER.length)
		introHeader.write('ED', 0, 'utf8')
		introHeader.writeUInt8(0, 2)
		introHeader.writeUInt8(1, 3)
		introHeader.writeUInt8((routingInfo.length >> 16) & 0xff, 4)
		introHeader.writeUInt16BE(routingInfo.length & 0xffff, 5)
		introHeader.set(routingInfo, 7)
		introHeader.set(NOISE_WA_HEADER, 7 + routingInfo.length)
	} else {
		introHeader = Buffer.from(NOISE_WA_HEADER)
	}

	const authenticate = (data) => {
		if (!transport) hash = sha256(Buffer.concat([hash, data]))
	}

	const encrypt = (plaintext) => {
		if (transport) return transport.encrypt(plaintext)
		const result = aesEncryptGCM(plaintext, encKey, generateIV(counter++), hash)
		authenticate(result)
		return result
	}

	const decrypt = (ciphertext) => {
		if (transport) return transport.decrypt(ciphertext)
		const result = aesDecryptGCM(ciphertext, decKey, generateIV(counter++), hash)
		authenticate(ciphertext)
		return result
	}

	const localHKDF = (data) => {
		const key = hkdf(Buffer.from(data), salt, EMPTY_BUFFER, 64)
		return [key.subarray(0, 32), key.subarray(32)]
	}

	const mixIntoKey = (data) => {
		const [write, read] = localHKDF(data)
		salt = write
		encKey = read
		decKey = read
		counter = 0
	}

	/** switch to transport mode (all further frames are encrypted) */
	const finishInit = () => {
		const [write, read] = localHKDF(EMPTY_BUFFER)
		transport = new TransportState(write, read)
		logger?.trace?.('noise: transport established')
	}

	/** frame with a 3 byte big endian length prefix */
	const encodeFrame = (data) => {
		if (transport) data = transport.encrypt(data)
		const dataLen = data.length
		const introSize = sentIntro ? 0 : introHeader.length
		const frame = Buffer.allocUnsafe(introSize + 3 + dataLen)
		if (!sentIntro) {
			frame.set(introHeader)
			sentIntro = true
		}
		frame[introSize] = (dataLen >>> 16) & 0xff
		frame[introSize + 1] = (dataLen >>> 8) & 0xff
		frame[introSize + 2] = dataLen & 0xff
		frame.set(data, introSize + 3)
		return frame
	}

	/** feed raw socket bytes; every complete frame is handed to `onFrame` */
	const decodeFrame = (newData, onFrame) => {
		inBytes = inBytes.length ? Buffer.concat([inBytes, newData]) : Buffer.from(newData)
		let size
		while (true) {
			if (inBytes.length < 3) return
			size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2]
			if (inBytes.length < size + 3) return
			let frame = inBytes.subarray(3, size + 3)
			inBytes = inBytes.subarray(size + 3)
			if (transport) {
				// transport payloads carry a 1 byte header and may contain several nodes
				for (const node of decodeWireFrame(transport.decrypt(frame))) onFrame(node)
				continue
			}
			onFrame(proto.HandshakeMessage.decode(frame))
		}
	}

	/** build the first (client hello) frame */
	const buildClientHello = (clientStaticKeyPair) => {
		const clientHello = {
			ephemeral: clientStaticKeyPair.public,
			static: publicKey,
			payload: EMPTY_BUFFER
		}
		return encodeFrame(proto.HandshakeMessage.encode({ clientHello }).finish())
	}

	/**
	 * Process the server hello and produce the `clientFinish` payload.
	 * Returns the encrypted static key (the `static` field of clientFinish).
	 */
	const processHandshake = ({ serverHello }, noiseKey) => {
		if (!serverHello) throw new Error('noise: missing serverHello')

		authenticate(serverHello.ephemeral)
		mixIntoKey(x25519.sharedKey(privateKey, serverHello.ephemeral))

		const decStaticContent = decrypt(serverHello.static)
		mixIntoKey(x25519.sharedKey(privateKey, decStaticContent))

		const certDecoded = decrypt(serverHello.payload)
		const { intermediate: certIntermediate, leaf } = proto.CertChain.decode(certDecoded)
		if (!leaf?.details || !leaf?.signature) throw new Error('noise: invalid leaf certificate')
		if (!certIntermediate?.details || !certIntermediate?.signature) throw new Error('noise: invalid intermediate certificate')

		const details = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details)
		const { issuerSerial } = details

		const validLeaf = x25519Verify(details.key, leaf.details, leaf.signature)
		const validIntermediate = x25519Verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature)

		if (!validLeaf) throw new Error('noise: leaf certificate signature invalid')
		if (!validIntermediate) throw new Error('noise: intermediate certificate signature invalid')
		if (issuerSerial !== WA_CERT_DETAILS.SERIAL) throw new Error('noise: certificate issuer mismatch')

		const keyEnc = encrypt(noiseKey.public)
		mixIntoKey(x25519.sharedKey(noiseKey.private, serverHello.ephemeral))

		return keyEnc
	}

	/** encode the final handshake message (static + encrypted client payload) */
	const buildClientFinish = (keyEnc, encryptedPayload) =>
		proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload: encryptedPayload } }).finish()

	// prologue
	authenticate(Buffer.from(NOISE_WA_HEADER))
	authenticate(prologueKey)

	return {
		encrypt,
		decrypt,
		authenticate,
		mixIntoKey,
		finishInit,
		processHandshake,
		encodeFrame,
		decodeFrame,
		buildClientHello,
		buildClientFinish,
		get isTransport() {
			return !!transport
		}
	}
}

/** XEdDSA verification helper (kept local to avoid a cyclic require) */
const x25519Verify = (publicKey, message, signature) => {
	try {
		// uses whichever Signal backend tobi resolved (see lib/Signal/curve.js)
		const { Curve } = require('../Signal/curve')
		return Curve.verify(publicKey, message, signature)
	} catch (err) {
		return false
	}
}

module.exports = { makeNoiseHandler, TransportState, generateIV }
