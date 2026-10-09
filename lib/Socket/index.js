'use strict'
/**
 * tobi - the socket: connect, Noise handshake, login/register, pairing (QR +
 * pairing code), send and receive.
 */
const EventEmitter = require('events')
const WebSocket = require('ws')

const { proto } = require('../Proto')
const { makeNoiseHandler } = require('../Utils/noise-handler')
const { Logger } = require('../Utils/logger')
const { jidDecode, jidEncode, jidNormalizedUser, generateMessageIDV2, delay, unixTimestampSeconds, resolvePairingCode, formatPairingCode } = require('../Utils/generics')
const { configureSuccessfulPairing, initAuthCreds, makeDeviceIdentityNode } = require('../Utils/auth-utils')
const { generateLoginNode, generateRegistrationNode, generatePairingNode, buildPairingQRData } = require('../Utils/validate-connection')
const { uploadPreKeys, uploadPreKeysToServerIfRequired, rotateSignedPreKey } = require('../Utils/pre-key-manager')
const { SignalRepository } = require('../Signal/repository')
const { generateKeyPair } = require('../Signal/curve')
const {
	DEFAULT_CONNECTION_CONFIG,
	NOISE_WA_HEADER,
	WA_WEBSOCKET_URL,
	DEFAULT_ORIGIN,
	S_WHATSAPP_NET,
	UNAUTHORIZED_CODES,
	DisconnectReason,
	MIN_PREKEY_COUNT
} = require('../Defaults')
const {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	assertNodeErrorFree,
	encodeBinaryNode,
	decodeBinaryNode
} = require('../WABinary')
const { relayMessage, assertSessions, sendReceipt } = require('./messages-send')
const recv = require('./messages-recv')
const groups = require('./groups')
const { getUSyncDevices, invalidateDeviceCache } = require('./usync')
const { makeEventBuffer } = require('../Utils/event-buffer')
const { generateWAMessageContent, generateWAMessage } = require('../Utils/messages')
const { downloadMediaMessage } = require('../Utils/media-upload')

class TobiSocket extends EventEmitter {
	constructor(config = {}) {
		super()
		this.config = { ...DEFAULT_CONNECTION_CONFIG, ...config }
		this.logger = config.logger || new Logger(config.logLevel || 'warn', { class: 'tobi' })
		this.authState = config.auth
		this.ws = null
		this.noise = null
		this.queryQueue = new Map()
		this.groupCache = new Map()
		this.mediaConn = null
		this.lastDisconnectReason = null
		this.closed = false
		this.connected = false
		this.qrTimer = null
		this.keepAliveTimer = null
		this.reconnectAttempts = 0
		this.firstConnection = true
		this.ev = this // `sock.ev.on(...)` is the same emitter

		// queue events until the connection is open, then replay them in order
		this.eventBuffer = makeEventBuffer(this)
		const rawEmit = this.emit.bind(this)
		this.emit = (event, ...args) => {
			const passthrough = event === 'connection.update' || event === 'creds.update' || event === 'node' || event === 'iq'
			if (!this.connected && !passthrough) {
				this.eventBuffer.bufferEvent(event, ...args)
				return false
			}
			return rawEmit(event, ...args)
		}
		this.eventBuffer.process((event, ...args) => rawEmit(event, ...args))
		this.pairingCode = null
		this.serverTimeOffset = 0
		this.messageRetryCache = new Map()

		if (!this.authState) {
			const creds = initAuthCreds()
			this.authState = { creds, keys: { get: async () => ({}), set: async () => {} } }
			this.logger.warn('no auth state supplied - using an in-memory one (credentials will be lost)')
		}
		this.signalRepository = new SignalRepository({
			creds: this.authState.creds,
			keys: this.authState.keys,
			logger: this.logger
		})
	}

	/* ------------------------------------------------------------------ *
	 * low level io
	 * ------------------------------------------------------------------ */

