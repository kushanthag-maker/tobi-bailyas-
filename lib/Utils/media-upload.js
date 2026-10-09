'use strict'
/**
 * tobi - media handling: encryption, upload and download.
 *
 * WhatsApp media is encrypted client side with a random 32 byte media key:
 *
 *   mediaKey --HKDF("WhatsApp <Type> Keys")--> iv(16) | cipherKey(32) | macKey(32) | refKey(32)
 *
 * The payload is AES-256-CBC encrypted and the last 10 bytes of
 * HMAC-SHA256(ciphertext) are appended. The same media key travels inside the
 * (Signal encrypted) protobuf, so only the recipient can decrypt the blob.
 *
 * Uploads go to mmg.whatsapp.net using a `media_conn` obtained over the socket.
 * Both buffer and streaming (multi GB video) paths are supported so RAM stays
 * flat no matter how big the file is.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { hkdf, sha256, randomBytes, createMediaCipher, hmacSign } = require('./crypto')
const { MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP, UPLOAD_TIMEOUT, S_WHATSAPP_NET, DEFAULT_ORIGIN } = require('../Defaults')
const { generateMessageID } = require('./generics')
const { proto } = require('../Proto')

const HKDF_INFO = (type) => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type] || 'Image'} Keys`
const BLOCK_SIZE = 16

/** derive the four media keys */
const getMediaKeys = (mediaKey, type) => {
	const expanded = hkdf(mediaKey, null, Buffer.from(HKDF_INFO(type)), 112)
	return {
		iv: expanded.subarray(0, 16),
		cipherKey: expanded.subarray(16, 48),
		macKey: expanded.subarray(48, 80),
		refKey: expanded.subarray(80, 112)
	}
}

/** guess the WhatsApp media type from a mimetype */
const getMediaType = (mimeType = '', fileName = '') => {
	const mime = String(mimeType).toLowerCase()
	const ext = path.extname(String(fileName)).toLowerCase()
	if (mime.startsWith('image/')) {
		if (mime.includes('webp') || ext === '.webp') return 'sticker'
		return 'image'
	}
	if (mime.startsWith('video/')) return 'video'
	if (mime.startsWith('audio/')) return mime.includes('ogg') && mime.includes('opus') ? 'ptt' : 'audio'
	if (mime.startsWith('application/') || mime.startsWith('text/')) return 'document'
	if (ext === '.webp') return 'sticker'
	if (['.jpg', '.jpeg', '.png'].includes(ext)) return 'image'
	if (['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext)) return 'video'
	if (['.mp3', '.m4a', '.aac', '.wav', '.flac'].includes(ext)) return 'audio'
	return 'document'
}

/** AES-256-CBC encrypt + 10 byte MAC, whole buffer in memory */
const encryptMediaBuffer = (buffer, mediaType, mediaKey) => {
	const { cipherKey, iv, macKey } = getMediaKeys(mediaKey, mediaType)
	const cipher = createMediaCipher(cipherKey, iv)
	const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()])
	const mac = hmacSign(ciphertext, macKey).subarray(0, 10)
	const encBuffer = Buffer.concat([ciphertext, mac])
	return {
		encBuffer,
		fileSha256: sha256(buffer),
		fileEncSha256: sha256(encBuffer),
		mediaKey,
		mediaKeyTimestamp: Math.floor(Date.now() / 1000),
		mac,
		ciphertext
	}
}

/**
 * Streaming encryption for very large files (movies): reads the file in chunks,
 * encrypts on the fly and hashes plaintext + ciphertext without loading it all.
 */
const encryptMediaStream = (filePath, mediaType, mediaKey) =>
	new Promise((resolve, reject) => {
		const { cipherKey, iv, macKey } = getMediaKeys(mediaKey, mediaType)
		const cipher = createMediaCipher(cipherKey, iv)
		const plainHash = crypto.createHash('sha256')
		const encHash = crypto.createHash('sha256')
		const chunks = []
		let totalLength = 0

		const input = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
		input.on('error', reject)
		input.on('data', (chunk) => {
			plainHash.update(chunk)
			const out = cipher.update(chunk)
			encHash.update(out)
			chunks.push(out)
			totalLength += out.length
		})
		input.on('end', () => {
			try {
				const final = cipher.final()
				encHash.update(final)
				chunks.push(final)
				totalLength += final.length
				const ciphertext = Buffer.concat(chunks, totalLength)
				const mac = hmacSign(ciphertext, macKey).subarray(0, 10)
				encHash.update(mac) // the uploaded file includes the MAC, so the hash must too
				const encBuffer = Buffer.concat([ciphertext, mac])
				resolve({
					encBuffer,
					fileSha256: plainHash.digest(),
					fileEncSha256: encHash.digest(),
					mediaKey,
					mediaKeyTimestamp: Math.floor(Date.now() / 1000),
					mac,
					ciphertext
				})
			} catch (err) {
				reject(err)
			}
		})
	})

