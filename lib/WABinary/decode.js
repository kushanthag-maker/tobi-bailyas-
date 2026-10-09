'use strict'
/**
 * tobi - WABinary decoder.
 *
 * Reads the compact binary node format produced by WhatsApp's servers.
 * On the wire every frame carries a 1 byte header: bit 1 signals zlib
 * compression, otherwise the byte is simply dropped (see `decodeWireFrame`).
 */
const zlib = require('zlib')
const { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } = require('./constants')

class Reader {
	constructor(buffer) {
		this.buffer = buffer
		this.pos = 0
	}

	readByte() {
		if (this.pos >= this.buffer.length) throw new Error('unexpected end of binary stream')
		return this.buffer[this.pos++]
	}

	readInt16() {
		return (this.readByte() << 8) | this.readByte()
	}

	readInt20() {
		const b0 = this.readByte()
		const b1 = this.readByte()
		const b2 = this.readByte()
		return ((b0 & 0x0f) << 16) | (b1 << 8) | b2
	}

	readInt32() {
		return this.readByte() * 0x1000000 + ((this.readByte() << 16) | (this.readByte() << 8) | this.readByte())
	}

	readBytes(length) {
		if (this.pos + length > this.buffer.length) throw new Error('unexpected end of binary stream')
		const value = this.buffer.subarray(this.pos, this.pos + length)
		this.pos += length
		return value
	}

	get hasMore() {
		return this.pos < this.buffer.length
	}
}

/**
 * Decode a single node.
 * Accepts either a bare node or one carrying the leading marker byte that
 * `encodeBinaryNode` writes, so encode -> decode is a symmetric round trip.
 */
const decodeBinaryNode = (buffer) => {
	const payload = buffer.length && buffer[0] === 0 ? buffer.subarray(1) : buffer
	const reader = new Reader(payload)
	return readNode(reader)
}

/** decode every node contained in a buffer that has no header byte */
const decodeBinaryNodes = (buffer) => {
	const reader = new Reader(buffer)
	const nodes = []
	while (reader.hasMore) nodes.push(readNode(reader))
	return nodes
}

/**
 * Decode a frame as it comes off the socket: strip the 1 byte header
 * (inflating first when the compression bit is set) and decode the node(s).
 */
const decodeWireFrame = (buffer) => {
	let payload = buffer
	if (payload.length && payload[0] & 2) {
		payload = zlib.inflateSync(payload.subarray(1))
	} else {
		payload = payload.subarray(1)
	}
	return decodeBinaryNodes(payload)
}

const readNode = (reader) => {
	const listSize = readListSize(reader.readByte(), reader)
	const descrTag = reader.readByte()
	if (descrTag === TAGS.LIST_EMPTY) throw new Error('invalid node: empty tag token')

	const tag = readString(descrTag, reader)
	if (!listSize || !tag) throw new Error('invalid node: missing tag or list size')

	const attrs = {}
	let remaining = listSize - 1
	while (remaining > 1) {
		const key = readString(reader.readByte(), reader)
		const value = readString(reader.readByte(), reader)
		if (key !== null && key !== undefined) attrs[key] = value
		remaining -= 2
	}

	const node = { tag, attrs }
	if (remaining === 1) {
		const content = readContent(reader)
		if (content !== null && content !== undefined) node.content = content
	}
	return node
}

const readContent = (reader) => {
	const tag = reader.readByte()
	if (tag === TAGS.LIST_EMPTY) return null
	if (tag === TAGS.LIST_8) return readList(reader.readByte(), reader)
	if (tag === TAGS.LIST_16) return readList(reader.readInt16(), reader)
	// binary content (encrypted payloads, media keys, ...) stays raw bytes
	if (tag === TAGS.BINARY_8) return Buffer.from(reader.readBytes(reader.readByte()))
	if (tag === TAGS.BINARY_20) return Buffer.from(reader.readBytes(reader.readInt20()))
	if (tag === TAGS.BINARY_32) return Buffer.from(reader.readBytes(reader.readInt32()))
	return readString(tag, reader)
}

const readList = (size, reader) => {
	const list = []
	for (let i = 0; i < size; i++) list.push(readNode(reader))
	return list
}

const readListSize = (token, reader) => {
	if (token === TAGS.LIST_EMPTY) return 0
	if (token === TAGS.LIST_8) return reader.readByte()
	if (token === TAGS.LIST_16) return reader.readInt16()
	throw new Error(`invalid list size token: ${token}`)
}

const readString = (tag, reader) => {
	switch (tag) {
		case TAGS.LIST_EMPTY:
			return null
		case TAGS.DICTIONARY_0:
		case TAGS.DICTIONARY_1:
		case TAGS.DICTIONARY_2:
		case TAGS.DICTIONARY_3: {
			const dictIndex = tag - TAGS.DICTIONARY_0
			const index = reader.readByte()
			const dict = DOUBLE_BYTE_TOKENS[dictIndex]
			return dict && dict[index] !== undefined ? dict[index] : null
		}
		case TAGS.INTEROP_JID:
		case TAGS.FB_JID:
		case TAGS.AD_JID:
			return readAdJid(tag, reader)
		case TAGS.LIST_8:
		case TAGS.LIST_16:
			return null
		case TAGS.JID_PAIR:
			return readJidPair(reader)
		case TAGS.HEX_8:
			return readPackedBytes('hex', reader)
		case TAGS.NIBBLE_8:
			return readPackedBytes('nibble', reader)
		case TAGS.BINARY_8:
			return reader.readBytes(reader.readByte()).toString('utf8')
		case TAGS.BINARY_20:
			return reader.readBytes(reader.readInt20()).toString('utf8')
		case TAGS.BINARY_32:
			return reader.readBytes(reader.readInt32()).toString('utf8')
		default:
			return SINGLE_BYTE_TOKENS[tag] !== undefined ? SINGLE_BYTE_TOKENS[tag] : null
	}
}

const readJidPair = (reader) => {
	const user = readString(reader.readByte(), reader)
	const server = readString(reader.readByte(), reader)
	if (!server) return null
	return `${user || ''}@${server}`
}

const readAdJid = (tag, reader) => {
	const agent = reader.readByte()
	const device = reader.readByte()
	const user = readString(reader.readByte(), reader)
	if (tag === TAGS.AD_JID) {
		const server = agent === 1 ? 'lid' : 's.whatsapp.net'
		return `${user}:${device}@${server}`
	}
	return `${user}:${device}.${agent}@s.whatsapp.net`
}

const unpackNibble = (value) => {
	if (value >= 0 && value <= 9) return String.fromCharCode(value + 48)
	switch (value) {
		case 10:
			return '-'
		case 11:
			return '.'
		case 15:
			return '\0'
		default:
			throw new Error(`invalid nibble value: ${value}`)
	}
}

const unpackHex = (value) => {
	if (value >= 0 && value <= 9) return String.fromCharCode(value + 48)
	if (value >= 10 && value <= 15) return String.fromCharCode(value + 55)
	throw new Error(`invalid hex value: ${value}`)
}

const readPackedBytes = (type, reader) => {
	const startByte = reader.readByte()
	const unpack = type === 'nibble' ? unpackNibble : unpackHex
	const length = startByte & 0x7f
	let value = ''
	for (let i = 0; i < length; i++) {
		const byte = reader.readByte()
		value += unpack((byte & 0xf0) >> 4)
		value += unpack(byte & 0x0f)
	}
	if (startByte >> 7 !== 0) value = value.slice(0, -1)
	return value
}

module.exports = { decodeBinaryNode, decodeBinaryNodes, decodeWireFrame, Reader }
