'use strict'
/**
 * tobi - offline self test.
 *
 * Verifies everything that does not need a WhatsApp account:
 *   - token dictionary integrity
 *   - WABinary encode/decode round trips
 *   - jid helpers
 *   - pairing code generation / validation / normalisation
 *   - crypto primitives (HKDF, AES-GCM, X25519)
 *   - the Noise XX key schedule (client handler vs a mirror server)
 *   - protobuf loading + message encoding (text, buttons, list)
 *   - media encryption / decryption (buffer + streaming)
 *
 * Run:  npm test
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
	WABinary,
	proto,
	crypto,
	generatePairingCode,
	resolvePairingCode,
	isValidPairingCode,
	formatPairingCode,
	jidEncode,
	jidDecode,
	buttons,
	quickReplyButton,
	list,
	text,
	getMediaKeys,
	encryptMediaBuffer,
	decryptMediaBuffer
} = require('..')

const { makeNoiseHandler } = require('../lib/Utils/noise-handler')
const { encryptMediaStream, decryptMediaStream } = require('../lib/Utils/media-upload')
const { NOISE_MODE, NOISE_WA_HEADER } = require('../lib/Defaults')

let passed = 0
let failed = 0

const test = (name, fn) => {
	try {
		fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (err) {
		failed++
		console.log(`  FAIL ${name}\n       ${err.message}`)
	}
}

const asyncTest = async (name, fn) => {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (err) {
		failed++
		console.log(`  FAIL ${name}\n       ${err.message}`)
	}
}

/* ------------------------------------------------------------------ *
 * a mirror of the server side of the Noise XX handshake, built directly
 * from the primitives so the handler's key schedule can be checked.
 * ------------------------------------------------------------------ */
const makeMirrorServer = (clientStaticPublicKey) => {
	const empty = Buffer.alloc(0)
	const mode = Buffer.from(NOISE_MODE, 'binary')
	let hash = mode.length === 32 ? mode : crypto.sha256(mode)
	let salt = hash
	let encKey = hash
	let decKey = hash
	let counter = 0
	// transport keeps SEPARATE read/write counters (exactly like the handler's
	// TransportState). a single shared counter drifts as soon as one direction
	// has been used, so the reply would be encrypted with IV 1 while the client
	// still expects IV 0.
	let readCounter = 0
	let writeCounter = 0
	let transport = false

	const iv = (c) => {
		const b = Buffer.alloc(12)
		b.writeUInt32BE(c >>> 0, 8)
		return b
	}
	const auth = (data) => {
		hash = crypto.sha256(Buffer.concat([hash, data]))
	}
	const ad = () => (transport ? empty : hash)
	const encrypt = (plaintext) => {
		const c = transport ? writeCounter++ : counter++
		const result = crypto.aesEncryptGCM(plaintext, encKey, iv(c), ad())
		if (!transport) auth(result)
		return result
	}
	const decrypt = (ciphertext) => {
		const c = transport ? readCounter++ : counter++
		const result = crypto.aesDecryptGCM(ciphertext, decKey, iv(c), ad())
		if (!transport) auth(ciphertext)
		return result
	}
	const mix = (data) => {
		const key = crypto.hkdf(Buffer.from(data), salt, empty, 64)
		salt = key.subarray(0, 32)
		// handshake traffic keys are the same in both directions
		encKey = key.subarray(32)
		decKey = key.subarray(32)
		counter = 0
	}
	const finishInit = () => {
		const key = crypto.hkdf(empty, salt, empty, 64)
		// transport: the server writes with the half the client reads
		encKey = key.subarray(32)
		decKey = key.subarray(0, 32)
		counter = 0
		readCounter = 0
		writeCounter = 0
		transport = true
	}

	// prologue
	auth(Buffer.from(NOISE_WA_HEADER))
	auth(clientStaticPublicKey)

	return { auth, encrypt, decrypt, mix, finishInit, get hash() { return hash } }
}

// noise expects tobi's {public, private} key shape
const noiseKeyPair = () => {
	const k = crypto.x25519.generateKeyPair()
	// both shapes: the handler reads {public, private}, the test reads *.publicKey
	return { public: k.publicKey, private: k.privateKey, publicKey: k.publicKey, privateKey: k.privateKey }
}