/** decrypt a downloaded blob back into the original file */
const decryptMediaBuffer = (encBuffer, mediaType, mediaKey) => {
	const { cipherKey, iv, macKey } = getMediaKeys(mediaKey, mediaType)
	const mac = encBuffer.subarray(-10)
	const ciphertext = encBuffer.subarray(0, -10)
	const expected = hmacSign(ciphertext, macKey).subarray(0, 10)
	if (!mac.equals(expected)) throw new Error('tobi: media MAC mismatch (corrupted or wrong key)')
	const decipher = require('./crypto').createMediaDecipher(cipherKey, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** streaming decryption for large downloads */
const decryptMediaStream = (encFilePath, outFilePath, mediaType, mediaKey) =>
	new Promise((resolve, reject) => {
		const { cipherKey, iv, macKey } = getMediaKeys(mediaKey, mediaType)
		const size = fs.statSync(encFilePath).size
		const ciphertextLength = size - 10
		const decipher = require('./crypto').createMediaDecipher(cipherKey, iv)
		const macHash = crypto.createHmac('sha256', macKey)
		const output = fs.createWriteStream(outFilePath)
		const input = fs.createReadStream(encFilePath, { end: ciphertextLength - 1, highWaterMark: 1024 * 1024 })
		let read = 0
		input.on('error', reject)
		output.on('error', reject)
		input.on('data', (chunk) => {
			read += chunk.length
			macHash.update(chunk)
			output.write(decipher.update(chunk))
		})
		input.on('end', () => {
			const fd = fs.openSync(encFilePath, 'r')
			const macBuf = Buffer.alloc(10)
			fs.readSync(fd, macBuf, 0, 10, ciphertextLength)
			fs.closeSync(fd)
			const expected = macHash.digest().subarray(0, 10)
			if (!macBuf.equals(expected)) return reject(new Error('tobi: media MAC mismatch'))
			output.end(decipher.final(), () => resolve(outFilePath))
		})
	})

/* ------------------------------------------------------------------ *
 * upload / download over the WhatsApp CDN
 * ------------------------------------------------------------------ */

/**
 * Ask the server for an upload host + auth token.
 * iq: <media_conn/> over xmlns="w:m"
 */
const refreshMediaConn = async (socket, force = false) => {
	const now = Date.now()
	if (!force && socket.mediaConn && socket.mediaConn.fetchDate + socket.mediaConn.ttl * 1000 > now) {
		return socket.mediaConn
	}
	const node = {
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:m', id: generateMessageID() },
		content: [{ tag: 'media_conn', attrs: {} }]
	}
	const result = await socket.query(node)
	const mediaConnNode = require('../WABinary').getBinaryNodeChild(result, 'media_conn')
	if (!mediaConnNode) throw new Error('tobi: server did not return a media_conn')
	const hosts = require('../WABinary')
		.getBinaryNodeChildren(mediaConnNode, 'host')
		.map((h) => h.attrs.hostname)
	socket.mediaConn = {
		hosts: hosts.length ? hosts : ['mmg.whatsapp.net'],
		auth: mediaConnNode.attrs.auth,
		ttl: +mediaConnNode.attrs.ttl || 21600,
		maxSize: +mediaConnNode.attrs.maxSize || 100 * 1024 * 1024,
		fetchDate: now
	}
	return socket.mediaConn
}

/** upload an already encrypted buffer to the CDN, returns { url, directPath } */
const uploadEncryptedToCDN = async (socket, encrypted, mediaType) => {
	const mediaConn = await refreshMediaConn(socket)
	const host = mediaConn.hosts[0]
	const encB64 = encodeURIComponent(encrypted.fileEncSha256.toString('base64'))
	const pathSuffix = MEDIA_PATH_MAP[mediaType] ?? '/mms/document'
	const url = `https://${host}${pathSuffix}/${encB64}?auth=${encodeURIComponent(mediaConn.auth)}&token=${encB64}`

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT * 10)
	try {
		const response = await fetch(url, {
			method: 'POST',
			body: encrypted.encBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
				Origin: DEFAULT_ORIGIN,
				'User-Agent': 'tobi'
			},
			signal: controller.signal
		})
		if (!response.ok) {
			throw new Error(`tobi: media upload failed with HTTP ${response.status}`)
		}
		const json = await response.json()
		if (!json.url || !json.direct_path) throw new Error('tobi: media upload response missing url/direct_path')
		return { url: json.url, directPath: json.direct_path }
	} finally {
		clearTimeout(timer)
	}
}

