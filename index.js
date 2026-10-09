'use strict'
/**
 * tobi - a from-scratch WhatsApp multi-device Web library.
 *
 * Public API:
 *   makeWASocket({ auth })            create a socket
 *   useMultiFileAuthState(folder)     file backed credentials
 *   DisconnectReason, proto, Browsers, ...
 *   message builders: text, image, video, buttons, list, ...
 */
const { makeWASocket, TobiSocket } = require('./lib/Socket')
const { useMultiFileAuthState } = require('./lib/Signal/store')
const { initAuthCreds, signedKeyPair, configureSuccessfulPairing, generateRegistrationId } = require('./lib/Utils/auth-utils')
const generics = require('./lib/Utils/generics')
const messages = require('./lib/Utils/messages')
const mediaUpload = require('./lib/Utils/media-upload')
const crypto = require('./lib/Utils/crypto')
const { Logger, LEVELS } = require('./lib/Utils/logger')
const { proto } = require('./lib/Proto')
const defaults = require('./lib/Defaults')
const WABinary = require('./lib/WABinary')
const Signal = require('./lib/Signal')
const { getUSyncDevices } = require('./lib/Socket/usync')

module.exports = {
	// core
	makeWASocket,
	TobiSocket,
	useMultiFileAuthState,

	// credentials
	initAuthCreds,
	signedKeyPair,
	generateRegistrationId,
	configureSuccessfulPairing,

	// message builders
	...messages,

	// media
	prepareWAMessageMedia: mediaUpload.prepareWAMessageMedia,
	downloadMediaMessage: mediaUpload.downloadMediaMessage,
	encryptMediaBuffer: mediaUpload.encryptMediaBuffer,
	encryptMediaStream: mediaUpload.encryptMediaStream,
	decryptMediaBuffer: mediaUpload.decryptMediaBuffer,
	getMediaKeys: mediaUpload.getMediaKeys,
	getMediaType: mediaUpload.getMediaType,

	// utils
	...generics,
	crypto,
	Logger,
	LEVELS,
	getUSyncDevices,

	// protocol
	proto,
	WABinary,
	Signal,
	...defaults,

	// constants people reach for
	DisconnectReason: defaults.DisconnectReason,
	Browsers: defaults.Browsers,
	DEFAULT_CONNECTION_CONFIG: defaults.DEFAULT_CONNECTION_CONFIG,

	// aliases matching the wider ecosystem so migration is easy
	useMultiFileAuthStateLegacy: useMultiFileAuthState
}
