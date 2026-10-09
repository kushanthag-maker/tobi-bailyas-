'use strict'
/**
 * tobi - file backed authentication state.
 *
 * `useMultiFileAuthState(folder)` gives you `{ state, saveCreds }` where
 * `state.creds` holds the account credentials and `state.keys` is the Signal
 * key store (pre-keys, sessions, sender keys, ...). Every mutation is written
 * to disk immediately so a restart resumes the same session.
 *
 * NOTE: for production workloads you usually want a database backed store; the
 * interface is intentionally tiny (`get` / `set`) so it is easy to swap out.
 */
const fs = require('fs')
const path = require('path')
const { initAuthCreds } = require('../Utils/auth-utils')

/** buffers inside the creds object are stored as { type: 'Buffer', data: [...] } */
const jsonClone = (obj) => JSON.parse(JSON.stringify(obj))

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch {
		return null
	}
}

const writeJson = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(data, null, '\t'))
}

const useMultiFileAuthState = async (folder) => {
	fs.mkdirSync(folder, { recursive: true })

	const credsFile = path.join(folder, 'creds.json')
	let creds = readJson(credsFile)
	if (!creds) {
		creds = jsonClone(initAuthCreds())
		writeJson(credsFile, creds)
	}
	// creds hold Buffers; revive them once
	const { BufferJSON } = require('./buffer-json')
	creds = JSON.parse(JSON.stringify(creds), BufferJSON.reviver)

	const saveCreds = async () => {
		writeJson(credsFile, JSON.parse(JSON.stringify(creds, BufferJSON.replacer)))
	}

	const fileFor = (type, id) => {
		const safeId = String(id).replace(/\//g, '__').replace(/:/g, '-')
		return path.join(folder, `${type}-${safeId}.json`)
	}

	const keys = {
		async get(type, ids) {
			const result = {}
			for (const id of ids) {
				const data = readJson(fileFor(type, id))
				if (data !== null && data !== undefined) {
					result[id] = JSON.parse(JSON.stringify(data), BufferJSON.reviver)
				}
			}
			return result
		},
		async set(data) {
			for (const type of Object.keys(data)) {
				const entries = data[type] || {}
				for (const id of Object.keys(entries)) {
					const value = entries[id]
					if (value === null || value === undefined) {
						try {
							fs.unlinkSync(fileFor(type, id))
						} catch {
							/* already gone */
						}
					} else {
						writeJson(fileFor(type, id), JSON.parse(JSON.stringify(value, BufferJSON.replacer)))
					}
				}
			}
		},
		async clear() {
			for (const file of fs.readdirSync(folder)) {
				if (file !== 'creds.json' && file.endsWith('.json')) {
					try {
						fs.unlinkSync(path.join(folder, file))
					} catch {
						/* ignore */
					}
				}
			}
		}
	}

	return {
		state: { creds, keys },
		saveCreds,
		/** wipe everything (used on logout) */
		deleteState: async () => {
			for (const file of fs.readdirSync(folder)) {
				try {
					fs.unlinkSync(path.join(folder, file))
				} catch {
					/* ignore */
				}
			}
		}
	}
}

module.exports = { useMultiFileAuthState }
