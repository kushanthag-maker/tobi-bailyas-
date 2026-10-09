'use strict'
/**
 * tobi - the Signal repository.
 *
 * Implements the store contract that libsignal calls into (pre-keys, signed
 * pre-keys, sessions, identity keys, our own identity) on top of `state.keys`,
 * and exposes the "encrypt this protobuf for this device" helpers the send
 * pipeline needs.
 *
 * Group messages are encrypted per participant device - a valid strategy that
 * always works. Sender-key ("skmsg") encryption is used automatically when the
 * installed Signal backend provides GroupCipher support.
 */
const {
	Curve,
	SessionBuilder,
	SessionCipher,
	GroupCipher,
	GroupSessionBuilder,
	SignalProtocolAddress,
	toSignalKeyPair,
	toBuf,
	withCurvePrefix,
	hasGroupSupport
} = require('./curve')
const { proto } = require('../Proto')
const { jidDecode, jidEncode } = require('../Utils/generics')
const { randomBytes } = require('../Utils/crypto')

const SESSIONS = 'session'
const PRE_KEYS = 'pre-key'
const SIGNED_PRE_KEYS = 'signed-pre-key'
const IDENTITY_KEYS = 'identity-key'
const SENDER_KEYS = 'sender-key'

class SignalRepository {
	constructor({ creds, keys, logger }) {
		this.creds = creds
		this.keys = keys
		this.logger = logger
		this.locks = new Map()
		this.canUseSenderKeys = !!hasGroupSupport
	}

	/** serialise work per jid so concurrent sends cannot corrupt a session */
	async withLock(key, fn) {
		const previous = this.locks.get(key) || Promise.resolve()
		let release
		const current = new Promise((resolve) => (release = resolve))
		this.locks.set(
			key,
			previous.then(() => current)
		)
		await previous
		try {
			return await fn()
		} finally {
			release()
			if (this.locks.get(key) === current) this.locks.delete(key)
		}
	}

	addressFor(jid) {
		const { user, server, device } = jidDecode(jid) || {}
		return new SignalProtocolAddress(`${user}@${server}`, device || 0)
	}

	/* ------------------------------------------------------------------ *
	 * 1:1 messaging
	 * ------------------------------------------------------------------ */

	/** X3DH: build an outgoing session from a device's pre-key bundle */
	async createSession(jid, { identityKey, signedPreKey, preKey, registrationId }) {
		const address = this.addressFor(jid)
		await this.withLock(`session-${jid}`, async () => {
			const builder = new SessionBuilder(this, address)
			const theirIdentity = toBuf(identityKey)
			const theirSignedPubKey = withCurvePrefix(signedPreKey.publicKey)

			if (typeof builder.initSession === 'function') {
				// libsignal 1.x signature
				await builder.initSession(
					true, // isInitiator
					undefined, // our ephemeral (generated internally)
					undefined, // our signed key
					theirIdentity,
					preKey ? withCurvePrefix(preKey.publicKey) : undefined,
					theirSignedPubKey,
					registrationId || 0
				)
			} else {
				// libsignal-protocol / libsignal-node style signature
				await builder.initOutgoing(
					{
						registrationId: registrationId || 0,
						identityKey: theirIdentity,
						signedPreKey: {
							keyId: signedPreKey.keyId,
							publicKey: theirSignedPubKey,
							signature: toBuf(signedPreKey.signature)
						},
						...(preKey ? { preKey: { keyId: preKey.keyId, publicKey: withCurvePrefix(preKey.publicKey) } } : {})
					},
					theirIdentity
				)
			}
		})
		return true
	}

	/** decrypt an incoming 1:1 payload */
	async decryptMessage(jid, { type, ciphertext }) {
		const address = this.addressFor(jid)
		const cipher = new SessionCipher(this, address)
		const data = toBuf(ciphertext)
		let plaintext
		if (type === 'pkmsg' || type === 'prekey') {
			plaintext = await cipher.decryptPreKeyWhisperMessage(data)
		} else {
			plaintext = await cipher.decryptWhisperMessage(data)
		}
		return toBuf(plaintext)
	}

	/** encrypt a protobuf for one specific device */
	async encryptMessage(jid, plaintext) {
		const address = this.addressFor(jid)
		return this.withLock(`session-${jid}`, async () => {
			const cipher = new SessionCipher(this, address)
			const hasSession = await this.containsSession(address)
			const result = await cipher.encrypt(plaintext)
			// 3 = PreKeyWhisperMessage, 2 = WhisperMessage
			const isPreKey = result.type === 3
			return { type: hasSession && !isPreKey ? 'msg' : isPreKey ? 'pkmsg' : 'msg', ciphertext: toBuf(result.body) }
		})
	}

	/* ------------------------------------------------------------------ *
	 * group messaging (sender keys when the backend supports them)
	 * ------------------------------------------------------------------ */

	senderKeyName(groupJid) {
		return `${groupJid}::tobi`
	}

