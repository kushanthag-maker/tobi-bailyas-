'use strict'
/**
 * tobi - pre-key manager.
 *
 * WhatsApp requires the client to keep a pool of one-time pre-keys on the
 * server. This module generates them, stores them locally and uploads them
 * through the `encrypt` iq (xmlns="encrypt").
 */
const { generatePreKeys, generateSignedPreKey, keyhelper } = require('../Signal/curve')
const { proto } = require('../Proto')
const { encodeBigEndian, generateMessageID } = require('./generics')
const { KEY_BUNDLE_TYPE, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, S_WHATSAPP_NET } = require('../Defaults')

const PRE_KEY_BATCH = 30

/** create `count` pre-keys starting at creds.nextPreKeyId and persist them */
const initPreKeys = async (creds, keys, count = PRE_KEY_BATCH) => {
	const startId = creds.nextPreKeyId
	const preKeys = generatePreKeys(startId, count)

	const toStore = {}
	for (const key of preKeys) {
		toStore[String(key.keyId)] = { public: key.keyPair.public, private: key.keyPair.private }
	}
	await keys.set({ 'pre-key': toStore })

	creds.nextPreKeyId += count
	return preKeys
}

/** the `encrypt` iq that publishes our key bundle */
const buildPreKeyUploadNode = (creds, preKeys) => ({
	tag: 'iq',
	attrs: {
		to: S_WHATSAPP_NET,
		type: 'set',
		xmlns: 'encrypt',
		id: generateMessageID()
	},
	content: [
		{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId, 4) },
		{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
		{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
		{
			tag: 'list',
			attrs: {},
			content: preKeys.map((key) => ({
				tag: 'key',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
					{ tag: 'value', attrs: {}, content: key.keyPair.public }
				]
			}))
		},
		{
			tag: 'skey',
			attrs: {},
			content: [
				{ tag: 'id', attrs: {}, content: encodeBigEndian(creds.signedPreKey.keyId, 3) },
				{ tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
				{ tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
			]
		}
	]
})

/** rotate the signed pre-key (weekly on WhatsApp Web) */
const rotateSignedPreKey = async (creds, keys) => {
	const newId = creds.signedPreKey.keyId + 1
	const signed = generateSignedPreKey(creds.signedIdentityKey, newId)
	creds.signedPreKey = signed
	await keys.set({
		'signed-pre-key': {
			[String(newId)]: { public: signed.keyPair.public, private: signed.keyPair.private, signature: signed.signature }
		}
	})
	return signed
}

/** upload a fresh batch of pre-keys */
const uploadPreKeys = async (socket, count = PRE_KEY_BATCH) => {
	const { creds, keys } = socket.authState
	const preKeys = await initPreKeys(creds, keys, count)
	const node = buildPreKeyUploadNode(creds, preKeys)
	const result = await socket.query(node)
	socket.logger?.debug?.(`uploaded ${count} pre-keys`)
	await socket.saveCreds()
	return result
}

/** check the server's count and top the pool up when needed */
const uploadPreKeysToServerIfRequired = async (socket) => {
	try {
		const count = await socket.getAvailablePreKeys()
		socket.logger?.debug?.(`server reports ${count} available pre-keys`)
		if (count < MIN_PREKEY_COUNT) await uploadPreKeys(socket)
	} catch (err) {
		socket.logger?.warn?.(`could not refresh pre-keys: ${err.message}`)
	}
}

module.exports = {
	initPreKeys,
	buildPreKeyUploadNode,
	rotateSignedPreKey,
	uploadPreKeys,
	uploadPreKeysToServerIfRequired,
	PRE_KEY_BATCH
}
