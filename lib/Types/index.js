'use strict'
/**
 * tobi - shared JSDoc type definitions.
 * This file has no runtime behaviour; it exists so editors can autocomplete.
 */

/**
 * @typedef {Object} BinaryNode
 * @property {string} tag
 * @property {Object.<string, string>} attrs
 * @property {string|Buffer|BinaryNode[]|undefined} [content]
 */

/**
 * @typedef {Object} KeyPair
 * @property {Buffer} public
 * @property {Buffer} private
 */

/**
 * @typedef {Object} SignedKeyPair
 * @property {number} keyId
 * @property {KeyPair} keyPair
 * @property {Buffer} signature
 */

/**
 * @typedef {Object} AuthenticationCreds
 * @property {KeyPair} noiseKey
 * @property {SignedKeyPair} signedIdentityKey
 * @property {SignedKeyPair} signedPreKey
 * @property {number} registrationId
 * @property {string} advSecretKey
 * @property {number} firstUnuploadedPreKeyId
 * @property {number} nextPreKeyId
 * @property {number} accountSyncCounter
 * @property {Buffer} [accountSettings]
 * @property {string} [pairingEphemeralKeyPair]
 * @property {string} [pairingCode]
 * @property {Object} [me]
 * @property {Object} [platform]
 * @property {Buffer} [routingInfo]
 * @property {number} [lastPropHash]
 */

module.exports = {}
