'use strict'
/**
 * tobi - defaults and protocol constants.
 *
 * Everything in here is derived from the publicly observable WhatsApp Web
 * multi-device wire format.
 */
const { proto } = require('../Proto')
const { jidEncode } = require('../Utils/generics')

/** WA Web build we announce to the server (client version) */
const DEFAULT_VERSION = [2, 3000, 1043857760]

/** the multi device websocket endpoint */
const WA_WEBSOCKET_URL = 'wss://web.whatsapp.com/ws/chat'
const DEFAULT_ORIGIN = 'https://web.whatsapp.com'

/** Noise handshake pattern used for the transport */
const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
/** prologue: 'WA' + 0x06 (version byte) + dictionary version */
const DICT_VERSION = 3
const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION])
/** byte prepended to the identity public key inside the key bundle */
const KEY_BUNDLE_TYPE = Buffer.from([5])

const WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}

/** prefixes for the ADV (account/device) signatures */
const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])

/** default disappearing-message timeout (7 days) */
const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60
const STATUS_EXPIRY_SECONDS = 24 * 60 * 60

const UNAUTHORIZED_CODES = [401, 403, 419]

const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'

const INITIAL_PREKEY_COUNT = 812
const MIN_PREKEY_COUNT = 5

const UPLOAD_TIMEOUT = 30_000
const DEFAULT_QUERY_TIMEOUT_MS = 60_000
const KEEP_ALIVE_INTERVAL_MS = 30_000
const CONNECT_TIMEOUT_MS = 20_000
const MAX_MSG_RETRY_COUNT = 5

const MEDIA_PATH_MAP = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	sticker: '/mms/image',
	'thumbnail-link': '/mms/image',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state',
	'biz-cover-photo': '/pps/biz-cover-photo'
}

const MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': '',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video',
	'biz-cover-photo': 'Image'
}

const PROCESSABLE_HISTORY_TYPES = [
	proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
	proto.HistorySync.HistorySyncType.PUSH_NAME,
	proto.HistorySync.HistorySyncType.RECENT,
	proto.HistorySync.HistorySyncType.FULL,
	proto.HistorySync.HistorySyncType.ON_DEMAND,
	proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
	proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]

const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60,
	MSG_RETRY: 60 * 60,
	CALL_OFFER: 5 * 60,
	USER_DEVICES: 5 * 60
}

/** disconnect reasons surfaced through `connection.update` */
const DisconnectReason = {
	connectionClosed: 428,
	connectionLost: 408,
	connectionReplaced: 440,
	timedOut: 408,
	loggedOut: 401,
	badSession: 500,
	restartRequired: 515,
	multideviceMismatch: 411,
	forbidden: 403,
	unavailableService: 503
}

/* ------------------------------------------------------------------ *
 * Browser / platform identification
 * ------------------------------------------------------------------ */

const Browsers = {
	ubuntu: (browser) => ['Ubuntu', browser, '22.04.4'],
	macOS: (browser) => ['Mac OS', browser, '14.4.1'],
	baileys: (browser) => ['tobi', browser, '1.0.0'],
	windows: (browser) => ['Windows', browser, '10.0.22631'],
	appropriate: (browser) => ['tobi', browser, '1.0.0']
}

const DEFAULT_BROWSER = Browsers.baileys('Chrome')

/** platform ids WhatsApp uses in `companion_platform_id` */
const PLATFORM_IDS = {
	Chrome: 1,
	Edge: 2,
	Firefox: 3,
	Opera: 4,
	Safari: 5,
	'Chrome iOS': 6,
	'Firefox iOS': 7,
	'Safari iOS': 8,
	'Edge iOS': 9,
	'Opera iOS': 10,
	Desktop: 21,
	tobi: 1
}

const getCompanionPlatformId = (browser) => String(PLATFORM_IDS[browser?.[1]] || PLATFORM_IDS[browser?.[0]] || 1)

