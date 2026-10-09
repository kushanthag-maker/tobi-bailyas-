'use strict'
/**
 * tobi - the send pipeline.
 *
 * relayMessage() takes an already built `proto.Message`, encrypts it once per
 * destination device and wraps everything into a `<message>` stanza:
 *
 *   1:1   -> one <enc type="msg"|"pkmsg"> per recipient device, plus a
 *            <participants> block so your own other devices stay in sync.
 *   group -> one <enc type="skmsg"> sender-key payload plus a <participants>
 *            block carrying the sender key distribution message, or (when the
 *            installed Signal backend has no GroupCipher) one <enc> per device.
 */
const { proto } = require('../Proto')
const { getBinaryNodeChild, getBinaryNodeChildren } = require('../WABinary')
const { generateMessageIDV2, jidDecode, unixTimestampSeconds } = require('../Utils/generics')
const { S_WHATSAPP_NET } = require('../Defaults')
const { getUSyncDevices, getOwnDevices } = require('./usync')
const { makeDeviceIdentityNode } = require('../Utils/auth-utils')
const { getMessageType } = require('../Utils/messages')

const readBigEndian = (buffer) => {
	if (!buffer) return 0
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
	let value = 0
	for (const byte of buf) value = value * 256 + byte
	return value
}

/** fetch the pre-key bundles and create Signal sessions for the given devices */
const assertSessions = async (socket, jids, force = false) => {
	if (!jids.length) return true
	const repository = socket.signalRepository
	const missing = []
	for (const jid of jids) {
		const has = await repository.containsSession(repository.addressFor(jid))
		if (!has || force) missing.push(jid)
	}
	if (!missing.length) return true

	socket.logger?.debug?.(`fetching pre-key bundles for ${missing.length} device(s)`)

	const result = await socket.query({
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt', id: generateMessageIDV2() },
		content: [
			{
				tag: 'key',
				attrs: {},
				content: missing.map((jid) => ({ tag: 'user', attrs: { jid } }))
			}
		]
	})

	const listNode = getBinaryNodeChild(result, 'list')
	if (!listNode) {
		socket.logger?.warn?.('pre-key bundle response had no <list>')
		return false
	}

	const tasks = []
	for (const userNode of getBinaryNodeChildren(listNode, 'user')) {
		const jid = userNode.attrs.jid
		const identityNode = getBinaryNodeChild(userNode, 'identity')
		const skeyNode = getBinaryNodeChild(userNode, 'skey')
		const keyNode = getBinaryNodeChild(userNode, 'key')
		if (!identityNode || !skeyNode) {
			socket.logger?.warn?.(`no pre-key bundle for ${jid}`)
			continue
		}
		const bundle = {
			registrationId: readBigEndian(getBinaryNodeChild(userNode, 'registration')?.content),
			identityKey: identityNode.content,
			signedPreKey: {
				keyId: readBigEndian(getBinaryNodeChild(skeyNode, 'id')?.content),
				publicKey: getBinaryNodeChild(skeyNode, 'value')?.content,
				signature: getBinaryNodeChild(skeyNode, 'signature')?.content
			}
		}
		if (keyNode) {
			bundle.preKey = {
				keyId: readBigEndian(getBinaryNodeChild(keyNode, 'id')?.content),
				publicKey: getBinaryNodeChild(keyNode, 'value')?.content
			}
		}
		tasks.push(repository.createSession(jid, bundle))
	}

	await Promise.all(tasks)
	return true
}

/** encrypt the same payload for every destination device */
const encryptForDevices = async (socket, jids, bytes) => {
	const repository = socket.signalRepository
	const results = await Promise.all(
		jids.map(async (jid) => {
			const { type, ciphertext } = await repository.encryptMessage(jid, bytes)
			return {
				jid,
				node: { tag: 'enc', attrs: { v: '2', type, 'decrypt-fail': 'hide' }, content: ciphertext }
			}
		})
	)
	return results
}

const unique = (list) => [...new Set(list)]

/**
 * Send an already built `proto.Message`.
 * @param {import('./index').TobiSocket} socket
 * @param {string} jid
 * @param {object} message a `proto.Message` shaped object
 * @param {object} [options]
 */
