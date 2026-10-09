'use strict'
/**
 * tobi - WABinary encoder.
 *
 * Turns `{ tag, attrs, content }` nodes into the compact binary format used by
 * the WhatsApp Web socket. Frequently used strings are replaced by dictionary
 * tokens (1 byte for the first 236 entries, 2 bytes for the rest), JIDs are
 * written as `JID_PAIR`s and buffers as length prefixed binary blobs.
 */
const { TAGS, SINGLE_BYTE_MAP, DOUBLE_BYTE_MAP } = require('./constants')

const JID_SERVERS = new Set(['s.whatsapp.net', 'lid', 'g.us', 'broadcast', 'newsletter', 'c.us', 'server', 'call'])

/** encode a single node (plus the leading 0x00 frame marker) into a Buffer */
const encodeBinaryNode = (node, buffer = [0]) => {
	encodeNode(node, buffer)
	return Buffer.from(buffer)
}

/** encode many nodes back to back (no frame marker) */
const encodeBinaryNodes = (nodes) => {
	const buffer = []
	for (const node of nodes) encodeNode(node, buffer)
	return Buffer.from(buffer)
}

const encodeNode = (node, buffer) => {
	if (!node || !node.tag) throw new Error('cannot encode a node without a tag')

	const { tag, attrs, content } = node
	const pairs = []
	if (attrs) {
		for (const key of Object.keys(attrs)) {
			const value = attrs[key]
			if (value !== undefined && value !== null) pairs.push([key, String(value)])
		}
	}

	const hasContent = content !== undefined && content !== null
	writeListStart(1 + pairs.length * 2 + (hasContent ? 1 : 0), buffer)

	if (typeof tag === 'string') writeString(tag, buffer)
	else buffer.push(tag & 0xff)

	for (const [key, value] of pairs) {
		writeString(key, buffer)
		writeString(value, buffer)
	}

	if (hasContent) writeContent(content, buffer)
}

const writeContent = (content, buffer) => {
	if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
		writeByteLength(content.length, buffer)
		for (const byte of content) buffer.push(byte)
	} else if (Array.isArray(content)) {
		writeListStart(content.length, buffer)
		for (const child of content) encodeNode(child, buffer)
	} else if (typeof content === 'string') {
		writeString(content, buffer)
	} else {
		throw new Error(`unsupported node content type: ${typeof content}`)
	}
}

const writeListStart = (listSize, buffer) => {
	if (listSize === 0) buffer.push(TAGS.LIST_EMPTY)
	else if (listSize < 256) {
		buffer.push(TAGS.LIST_8)
		buffer.push(listSize)
	} else {
		buffer.push(TAGS.LIST_16)
		buffer.push((listSize >> 8) & 0xff)
		buffer.push(listSize & 0xff)
	}
}

const writeByteLength = (length, buffer) => {
	if (length >= 4294967296) throw new Error('string too large to encode: ' + length)
	if (length >= 1 << 20) {
		buffer.push(TAGS.BINARY_32)
		buffer.push((length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff)
	} else if (length >= 256) {
		buffer.push(TAGS.BINARY_20)
		buffer.push((length >> 16) & 0x0f, (length >> 8) & 0xff, length & 0xff)
	} else {
		buffer.push(TAGS.BINARY_8)
		buffer.push(length)
	}
}

const writeRawString = (str, buffer) => {
	const bytes = Buffer.from(str, 'utf8')
	writeByteLength(bytes.length, buffer)
	for (const byte of bytes) buffer.push(byte)
}

const writeString = (str, buffer) => {
	if (str === undefined || str === null) {
		buffer.push(TAGS.LIST_EMPTY)
		return
	}
	if (typeof str !== 'string') str = String(str)

	// single byte dictionary hit
	const single = SINGLE_BYTE_MAP.get(str)
	if (single !== undefined) {
		buffer.push(single)
		return
	}
	// double byte dictionary hit
	const double = DOUBLE_BYTE_MAP.get(str)
	if (double) {
		buffer.push(TAGS.DICTIONARY_0 + double[0])
		buffer.push(double[1])
		return
	}
	// jid?
	if (writeJidIfPossible(str, buffer)) return

	writeRawString(str, buffer)
}

/** a jid like `1234:5@s.whatsapp.net` becomes a JID_PAIR (or AD_JID with device) */
const writeJidIfPossible = (str, buffer) => {
	const at = str.indexOf('@')
	if (at < 1) return false
	const server = str.slice(at + 1)
	if (!JID_SERVERS.has(server)) return false

	const userPart = str.slice(0, at)
	const colon = userPart.indexOf(':')
	const devicePart = colon >= 0 ? userPart.slice(colon + 1) : undefined
	const userAgent = colon >= 0 ? userPart.slice(0, colon) : userPart
	const dot = userAgent.indexOf('.')
	const user = dot >= 0 ? userAgent.slice(0, dot) : userAgent
	const agent = dot >= 0 ? userAgent.slice(dot + 1) : undefined

	if (devicePart !== undefined) {
		buffer.push(TAGS.AD_JID)
		buffer.push(agent ? Number(agent) & 0xff : 0)
		buffer.push(Number(devicePart) & 0xff)
		writeString(user, buffer)
	} else {
		buffer.push(TAGS.JID_PAIR)
		if (user) writeString(user, buffer)
		else buffer.push(TAGS.LIST_EMPTY)
		writeString(server, buffer)
	}
	return true
}

const packNibble = (char) => {
	if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48
	switch (char) {
		case '-':
			return 10
		case '.':
			return 11
		case '\0':
			return 15
		default:
			throw new Error(`invalid nibble character "${char}"`)
	}
}

const packHex = (char) => {
	if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48
	if (char >= 'A' && char <= 'F') return 10 + char.charCodeAt(0) - 65
	if (char >= 'a' && char <= 'f') return 10 + char.charCodeAt(0) - 97
	if (char === '\0') return 15
	throw new Error(`invalid hex character "${char}"`)
}

/** NIBBLE_8 / HEX_8 packed strings (used for e.g. `device` and phone attributes) */
const writePackedBytes = (str, type, buffer) => {
	if (str.length > TAGS.PACKED_MAX) throw new Error('too many bytes to pack')
	const pack = type === 'nibble' ? packNibble : packHex
	buffer.push(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8)
	const odd = str.length % 2 !== 0
	const byteLength = Math.ceil(str.length / 2)
	buffer.push(byteLength | (odd ? 0x80 : 0))
	for (let i = 0; i < str.length; i += 2) {
		const high = pack(str[i])
		const low = i + 1 < str.length ? pack(str[i + 1]) : 0x0f
		buffer.push((high << 4) | low)
	}
}

module.exports = { encodeBinaryNode, encodeBinaryNodes, encodeNode, writeString }