const main = async () => {
	console.log('\ntobi self test\n--------------')

	console.log('\n[token dictionary]')
	test('236 single byte tokens', () => {
		const count = WABinary.SINGLE_BYTE_TOKENS.filter((t) => typeof t === 'string').length
		assert.strictEqual(count, 236, `expected 236, got ${count}`)
	})
	test('4 double byte dictionaries of 256 entries', () => {
		assert.strictEqual(WABinary.DOUBLE_BYTE_TOKENS.length, 4)
		for (const dict of WABinary.DOUBLE_BYTE_TOKENS) assert.strictEqual(dict.length, 256)
	})
	test('well known tokens are present', () => {
		assert.ok(WABinary.SINGLE_BYTE_MAP.has('s.whatsapp.net'), 's.whatsapp.net token missing')
		assert.ok(WABinary.SINGLE_BYTE_MAP.has('message'), 'message token missing')
		assert.ok(WABinary.DOUBLE_BYTE_MAP.size > 900, 'double byte dictionary looks too small')
	})

	console.log('\n[WABinary round trip]')
	const roundTrip = (node) => WABinary.decodeBinaryNode(WABinary.encodeBinaryNode(node))

	test('simple node with attributes', () => {
		const decoded = roundTrip({ tag: 'iq', attrs: { id: 'abc', type: 'get', to: 's.whatsapp.net' } })
		assert.strictEqual(decoded.tag, 'iq')
		assert.strictEqual(decoded.attrs.id, 'abc')
		assert.strictEqual(decoded.attrs.type, 'get')
		assert.strictEqual(decoded.attrs.to, 's.whatsapp.net')
	})
	test('node with buffer content', () => {
		const payload = Buffer.from([1, 2, 3, 4, 5, 250, 251, 252])
		const decoded = roundTrip({ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: payload })
		assert.strictEqual(decoded.tag, 'enc')
		assert.ok(Buffer.isBuffer(decoded.content), 'content should stay a Buffer')
		assert.ok(decoded.content.equals(payload), 'buffer content must survive the round trip')
	})
	test('nested children', () => {
		const decoded = roundTrip({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'md' },
			content: [
				{
					tag: 'link_code_companion_reg',
					attrs: { stage: 'companion_hello' },
					content: [
						{ tag: 'companion_platform_id', attrs: {}, content: '1' },
						{ tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
					]
				}
			]
		})
		const child = WABinary.getBinaryNodeChild(decoded, 'link_code_companion_reg')
		assert.ok(child, 'child node missing')
		assert.strictEqual(child.attrs.stage, 'companion_hello')
		assert.strictEqual(WABinary.getBinaryNodeChildString(child, 'companion_platform_id'), '1')
	})
	test('jid pair encoding', () => {
		const decoded = roundTrip({ tag: 'message', attrs: { to: jidEncode('94771234567', 's.whatsapp.net') } })
		assert.strictEqual(decoded.attrs.to, '94771234567@s.whatsapp.net')
	})
	test('device jid (AD_JID)', () => {
		const decoded = roundTrip({ tag: 'message', attrs: { to: jidEncode('94771234567', 's.whatsapp.net', 3) } })
		assert.strictEqual(decoded.attrs.to, '94771234567:3@s.whatsapp.net')
	})
	test('long string uses BINARY_20', () => {
		const long = 'x'.repeat(1000)
		const decoded = roundTrip({ tag: 'body', attrs: { text: long } })
		assert.strictEqual(decoded.attrs.text, long)
	})
	test('large buffer uses BINARY_32', () => {
		const big = Buffer.alloc(300000, 7)
		const decoded = roundTrip({ tag: 'enc', attrs: {}, content: big })
		assert.strictEqual(decoded.content.length, big.length)
		assert.ok(decoded.content.equals(big))
	})
	test('multi node stream decode', () => {
		const buf = WABinary.encodeBinaryNodes([
			{ tag: 'receipt', attrs: { id: '1', type: 'read' } },
			{ tag: 'message', attrs: { id: '2', to: 'x@s.whatsapp.net' } },
			{ tag: 'presence', attrs: { type: 'available' } }
		])
		const decoded = WABinary.decodeBinaryNodes(buf)
		assert.strictEqual(decoded.length, 3)
		assert.strictEqual(decoded[2].attrs.type, 'available')
	})
	test('wire frame decode (header byte + node)', () => {
		const node = WABinary.encodeBinaryNode({ tag: 'success', attrs: { t: '123' } })
		const decoded = WABinary.decodeWireFrame(node)
		assert.strictEqual(decoded.length, 1)
		assert.strictEqual(decoded[0].tag, 'success')
	})
	test('binaryNodeToString produces readable output', () => {
		const out = WABinary.binaryNodeToString({ tag: 'iq', attrs: { id: '1' }, content: [{ tag: 'ping', attrs: {} }] })
		assert.ok(out.includes('<iq'), 'dump should contain the tag')
		assert.ok(out.includes('<ping'), 'dump should contain the child')
	})

	console.log('\n[jid helpers]')
	test('jidEncode / jidDecode round trip', () => {
		const jid = jidEncode('94771234567', 's.whatsapp.net', 2)
		assert.strictEqual(jid, '94771234567:2@s.whatsapp.net')
		const decoded = jidDecode(jid)
		assert.strictEqual(decoded.user, '94771234567')
		assert.strictEqual(decoded.server, 's.whatsapp.net')
		assert.strictEqual(decoded.device, 2)
	})
	test('plain user jid decodes without a device', () => {
		const decoded = jidDecode('94771234567@s.whatsapp.net')
		assert.strictEqual(decoded.user, '94771234567')
		assert.strictEqual(decoded.device, undefined)
		assert.strictEqual(decoded.agent, undefined)
	})
	test('group jid decodes', () => {
		const decoded = jidDecode('123456789-987654@g.us')
		assert.strictEqual(decoded.server, 'g.us')
		assert.strictEqual(decoded.user, '123456789-987654')
	})

	console.log('\n[pairing codes]')
	test('generated code is always 8 valid characters', () => {
		for (let i = 0; i < 500; i++) {
			const code = generatePairingCode()
			assert.strictEqual(code.length, 8)
			assert.ok(isValidPairingCode(code), `invalid code generated: ${code}`)
		}
	})
	test('custom code is accepted and normalised', () => {
		assert.strictEqual(resolvePairingCode('tobidevv'), 'TOBIDEVV')
		assert.strictEqual(resolvePairingCode('TOBI-DEVV'), 'TOBIDEVV')
		assert.strictEqual(resolvePairingCode('abcd 1234'), 'ABCD1234')
	})
	test('bad custom codes are rejected', () => {
		assert.throws(() => resolvePairingCode('SHORT'))
		assert.throws(() => resolvePairingCode('TOOLONGCODE'))
		assert.throws(() => resolvePairingCode('!!!!!123'))
	})
	test('display formatting', () => {
		assert.strictEqual(formatPairingCode('tobidevv'), 'TOBI-DEVV')
	})

	console.log('\n[crypto]')
	test('hkdf produces the requested length', () => {
		assert.strictEqual(crypto.hkdf(Buffer.alloc(32, 1), null, Buffer.from('info'), 112).length, 112)
	})
	test('AES-256-GCM round trip', () => {
		const key = crypto.randomBytes(32)
		const iv = crypto.randomBytes(12)
		const plaintext = Buffer.from('hello tobi')
		const enc = crypto.aesEncryptGCM(plaintext, key, iv, Buffer.alloc(0))
		assert.ok(crypto.aesDecryptGCM(enc, key, iv, Buffer.alloc(0)).equals(plaintext))
	})
	test('AES-256-CTR round trip', () => {
		const key = crypto.randomBytes(32)
		const iv = crypto.randomBytes(16)
		const plaintext = Buffer.from('pairing key material')
		const enc = crypto.aesEncryptCTR(plaintext, key, iv)
		assert.ok(crypto.aesDecryptCTR(enc, key, iv).equals(plaintext))
	})
	test('X25519 shared secret agrees on both sides', () => {
		const a = crypto.x25519.generateKeyPair()
		const b = crypto.x25519.generateKeyPair()
		assert.ok(crypto.x25519.sharedKey(a.privateKey, b.publicKey).equals(crypto.x25519.sharedKey(b.privateKey, a.publicKey)))
	})

	console.log('\n[noise handshake]')
	test('client key schedule matches a mirror server', () => {
		// WhatsApp reuses the same X25519 noise key as the ClientHello ephemeral and as
		// the static key in ClientFinish, so E_c === S_c here too (otherwise the two
		// sides mix different DH values and the key schedules can never agree)
		const clientStatic = noiseKeyPair()
		const clientEphemeral = clientStatic
		const serverStatic = noiseKeyPair()
		const serverEphemeral = noiseKeyPair()

		const client = makeNoiseHandler({ keyPair: clientStatic, logger: null })
		const server = makeMirrorServer(clientStatic.publicKey)

		// <- e, ee, s, es   (the server's reply to our clientHello)
		server.auth(serverEphemeral.publicKey)
		server.mix(crypto.x25519.sharedKey(serverEphemeral.privateKey, clientEphemeral.publicKey))
		const encryptedStatic = server.encrypt(serverStatic.publicKey)
		server.mix(crypto.x25519.sharedKey(serverStatic.privateKey, clientEphemeral.publicKey))
		const certPlaceholder = Buffer.from('cert chain placeholder')
		const encryptedPayload = server.encrypt(certPlaceholder)

		// the client processes that serverHello
		client.authenticate(serverEphemeral.publicKey)
		client.mixIntoKey(crypto.x25519.sharedKey(clientEphemeral.privateKey, serverEphemeral.publicKey))
		const decryptedStatic = client.decrypt(encryptedStatic)
		assert.ok(decryptedStatic.equals(serverStatic.publicKey), 'client must recover the server static key')
		client.mixIntoKey(crypto.x25519.sharedKey(clientStatic.private, decryptedStatic))
		const decryptedPayload = client.decrypt(encryptedPayload)
		assert.ok(decryptedPayload.equals(certPlaceholder), 'client must recover the server payload')

		// -> s, se
		const keyEnc = client.encrypt(clientStatic.public)
		const readStatic = server.decrypt(keyEnc)
		assert.ok(readStatic.equals(clientStatic.public), 'server must recover the client static key')
		// the closing 'se' token of Noise XX: BOTH sides mix the
		// client-static / server-ephemeral DH. this test used to mix it on the
		// server only, so the two sides reached finishInit with different salts
		// and derived different transport keys (the library's own
		// processHandshake() performs this mix itself).
		server.mix(crypto.x25519.sharedKey(serverEphemeral.privateKey, readStatic))
		client.mixIntoKey(crypto.x25519.sharedKey(clientStatic.private, serverEphemeral.publicKey))

		// both sides derive transport keys
		client.finishInit()
		server.finishInit()

		const outbound = Buffer.from('client -> server')
		assert.ok(server.decrypt(client.encrypt(outbound)).equals(outbound), 'server must decrypt client frames')

		const inbound = Buffer.from('server -> client')
		assert.ok(client.decrypt(server.encrypt(inbound)).equals(inbound), 'client must decrypt server frames')

		for (let i = 0; i < 5; i++) {
			const msg = Buffer.from(`frame ${i}`)
			assert.ok(server.decrypt(client.encrypt(msg)).equals(msg), `frame ${i} failed`)
		}
	})
	test('a forged server hello is rejected', () => {
		const clientStatic = noiseKeyPair()
		const client = makeNoiseHandler({ keyPair: clientStatic, logger: null })
		const serverEphemeral = noiseKeyPair()
		client.authenticate(serverEphemeral.publicKey)
		client.mixIntoKey(crypto.x25519.sharedKey(clientStatic.private, serverEphemeral.publicKey))
		assert.throws(
			() =>
				client.processHandshake(
					{
						serverHello: {
							ephemeral: serverEphemeral.publicKey,
							static: crypto.randomBytes(48),
							payload: crypto.randomBytes(64)
						}
					},
					clientStatic
				),
			'a handshake with garbage certificates must not succeed'
		)
	})
	test('frames carry the 3 byte length prefix', () => {
		const clientStatic = noiseKeyPair()
		const client = makeNoiseHandler({ keyPair: clientStatic, logger: null })
		const frame = client.encodeFrame(Buffer.from('payload'))
		const size = (frame[4] << 16) | (frame[5] << 8) | frame[6]
		assert.strictEqual(size, 7, 'length prefix must equal the payload length')
	})

	console.log('\n[protobuf]')
	test('ClientPayload encodes and decodes', () => {
		const bytes = proto.ClientPayload.encode(
			proto.ClientPayload.fromObject({ username: 94771234567, device: 0, passive: true, pull: true })
		).finish()
		const decoded = proto.ClientPayload.decode(bytes)
		assert.strictEqual(Number(decoded.username), 94771234567)
		assert.strictEqual(decoded.passive, true)
	})
	test('plain text message encodes', () => {
		const bytes = proto.Message.encode({ conversation: 'hello' }).finish()
		assert.strictEqual(proto.Message.decode(bytes).conversation, 'hello')
	})
	test('interactive (native flow) buttons encode', () => {
		const bytes = proto.Message.encode(
			proto.Message.fromObject({
				interactiveMessage: {
					body: { text: 'pick one' },
					header: { title: 'tobi' },
					nativeFlowMessage: {
						buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) }]
					}
				}
			})
		).finish()
		const decoded = proto.Message.decode(bytes)
		assert.strictEqual(decoded.interactiveMessage.body.text, 'pick one')
		assert.strictEqual(decoded.interactiveMessage.nativeFlowMessage.buttons.length, 1)
		assert.strictEqual(JSON.parse(decoded.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson).id, 'yes')
	})
	test('list message encodes', () => {
		const bytes = proto.Message.encode(
			proto.Message.fromObject({
				listMessage: {
					description: 'choose',
					buttonText: 'open',
					listType: 1,
					sections: [{ title: 'A', rows: [{ title: 'one', rowId: '1' }] }]
				}
			})
		).finish()
		assert.strictEqual(proto.Message.decode(bytes).listMessage.sections.length, 1)
	})
	test('legacy buttonsMessage encodes', () => {
		const bytes = proto.Message.encode(
			proto.Message.fromObject({
				buttonsMessage: {
					contentText: 'body',
					footerText: 'footer',
					headerType: 1,
					buttons: [{ buttonId: 'a', buttonText: { displayText: 'A' }, type: 1 }]
				}
			})
		).finish()
		assert.strictEqual(proto.Message.decode(bytes).buttonsMessage.buttons.length, 1)
	})
	test('all required protobuf types resolve', () => {
		const required = [
			'Message',
			'ClientPayload',
			'DeviceProps',
			'HandshakeMessage',
			'CertChain',
			'AdvSignedDeviceIdentity',
			'AdvSignedDeviceIdentityHMAC',
			'AdvDeviceIdentity',
			'DevicePairingRegistrationData',
			'CompanionRegistrationData',
			'SenderKeyDistributionMessage',
			'WebMessageInfo',
			'HistorySync',
			'MediaRetryNotification'
		]
		for (const name of required) assert.ok(proto[name], `missing protobuf type: ${name}`)
	})

	console.log('\n[message builders]')
	test('text()', () => {
		assert.strictEqual(text('hi').text, 'hi')
	})
	test('buttons() builds native flow buttons', () => {
		const built = buttons({ text: 'body', title: 'title', buttons: [quickReplyButton({ displayText: 'A', id: 'a' })] })
		assert.ok(built.interactive)
		assert.strictEqual(built.interactive.nativeFlowMessage.buttons[0].name, 'quick_reply')
	})
	test('list()', () => {
		assert.ok(list({ text: 'b', buttonText: 'open', sections: [] }).list)
	})

	console.log('\n[media encryption]')
	await asyncTest('buffer encrypt -> decrypt round trip', async () => {
		const mediaKey = crypto.randomBytes(32)
		const original = crypto.randomBytes(5000)
		const encrypted = encryptMediaBuffer(original, 'video', mediaKey)
		assert.strictEqual((encrypted.encBuffer.length - 10) % 16, 0, 'ciphertext must be a whole number of AES blocks')
		assert.ok(encrypted.encBuffer.length >= original.length + 10, 'ciphertext + MAC must cover the payload')
		assert.ok(decryptMediaBuffer(encrypted.encBuffer, 'video', mediaKey).equals(original))
	})
	await asyncTest('a wrong media key is rejected by the MAC', async () => {
		const encrypted = encryptMediaBuffer(crypto.randomBytes(100), 'image', crypto.randomBytes(32))
		assert.throws(() => decryptMediaBuffer(encrypted.encBuffer, 'image', crypto.randomBytes(32)))
	})
	await asyncTest('streaming encryption matches the buffer path', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tobi-'))
		const src = path.join(dir, 'movie.bin')
		const data = crypto.randomBytes(3 * 1024 * 1024) // 3 MB "movie"
		fs.writeFileSync(src, data)
		const mediaKey = crypto.randomBytes(32)

		const streamed = await encryptMediaStream(src, 'video', mediaKey)
		const buffered = encryptMediaBuffer(data, 'video', mediaKey)
		assert.ok(streamed.fileEncSha256.equals(buffered.fileEncSha256), 'streamed and buffered hashes must match')
		assert.ok(streamed.fileSha256.equals(buffered.fileSha256), 'plaintext hashes must match')

		const encPath = path.join(dir, 'movie.enc')
		fs.writeFileSync(encPath, streamed.encBuffer)
		const outPath = path.join(dir, 'movie.out')
		await decryptMediaStream(encPath, outPath, 'video', mediaKey)
		assert.ok(fs.readFileSync(outPath).equals(data), 'streamed round trip must be lossless')
		fs.rmSync(dir, { recursive: true, force: true })
	})
	test('media key derivation yields 16/32/32/32 bytes', () => {
		const keys = getMediaKeys(crypto.randomBytes(32), 'video')
		assert.strictEqual(keys.iv.length, 16)
		assert.strictEqual(keys.cipherKey.length, 32)
		assert.strictEqual(keys.macKey.length, 32)
		assert.strictEqual(keys.refKey.length, 32)
	})

	console.log(`\n--------------\n${passed} passed, ${failed} failed\n`)
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