const relayMessage = async (socket, jid, message, options = {}) => {
	const me = socket.authState.creds.me
	if (!me?.id) throw new Error('tobi: not logged in')

	const isGroup = jid.endsWith('@g.us')
	const messageId = options.messageId || generateMessageIDV2()
	const bytes = proto.Message.encode(proto.Message.fromObject(message)).finish()
	const deviceIdentityNode = makeDeviceIdentityNode(socket.authState.creds.account)

	/** build the <message> stanza */
	const buildNode = (encNodes, extraContent = [], extraAttrs = {}) => ({
		tag: 'message',
		attrs: {
			id: messageId,
			to: jid,
			type: getMessageType(message),
			...extraAttrs,
			...(options.attributes || {})
		},
		content: [...encNodes, deviceIdentityNode, ...extraContent]
	})

	/* ------------------------------ 1:1 ------------------------------ */
	if (!isGroup) {
		const recipientDevices = await getUSyncDevices(socket, [jid], true, false)
		const ownDevices = await getOwnDevices(socket)
		const recipientJids = recipientDevices.map((d) => d.jid)
		const ownJids = ownDevices.map((d) => d.jid)

		await assertSessions(socket, unique([...recipientJids, ...ownJids]), options.forceSession)

		const recipientEnc = await encryptForDevices(socket, recipientJids, bytes)

		// our own other devices receive a deviceSentMessage wrapper
		let ownEnc = []
		if (ownJids.length) {
			const deviceSentBytes = proto.Message.encode(
				proto.Message.fromObject({ deviceSentMessage: { destinationJid: jid, message } })
			).finish()
			ownEnc = await encryptForDevices(socket, ownJids, deviceSentBytes)
		}

		const extra = ownEnc.length
			? [
					{
						tag: 'participants',
						attrs: {},
						content: ownEnc.map((e) => ({ tag: 'to', attrs: { jid: e.jid }, content: [e.node] }))
					}
				]
			: []

		const node = buildNode(
			recipientEnc.map((e) => e.node),
			extra
		)
		await socket.sendNode(node)
		return {
			key: { remoteJid: jid, fromMe: true, id: messageId },
			message,
			messageTimestamp: unixTimestampSeconds()
		}
	}

	/* ----------------------------- group ----------------------------- */
	const metadata = options.participants
		? { participants: options.participants.map((id) => ({ id })) }
		: await socket.groupMetadata(jid)
	const participantJids = metadata.participants.map((p) => p.id)

	// device 0 of each participant is already the group member; include all devices
	const recipientDevices = await getUSyncDevices(socket, participantJids, true, true)
	const ownDevices = await getOwnDevices(socket)
	const deviceJids = unique([...recipientDevices.map((d) => d.jid), ...ownDevices.map((d) => d.jid)])

	await assertSessions(socket, deviceJids, options.forceSession)

	const repository = socket.signalRepository

	// preferred path: sender key (skmsg)
	if (repository.canUseSenderKeys && !options.forcePerDevice) {
		try {
			const senderKey = await repository.createSenderKeyDistribution(jid)
			const ciphertext = await repository.encryptGroupMessage(jid, bytes)

			const skdmBytes = proto.Message.encode(
				proto.Message.fromObject({
					senderKeyDistributionMessage: {
						groupId: jid,
						axolotlSenderKeyDistributionMessage: senderKey
					}
				})
			).finish()
			const skdmEnc = await encryptForDevices(socket, deviceJids, skdmBytes)

			const node = buildNode(
				[{ tag: 'enc', attrs: { v: '2', type: 'skmsg' }, content: ciphertext }],
				[
					{
						tag: 'participants',
						attrs: {},
						content: skdmEnc.map((e) => ({ tag: 'to', attrs: { jid: e.jid }, content: [e.node] }))
					}
				],
				{ participant: me.id }
			)
			await socket.sendNode(node)
			return {
				key: { remoteJid: jid, fromMe: true, id: messageId, participant: me.id },
				message,
				messageTimestamp: unixTimestampSeconds()
			}
		} catch (err) {
			socket.logger?.warn?.(`sender key path failed, using per-device encryption: ${err.message}`)
		}
	}

	// fallback: encrypt individually for every participant device
	const encNodes = await encryptForDevices(socket, deviceJids, bytes)
	const node = buildNode(
		encNodes.map((e) => e.node),
		[],
		{ participant: me.id }
	)
	await socket.sendNode(node)
	return {
		key: { remoteJid: jid, fromMe: true, id: messageId, participant: me.id },
		message,
		messageTimestamp: unixTimestampSeconds()
	}
}

/** receipts (delivered / read / played) */
const sendReceipt = async (socket, jid, participant, ids, type = 'delivered') => {
	const node = {
		tag: 'receipt',
		attrs: {
			id: ids[0],
			t: String(unixTimestampSeconds()),
			...(participant ? { participant } : {}),
			type,
			...(jid.endsWith('@g.us') ? { to: jid } : {})
		}
	}
	if (ids.length > 1) {
		node.content = [{ tag: 'list', attrs: {}, content: ids.slice(1).map((id) => ({ tag: 'item', attrs: { id } })) }]
	}
	await socket.sendNode(node)
}

module.exports = { relayMessage, assertSessions, encryptForDevices, sendReceipt, readBigEndian }