/** fetch a media blob (url or directPath) */
const downloadEncrypted = async (socket, { url, directPath }) => {
	const target = url || `https://mmg.whatsapp.net${directPath}`
	const response = await fetch(target, {
		headers: { Origin: DEFAULT_ORIGIN, 'User-Agent': 'tobi' }
	})
	if (!response.ok) throw new Error(`tobi: media download failed with HTTP ${response.status}`)
	return Buffer.from(await response.arrayBuffer())
}

/* ------------------------------------------------------------------ *
 * high level helpers used by the message builders
 * ------------------------------------------------------------------ */

/**
 * Prepare a media message payload: encrypt (buffer or streamed from disk) and
 * upload it, then return the protobuf fields for image/video/audio/document.
 */
const prepareWAMessageMedia = async (socket, message, options = {}) => {
	const mediaType = message.mediaType || getMediaType(message.mimetype, message.fileName)
	const mediaKey = randomBytes(32)

	let encrypted
	if (message.filePath && fs.existsSync(message.filePath)) {
		// streaming path: safe for multi GB movies
		encrypted = await encryptMediaStream(message.filePath, mediaType, mediaKey)
	} else if (message.buffer) {
		encrypted = encryptMediaBuffer(message.buffer, mediaType, mediaKey)
	} else if (message.url) {
		const remote = await fetch(message.url)
		const buffer = Buffer.from(await remote.arrayBuffer())
		encrypted = encryptMediaBuffer(buffer, mediaType, mediaKey)
	} else {
		throw new Error('tobi: media needs one of buffer | filePath | url')
	}

	const { url, directPath } = await uploadEncryptedToCDN(socket, encrypted, mediaType)

	const common = {
		url,
		directPath,
		mediaKey,
		fileEncSha256: encrypted.fileEncSha256,
		fileSha256: encrypted.fileSha256,
		fileLength: encrypted.encBuffer.length,
		mediaKeyTimestamp: encrypted.mediaKeyTimestamp,
		mimetype: message.mimetype || 'application/octet-stream',
		jpegThumbnail: message.jpegThumbnail
	}
	return { mediaType, ...common }
}

/** download + decrypt the media attached to a message */
const downloadMediaMessage = async (socket, message, options = {}) => {
	const inner = unwrapMessage(message.message || message)
	const media = pickMedia(inner)
	if (!media) throw new Error('tobi: message has no downloadable media')

	const type = getMediaType(media.mimetype)
	const buffer = await downloadEncrypted(socket, { url: media.url, directPath: media.directPath })
	const decrypted = decryptMediaBuffer(buffer, type, Buffer.from(media.mediaKey))

	if (options.filePath) {
		fs.mkdirSync(path.dirname(options.filePath), { recursive: true })
		fs.writeFileSync(options.filePath, decrypted)
		return { filePath: options.filePath, buffer: decrypted }
	}
	return { buffer: decrypted }
}

/** strip ephemeral / view once / document-with-caption wrappers */
const unwrapMessage = (message) => {
	if (!message) return message
	const inner =
		message.ephemeralMessage?.message ||
		message.viewOnceMessage?.message ||
		message.viewOnceMessageV2?.message ||
		message.viewOnceMessageV2Extension?.message ||
		message.documentWithCaptionMessage?.message ||
		message.deviceSentMessage?.message ||
		message
	return inner
}

const pickMedia = (message) =>
	message.imageMessage ||
	message.videoMessage ||
	message.audioMessage ||
	message.documentMessage ||
	message.stickerMessage ||
	undefined

module.exports = {
	getMediaKeys,
	getMediaType,
	encryptMediaBuffer,
	encryptMediaStream,
	decryptMediaBuffer,
	decryptMediaStream,
	refreshMediaConn,
	uploadEncryptedToCDN,
	downloadEncrypted,
	prepareWAMessageMedia,
	downloadMediaMessage,
	unwrapMessage,
	pickMedia
}
