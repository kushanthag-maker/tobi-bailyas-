'use strict'
/**
 * tobi - the receive pipeline: decrypts incoming `<message>` stanzas, handles
 * receipts, retries and the various `<notification>` types.
 */
const { proto } = require('../Proto')
const { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer } = require('../WABinary')
const { jidDecode, jidEncode, jidNormalizedUser } = require('../Utils/generics')
const { unwrapMessage } = require('../Utils/media-upload')
const { sendReceipt } = require('./messages-send')

/** pull the ciphertext + type out of an `<enc>` node */
const decodeEnc = (encNode) => ({
	type: encNode.attrs.type || 'msg',
	ciphertext: Buffer.isBuffer(encNode.content) ? encNode.content : Buffer.from(encNode.content || [])
})

/** decrypt an incoming stanza; returns the decoded WebMessageInfo message */
const decryptMessageNode = async (socket, node) => {
	const me = socket.authState.creds.me
	const fromJid = node.attrs.from
	const participant = node.attrs.participant
	const authorJid = participant || fromJid

	const encNodes = getBinaryNodeChildren(node, 'enc')
	if (!encNodes.length) return null

	const repository = socket.signalRepository

	// sender key (group) message?
	const skmsgNode = encNodes.find((e) => e.attrs.type === 'skmsg')
	if (skmsgNode) {
		try {
			const plaintext = await repository.decryptGroupMessage(fromJid, authorJid, decodeEnc(skmsgNode).ciphertext)
			return proto.Message.decode(plaintext)
		} catch (err) {
			socket.logger?.debug?.(`group decrypt failed (${err.message}) - requesting retry`)
			await requestRetry(socket, node, authorJid)
			return null
		}
	}

	// 1:1 / pre-key message
	for (const encNode of encNodes) {
		try {
			const plaintext = await repository.decryptMessage(authorJid, decodeEnc(encNode))
			let message = proto.Message.decode(plaintext)

			// deviceSentMessage: unwrap and keep the original destination
			if (message.deviceSentMessage?.message) {
				const destination = message.deviceSentMessage.destinationJid
				message = message.deviceSentMessage.message
				return { message, destinationJid: destination }
			}

			// sender key distribution message inside a 1:1 chat
			if (message.senderKeyDistributionMessage) {
				await handleSenderKeyDistribution(socket, fromJid, message.senderKeyDistributionMessage)
			}
			return { message }
		} catch (err) {
			socket.logger?.debug?.(`decrypt attempt failed (${err.message})`)
		}
	}

	await requestRetry(socket, node, authorJid)
	return null
}

/** ask the sender to re-encrypt (a "retry receipt") */
const requestRetry = async (socket, node, authorJid) => {
	try {
		const me = socket.authState.creds.me
		const retryNode = {
			tag: 'receipt',
			attrs: {
				id: node.attrs.id,
				to: authorJid,
				type: 'retry'
			},
			content: [
				{ tag: 'retry', attrs: { count: '1', id: node.attrs.id, t: String(Math.floor(Date.now() / 1000)), v: '1' } },
				{ tag: 'registration', attrs: {}, content: Buffer.from([0, 0, 0, 0]) }
			]
		}
		await socket.sendNode(retryNode)
	} catch (err) {
		socket.logger?.warn?.(`could not send retry receipt: ${err.message}`)
	}
}

const handleSenderKeyDistribution = async (socket, groupJid, skdm) => {
	try {
		await socket.signalRepository.processSenderKeyDistributionMessage(groupJid, skdm)
	} catch (err) {
		socket.logger?.debug?.(`sender key distribution not stored: ${err.message}`)
	}
}

/** full handler for one incoming `<message>` stanza */
const handleMessageStanza = async (socket, node) => {
	const me = socket.authState.creds.me
	const fromJid = node.attrs.from
	const participant = node.attrs.participant
	const isGroup = fromJid.endsWith('@g.us')
	const authorJid = participant || fromJid

	// ignore our own echo unless asked for
	const decrypted = await decryptMessageNode(socket, node)
	if (!decrypted) return

	const { message } = decrypted
	const key = {
		remoteJid: fromJid,
		fromMe: false,
		id: node.attrs.id,
		...(isGroup ? { participant: authorJid } : {})
	}

	const fullMessage = {
		key,
		message,
		messageTimestamp: +(node.attrs.t || Math.floor(Date.now() / 1000)),
		pushName: node.attrs.notify,
		status: proto.WebMessageInfo.Status.DELIVERY_ACK
	}

	// handle protocol messages
	const inner = unwrapMessage(message)
	if (inner.protocolMessage) {
		await handleProtocolMessage(socket, fullMessage, inner.protocolMessage)
		return
	}

	socket.ev.emit('messages.upsert', { messages: [fullMessage], type: 'notify' })

	// send the delivery receipt
	if (!node.attrs.from?.endsWith('@broadcast')) {
		try {
			await sendReceipt(socket, fromJid, isGroup ? authorJid : undefined, [node.attrs.id], 'delivered')
		} catch (err) {
			socket.logger?.debug?.(`delivery receipt failed: ${err.message}`)
		}
	}
}

const handleProtocolMessage = async (socket, fullMessage, protocolMessage) => {
	const type = protocolMessage.type
	const targetKey = protocolMessage.key

	if (type === proto.Message.ProtocolMessage.Type.REVOKE) {
		socket.ev.emit('messages.update', [{ key: targetKey, update: { message: null, messageStubType: 1 } }])
		return
	}
	if (type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
		socket.ev.emit('messages.update', [
			{ key: targetKey, update: { message: protocolMessage.editedMessage, messageTimestamp: Math.floor(Date.now() / 1000) } }
		])
		return
	}
	if (type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING) {
		socket.ev.emit('messages.update', [{ key: targetKey, update: { message: null, messageStubType: 4 } }])
		return
	}
	socket.ev.emit('messages.upsert', { messages: [fullMessage], type: 'notify' })
}

