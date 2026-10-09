'use strict'
/**
 * tobi - group helpers: metadata, create, participants, settings.
 */
const { proto } = require('../Proto')
const { getBinaryNodeChild, getBinaryNodeChildren } = require('../WABinary')
const { generateMessageIDV2, jidNormalizedUser, jidDecode, jidEncode } = require('../Utils/generics')
const { S_WHATSAPP_NET } = require('../Defaults')

const GROUP_JID = '@g.us'

/** parse the group metadata returned by the server */
const parseGroupMetadata = (node) => {
	const groupNode = getBinaryNodeChild(node, 'group') || node
	const attrs = groupNode.attrs || {}
	const participants = []

	for (const participantNode of getBinaryNodeChildren(groupNode, 'participant')) {
		participants.push({
			id: participantNode.attrs.jid,
			admin: participantNode.attrs.type === 'admin' ? 'admin' : participantNode.attrs.type === 'superadmin' ? 'superadmin' : null,
			lid: participantNode.attrs.lid
		})
	}

	return {
		id: attrs.id,
		subject: attrs.subject,
		subjectOwner: attrs.s_o,
		subjectTime: +attrs.s_t || 0,
		size: participants.length,
		creation: +attrs.creation || 0,
		owner: attrs.creator,
		desc: attrs.desc,
		descId: attrs.desc_id,
		restrict: attrs.restrict === 'true',
		announce: attrs.announce === 'true',
		participants,
		ephemeralDuration: attrs.ephemeral ? +attrs.ephemeral : undefined,
		addressingMode: attrs.addressing_mode
	}
}

/** fetch (and optionally force refresh) the metadata of a group */
const groupMetadata = async (socket, jid, force = false) => {
	if (!jid.endsWith(GROUP_JID)) throw new Error('tobi: groupMetadata expects a group jid')
	if (!force && socket.groupCache.has(jid)) return socket.groupCache.get(jid)

	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'get', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [
			{
				tag: 'query',
				attrs: { request: 'interactive' },
				content: [{ tag: 'participants', attrs: {} }]
			}
		]
	})

	const metadata = parseGroupMetadata(result)
	socket.groupCache.set(jid, metadata)
	return metadata
}

/** create a group */
const groupCreate = async (socket, subject, participants) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [
			{
				tag: 'create',
				attrs: { subject },
				content: participants.map((jid) => ({ tag: 'participant', attrs: { jid } }))
			}
		]
	})
	const groupNode = getBinaryNodeChild(result, 'group')
	const jid = groupNode?.attrs.id
	return { jid, metadata: parseGroupMetadata(result) }
}

/** add / remove / promote / demote participants */
const groupParticipantsUpdate = async (socket, jid, participants, action) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [
			{
				tag: action,
				attrs: {},
				content: participants.map((p) => ({ tag: 'participant', attrs: { jid: p } }))
			}
		]
	})
	socket.groupCache.delete(jid)
	return getBinaryNodeChildren(getBinaryNodeChild(result, action), 'participant').map((n) => ({
		status: n.attrs.error ? 'error' : 'success',
		jid: n.attrs.jid,
		error: n.attrs.error
	}))
}

const groupAdd = (socket, jid, participants) => groupParticipantsUpdate(socket, jid, participants, 'add')
const groupRemove = (socket, jid, participants) => groupParticipantsUpdate(socket, jid, participants, 'remove')
const groupPromote = (socket, jid, participants) => groupParticipantsUpdate(socket, jid, participants, 'promote')
const groupDemote = (socket, jid, participants) => groupParticipantsUpdate(socket, jid, participants, 'demote')

/** change the group subject / description */
const groupUpdateSubject = async (socket, jid, subject) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf8') }]
	})
	socket.groupCache.delete(jid)
	return result
}

const groupUpdateDescription = async (socket, jid, description) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: 'description', attrs: {}, content: Buffer.from(description, 'utf8') }]
	})
	socket.groupCache.delete(jid)
	return result
}

const groupSettingUpdate = async (socket, jid, setting) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: setting, attrs: {} }]
	})
	socket.groupCache.delete(jid)
	return result
}

const groupLeave = (socket, jid) => groupSettingUpdate(socket, jid, 'leave')

/** fetch the invite code of a group */
const groupInviteCode = async (socket, jid) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'get', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: 'invite', attrs: {} }]
	})
	const inviteNode = getBinaryNodeChild(result, 'invite')
	return inviteNode?.attrs.code
}

const groupRevokeInvite = async (socket, jid) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: jid, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: 'invite', attrs: {} }]
	})
	return getBinaryNodeChild(result, 'invite')?.attrs.code
}

const groupAcceptInvite = async (socket, code) => {
	const result = await socket.query({
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:g2', id: generateMessageIDV2() },
		content: [{ tag: 'invite', attrs: { code } }]
	})
	return getBinaryNodeChild(result, 'group')?.attrs.id
}

module.exports = {
	parseGroupMetadata,
	groupMetadata,
	groupCreate,
	groupAdd,
	groupRemove,
	groupPromote,
	groupDemote,
	groupUpdateSubject,
	groupUpdateDescription,
	groupSettingUpdate,
	groupLeave,
	groupInviteCode,
	groupRevokeInvite,
	groupAcceptInvite
}
