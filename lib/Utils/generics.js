'use strict'
/**
 * tobi - generic helpers (ids, jids, crockford base32 for pairing codes, timing).
 */
const crypto = require('crypto')

const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** WhatsApp message ids look like 3EB0<34 uppercase hex chars> */
const generateMessageIDV2 = () => {
	const random = crypto.randomBytes(18).toString('hex').toUpperCase()
	return '3EB0' + random
}

const generateMessageID = () => '3EB0' + crypto.randomBytes(18).toString('hex').toUpperCase()

/** Client/server request id used on <iq> stanzas */
let counter = 0
const generateClientPayloadID = () => String(++counter)
const resetCounter = () => {
	counter = 0
}

/* ------------------------------------------------------------------ *
 * JIDs
 * ------------------------------------------------------------------ */

const S_WHATSAPP_NET = '@s.whatsapp.net'
const OFFICIAL_BIZ_JID = '16505361212@c.us'
const SERVER_JID = 'server@c.us'
const PSA_JID = '0@s.whatsapp.net'
const LID_WHATSAPP_NET = '@lid'
const GROUP_JID = '@g.us'
const NEWSLETTER_JID = '@newsletter'
const BROADCAST_JID = '@broadcast'

const jidEncode = (user, server, device, agent) =>
	`${user}${device != null ? `:${device}` : ''}${agent != null ? `.${agent}` : ''}@${server}`

/**
 * Decode `user:device.agent@server` (all parts optional) into its pieces.
 * The layout produced by jidEncode is `user` [`:` device] [`.` agent] `@` server.
 */
const jidDecode = (jid) => {
	const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
	if (sepIdx < 0) return undefined
	const server = jid.slice(sepIdx + 1)
	const userCombined = jid.slice(0, sepIdx)

	let userPart = userCombined
	let devicePart
	const colon = userCombined.indexOf(':')
	if (colon >= 0) {
		userPart = userCombined.slice(0, colon)
		devicePart = userCombined.slice(colon + 1)
	}

	let device
	let agent
	if (devicePart !== undefined) {
		const dot = devicePart.indexOf('.')
		if (dot >= 0) {
			device = +devicePart.slice(0, dot)
			agent = +devicePart.slice(dot + 1)
		} else {
			device = +devicePart
		}
	} else {
		const dot = userPart.indexOf('.')
		if (dot >= 0) {
			agent = +userPart.slice(dot + 1)
			userPart = userPart.slice(0, dot)
		}
	}

	return {
		server,
		user: userPart,
		agent: Number.isNaN(agent) ? undefined : agent,
		device: Number.isNaN(device) ? undefined : device
	}
}

const isJidGroup = (jid) => !!jid && jid.endsWith(GROUP_JID)
const isJidUser = (jid) => !!jid && jid.endsWith(S_WHATSAPP_NET)
const isJidBroadcast = (jid) => !!jid && jid.endsWith(BROADCAST_JID)
const isJidNewsletter = (jid) => !!jid && jid.endsWith(NEWSLETTER_JID)
const isJidStatusBroadcast = (jid) => jid === 'status@broadcast'
const isLidUser = (jid) => !!jid && jid.endsWith(LID_WHATSAPP_NET)
const isPnUser = (jid) => !!jid && jid.endsWith(S_WHATSAPP_NET)

/** strip device/agent from a jid */
const jidNormalizedUser = (jid) => {
	const result = jidDecode(jid)
	if (!result) return ''
	const { user, server } = result
	return jidEncode(user, server)
}

/** convert a phone number into a user jid */
const phoneNumberToJid = (phoneNumber) => `${String(phoneNumber).replace(/[^0-9]/g, '')}${S_WHATSAPP_NET}`

/* ------------------------------------------------------------------ *
 * Crockford base32 - used to turn 5 random bytes into an 8 char
 * pairing code such as TOBIDEVV.
 * ------------------------------------------------------------------ */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const bytesToCrockford = (buffer) => {
	let value = 0
	let bits = 0
	let out = ''
	for (const byte of buffer) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			bits -= 5
			out += CROCKFORD_ALPHABET[(value >>> bits) & 0x1f]
		}
	}
	if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f]
	return out
}

/**
 * Build the pairing code shown to the user.
 * WhatsApp expects exactly 8 characters (A-Z / 0-9, no dash).
 * If a custom code is supplied we normalise it (uppercase, strip dashes)
 * and validate the length, otherwise we generate a random one.
 */
const PAIRING_CODE_LENGTH = 8

const normalisePairingCode = (code) => String(code).replace(/[\s-]/g, '').toUpperCase()

const isValidPairingCode = (code) => {
	const normalised = normalisePairingCode(code)
	return normalised.length === PAIRING_CODE_LENGTH && /^[0-9A-Z]{8}$/.test(normalised)
}

const generatePairingCode = () => {
	// 5 random bytes -> exactly 8 crockford characters
	return bytesToCrockford(crypto.randomBytes(5)).slice(0, PAIRING_CODE_LENGTH)
}

/** resolve a user supplied code, falling back to a random one */
const resolvePairingCode = (custom) => {
	if (!custom) return generatePairingCode()
	const normalised = normalisePairingCode(custom)
	if (!isValidPairingCode(normalised)) {
		throw new Error(
			`invalid pairing code "${custom}" - WhatsApp pairing codes must be exactly 8 characters (letters A-Z and digits 0-9, dashes are removed automatically)`
		)
	}
	return normalised
}

/** pretty display form, e.g. TOBI-DEVV */
const formatPairingCode = (code) => {
	const c = normalisePairingCode(code)
	return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/* ------------------------------------------------------------------ *
 * misc
 * ------------------------------------------------------------------ */

const DEF_MEDIA_KEY_TIMESTAMP = 0

const encodeBigEndian = (n, bytes = 4) => {
	const buf = Buffer.allocUnsafe(bytes)
	for (let i = bytes - 1; i >= 0; i--) {
		buf[i] = n & 0xff
		n = n >>> 8
	}
	return buf
}

const assertNodeErrorFree = (node) => {
	const errNode = node?.content?.find?.((c) => c.tag === 'error')
	if (errNode) {
		throw new Error(`server error ${errNode.attrs.code}: ${errNode.attrs.text}`)
	}
}

/** normalise a phone number to E.164 without the plus (WhatsApp requires this) */
const toE164 = (phoneNumber) => {
	const cleaned = String(phoneNumber).replace(/[^0-9]/g, '')
	if (!cleaned) throw new Error('phone number is required (E.164 without +, e.g. 94771234567)')
	return cleaned
}

module.exports = {
	unixTimestampSeconds,
	delay,
	generateMessageID,
	generateMessageIDV2,
	generateClientPayloadID,
	resetCounter,
	jidEncode,
	jidDecode,
	jidNormalizedUser,
	phoneNumberToJid,
	isJidGroup,
	isJidUser,
	isJidBroadcast,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	bytesToCrockford,
	generatePairingCode,
	resolvePairingCode,
	normalisePairingCode,
	isValidPairingCode,
	formatPairingCode,
	PAIRING_CODE_LENGTH,
	encodeBigEndian,
	assertNodeErrorFree,
	toE164,
	S_WHATSAPP_NET,
	LID_WHATSAPP_NET,
	GROUP_JID,
	NEWSLETTER_JID,
	BROADCAST_JID,
	SERVER_JID,
	PSA_JID,
	OFFICIAL_BIZ_JID,
	DEF_MEDIA_KEY_TIMESTAMP
}
