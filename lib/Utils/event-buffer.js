'use strict'
/**
 * tobi - event buffer.
 *
 * Events that arrive before the connection is fully open (history sync,
 * notifications, presence, ...) are queued here and replayed in order once the
 * socket is ready, so consumers never miss early events or receive them out of
 * order.
 */
const makeEventBuffer = (emitter, { max = 5000 } = {}) => {
	const buffer = new Map()
	let buffering = true
	let flushHandler = null

	/** record an event while buffering is active */
	const bufferEvent = (event, ...args) => {
		if (!buffering) return false
		const existing = buffer.get(event)
		if (existing) {
			if (existing.count >= max) {
				// drop the oldest to stay bounded
				existing.args.shift()
			} else {
				existing.count++
			}
			existing.args.push(args)
		} else {
			buffer.set(event, { args: [args], count: 1 })
		}
		return true
	}

	/** replay everything that was queued, in insertion order per event */
	const flush = () => {
		if (!buffering) return
		buffering = false
		for (const [event, { args }] of buffer) {
			for (const entry of args) {
				if (flushHandler) flushHandler(event, ...entry)
				else emitter.emit(event, ...entry)
			}
		}
		buffer.clear()
	}

	/** register the function used to deliver buffered events */
	const process = (handler) => {
		flushHandler = handler
	}

	return {
		bufferEvent,
		flush,
		process,
		get isBuffering() {
			return buffering
		},
		get size() {
			return buffer.size
		},
		destroy() {
			buffer.clear()
			buffering = false
		}
	}
}

module.exports = { makeEventBuffer }
