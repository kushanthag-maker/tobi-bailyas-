'use strict'
/**
 * tobi - protobuf layer.
 *
 * WhatsApp's wire format is described by the public `WAProto.proto` file which
 * ships inside this package (lib/Proto/WAProto.proto). We load it with
 * protobufjs and expose every message type lazily through `proto.<Type>`.
 */
const path = require('path')
const protobuf = require('protobufjs')

const PROTO_FILE = path.join(__dirname, 'WAProto.proto')

let root
try {
	root = protobuf.loadSync(PROTO_FILE)
} catch (err) {
	throw new Error(`tobi: could not load the bundled WAProto.proto (${err.message})`)
}

const cache = new Map()

/** resolve a message type, tolerating both a bare and a `proto.` prefixed name */
const lookupType = (name) => {
	if (cache.has(name)) return cache.get(name)
	let type
	try {
		type = root.lookupType(name)
	} catch {
		try {
			type = root.lookupType(`proto.${name}`)
		} catch {
			type = undefined
		}
	}
	cache.set(name, type)
	return type
}

/** `proto.Message.encode(...)`, `proto.CertChain.NoiseCertificate.Details` ... */
const proto = new Proxy(
	{},
	{
		get: (_target, name) => {
			const type = lookupType(String(name))
			if (!type) throw new Error(`tobi: unknown protobuf type "${String(name)}"`)
			return type
		}
	}
)

const hasType = (name) => !!lookupType(name)

/** encode a message, dropping unknown keys instead of throwing */
const encode = (typeName, payload) => {
	const type = lookupType(typeName)
	if (!type) throw new Error(`tobi: unknown protobuf type "${typeName}"`)
	const message = type.fromObject(payload)
	return Buffer.from(type.encode(message).finish())
}

const decode = (typeName, buffer) => {
	const type = lookupType(typeName)
	if (!type) throw new Error(`tobi: unknown protobuf type "${typeName}"`)
	return type.decode(buffer)
}

module.exports = { proto, root, lookupType, hasType, encode, decode, PROTO_FILE }