/** `<receipt>` handling: delivery / read / played updates */
const handleReceipt = (socket, node) => {
	const attrs = node.attrs
	const key = {
		remoteJid: attrs.from,
		id: attrs.id,
		fromMe: true,
		participant: attrs.participant
	}
	const receipt = {
		userJid: attrs.participant || attrs.from,
		receiptTimestamp: +(attrs.t || Math.floor(Date.now() / 1000)),
		readTimestamp: attrs.type === 'read' ? +(attrs.t || 0) : undefined,
		playedTimestamp: attrs.type === 'played' ? +(attrs.t || 0) : undefined
	}
	socket.ev.emit('message-receipt.update', [{ key, receipt }])

	if (attrs.type === 'retry') {
		socket.logger?.debug?.(`retry receipt for ${attrs.id}`)
		socket.ev.emit('messages.retry', { key, retryCount: +(getBinaryNodeChild(node, 'retry')?.attrs.count || 1) })
	}
}

/** `<notification>` handling: groups, privacy token, server sync, ... */
const handleNotification = async (socket, node) => {
	const type = node.attrs.type
	const from = node.attrs.from

	if (type === 'w:gp2') {
		// group participants changed / group created
		const child = getBinaryNodeChild(node, 'create') || getBinaryNodeChild(node, 'add') || getBinaryNodeChild(node, 'remove') || getBinaryNodeChild(node, 'modify')
		socket.ev.emit('groups.update', [{ id: from, notify: node.attrs.type, ...(child ? { author: child.attrs.participant } : {}) }])
		try {
			const metadata = await socket.groupMetadata(from, true)
			socket.ev.emit('groups.upsert', [metadata])
		} catch (err) {
			socket.logger?.debug?.(`group metadata refresh failed: ${err.message}`)
		}
		return
	}

	if (type === 'server_sync' || type === 'account_sync') {
		// app state / contact sync - acknowledged, exposed as an event
		socket.ev.emit('sync.update', { type, node })
		return
	}

	if (type === 'encrypt') {
		// pre-key count / identity change
		const countNode = getBinaryNodeChild(node, 'count')
		if (countNode) {
			socket.logger?.debug?.(`server reports ${countNode.attrs.value} pre-keys left`)
			socket.ev.emit('prekeys.update', { count: +countNode.attrs.value })
		}
		return
	}

	if (type === 'devices') {
		const { invalidateDeviceCache } = require('./usync')
		invalidateDeviceCache()
		return
	}

	if (type === 'link_code_companion_reg') {
		socket.ev.emit('pairing.update', { node })
		return
	}

	if (type === 'mediaretry') {
		socket.ev.emit('media.retry', { node })
		return
	}

	socket.ev.emit('notification', { type, from, node })
}

/** `<call>` stanza -> call event */
const handleCall = (socket, node) => {
	const child = Array.isArray(node.content) ? node.content[0] : undefined
	const call = {
		from: node.attrs.from,
		id: node.attrs.id,
		...(child
			? {
					callId: child.attrs['call-id'],
					status: child.tag,
					offline: child.attrs.offline,
					offerTime: child.attrs['call-creator'] ? Date.now() : undefined
				}
			: {})
	}
	socket.ev.emit('call', [call])
}

/** `<ib>` (info bundle): offline messages, edge routing, dirty bits */
const handleInfoBundle = async (socket, node) => {
	const type = node.attrs.type
	const children = Array.isArray(node.content) ? node.content : []

	if (type === 'edge_routing') {
		const routingNode = getBinaryNodeChild(node, 'routing_info')
		if (routingNode) {
			socket.authState.creds.routingInfo = Buffer.isBuffer(routingNode.content)
				? routingNode.content
				: Buffer.from(routingNode.content || [])
			await socket.saveCreds()
		}
		return
	}

	if (type === 'offline') {
		socket.ev.emit('connection.update', { receivedPendingNotifications: true })
		// process buffered messages in order
		for (const child of children) {
			if (child.tag === 'message') await handleMessageStanza(socket, child)
			else if (child.tag === 'receipt') handleReceipt(socket, child)
			else if (child.tag === 'notification') await handleNotification(socket, child)
		}
		await socket.sendNode({
			tag: 'ib',
			attrs: {},
			content: [{ tag: 'offline', attrs: {} }]
		})
		return
	}

	if (type === 'dirty') {
		const { invalidateDeviceCache } = require('./usync')
		invalidateDeviceCache()
		return
	}

	if (type === 'history') {
		// initial / on-demand history sync
		for (const child of children) {
			if (child.tag === 'sync') {
				try {
					const sync = proto.HistorySync.decode(
						Buffer.isBuffer(child.content) ? child.content : Buffer.from(child.content || [])
					)
					socket.ev.emit('messaging-history.set', { syncType: sync.syncType, chats: sync.conversations })
				} catch (err) {
					socket.logger?.warn?.(`history sync decode failed: ${err.message}`)
				}
			}
		}
		return
	}
}

module.exports = {
	handleMessageStanza,
	handleReceipt,
	handleNotification,
	handleCall,
	handleInfoBundle,
	decryptMessageNode,
	requestRetry
}
