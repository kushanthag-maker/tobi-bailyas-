'use strict'
/**
 * tobi - Curve / Signal crypto primitives.
 *
 * The Signal Protocol maths (X3DH, Double Ratchet) comes from a standalone
 * Signal implementation. tobi looks for, in order:
 *
 *   1. libsignal-protocol   (exposes `Curve` + GroupCipher directly)
 *   2. libsignal            (exposes `crypto` + `KeyHelper` instead)
 *
 * Because the two builds expose the same primitives under different names, a
 * `Curve`-shaped facade is built here, so the rest of tobi always talks to the
 * same API. Nothing WhatsApp specific lives in this file: key generation,
 * XEdDSA signing, DH, and normalisation between libsignal's `{pubKey, privKey}`
 * and tobi's `{public, private}` key shape.
 */
const CANDIDATES = ['libsignal-protocol', 'libsignal']

const toBuf = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value))

const buildFacade = (mod, name) => {
	const pools = [mod, mod.crypto, mod.default, mod.libsignal].filter(Boolean)
	const pick = (...names) => {
		for (const pool of pools) {
			for (const key of names) {
				if (pool && pool[key]) return pool[key]
			}
		}
		return undefined
	}

	const rawCrypto = pick('crypto')
	const KeyHelper = pick('keyhelper', 'KeyHelper')
	const SessionBuilder = pick('SessionBuilder')
	const SessionCipher = pick('SessionCipher')
	const SignalProtocolAddress = pick('SignalProtocolAddress', 'ProtocolAddress')

	// build 1: a ready made Curve object
	let Curve = pick('Curve')

	// build 2: assemble Curve from crypto + KeyHelper (libsignal@1.x layout)
	if (!Curve && rawCrypto && typeof rawCrypto.calculateAgreement === 'function') {
		Curve = {
			generateKeyPair: () => rawCrypto.generateKeyPair(),
			/** XEdDSA signature used by identity keys */
			sign: (privKey, message) => toBuf(rawCrypto.calculateSignature(privKey, message)),
			calculateSignature: (privKey, message) => toBuf(rawCrypto.calculateSignature(privKey, message)),
			verifySignature: (pubKey, message, sig) => rawCrypto.verifySignature(pubKey, message, sig),
			verify: (pubKey, message, sig) => rawCrypto.verifySignature(pubKey, message, sig),
			calculateAgreement: (pubKey, privKey) => toBuf(rawCrypto.calculateAgreement(pubKey, privKey)),
			sharedKey: (privKey, pubKey) => toBuf(rawCrypto.calculateAgreement(pubKey, privKey)),
			createKeyPair: () => rawCrypto.createKeyPair()
		}
	}

	if (!Curve || !KeyHelper || !SessionBuilder || !SessionCipher || !SignalProtocolAddress) return null

	// normalise the key helper surface
	const helper = {
		generateIdentityKeyPair: () => KeyHelper.generateIdentityKeyPair(),
		generateRegistrationId: () => KeyHelper.generateRegistrationId(),
		generatePreKey: (id) => KeyHelper.generatePreKey(id),
		generatePreKeys: (start, count) => {
			if (typeof KeyHelper.generatePreKeys === 'function') return KeyHelper.generatePreKeys(start, count)
			return Array.from({ length: count }, (_value, index) => KeyHelper.generatePreKey(start + index))
		},
		generateSignedPreKey: (identityKeyPair, id) => KeyHelper.generateSignedPreKey(identityKeyPair, id)
	}

	return {
		impl: mod,
		implName: name,
		Curve,
		keyhelper: helper,
		SessionBuilder,
		SessionCipher,
		SignalProtocolAddress,
		GroupCipher: pick('GroupCipher'),
		GroupSessionBuilder: pick('GroupSessionBuilder')
	}
}

let backend
let lastError

for (const name of CANDIDATES) {
	let mod
	try {
		mod = require(name)
	} catch (err) {
		lastError = err
		continue
	}
	const facade = buildFacade(mod, name)
	if (facade) {
		backend = facade
		break
	}
	lastError = new Error(`"${name}" does not expose the expected Signal API`)
}

if (!backend) {
	throw new Error(
		'tobi: Signal crypto backend missing.\n' +
			'  install one:  npm i libsignal-protocol   (recommended)\n' +
			'            or: npm i libsignal\n' +
			`  (last error: ${lastError?.message})`
	)
}

const { Curve, keyhelper, SessionBuilder, SessionCipher, SignalProtocolAddress, GroupCipher, GroupSessionBuilder } = backend

/** `{public, private}` (tobi) -> `{pubKey, privKey}` (libsignal) */
const toSignalKeyPair = (pair) => {
	if (!pair) return pair
	if (pair.pubKey && pair.privKey) return { pubKey: toBuf(pair.pubKey), privKey: toBuf(pair.privKey) }
	return { pubKey: toBuf(pair.public), privKey: toBuf(pair.private) }
}

/** `{pubKey, privKey}` (libsignal) -> `{public, private}` (tobi) */
const fromSignalKeyPair = (pair) => {
	if (!pair) return pair
	if (pair.public && pair.private) return { public: toBuf(pair.public), private: toBuf(pair.private) }
	return { public: toBuf(pair.pubKey), private: toBuf(pair.privKey) }
}

/** Signal requires public keys to carry the 0x05 curve prefix */
const withCurvePrefix = (key) => {
	const buf = toBuf(key)
	return buf.length === 32 ? Buffer.concat([Buffer.from([5]), buf]) : buf
}

module.exports = {
	impl: backend.impl,
	implName: backend.implName,
	Curve,
	keyhelper,
	SessionBuilder,
	SessionCipher,
	SignalProtocolAddress,
	ProtocolAddress: SignalProtocolAddress,
	GroupCipher,
	GroupSessionBuilder,
	/** does the backend support group (sender key) messaging? */
	hasGroupSupport: !!(GroupCipher && GroupSessionBuilder),
	toBuf,
	toSignalKeyPair,
	fromSignalKeyPair,
	withCurvePrefix,
	/** X25519 key pair in tobi format */
	generateKeyPair: () => fromSignalKeyPair(Curve.generateKeyPair()),
	/** XEdDSA signature (identity keys) */
	sign: (privateKey, message) => toBuf(Curve.sign(privateKey, message)),
	/** Curve25519 signature (pre-keys) */
	calculateSignature: (privateKey, message) => toBuf(Curve.calculateSignature(privateKey, message)),
	verify: (publicKey, message, signature) => Curve.verify(publicKey, message, signature),
	sharedKey: (privateKey, publicKey) => toBuf(Curve.sharedKey(privateKey, publicKey)),
	generateRegistrationId: () => keyhelper.generateRegistrationId(),
	generateIdentityKeyPair: () => fromSignalKeyPair(keyhelper.generateIdentityKeyPair()),
	generatePreKeys: (start, count) =>
		keyhelper.generatePreKeys(start, count).map((key) => ({
			keyId: key.keyId,
			keyPair: fromSignalKeyPair(key.keyPair)
		})),
	generateSignedPreKey: (identityKeyPair, signedPreKeyId) => {
		const signed = keyhelper.generateSignedPreKey(toSignalKeyPair(identityKeyPair), signedPreKeyId)
		return {
			keyId: signed.keyId,
			keyPair: fromSignalKeyPair(signed.keyPair),
			signature: toBuf(signed.signature)
		}
	}
}
