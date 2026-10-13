'use strict'
/**
 * tobi - MongoDB backed authentication state.
 *
 * `useMongoAuthState(uri)` is a drop-in replacement for
 * `useMultiFileAuthState(folder)`: it returns the exact same
 * `{ state: { creds, keys }, saveCreds }` shape, so a socket created with it
 * survives restarts, redeploys and multiple processes - which is what you want
 * on a server (the file store is meant for local development only).
 *
 * Buffers are persisted with the same BufferJSON replacer/reviver the file
 * store uses, so credentials written by one store can be read by the other.
 *
 *   const { state, saveCreds } = await useMongoAuthState(process.env.MONGODB_URI)
 *   const sock = makeWASocket({ auth: state })
 *   sock.ev.on('creds.update', saveCreds)
 */
const { initAuthCreds } = require('../Utils/auth-utils')
const { BufferJSON } = require('./buffer-json')

const CREDS_ID = 'me'

const jsonClone = (obj) => JSON.parse(JSON.stringify(obj))

/** `mongodb` is optional, so it is loaded on demand with a helpful error */
const loadMongo = () => {
	try {
		return require('mongodb')
	} catch (err) {
		throw new Error("useMongoAuthState needs the 'mongodb' package - run: npm install mongodb")
	}
}

const useMongoAuthState = async (uri, opts = {}) => {
	if (!uri) throw new Error('useMongoAuthState: a MongoDB connection string is required')

	const { MongoClient } = loadMongo()
	const dbName = opts.dbName || 'tobi_baileys'
	const collectionName = opts.collection || 'auth'

	const ownsClient = !opts.client
	const client = opts.client || new MongoClient(uri, { serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS || 15000 })
	if (ownsClient) await client.connect()

	const col = client.db(dbName).collection(collectionName)
	// one document per key, so concurrent writers never clobber each other
	await col.createIndex({ type: 1, id: 1 }).catch(() => {})

	const read = async (type, id) => {
		const doc = await col.findOne({ _id: `${type}:${id}` })
		if (!doc || doc.value === undefined || doc.value === null) return null
		// revive Buffers ({ type: 'Buffer', data: [...] } -> Buffer)
		return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver)
	}

	const write = async (type, id, value) => {
		await col.updateOne(
			{ _id: `${type}:${id}` },
			{ $set: { type, id, value: jsonClone(JSON.parse(JSON.stringify(value, BufferJSON.replacer))), updatedAt: new Date() } },
			{ upsert: true }
		)
	}

	let creds = await read('creds', CREDS_ID)
	if (!creds) {
		// initAuthCreds() returns REAL Buffers - keep them as they are (a
		// JSON clone would turn them into { type: 'Buffer', data: [...] } and
		// break every Curve call that expects a Buffer)
		creds = initAuthCreds()
		await write('creds', CREDS_ID, creds)
	}

	const saveCreds = async () => write('creds', CREDS_ID, creds)

	const keys = {
		async get(type, ids) {
			const result = {}
			for (const id of ids) {
				const value = await read(type, id)
				if (value !== null && value !== undefined) result[id] = value
			}
			return result
		},
		async set(data) {
			for (const type of Object.keys(data)) {
				const bucket = data[type] || {}
				for (const id of Object.keys(bucket)) await write(type, id, bucket[id])
			}
		},
		/** wipe this account's keys (creds included) - useful for tests */
		async clear() {
			await col.deleteMany({})
		}
	}

	return {
		state: { creds, keys },
		saveCreds,
		close: () => (ownsClient ? client.close() : Promise.resolve())
	}
}

module.exports = { useMongoAuthState }
