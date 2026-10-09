'use strict'
/**
 * tobi - low level crypto helpers.
 * Everything here is built on Node's built-in `crypto` module (zero third party deps).
 */
const crypto = require('crypto')

const AES_KEY_SIZE = 32
const IV_LENGTH = 16
const HASH_LENGTH = 32

/** sha256 digest */
const sha256 = (data) => crypto.createHash('sha256').update(data).digest()

/** hmac-sha256 */
const hmacSign = (data, key) => crypto.createHmac('sha256', key).update(data).digest()

const md5 = (data) => crypto.createHash('md5').update(data).digest()

const randomBytes = (length) => crypto.randomBytes(length)

/**
 * HKDF-SHA256 (RFC 5869).
 * A missing salt means "32 zero bytes", as the RFC specifies.
 */
const hkdf = (key, salt, info, length = 32) => {
	const actualSalt = salt === null || salt === undefined ? Buffer.alloc(HASH_LENGTH) : Buffer.from(salt)
	const actualInfo = info === null || info === undefined ? Buffer.alloc(0) : info
	return Buffer.from(crypto.hkdfSync('sha256', key, actualSalt, actualInfo, length))
}

/** HKDF with the 64 bytes the Noise handshake needs */
const hkdf64 = (key, salt, info) => hkdf(key, salt, info, 64)

/** AES-256-GCM, returns ciphertext + auth tag (16 bytes appended) */
const aesEncryptGCM = (plaintext, key, iv, additionalData) => {
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
	if (additionalData && additionalData.length) cipher.setAAD(additionalData)
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

const aesDecryptGCM = (ciphertext, key, iv, additionalData) => {
	const tag = ciphertext.slice(-16)
	const data = ciphertext.slice(0, -16)
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
	if (additionalData && additionalData.length) decipher.setAAD(additionalData)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(data), decipher.final()])
}

/** AES-256-CTR (used by the pairing-code key wrap) */
const aesEncryptCTR = (plaintext, key, iv) => {
	const cipher = crypto.createCipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

const aesDecryptCTR = (ciphertext, key, iv) => {
	const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** AES-256-CBC with PKCS#7 padding (used for media payloads) */
const aesEncrypt = (plaintext, key, iv) => {
	const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

const aesDecrypt = (ciphertext, key, iv) => {
	const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** streaming AES-256-CBC (keeps RAM flat for multi GB movie files) */
const createMediaCipher = (key, iv) => crypto.createCipheriv('aes-256-cbc', key, iv)
const createMediaDecipher = (key, iv) => crypto.createDecipheriv('aes-256-cbc', key, iv)

/* ------------------------------------------------------------------ *
 * X25519
 *
 * Node can do X25519 through its KeyObject API. Raw 32 byte keys are wrapped
 * in the standard DER envelopes so no third party curve library is needed.
 * ------------------------------------------------------------------ */

/** PKCS#8 prefix for a raw X25519 private key */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
/** SPKI prefix for a raw X25519 public key */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

const privateKeyObject = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
const publicKeyObject = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' })

const x25519 = {
	generateKeyPair: () => {
		const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
		const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
		const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
		return { publicKey: Buffer.from(pub), privateKey: Buffer.from(priv) }
	},
	/** Diffie-Hellman: sharedKey(myPrivate, theirPublic) */
	sharedKey: (privateKey, publicKey) =>
		crypto.diffieHellman({
			privateKey: privateKeyObject(privateKey),
			publicKey: publicKeyObject(publicKey)
		}),
	/** derive the public key that belongs to a private key */
	publicFromPrivate: (privateKey) => {
		const priv = privateKeyObject(privateKey)
		const pub = crypto.createPublicKey(priv)
		return Buffer.from(pub.export({ format: 'der', type: 'spki' }).subarray(-32))
	}
}

/** Ed25519 signing (used for the ADVSignedDeviceIdentity) */
const ed25519 = {
	sign: (message, privateKey) => crypto.sign(null, message, privateKey),
	verify: (message, signature, publicKey) => crypto.verify(null, message, publicKey, signature)
}

const toBase64 = (buf) => Buffer.from(buf).toString('base64')
const fromBase64 = (str) => Buffer.from(str, 'base64')

module.exports = {
	AES_KEY_SIZE,
	IV_LENGTH,
	HASH_LENGTH,
	sha256,
	hmacSign,
	md5,
	hkdf,
	hkdf64,
	aesEncryptGCM,
	aesDecryptGCM,
	aesEncryptCTR,
	aesDecryptCTR,
	aesEncrypt,
	aesDecrypt,
	createMediaCipher,
	createMediaDecipher,
	x25519,
	ed25519,
	randomBytes,
	toBase64,
	fromBase64
}