	async sendNode(node) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tobi: socket is not open')
		const encoded = encodeBinaryNode(node)
		const frame = this.noise.encodeFrame(encoded)
		return new Promise((resolve, reject) => {
			this.ws.send(frame, (err) => (err ? reject(err) : resolve(true)))
		})
	}

	async sendRawFrame(buffer) {
		return new Promise((resolve, reject) => {
			this.ws.send(buffer, (err) => (err ? reject(err) : resolve(true)))
		})
	}

	/** send an iq and resolve with the matching result */
	query(node, timeoutMs = this.config.defaultQueryTimeoutMs) {
		return new Promise((resolve, reject) => {
			if (!node.attrs?.id) node.attrs = { ...(node.attrs || {}), id: generateMessageIDV2() }
			const id = node.attrs.id
			const timer = setTimeout(() => {
				this.queryQueue.delete(id)
				reject(new Error(`tobi: query timed out after ${timeoutMs}ms (${node.tag} ${node.attrs.xmlns || ''})`))
			}, timeoutMs)

			this.queryQueue.set(id, {
				resolve: (result) => {
					clearTimeout(timer)
					this.queryQueue.delete(id)
					resolve(result)
				},
				reject: (err) => {
					clearTimeout(timer)
					this.queryQueue.delete(id)
					reject(err)
				}
			})

			this.sendNode(node).catch((err) => {
				clearTimeout(timer)
				this.queryQueue.delete(id)
				reject(err)
			})
		})
	}

	async saveCreds() {
		this.emit('creds.update', this.authState.creds)
		if (this.authState.saveCreds) await this.authState.saveCreds()
	}

	/* ------------------------------------------------------------------ *
	 * connection
	 * ------------------------------------------------------------------ */

	async connect() {
		if (this.ws) {
			try {
				this.ws.removeAllListeners()
				this.ws.close()
			} catch {
				/* ignore */
			}
		}
		this.closed = false
		this.logger.info('connecting to WhatsApp Web...')
		this.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })

		const url = this.config.waWebSocketUrl || WA_WEBSOCKET_URL
		this.ws = new WebSocket(url, {
			headers: { Origin: DEFAULT_ORIGIN, 'User-Agent': 'tobi' },
			handshakeTimeout: this.config.connectTimeoutMs
		})

		// fresh ephemeral key pair per connection (Noise XX message 1: `-> e`)
		this.handshakeEphemeral = generateKeyPair()
		this.noise = makeNoiseHandler({
			keyPair: this.authState.creds.noiseKey,
			logger: this.logger,
			routingInfo: this.authState.creds.routingInfo
		})

		this.ws.on('open', () => this.onOpen())
		this.ws.on('message', (data) => this.onData(data))
		this.ws.on('error', (err) => this.logger.error(`websocket error: ${err.message}`))
		this.ws.on('close', (code) => this.onClose(code))
		return this
	}

	async onOpen() {
		this.logger.debug('websocket open, sending client hello')
		const helloMsg = {
			clientHello: {
				ephemeral: this.handshakeEphemeral.public,
				payload: Buffer.alloc(0)
			}
		}
		const encoded = proto.HandshakeMessage.encode(helloMsg).finish()
		await this.sendRawFrame(this.noise.encodeFrame(encoded))
	}

	onData(data) {
		try {
			this.noise.decodeFrame(Buffer.from(data), (frame) => {
				// before the transport is up, frames are HandshakeMessages
				if (frame.serverHello) {
					this.onServerHello(frame).catch((err) => this.onFatal(err))
				} else if (frame.tag) {
					this.onNode(frame).catch((err) => this.logger.error(`node handling failed: ${err.message}`))
				}
			})
		} catch (err) {
			this.onFatal(err)
		}
	}

	async onServerHello(handshake) {
		this.logger.debug('server hello received, finishing handshake')
		const keyEnc = this.noise.processHandshake(handshake, this.authState.creds.noiseKey)

		const creds = this.authState.creds
		const isRegistered = !!creds.me?.id

		let clientPayload
		if (isRegistered) {
			clientPayload = generateLoginNode(creds.me.id, this.config)
		} else {
			clientPayload = generateRegistrationNode(
				{
					registrationId: creds.registrationId,
					signedPreKey: creds.signedPreKey,
					signedIdentityKey: creds.signedIdentityKey
				},
				this.config
			)
		}

		const payloadBytes = proto.ClientPayload.encode(clientPayload).finish()
		const encryptedPayload = this.noise.encrypt(payloadBytes)

		const finishMsg = {
			clientFinish: {
				static: keyEnc,
				payload: encryptedPayload
			}
		}
		await this.sendRawFrame(this.noise.encodeFrame(proto.HandshakeMessage.encode(finishMsg).finish()))
		this.noise.finishInit()
		this.logger.debug('transport established')
	}

	onClose(code) {
		this.connected = false
		if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
		if (this.qrTimer) clearTimeout(this.qrTimer)

		const statusCode = this.lastDisconnectReason || code
		this.logger.warn(`connection closed (code ${code})`)
		this.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: new Error(`connection closed: ${code}`), date: new Date(), statusCode }
		})

		const shouldReconnect =
			!this.closed &&
			!UNAUTHORIZED_CODES.includes(statusCode) &&
			statusCode !== DisconnectReason.loggedOut

		if (shouldReconnect) {
			this.reconnectAttempts += 1
			const delayMs = Math.min(1000 * this.reconnectAttempts, 10_000)
			this.logger.info(`reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts})`)
			setTimeout(() => this.connect().catch((err) => this.logger.error(err.message)), delayMs)
		}
	}

	onFatal(err) {
		this.logger.error(err.message)
		try {
			this.ws?.close()
		} catch {
			/* ignore */
		}
		this.emit('connection.update', { connection: 'close', lastDisconnect: { error: err, date: new Date() } })
	}

	/* ------------------------------------------------------------------ *
	 * stanza dispatch
	 * ------------------------------------------------------------------ */

	async onNode(node) {
		// resolve pending queries
		if (node.attrs?.id && this.queryQueue.has(node.attrs.id)) {
			const pending = this.queryQueue.get(node.attrs.id)
			if (node.tag === 'iq') {
				const errorNode = getBinaryNodeChild(node, 'error')
				if (errorNode) pending.reject(new Error(`server error ${errorNode.attrs.code}: ${errorNode.attrs.text}`))
				else pending.resolve(node)
				return
			}
		}

		switch (node.tag) {
			case 'success':
				await this.onSuccess(node)
				return
			case 'failure':
				return this.onFailure(node)
			case 'iq':
				return this.onIq(node)
			case 'message':
				return recv.handleMessageStanza(this, node)
			case 'receipt':
				return recv.handleReceipt(this, node)
			case 'notification':
				return recv.handleNotification(this, node)
			case 'call':
				return recv.handleCall(this, node)
			case 'ib':
				return recv.handleInfoBundle(this, node)
			case 'stream:error':
				return this.onStreamError(node)
			case 'xmlstreamend':
				this.closed = true
				return this.ws?.close()
			default:
				this.emit('node', node)
		}
	}

	async onIq(node) {
		// pairing flows arrive as iq set
		if (node.attrs.type === 'set' && getBinaryNodeChild(node, 'pair-device')) {
			return this.onPairDevice(node)
		}
		if (node.attrs.type === 'set' && getBinaryNodeChild(node, 'pair-success')) {
			return this.onPairSuccess(node)
		}
		// answer "get" iqs so the server does not time out
		if (node.attrs.type === 'get') {
			try {
				await this.sendNode({ tag: 'iq', attrs: { to: node.attrs.from || S_WHATSAPP_NET, type: 'result', id: node.attrs.id } })
			} catch (err) {
				this.logger.debug(`could not answer iq get: ${err.message}`)
			}
		}
		this.emit('iq', node)
	}

	async onStreamError(node) {
		const code = node.attrs?.code
		const text = getBinaryNodeChildString(node, 'text') || 'stream error'
		this.lastDisconnectReason = UNAUTHORIZED_CODES.includes(+code) ? DisconnectReason.loggedOut : +code
		this.logger.error(`stream error ${code}: ${text}`)
		this.closed = true
		this.ws?.close()
	}

	async onFailure(node) {
		const reason = node.attrs?.reason || 'unknown'
		this.logger.error(`login failure: ${reason}`)
		this.lastDisconnectReason = reason === '401' ? DisconnectReason.loggedOut : DisconnectReason.badSession
		this.closed = true
		this.ws?.close()
	}

	async onSuccess(node) {
		this.connected = true
		this.reconnectAttempts = 0
		this.serverTimeOffset = node.attrs?.t ? +node.attrs.t - unixTimestampSeconds() : 0
		this.logger.info('logged in to WhatsApp')

		if (node.attrs?.lid && this.authState.creds.me) {
			this.authState.creds.me.lid = node.attrs.lid
			await this.saveCreds()
		}

		await this.sendInitQueries()
		this.startKeepAlive()

		this.emit('connection.update', { connection: 'open', receivedPendingNotifications: false })
		// replay everything that arrived before we were ready
		this.eventBuffer.flush()
	}

	/** the queries WhatsApp Web fires right after login */
	async sendInitQueries() {
		try {
			await this.sendPassiveIq(this.config.markOnlineOnConnect ? 'active' : 'passive')
		} catch (err) {
			this.logger.warn(`passive iq failed: ${err.message}`)
		}

		if (this.config.markOnlineOnConnect) {
			try {
				await this.sendPresenceUpdate('available')
			} catch (err) {
				this.logger.debug(`presence failed: ${err.message}`)
			}
		}

		try {
			await uploadPreKeysToServerIfRequired(this)
		} catch (err) {
			this.logger.warn(`pre-key upload failed: ${err.message}`)
		}

		try {
			await this.query({
				tag: 'iq',
				attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'digest', id: generateMessageIDV2() },
				content: [{ tag: 'digest', attrs: {} }]
			})
		} catch (err) {
			this.logger.debug(`digest query failed: ${err.message}`)
		}
	}

	startKeepAlive() {
		if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
		this.keepAliveTimer = setInterval(async () => {
			if (!this.connected) return
			try {
				await this.query({
					tag: 'iq',
					attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p', id: generateMessageIDV2() },
					content: [{ tag: 'ping', attrs: {} }]
				})
			} catch (err) {
				this.logger.debug(`keep alive failed: ${err.message}`)
			}
		}, this.config.keepAliveIntervalMs)
		if (this.keepAliveTimer.unref) this.keepAliveTimer.unref()
	}

	async sendPassiveIq(active) {
		return this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'passive', id: generateMessageIDV2() },
			content: [{ tag: active, attrs: {} }]
		})
	}

	async sendPresenceUpdate(type, toJid) {
		const node = {
			tag: 'presence',
			attrs: { name: this.authState.creds.me?.name || 'tobi', type }
		}
		if (toJid) node.attrs.to = toJid
		return this.sendNode(node)
	}

	/* ------------------------------------------------------------------ *
	 * pairing
	 * ------------------------------------------------------------------ */

	/** QR pairing: the server pushes <pair-device><ref>..</ref></pair-device> */
	async onPairDevice(node) {
		// ack
		await this.sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: node.attrs.id } })

		const pairDeviceNode = getBinaryNodeChild(node, 'pair-device')
		const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
		const creds = this.authState.creds
		const noiseKeyB64 = creds.noiseKey.public.toString('base64')
		const identityKeyB64 = creds.signedIdentityKey.public.toString('base64')
		const advB64 = creds.advSecretKey

		let qrMs = this.config.qrTimeout || 60_000
		const genPairQR = async () => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
			const refNode = refNodes.shift()
			if (!refNode) {
				this.lastDisconnectReason = DisconnectReason.timedOut
				return this.ws.close()
			}
			const ref = Buffer.isBuffer(refNode.content) ? refNode.content.toString('utf8') : String(refNode.content)
			const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, this.config.browser)
			this.emit('connection.update', { qr })
			if (this.config.printQRInTerminal) {
				try {
					// eslint-disable-next-line global-require
					require('qrcode-terminal').generate(qr, { small: true })
				} catch {
					this.logger.info(`QR string: ${qr}`)
				}
			}
			this.qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = 20_000
			if (this.qrTimer.unref) this.qrTimer.unref()
		}
		await genPairQR()
	}

	/** the phone confirmed the link */
	async onPairSuccess(node) {
		this.logger.info('pair success received')
		try {
			const pairSuccessNode = getBinaryNodeChild(node, 'pair-success')
			const { creds, reply } = configureSuccessfulPairing(pairSuccessNode, this.authState.creds)
			this.authState.creds = creds
			this.signalRepository.creds = creds
			await this.saveCreds()
			await this.sendNode(reply)
			this.emit('connection.update', { isNewLogin: true, qr: undefined })
			// the server always asks for a reconnect after pairing
			this.lastDisconnectReason = DisconnectReason.restartRequired
			setTimeout(() => this.ws?.close(), 500)
		} catch (err) {
			this.logger.error(`pairing failed: ${err.message}`)
			this.onFatal(err)
		}
	}

	/**
	 * Pairing code login.
	 * @param {string} phoneNumber E.164 without the leading +
	 * @param {string} [customCode] your own 8 character code (optional)
	 * @returns {Promise<string>} the 8 character code to type on the phone
	 */
	async requestPairingCode(phoneNumber, customCode) {
		if (!phoneNumber) throw new Error('tobi: phoneNumber is required (E.164 without +)')
		const cleaned = String(phoneNumber).replace(/[^0-9]/g, '')
		const code = resolvePairingCode(customCode)

		const creds = this.authState.creds
		creds.pairingCode = code
		creds.me = { id: jidEncode(cleaned, 's.whatsapp.net'), name: '~' }
		await this.saveCreds()

		const node = await generatePairingNode(creds, this.config, code)
		await this.sendNode(node)

		this.pairingCode = code
		this.logger.info(`pairing code ready: ${formatPairingCode(code)}`)
		return code
	}

	/* ------------------------------------------------------------------ *
	 * public helpers
	 * ------------------------------------------------------------------ */

	async getAvailablePreKeys() {
		const result = await this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt', id: generateMessageIDV2() },
			content: [{ tag: 'count', attrs: {} }]
		})
		const countNode = getBinaryNodeChild(result, 'count')
		return countNode ? +countNode.attrs.value : 0
	}

	async groupMetadata(jid, force = false) {
		return groups.groupMetadata(this, jid, force)
	}

	async sendMessage(jid, message, options = {}) {
		if (!this.authState.creds.me?.id) throw new Error('tobi: not connected')
		const normalizedJid = jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') ? jid : jidNormalizedUser(jid)
		const content = await generateWAMessageContent(this, message, options)
		const result = await relayMessage(this, normalizedJid, content, options)

		if (this.config.emitOwnEvents) {
			this.emit('messages.upsert', {
				messages: [
					{
						key: result.key,
						message: content,
						messageTimestamp: result.messageTimestamp,
						pushName: this.authState.creds.me.name,
						status: proto.WebMessageInfo.Status.PENDING
					}
				],
				type: 'append'
			})
		}
		return result
	}

	async downloadMedia(message, options = {}) {
		return downloadMediaMessage(this, message, options)
	}

	async readMessages(keys) {
		for (const key of keys) {
			await sendReceipt(this, key.remoteJid, key.participant, [key.id], 'read')
		}
	}

	async fetchGroupMetadata(jid) {
		return this.groupMetadata(jid)
	}

	async updateProfileName(name) {
		return this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', id: generateMessageIDV2() },
			content: [{ tag: 'name', attrs: {}, content: Buffer.from(name, 'utf8') }]
		})
	}

	async updateProfileStatus(status) {
		return this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status', id: generateMessageIDV2() },
			content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf8') }]
		})
	}

	async fetchStatus(jid) {
		return this.query({
			tag: 'iq',
			attrs: { to: jid, type: 'get', xmlns: 'status', id: generateMessageIDV2() }
		})
	}

	/** is this number registered on WhatsApp? */
	async onWhatsApp(phoneNumber) {
		const jid = jidEncode(String(phoneNumber).replace(/[^0-9]/g, ''), 's.whatsapp.net')
		const result = await this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync', id: generateMessageIDV2() },
			content: [
				{
					tag: 'usync',
					attrs: { sid: generateMessageIDV2(), mode: 'query', last: 'true', index: '0', context: 'registration' },
					content: [
						{ tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }] },
						{ tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid } }] }
					]
				}
			]
		})
		const usyncNode = getBinaryNodeChild(result, 'usync')
		const userNode = getBinaryNodeChild(getBinaryNodeChild(usyncNode, 'list'), 'user')
		const contactNode = getBinaryNodeChild(userNode, 'contact')
		if (!contactNode || contactNode.attrs.type === 'in') return { exists: false, jid }
		return { exists: true, jid, lid: contactNode.attrs.lid }
	}

	async profilePictureUrl(jid, type = 'preview') {
		const result = await this.query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:profile:picture', id: generateMessageIDV2() },
			content: [{ tag: 'picture', attrs: { type, query: 'url' }, content: [] }]
		})
		const pictureNode = getBinaryNodeChild(result, 'picture')
		return pictureNode?.attrs.url
	}

	async presenceSubscribe(jid) {
		await this.sendNode({ tag: 'presence', attrs: { to: jid, type: 'subscribe' } })
	}

	async logout(message = 'user requested logout') {
		try {
			if (this.authState.creds.me?.id) {
				await this.query({
					tag: 'iq',
					attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageIDV2(), xmlns: 'md' },
					content: [
						{
							tag: 'remove-companion-device',
							attrs: { jid: this.authState.creds.me.id, reason: 'user_initiated' }
						}
					]
				})
			}
		} catch (err) {
			this.logger.warn(`logout iq failed: ${err.message}`)
		}
		this.lastDisconnectReason = DisconnectReason.loggedOut
		this.closed = true
		this.ws?.close()
		this.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error(message), date: new Date() } })
	}

	async end(error) {
		this.closed = true
		this.ws?.close()
		if (error) this.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
	}

	/* ------------------------------------------------------------------ *
	 * convenience wrappers
	 * ------------------------------------------------------------------ */

	groupCreate(subject, participants) {
		return groups.groupCreate(this, subject, participants)
	}
	groupAdd(jid, participants) {
		return groups.groupAdd(this, jid, participants)
	}
	groupRemove(jid, participants) {
		return groups.groupRemove(this, jid, participants)
	}
	groupPromote(jid, participants) {
		return groups.groupPromote(this, jid, participants)
	}
	groupDemote(jid, participants) {
		return groups.groupDemote(this, jid, participants)
	}
	groupUpdateSubject(jid, subject) {
		return groups.groupUpdateSubject(this, jid, subject)
	}
	groupUpdateDescription(jid, description) {
		return groups.groupUpdateDescription(this, jid, description)
	}
	groupLeave(jid) {
		return groups.groupLeave(this, jid)
	}
	groupInviteCode(jid) {
		return groups.groupInviteCode(this, jid)
	}
	groupRevokeInvite(jid) {
		return groups.groupRevokeInvite(this, jid)
	}
	groupAcceptInvite(code) {
		return groups.groupAcceptInvite(this, code)
	}
	groupSettingUpdate(jid, setting) {
		return groups.groupSettingUpdate(this, jid, setting)
	}
	updateGroupSubject(jid, subject) {
		return groups.groupUpdateSubject(this, jid, subject)
	}

	/** fetch the devices of a jid (useful for debugging) */
	getUserDevices(jid) {
		return getUSyncDevices(this, [jid], false, false)
	}
}

/** factory, mirrors the familiar `makeWASocket` shape */
const makeWASocket = (config = {}) => new TobiSocket(config)

module.exports = { TobiSocket, makeWASocket }
