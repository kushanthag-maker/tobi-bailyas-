'use strict'
/**
 * tobi - authentication state helpers: credential generation, signed key pairs
 * and the "pair success" handling that turns a QR / pairing-code handshake into
 * permanent credentials.
 */
const { Curve, generateKeyPair } = require('../Signal/curve')
const { randomBytes, hmacSign } = require('./crypto')
const {
	encodeBigEndian,
	generateMessageID,
	jidEncode,
	S_WHATSAPP_NET,
	unixTimestampSeconds
} = require('./generics')
const { proto } = require('../Proto')
const { KEY_BUNDLE_TYPE, WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_DEVICE_SIG_PREFIX, DEFAULT_VERSION } = require('../Defaults')
const { getBinaryNodeChild, getBinaryNodeChildString } = require('../WABinary')

/** a fresh registration id (14 bit, 1..16383) */
const generateRegistrationId = () => {
	const bytes = randomBytes(2)
	return (bytes[0] & 0x3f) * 256 + bytes[1] + 1
}

/** a Signal signed pre-key: X25519 key pair + XEdDSA signature by the identity key */
const signedKeyPair = (identityKeyPair, keyId) => {
	const preKey = generateKeyPair()
	const pubKey = Buffer.concat([KEY_BUNDLE_TYPE, preKey.public])
	const signature = Curve.sign(identityKeyPair.private, pubKey)
	return { keyId, keyPair: preKey, signature: Buffer.from(signature) }
}

/** complete, brand new credential set */
const initAuthCreds = () => {
	const identityKey = generateKeyPair()
	return {
		noiseKey: generateKeyPair(),
		pairingEphemeralKeyPair: generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: { unarchiveChats: false },
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined,
		additionalData: undefined,
		me: undefined,
		platform: undefined,
		account: undefined,
		signalIdentities: []
	}
}

/**
 * Handle the `pair-success` stanza: verify the signed device identity that
 * WhatsApp's servers sent back and build the final credentials + the reply node.
 */
const configureSuccessfulPairing = (pairingNode, creds) => {
	const deviceIdentityNode = getBinaryNodeChild(pairingNode, 'device-identity')
	const deviceNode = getBinaryNodeChild(pairingNode, 'device')
	const platformNode = getBinaryNodeChild(pairingNode, 'platform')
	const businessNode = getBinaryNodeChild(pairingNode, 'biz')

	if (!deviceIdentityNode || !deviceNode) throw new Error('pair-success: missing device-identity or device node')

	const advIdentity = proto.AdvSignedDeviceIdentity.decode(deviceIdentityNode.content)
	const { details, accountSignatureKey, accountSignature, deviceSignature } = advIdentity
	if (!details || !accountSignatureKey || !accountSignature || !deviceSignature) {
		throw new Error('pair-success: incomplete signed device identity')
	}

	const deviceDetails = proto.AdvDeviceIdentity.decode(details)
	const deviceJid = deviceNode.attrs.jid
	const deviceLid = deviceNode.attrs.lid

	// the device signature must cover our own identity key
	const deviceMsg = Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, details, creds.signedIdentityKey.public])
	const deviceVerified = Curve.verify(deviceDetails.deviceIdentity, deviceMsg, deviceSignature)
	if (!deviceVerified) throw new Error('pair-success: device signature invalid')

	// the account signature must be made by the primary account identity key
	const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, details, accountSignatureKey])
	const accountVerified = Curve.verify(accountSignatureKey, accountMsg, accountSignature)
	if (!accountVerified) throw new Error('pair-success: account signature invalid')

	const { user } = require('./generics').jidDecode(deviceJid)
	const me = {
		id: deviceJid,
		lid: deviceLid,
		name: deviceNode.attrs.name || '~',
		phoneNumber: user
	}

	const updatedCreds = {
		...creds,
		registered: true,
		me,
		platform: platformNode ? platformNode.attrs.name : 'tobi',
		account: {
			details,
			accountSignatureKey,
			accountSignature,
			deviceSignature
		},
		signalIdentities: [
			...(creds.signalIdentities || []),
			{
				identifier: { name: deviceJid, deviceId: 0 },
				identifierKey: accountSignatureKey
			}
		]
	}

	// WhatsApp wants an HMAC of the device details, keyed by the adv secret
	const advSecret = Buffer.from(updatedCreds.advSecretKey, 'base64')
	const hmac = hmacSign(details, advSecret)
	const deviceIdentityHmac = proto.AdvSignedDeviceIdentityHMAC.encode({ details, hmac }).finish()

	const reply = {
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'result', id: pairingNode.attrs.id },
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': String(deviceDetails.keyIndex || 0) },
						content: deviceIdentityHmac
					}
				]
			}
		]
	}

	return { creds: updatedCreds, reply }
}

/**
 * Encode our own signed device identity for `device-identity` nodes that are
 * attached to outgoing message stanzas.
 */
const encodeSignedDeviceIdentity = (account, includeSignatureKey = false) => {
	const { details, accountSignatureKey, accountSignature, deviceSignature } = account || {}
	const payload = { details }
	if (includeSignatureKey) payload.accountSignatureKey = accountSignatureKey
	if (accountSignature) payload.accountSignature = accountSignature
	if (deviceSignature) payload.deviceSignature = deviceSignature
	return proto.AdvSignedDeviceIdentity.encode(payload).finish()
}

/** node describing this device, used inside the register/login payload */
const makeDeviceIdentityNode = (account, keyIndex = 0) => ({
	tag: 'device-identity',
	attrs: { 'key-index': String(keyIndex) },
	content: encodeSignedDeviceIdentity(account, true)
})

const generateMessageTag = () => generateMessageID()

module.exports = {
	generateRegistrationId,
	signedKeyPair,
	initAuthCreds,
	configureSuccessfulPairing,
	encodeSignedDeviceIdentity,
	makeDeviceIdentityNode,
	generateMessageTag,
	encodeBigEndian,
	jidEncode,
	unixTimestampSeconds,
	DEFAULT_VERSION
}