	async createSenderKeyDistribution(groupJid) {
		if (!hasGroupSupport) return null
		const name = this.senderKeyName(groupJid)
		const builder = new GroupSessionBuilder(this)
		return builder.create(name)
	}

	async encryptGroupMessage(groupJid, plaintext) {
		const name = this.senderKeyName(groupJid)
		const cipher = new GroupCipher(this, name)
		return toBuf(await cipher.encrypt(toBuf(plaintext)))
	}

	async decryptGroupMessage(groupJid, ciphertext) {
		const name = this.senderKeyName(groupJid)
		const cipher = new GroupCipher(this, name)
		return toBuf(await cipher.decrypt(toBuf(ciphertext)))
	}

	async processSenderKeyDistributionMessage(groupJid, skdm) {
		if (!hasGroupSupport) return
		const name = this.senderKeyName(groupJid)
		const builder = new GroupSessionBuilder(this)
		await builder.process(name, skdm)
	}

	/* ------------------------------------------------------------------ *
	 * libsignal store contract
	 * ------------------------------------------------------------------ */

	async loadSession(address) {
		const key = address.toString()
		const stored = await this.keys.get(SESSIONS, [key])
		return stored[key] || undefined
	}

	async storeSession(address, record) {
		await this.keys.set({ [SESSIONS]: { [address.toString()]: record } })
	}

	async containsSession(address) {
		return !!(await this.loadSession(address))
	}

	async deleteSession(address) {
		await this.keys.set({ [SESSIONS]: { [address.toString()]: null } })
	}

	async deleteAllSessions(jid) {
		const { user, server } = jidDecode(jid) || {}
		await this.keys.set({ [SESSIONS]: { [`${user}@${server}`]: null } })
	}

	async loadPreKey(keyId) {
		const stored = await this.keys.get(PRE_KEYS, [String(keyId)])
		const record = stored[String(keyId)]
		if (!record) return undefined
		return { privKey: toBuf(record.private || record.privKey), pubKey: toBuf(record.public || record.pubKey) }
	}

	async storePreKey(keyId, keyPair) {
		await this.keys.set({
			[PRE_KEYS]: { [String(keyId)]: { private: toBuf(keyPair.privKey), public: toBuf(keyPair.pubKey) } }
		})
	}

	async removePreKey(keyId) {
		await this.keys.set({ [PRE_KEYS]: { [String(keyId)]: null } })
	}

	async loadSignedPreKey(keyId) {
		const stored = await this.keys.get(SIGNED_PRE_KEYS, [String(keyId)])
		const record = stored[String(keyId)]
		if (!record) return undefined
		return {
			privKey: toBuf(record.private),
			pubKey: toBuf(record.public),
			signature: record.signature ? toBuf(record.signature) : undefined
		}
	}

	async storeSignedPreKey(keyId, record) {
		await this.keys.set({
			[SIGNED_PRE_KEYS]: {
				[String(keyId)]: {
					private: toBuf(record.privKey || record.private),
					public: toBuf(record.pubKey || record.public),
					signature: record.signature ? toBuf(record.signature) : undefined
				}
			}
		})
	}

	/** our own registration id (asked for by SessionCipher) */
	async getOurRegistrationId() {
		return this.creds.registrationId
	}

	/** our own identity key pair, in libsignal's key shape */
	async getOurIdentity() {
		return toSignalKeyPair(this.creds.signedIdentityKey)
	}

	/** identity key of a contact (per jid, device independent) */
	async loadIdentityKey(address) {
		const jid = typeof address === 'string' ? address : address.toString()
		const { user, server } = jidDecode(jid) || {}
		const key = jidEncode(user, server)
		const stored = await this.keys.get(IDENTITY_KEYS, [key])
		return stored[key]
	}

	async saveIdentity(address, identityKey) {
		const jid = typeof address === 'string' ? address : address.toString()
		const { user, server } = jidDecode(jid) || {}
		const key = jidEncode(user, server)
		await this.keys.set({ [IDENTITY_KEYS]: { [key]: toBuf(identityKey) } })
	}

	async isTrustedIdentity(address, identityKey) {
		const jid = typeof address === 'string' ? address : address.toString()
		const existing = await this.loadIdentityKey(jid)
		if (!existing) return true
		return toBuf(existing).equals(toBuf(identityKey))
	}

	/* sender key store (used by GroupCipher when available) */
	async loadSenderKeyRecord(name) {
		const stored = await this.keys.get(SENDER_KEYS, [name])
		return stored[name] || undefined
	}

	async storeSenderKeyRecord(name, record) {
		await this.keys.set({ [SENDER_KEYS]: { [name]: record } })
	}

	async loadSenderKey(groupJid) {
		return this.loadSenderKeyRecord(this.senderKeyName(groupJid))
	}

	async storeSenderKey(groupJid, record) {
		return this.storeSenderKeyRecord(this.senderKeyName(groupJid), record)
	}

	/** generate a random sender key id (kept for completeness) */
	generateSenderKeyId() {
		return randomBytes(4).readUInt32BE(0)
	}
}

module.exports = { SignalRepository }
