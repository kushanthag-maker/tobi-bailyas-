'use strict'
/**
 * tobi - example bot.
 *
 *   node example/bot.js qr            -> link by scanning a QR code
 *   node example/bot.js code 9477XXXXXXX        -> link with a random pairing code
 *   node example/bot.js code 9477XXXXXXX TOBIDEVV -> link with YOUR OWN code
 */
const {
	makeWASocket,
	useMultiFileAuthState,
	DisconnectReason,
	Browsers,
	downloadMediaMessage,
	text,
	image,
	video,
	buttons,
	quickReplyButton,
	urlButton,
	list,
	Logger
} = require('..')

const AUTH_FOLDER = './tobi_auth'
const logger = new Logger('info', { class: 'bot' })

const [mode = 'qr', phoneNumber, customCode] = process.argv.slice(2)

const start = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

	const sock = makeWASocket({
		auth: state,
		logger,
		browser: Browsers.baileys('Chrome'),
		printQRInTerminal: true,
		markOnlineOnConnect: true,
		syncFullHistory: false
	})

	sock.ev.on('creds.update', saveCreds)

	// ---- pairing code mode ------------------------------------------------
	if (mode === 'code' && !sock.authState.creds.registered) {
		if (!phoneNumber) throw new Error('usage: node example/bot.js code <phoneNumber> [CUSTOMCODE]')
		// wait for the socket to be ready before asking for a code
		setTimeout(async () => {
			try {
				const code = await sock.requestPairingCode(phoneNumber, customCode)
				logger.info(`pairing code: ${code}`)
				logger.info('open WhatsApp > Linked devices > Link with phone number, then type this code')
			} catch (err) {
				logger.error(`could not request a pairing code: ${err.message}`)
			}
		}, 3000)
	}

	// ---- connection lifecycle --------------------------------------------
	sock.ev.on('connection.update', ({ connection, lastDisconnect, qr, isNewLogin }) => {
		if (qr) logger.info('QR ready - scan it from Linked devices')
		if (isNewLogin) logger.info('new device linked')
		if (connection === 'open') logger.info('connected as ' + sock.authState.creds.me?.id)
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.statusCode
			logger.warn(`closed (${code})`)
			if (code === DisconnectReason.loggedOut) logger.error('logged out - delete ./tobi_auth and start again')
		}
	})

	// ---- incoming messages -----------------------------------------------
	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') return
		for (const msg of messages) {
			if (msg.key.fromMe) continue
			const jid = msg.key.remoteJid
			const inner = msg.message || {}
			const body =
				inner.conversation ||
				inner.extendedTextMessage?.text ||
				inner.imageMessage?.caption ||
				inner.videoMessage?.caption ||
				''
			logger.info(`${jid}: ${body || '<media>'}`)

			if (!body) continue

			// --- plain text reply ---
			if (body.toLowerCase() === 'hi') {
				await sock.sendMessage(jid, text('hello from tobi 👋'))
				continue
			}

			// --- buttons ---
			if (body.toLowerCase() === 'menu') {
				await sock.sendMessage(
					jid,
					buttons({
						text: 'What would you like to do?',
						title: 'tobi menu',
						footer: 'pick one',
						buttons: [
							quickReplyButton({ displayText: 'Say hello', id: 'hello' }),
							urlButton({ displayText: 'Visit GitHub', url: 'https://github.com/' }),
							quickReplyButton({ displayText: 'Send a photo', id: 'photo' })
						]
					})
				)
				continue
			}

			// --- list ---
			if (body.toLowerCase() === 'list') {
				await sock.sendMessage(
					jid,
					list({
						text: 'Choose a colour',
						title: 'Colours',
						buttonText: 'Open list',
						footer: 'tobi',
						sections: [
							{
								title: 'Warm',
								rows: [
									{ id: 'red', title: 'Red', description: 'the loud one' },
									{ id: 'orange', title: 'Orange' }
								]
							},
							{
								title: 'Cool',
								rows: [
									{ id: 'blue', title: 'Blue', description: 'the calm one' },
									{ id: 'green', title: 'Green' }
								]
							}
						]
					})
				)
				continue
			}

			// --- media ---
			if (inner.imageMessage || inner.videoMessage) {
				const { buffer } = await downloadMediaMessage(sock, msg)
				logger.info(`downloaded ${buffer.length} bytes of media`)
				await sock.sendMessage(jid, text('got your media, thanks!'))
				continue
			}

			// --- send a local movie / photo ---
			if (body.toLowerCase() === 'movie' && process.env.MOVIE_PATH) {
				await sock.sendMessage(jid, {
					video: { filePath: process.env.MOVIE_PATH, caption: 'here is the movie 🎬' }
				})
			}
		}
	})
}

start().catch((err) => {
	logger.error(err.stack || err.message)
	process.exit(1)
})
