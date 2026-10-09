'use strict'
/**
 * tobi - build the `ClientPayload` protobufs used during the Noise handshake
 * (register / login), plus the QR payload and the pairing-code stanza helpers.
 */
const crypto = require('crypto')
const { proto } = require('../Proto')
const {
	KEY_BUNDLE_TYPE,
	DEFAULT_VERSION,
	getCompanionPlatformId,
	makeBrowserString,
	makeDeviceProps,
	S_WHATSAPP_NET
} = require('../Defaults')
const { encodeBigEndian, jidDecode, generateMessageID, randomBytes } = require('./generics')
const { aesEncryptCTR } = require('./crypto')
const { toBase64 } = require('./crypto')

/** PBKDF2-SHA256 with 2<<16 iterations, exactly what WhatsApp Web uses */
const derivePairingCodeKey = (pairingCode, salt) =>
	new Promise((resolve, reject) => {
		crypto.pbkdf2(pairingCode, salt, 2 << 16, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)))
	})

const getPlatformType = (platform) => {
	const key = String(platform || '').toLowerCase()
	if (key.includes('chrome')) return proto.DeviceProps.PlatformType.CHROME
	if (key.includes('firefox')) return proto.DeviceProps.PlatformType.FIREFOX
	if (key.includes('edge')) return proto.DeviceProps.PlatformType.EDGE
	if (key.includes('opera')) return proto.DeviceProps.PlatformType.OPERA
	if (key.includes('safari')) return proto.DeviceProps.PlatformType.SAFARI
	return proto.DeviceProps.PlatformType.CHROME
}

/** the `WebInfo` / `UserAgent` block that is part of every ClientPayload */
const getClientPayload = (config = {}) => {
	const version = config.version || DEFAULT_VERSION
	const browser = config.browser || ['tobi', 'Chrome', '1.0.0']
	return {
		connectType: config.connectType ?? proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: config.connectReason ?? proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: {
			platform: proto.ClientPayload.UserAgent.Platform.WEB,
			appVersion: { primary: version[0], secondary: version[1], tertiary: version[2] },
			mcc: '000',
			mnc: '000',
			osVersion: browser[2] || '1.0.0',
			device: browser[0] || 'tobi',
			osBuildNumber: '0',
			releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
			localeLanguageIso6391: config.localeLanguage || 'en',
			localeCountryIso31661Alpha2: config.countryCode || 'US'
		},
		webInfo: {
			webSubPlatform: proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
		}
	}
}

/** payload for an already-registered device (every reconnect) */
const generateLoginNode = (userJid, config = {}) => {
	const { user, device } = jidDecode(userJid)
	const payload = {
		...getClientPayload(config),
		passive: true,
		pull: true,
		username: +user,
		device: device || 0,
		lidDbMigrated: false
	}
	if (config.pushName) payload.pushName = config.pushName
	return proto.ClientPayload.fromObject(payload)
}

/** payload for the very first (registration) connection */
const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config = {}) => {
	const version = config.version || DEFAULT_VERSION
	// the app version must be md5 hashed and sent as build hash
	const buildHash = crypto.createHash('md5').update(version.join('.')).digest()

	const companion = {
		os: (config.browser || ['tobi'])[0],
		platformType: getPlatformType((config.browser || [])[1]),
		requireFullSync: config.syncFullHistory ?? true,
		historySyncConfig: {
			storageQuotaMb: 10240,
			inlineInitialPayloadInE2EeMsg: true,
			supportCallLogHistory: false,
			supportBotUserAgentChatHistory: true,
			supportCagReactionsAndPolls: true,
			supportBizHostedMsg: true,
			supportRecentSyncChunkMessageCountTuning: true,
			supportHostedGroupMsg: true,
			supportFbidBotChatHistory: true,
			supportMessageAssociation: true,
			supportGroupHistory: false
		},
		version: { primary: 10, secondary: 15, tertiary: 7 }
	}

	const registerPayload = {
		...getClientPayload(config),
		passive: false,
		pull: false,
		devicePairingData: {
			buildHash,
			deviceProps: proto.DeviceProps.encode(companion).finish(),
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}
	return proto.ClientPayload.fromObject(registerPayload)
}

/**
 * The 8 character pairing code shown to the user.
 * Wrapped the way WhatsApp expects: salt(32) | iv(16) | AES-CTR(ephemeral pub).
 */
const generatePairingKey = async (pairingCode, pairingEphemeralKeyPair) => {
	const salt = randomBytes(32)
	const iv = randomBytes(16)
	const key = await derivePairingCodeKey(pairingCode, salt)
	const ciphered = aesEncryptCTR(pairingEphemeralKeyPair.public, key, iv)
	return Buffer.concat([salt, iv, ciphered])
}

/** the `link_code_companion_reg` iq that triggers the phone notification */
const generatePairingNode = async (creds, config = {}, pairingCode) => {
	const browser = config.browser || ['tobi', 'Chrome', '1.0.0']
	const { user } = jidDecode(creds.me.id)
	return {
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageID(), xmlns: 'md' },
		content: [
			{
				tag: 'link_code_companion_reg',
				attrs: {
					jid: creds.me.id,
					stage: 'companion_hello',
					should_show_push_notification: 'true'
				},
				content: [
					{
						tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
						attrs: {},
						content: await generatePairingKey(pairingCode, creds.pairingEphemeralKeyPair)
					},
					{ tag: 'companion_server_auth_key_pub', attrs: {}, content: creds.noiseKey.public },
					{ tag: 'companion_platform_id', attrs: {}, content: getCompanionPlatformId(browser) },
					{ tag: 'companion_platform_display', attrs: {}, content: makeBrowserString(browser) },
					{ tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
				]
			}
		]
	}
}

/**
 * The string that goes into the QR code: 4 comma separated values
 * (ref, noise public key, identity public key, adv secret key) - base64 encoded.
 */
const buildPairingQRData = (ref, noiseKeyB64, identityKeyB64, advB64, browser) =>
	[ref, noiseKeyB64, identityKeyB64, advB64].join(',')

module.exports = {
	derivePairingCodeKey,
	getPlatformType,
	getClientPayload,
	generateLoginNode,
	generateRegistrationNode,
	generatePairingKey,
	generatePairingNode,
	buildPairingQRData,
	toBase64
}
