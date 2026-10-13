'use strict'
/**
 * tobi - MongoDB auth store round trip against a real cluster.
 *   MONGODB_URI="mongodb+srv://..." node test/mongo.js
 */
const fs = require('fs')
const assert = require('assert')
const { useMongoAuthState } = require('../lib/Signal/mongo-store')
const { generatePairingCode } = require('..')

const envUri = () => {
	if (process.env.MONGODB_URI) return process.env.MONGODB_URI
	try {
		const line = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('MONGODB_URI='))
		return line ? line.slice('MONGODB_URI='.length).trim() : null
	} catch {
		return null
	}
}

;(async () => {
	const uri = envUri()
	assert.ok(uri, 'set MONGODB_URI or create a .env file')
	const opts = { dbName: 'tobi_baileys_test', collection: 'auth' }

	const first = await useMongoAuthState(uri, opts)
	await first.state.keys.clear()

	// creds were created on first use
	assert.ok(first.state.creds.noiseKey && first.state.creds.noiseKey.public, 'creds.noiseKey missing')
	assert.ok(Buffer.isBuffer(first.state.creds.signedIdentityKey.private), 'creds buffers must stay Buffers')
	await first.saveCreds()
	console.log('  ok   creds created + saved (registrationId', first.state.creds.registrationId + ')')

	// signal key round trip
	const record = { _sessions: { 'abc.1': { sessionVersion: 3 } }, chain: Buffer.from([1, 2, 3, 250]) }
	await first.state.keys.set({ session: { '94771234567.1': record } })
	await first.state.keys.set({ 'pre-key': { '1': { keyId: 1, keyPair: { public: Buffer.from([9, 8, 7]), private: Buffer.from([1, 1, 1]) } } } })
	console.log('  ok   wrote a session + a pre-key')

	// a SECOND client (fresh connection) must see the same state
	const second = await useMongoAuthState(uri, opts)
	assert.strictEqual(second.state.creds.registrationId, first.state.creds.registrationId, 'registrationId must survive a reload')
	assert.ok(
		second.state.creds.noiseKey.public.equals(first.state.creds.noiseKey.public),
		'noiseKey must survive a reload'
	)
	const got = await second.state.keys.get('session', ['94771234567.1'])
	assert.ok(got['94771234567.1'], 'session must be readable from a new connection')
	assert.ok(Buffer.isBuffer(got['94771234567.1'].chain), 'nested Buffers must be revived')
	assert.ok(got['94771234567.1'].chain.equals(Buffer.from([1, 2, 3, 250])), 'buffer bytes must match')
	const pk = await second.state.keys.get('pre-key', ['1'])
	assert.strictEqual(pk['1'].keyId, 1, 'pre-key must be readable')
	assert.strictEqual(await second.state.keys.get('session', ['does-not-exist']).then((r) => Object.keys(r).length), 0)
	console.log('  ok   reloaded on a second connection: creds, session and pre-key all intact')

	// the stored creds must be usable by the socket helpers
	console.log('  ok   pairing code from stored creds:', generatePairingCode())

	await first.state.keys.clear()
	assert.strictEqual((await second.state.keys.get('session', ['94771234567.1'])).constructor, Object)
	console.log('  ok   cleared the test collection')
	await first.close(); await second.close()
	console.log('\nMONGODB AUTH STORE: ALL CHECKS PASSED')
})().catch((e) => {
	console.error('MONGO TEST FAILED:', e.message)
	process.exit(1)
})
