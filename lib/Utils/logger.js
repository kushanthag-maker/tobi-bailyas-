'use strict'
/**
 * tobi - tiny dependency free logger.
 * Levels: trace < debug < info < warn < error < silent
 */
const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, silent: 5 }

const COLORS = {
	trace: '\x1b[90m',
	debug: '\x1b[36m',
	info: '\x1b[32m',
	warn: '\x1b[33m',
	error: '\x1b[31m',
	reset: '\x1b[0m'
}

class Logger {
	constructor(level = 'warn', bindings = {}, color = true) {
		this.level = level
		this.bindings = bindings
		this.color = color
	}

	child(bindings = {}) {
		return new Logger(this.level, { ...this.bindings, ...bindings }, this.color)
	}

	setLevel(level) {
		this.level = level
	}

	shouldLog(level) {
		return LEVELS[level] >= LEVELS[this.level]
	}

	log(level, ...args) {
		if (!this.shouldLog(level)) return
		const scope = Object.entries(this.bindings)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')
		const label = scope ? `[tobi:${scope}]` : '[tobi]'
		const prefix = this.color ? `${COLORS[level]}${label} ${level.toUpperCase()}${COLORS.reset}` : `${label} ${level.toUpperCase()}`
		// eslint-disable-next-line no-console
		console[level === 'trace' || level === 'debug' ? 'log' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](prefix, ...args)
	}

	trace(...args) {
		this.log('trace', ...args)
	}

	debug(...args) {
		this.log('debug', ...args)
	}

	info(...args) {
		this.log('info', ...args)
	}

	warn(...args) {
		this.log('warn', ...args)
	}

	error(...args) {
		this.log('error', ...args)
	}
}

module.exports = { Logger, LEVELS }
