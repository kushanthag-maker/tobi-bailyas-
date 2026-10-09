'use strict'
/** JSON <-> Buffer helpers, needed because Buffers do not survive JSON.stringify */

const BufferJSON = {
	replacer: (_key, value) => {
		if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
			return { type: 'Buffer', data: value.data }
		}
		if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
			return { type: 'Buffer', data: Array.from(value) }
		}
		if (value instanceof Map) {
			return { __map: Array.from(value.entries()) }
		}
		return value
	},
	reviver: (_key, value) => {
		if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
			return Buffer.from(value.data)
		}
		if (value && Array.isArray(value.__map)) {
			return new Map(value.__map)
		}
		return value
	}
}

module.exports = { BufferJSON }
