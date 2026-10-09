'use strict'
/** tobi - WABinary public surface */
const constants = require('./constants')
const { encodeBinaryNode, encodeBinaryNodes, encodeNode, writeString } = require('./encode')
const { decodeBinaryNode, decodeBinaryNodes, decodeWireFrame, Reader } = require('./decode')

/** find the first child node with the given tag */
const getBinaryNodeChild = (node, childTag) => {
	if (!node || !Array.isArray(node.content)) return undefined
	return node.content.find((child) => child && child.tag === childTag)
}

/** find every child node with the given tag */
const getBinaryNodeChildren = (node, childTag) => {
	if (!node || !Array.isArray(node.content)) return []
	return node.content.filter((child) => child && child.tag === childTag)
}

const getAllBinaryNodeChildren = (node) => (Array.isArray(node?.content) ? node.content : [])

const getBinaryNodeChildBuffer = (node, childTag) => {
	const child = getBinaryNodeChild(node, childTag)
	if (!child) return undefined
	return Buffer.isBuffer(child.content) ? child.content : undefined
}

const getBinaryNodeChildString = (node, childTag) => {
	const child = getBinaryNodeChild(node, childTag)
	if (!child) return undefined
	if (typeof child.content === 'string') return child.content
	if (Buffer.isBuffer(child.content)) return child.content.toString('utf8')
	return undefined
}

/** throw when the server answered an <iq> with an <error> child */
const assertNodeErrorFree = (node) => {
	const errorNode = getBinaryNodeChild(node, 'error')
	if (errorNode) {
		const code = errorNode.attrs?.code || 'unknown'
		const text = errorNode.attrs?.text || 'unknown error'
		const err = new Error(`whatsapp server error ${code}: ${text}`)
		err.data = node
		throw err
	}
}

/** build a simple node */
const binaryNode = (tag, attrs = {}, content = null) => {
	const node = { tag, attrs }
	if (content !== null && content !== undefined) node.content = content
	return node
}

/** human readable dump, handy while debugging */
const binaryNodeToString = (node, indent = '') => {
	if (!node) return `${indent}(empty)`
	const attrs = Object.entries(node.attrs || {})
		.map(([k, v]) => `${k}="${String(v).length > 60 ? `${String(v).slice(0, 60)}…` : v}"`)
		.join(' ')
	let out = `${indent}<${node.tag}${attrs ? ` ${attrs}` : ''}`
	if (node.content === undefined) return `${out}/>`
	if (Buffer.isBuffer(node.content)) return `${out}>(${node.content.length} bytes)</${node.tag}>`
	if (typeof node.content === 'string') return `${out}>${node.content}</${node.tag}>`
	out += '>\n'
	for (const child of node.content) out += `${binaryNodeToString(child, `${indent}  `)}\n`
	return `${out}${indent}</${node.tag}>`
}

module.exports = {
	...constants,
	encodeBinaryNode,
	encodeBinaryNodes,
	encodeNode,
	writeString,
	decodeBinaryNode,
	decodeBinaryNodes,
	decodeWireFrame,
	Reader,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getAllBinaryNodeChildren,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildString,
	assertNodeErrorFree,
	binaryNode,
	binaryNodeToString
}