/** the device properties we announce (name shown inside "Linked devices") */
const makeDeviceProps = (browser = DEFAULT_BROWSER) => ({
	os: browser[0],
	platformType: proto.DeviceProps.PlatformType.CHROME,
	requireFullSync: false,
	historySyncConfig: {
		storageQuotaMb: 10240,
		inlineInitialPayloadInE2EeMsg: true,
		recentSyncDaysLimit: 0,
		supportCallLogHistory: true,
		supportRecentStickerBundles: true,
		supportHatchMigration: true,
		initialSyncDaysLimit: 0,
		inlineInitialPayloadInE2EeMsgOnHistorySync: true,
		supportManusHistory: true,
		supportBatchedHistorySync: true,
		supportMessageAssociation: true,
		supportGroupHistory: true
	},
	appVersion: {
		primary: DEFAULT_VERSION[0],
		secondary: DEFAULT_VERSION[1],
		tertiary: DEFAULT_VERSION[2]
	}
})

/** the browser string WhatsApp shows on the phone when linking */
const makeBrowserString = (browser = DEFAULT_BROWSER) => `${browser[1]} (${browser[0]})`

const DEFAULT_CONNECTION_CONFIG = {
	version: DEFAULT_VERSION,
	browser: DEFAULT_BROWSER,
	waWebSocketUrl: WA_WEBSOCKET_URL,
	connectTimeoutMs: CONNECT_TIMEOUT_MS,
	keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
	defaultQueryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
	maxMsgRetryCount: MAX_MSG_RETRY_COUNT,
	retryRequestDelayMs: 250,
	qrTimeout: 60_000,
	markOnlineOnConnect: true,
	syncFullHistory: true,
	emitOwnEvents: true,
	generateHighQualityLinkPreview: false,
	linkPreviewImageThumbnailWidth: 192,
	countryCode: 'US',
	connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
	connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
	emitOwnEvents: true
}

const S_WHATSAPP_NET = '@s.whatsapp.net'
const OFFICIAL_BIZ_JID = '16505361212@c.us'
const SERVER_JID = 'server@c.us'
const PSA_JID = '0@s.whatsapp.net'
const LID_WHATSAPP_NET = '@lid'
const GROUP_JID = '@g.us'
const NEWSLETTER_JID = '@newsletter'
const BROADCAST_JID = '@broadcast'
const STORIES_JID = 'status@broadcast'

/** WA's default "message is empty" placeholder content */
const DEFAULT_EMPTY_MESSAGE = ''

module.exports = {
	DEFAULT_VERSION,
	WA_WEBSOCKET_URL,
	DEFAULT_ORIGIN,
	NOISE_MODE,
	DICT_VERSION,
	NOISE_WA_HEADER,
	KEY_BUNDLE_TYPE,
	WA_CERT_DETAILS,
	WA_ADV_ACCOUNT_SIG_PREFIX,
	WA_ADV_DEVICE_SIG_PREFIX,
	WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX,
	WA_ADV_HOSTED_DEVICE_SIG_PREFIX,
	WA_DEFAULT_EPHEMERAL,
	STATUS_EXPIRY_SECONDS,
	UNAUTHORIZED_CODES,
	CALL_VIDEO_PREFIX,
	CALL_AUDIO_PREFIX,
	INITIAL_PREKEY_COUNT,
	MIN_PREKEY_COUNT,
	UPLOAD_TIMEOUT,
	DEFAULT_QUERY_TIMEOUT_MS,
	KEEP_ALIVE_INTERVAL_MS,
	CONNECT_TIMEOUT_MS,
	MAX_MSG_RETRY_COUNT,
	MEDIA_PATH_MAP,
	MEDIA_HKDF_KEY_MAPPING,
	PROCESSABLE_HISTORY_TYPES,
	DEFAULT_CACHE_TTLS,
	DisconnectReason,
	Browsers,
	DEFAULT_BROWSER,
	PLATFORM_IDS,
	getCompanionPlatformId,
	makeDeviceProps,
	makeBrowserString,
	DEFAULT_CONNECTION_CONFIG,
	S_WHATSAPP_NET,
	OFFICIAL_BIZ_JID,
	SERVER_JID,
	PSA_JID,
	LID_WHATSAPP_NET,
	GROUP_JID,
	NEWSLETTER_JID,
	BROADCAST_JID,
	STORIES_JID,
	DEFAULT_EMPTY_MESSAGE,
	jidEncode
}
