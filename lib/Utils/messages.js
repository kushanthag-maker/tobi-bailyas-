'use strict'
/**
 * tobi - message builders.
 *
 * Every helper here returns a plain `proto.Message` shaped object which
 * `messages-send` then encrypts and relays. Buttons and list messages are
 * implemented in the modern `interactiveMessage` / `nativeFlowMessage` form,
 * which is what renders on regular (non business) WhatsApp accounts today;
 * the legacy `buttonsMessage` / `listMessage` builders are also provided.
 */
const fs = require('fs')
const path = require('path')
const { proto } = require('../Proto')
const { prepareWAMessageMedia, getMediaType, unwrapMessage } = require('./media-upload')
const { generateMessageIDV2, unixTimestampSeconds, jidEncode } = require('./generics')
const { WA_DEFAULT_EPHEMERAL, DEFAULT_EMPTY_MESSAGE } = require('../Defaults')

/* ------------------------------------------------------------------ *
 * plain text / rich text
 * ------------------------------------------------------------------ */

const text = (content) => ({ text: String(content ?? '') })

/** extended text (reply / link preview / mentions / quotes) */
const extendedText = (content, options = {}) => {
	const message = {
		extendedTextMessage: {
			text: String(content ?? '')
		}
	}
	const ctx = buildContextInfo(options)
	if (ctx) message.extendedTextMessage.contextInfo = ctx
	if (options.linkPreview) {
		message.extendedTextMessage.matchedText = options.linkPreview.matchedText
		message.extendedTextMessage.canonicalUrl = options.linkPreview.canonicalUrl
		message.extendedTextMessage.title = options.linkPreview.title
		message.extendedTextMessage.description = options.linkPreview.description
		if (options.linkPreview.jpegThumbnail) message.extendedTextMessage.jpegThumbnail = options.linkPreview.jpegThumbnail
		message.extendedTextMessage.previewType = proto.Message.ExtendedTextMessage.PreviewType.NONE
	}
	return message
}

const buildContextInfo = (options = {}) => {
	if (!options.quoted && !options.mentions && !options.expiration && !options.forwardingScore && !options.isForwarded) {
		return undefined
	}
	const ctx = {}
	if (options.quoted) {
		const quoted = options.quoted
		const key = quoted.key || {}
		ctx.stanzaId = key.id
		ctx.participant = key.participant || key.remoteJid
		if (quoted.message) ctx.quotedMessage = unwrapMessage(quoted.message)
	}
	if (options.mentions?.length) ctx.mentionedJid = options.mentions.map((m) => jidEncode(require('./generics').jidDecode(m)?.user || m, 's.whatsapp.net'))
	if (options.expiration) ctx.expiration = options.expiration
	if (options.forwardingScore) ctx.forwardingScore = options.forwardingScore
	if (options.isForwarded) ctx.isForwarded = true
	return ctx
}

/* ------------------------------------------------------------------ *
 * media
 * ------------------------------------------------------------------ */

const image = (content) => ({ image: content, mediaType: 'image' })
const video = (content) => ({ video: content, mediaType: 'video' })
const audio = (content) => ({ audio: content, mediaType: content.ptt ? 'ptt' : 'audio' })
const document = (content) => ({ document: content, mediaType: 'document' })
const sticker = (content) => ({ sticker: content, mediaType: 'sticker' })
/** view-once wrapper */
const viewOnce = (content, kind = 'video') => ({ viewOnce: content, kind })

/** turn a media descriptor into the protobuf message */
const buildMediaContent = async (socket, descriptor, options = {}) => {
	const { mediaType } = descriptor
	const payload = descriptor[mediaType === 'ptt' ? 'audio' : mediaType] || descriptor.video || descriptor.image
	const prepared = await prepareWAMessageMedia(socket, { ...payload, mediaType }, options)
	const ctx = buildContextInfo(options)
	const caption = payload.caption

	const base = {
		url: prepared.url,
		directPath: prepared.directPath,
		mediaKey: prepared.mediaKey,
		fileEncSha256: prepared.fileEncSha256,
		fileSha256: prepared.fileSha256,
		fileLength: prepared.fileLength,
		mediaKeyTimestamp: prepared.mediaKeyTimestamp,
		mimetype: payload.mimetype || defaultMime(mediaType),
		...(ctx ? { contextInfo: ctx } : {})
	}

	let inner
	if (mediaType === 'image') {
		inner = { imageMessage: { ...base, caption, jpegThumbnail: prepared.jpegThumbnail, height: payload.height, width: payload.width } }
	} else if (mediaType === 'video') {
		inner = {
			videoMessage: {
				...base,
				caption,
				seconds: payload.seconds ?? 0,
				gifPlayback: payload.gifPlayback ?? false,
				ptv: payload.ptv ?? false,
				height: payload.height,
				width: payload.width,
				jpegThumbnail: prepared.jpegThumbnail
			}
		}
	} else if (mediaType === 'audio' || mediaType === 'ptt') {
		inner = {
			audioMessage: {
				...base,
				ptt: mediaType === 'ptt',
				seconds: payload.seconds ?? 0,
				waveform: payload.waveform
			}
		}
	} else if (mediaType === 'sticker') {
		inner = { stickerMessage: { ...base, isAnimated: payload.isAnimated ?? false } }
	} else {
		inner = {
			documentMessage: {
				...base,
				title: payload.fileName || path.basename(payload.filePath || '') || 'document',
				fileName: payload.fileName || path.basename(payload.filePath || '') || 'document',
				pageCount: payload.pageCount,
				caption
			}
		}
	}

	// view once
	if (descriptor.viewOnce) {
		return { viewOnceMessage: { message: inner } }
	}
	return inner
}

const defaultMime = (mediaType) =>
	mediaType === 'image'
		? 'image/jpeg'
		: mediaType === 'video'
			? 'video/mp4'
			: mediaType === 'audio'
				? 'audio/mpeg'
				: mediaType === 'ptt'
					? 'audio/ogg; codecs=opus'
					: mediaType === 'sticker'
						? 'image/webp'
						: 'application/octet-stream'

/* ------------------------------------------------------------------ *
 * buttons - modern interactive (works on regular accounts)
 * ------------------------------------------------------------------ */

/**
 * quick reply button
 * @example { displayText: 'Yes', id: 'yes' }
 */
const quickReplyButton = ({ displayText, id }) => ({
	name: 'quick_reply',
	buttonParamsJson: JSON.stringify({ display_text: displayText, id })
})

/** url button (opens a link) */
const urlButton = ({ displayText, url, merchantUrl, webviewPresentation = 'PAGE' }) => ({
	name: 'cta_url',
	buttonParamsJson: JSON.stringify({
		display_text: displayText,
		url,
		merchant_url: merchantUrl || url,
		webview_presentation: webviewPresentation
	})
})

/** call button */
const callButton = ({ displayText, phoneNumber }) => ({
	name: 'cta_call',
	buttonParamsJson: JSON.stringify({ display_text: displayText, phone_number: phoneNumber })
})

/** copy-to-clipboard button */
const copyButton = ({ displayText, copyCode }) => ({
	name: 'cta_copy',
	buttonParamsJson: JSON.stringify({ display_text: displayText, copy_code: copyCode })
})

/** single-select list button (a "dropdown" of options) */
const singleSelectButton = ({ title, sections }) => ({
	name: 'single_select',
	buttonParamsJson: JSON.stringify({
		title,
		sections: sections.map((section) => ({
			title: section.title,
			rows: section.rows.map((row) => ({
				id: row.id,
				title: row.title,
				description: row.description
			}))
		}))
	})
})

/**
 * The modern button message.
 * @param {Object} content
 * @param {string} [content.text]      body text
 * @param {string} [content.title]     header title
 * @param {string} [content.footer]    footer text
 * @param {Array}  content.buttons     array of button objects (see helpers above)
 * @param {Object} [content.media]     optional image/video header
 */
/** map user supplied buttons to WhatsApp native-flow buttons */
const mapButtonList = (buttonList = []) =>
	buttonList.map((button) => {
		if (typeof button === 'string') return quickReplyButton({ displayText: button, id: button })
		if (button.name) return button
		if (button.displayText && button.url) return urlButton(button)
		if (button.displayText && button.phoneNumber) return callButton(button)
		if (button.displayText && button.copyCode) return copyButton(button)
		if (button.title && button.sections) return singleSelectButton(button)
		return quickReplyButton({
			displayText: button.displayText || button.text || 'Button',
			id: button.id || button.text || 'btn'
		})
	})

/**
 * The modern button message. Returns the `interactiveMessage` shape WhatsApp
 * renders on regular (non business) accounts.
 *
 * @param {Object} content
 * @param {string} [content.text]     body text
 * @param {string} [content.title]    header title
 * @param {string} [content.footer]   footer text
 * @param {Array}  content.buttons    buttons (plain objects or the helpers above)
 * @param {Object} [content.media]    optional image / video header
 */
const buttons = (content = {}) => {
	const interactive = {
		body: { text: content.text || '' },
		nativeFlowMessage: { buttons: mapButtonList(content.buttons), messageParamsJson: '' }
	}
	if (content.title) interactive.header = { title: content.title, hasMediaAttachment: false }
	if (content.footer) interactive.footer = { text: content.footer }
	return { interactive, media: content.media }
}

/** attach a media header to an already built interactive message */
const buildButtonsContent = async (socket, interactive, options = {}, media) => {
	const built = JSON.parse(JSON.stringify(interactive))
	const ctx = buildContextInfo(options)
	if (ctx) built.contextInfo = ctx

	if (media) {
		const mediaType = media.mediaType || getMediaType(media.mimetype, media.fileName)
		const prepared = await prepareWAMessageMedia(socket, { ...media, mediaType }, options)
		const common = {
			url: prepared.url,
			directPath: prepared.directPath,
			mediaKey: prepared.mediaKey,
			fileEncSha256: prepared.fileEncSha256,
			fileSha256: prepared.fileSha256,
			fileLength: prepared.fileLength,
			mediaKeyTimestamp: prepared.mediaKeyTimestamp,
			mimetype: media.mimetype || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg')
		}
		built.header = {
			title: built.header?.title,
			hasMediaAttachment: true,
			...(mediaType === 'video' ? { videoMessage: common } : { imageMessage: common })
		}
	}

	return { interactiveMessage: built }
}

/**
 * Legacy buttons message (`buttonsMessage`). Still accepted by the server on
 * some accounts; prefer `buttons()` for anything new.
 */
const legacyButtons = (content) => {
	const { text: bodyText, footer, buttons: buttonList = [], title } = content
	return {
		buttonsMessage: {
			contentText: bodyText,
			footerText: footer,
			headerType: title ? proto.Message.ButtonsMessage.HeaderType.TEXT : proto.Message.ButtonsMessage.HeaderType.EMPTY,
			text: title,
			buttons: buttonList.map((b) => ({
				buttonId: b.id || b.displayText,
				buttonText: { displayText: b.displayText },
				type: proto.Message.ButtonsMessage.Button.Type.RESPONSE
			}))
		}
	}
}

/** a reply to a button press */
const buttonsResponse = ({ selectedButtonId, selectedDisplayText, quoted }) => ({
	buttonsResponseMessage: {
		selectedButtonId,
		selectedDisplayText,
		type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT,
		...(quoted ? { contextInfo: buildContextInfo({ quoted }) } : {})
	}
})

/* ------------------------------------------------------------------ *
 * list messages
 * ------------------------------------------------------------------ */

/**
 * @param {Object} content
 * @param {string} content.text
 * @param {string} content.buttonText
 * @param {Array}  content.sections  [{ title, rows: [{ id, title, description }] }]
 */
const list = (content) => ({ list: content })

const buildListContent = (content, options = {}) => {
	const { text: bodyText, buttonText, sections = [], title, footer } = content
	return {
		listMessage: {
			title,
			description: bodyText,
			footerText: footer,
			buttonText,
			listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
			sections: sections.map((section) => ({
				title: section.title,
				rows: section.rows.map((row) => ({
					title: row.title,
					description: row.description,
					rowId: row.id
				}))
			}))
		}
	}
}

const listResponse = ({ selectedRowId, title, description, quoted }) => ({
	listResponseMessage: {
		title,
		description,
		singleSelectReply: { selectedRowId },
		listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
		...(quoted ? { contextInfo: buildContextInfo({ quoted }) } : {})
	}
})

/* ------------------------------------------------------------------ *
 * misc message kinds
 * ------------------------------------------------------------------ */

const reaction = ({ text: emoji, key }) => ({
	reactionMessage: {
		text: emoji,
		key: {
			remoteJid: key.remoteJid,
			fromMe: key.fromMe ?? false,
			id: key.id,
			participant: key.participant
		},
		senderTimestampMs: Date.now()
	}
})

const location = ({ degreesLatitude, degreesLongitude, name, address, url }) => ({
	locationMessage: { degreesLatitude, degreesLongitude, name, address, url }
})

const liveLocation = ({ degreesLatitude, degreesLongitude, accuracyInMeters, speedInMps, degreesClockwiseFromMagneticNorth, caption, sequenceNumber, timeOffset }) => ({
	liveLocationMessage: {
		degreesLatitude,
		degreesLongitude,
		accuracyInMeters,
		speedInMps,
		degreesClockwiseFromMagneticNorth,
		caption,
		sequenceNumber,
		timeOffset
	}
})

const contact = (vcard, displayName) => {
	const contact = { displayName }
	if (typeof vcard === 'string') contact.vcard = vcard
	else contact.vcard = makeVCard(vcard)
	return { contactMessage: contact }
}

const contacts = (list) => ({
	contactsArrayMessage: {
		displayName: list.length === 1 ? list[0].displayName : `${list.length} contacts`,
		contacts: list.map((c) => (typeof c.vcard === 'string' ? c : { displayName: c.displayName, vcard: makeVCard(c) }))
	}
})

const makeVCard = ({ fullName, organization, phone }) =>
	[
		'BEGIN:VCARD',
		'VERSION:3.0',
		`FN:${fullName}`,
		organization ? `ORG:${organization}` : null,
		`TEL;type=CELL;type=VOICE;waid=${String(phone).replace(/[^0-9]/g, '')}:+${String(phone).replace(/[^0-9]/g, '')}`,
		'END:VCARD'
	]
		.filter(Boolean)
		.join('\n')

const poll = ({ name, values, selectableCount = 1, toAnnounceAnonymously = false }) => ({
	pollCreationMessage: {
		name,
		options: values.map((value) => ({ optionName: value })),
		selectableOptionsCount: selectableCount
	}
})

const pollResult = ({ name, votes, key }) => ({
	pollUpdateMessage: {
		pollCreationMessageKey: key,
		vote: {
			selectedOptions: votes.map((value) => ({ optionName: value }))
		},
		name
	}
})

const stickerPack = (pack) => ({ stickerPackMessage: pack })

const edit = (message, key) => ({
	protocolMessage: {
		key: { remoteJid: key.remoteJid, fromMe: key.fromMe ?? true, id: key.id, participant: key.participant },
		type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
		editedMessage: message,
		timestampMs: Date.now()
	}
})

const deleteMessage = (key) => ({
	protocolMessage: {
		key: { remoteJid: key.remoteJid, fromMe: key.fromMe ?? true, id: key.id, participant: key.participant },
		type: proto.Message.ProtocolMessage.Type.REVOKE,
		timestampMs: Date.now()
	}
})

/* ------------------------------------------------------------------ *
 * assembling the final proto.Message
 * ------------------------------------------------------------------ */

/** build a `proto.Message` object from one of the helpers above */
const generateWAMessageContent = async (socket, message, options = {}) => {
	let content

	if (message.text !== undefined && !message.extendedText) {
		content = options.quoted || options.mentions || options.linkPreview ? extendedText(message.text, options) : text(message.text)
	} else if (message.interactive) {
		content = await buildButtonsContent(socket, message.interactive, options, message.media)
	} else if (message.list) {
		content = buildListContent(message.list, options)
	} else if (message.buttons || message.templateButtons) {
		content = legacyButtons({ ...message, buttons: message.buttons || message.templateButtons })
	} else if (message.image || message.video || message.audio || message.document || message.sticker) {
		content = await buildMediaContent(socket, message, options)
	} else if (message.reactionMessage) {
		content = { reactionMessage: message.reactionMessage }
	} else if (message.locationMessage) {
		content = { locationMessage: message.locationMessage }
	} else if (message.liveLocationMessage) {
		content = { liveLocationMessage: message.liveLocationMessage }
	} else if (message.contactMessage) {
		content = { contactMessage: message.contactMessage }
	} else if (message.contactsArrayMessage) {
		content = { contactsArrayMessage: message.contactsArrayMessage }
	} else if (message.pollCreationMessage) {
		content = { pollCreationMessage: message.pollCreationMessage }
	} else if (message.protocolMessage) {
		content = { protocolMessage: message.protocolMessage }
	} else if (message.buttonsResponseMessage) {
		content = { buttonsResponseMessage: message.buttonsResponseMessage }
	} else if (message.listResponseMessage) {
		content = { listResponseMessage: message.listResponseMessage }
	} else if (message.raw) {
		content = message.raw
	} else {
		content = text(message.text ?? DEFAULT_EMPTY_MESSAGE)
	}

	// disappearing messages wrapper
	if (options.ephemeralExpiration) {
		content = { ephemeralMessage: { message: content } }
	}
	return content
}

/** a full WebMessageInfo (mostly useful for events / local echo) */
const generateWAMessage = async (socket, jid, message, options = {}) => {
	const content = await generateWAMessageContent(socket, message, options)
	const messageId = options.messageId || generateMessageIDV2()
	const me = socket?.authState?.creds?.me
	const key = {
		remoteJid: jid,
		fromMe: true,
		id: messageId,
		...(jid.endsWith('@g.us') ? { participant: me?.id } : {})
	}
	return {
		key,
		message: content,
		messageTimestamp: unixTimestampSeconds(),
		pushName: me?.name,
		status: proto.WebMessageInfo.Status.PENDING
	}
}

/** the stanza `type` attribute for a message */
const getMessageType = (message) => {
	const inner = unwrapMessage(message)
	if (inner.conversation || inner.extendedTextMessage) return 'text'
	if (inner.imageMessage) return 'media'
	if (inner.videoMessage) return 'media'
	if (inner.audioMessage) return 'media'
	if (inner.documentMessage) return 'media'
	if (inner.stickerMessage) return 'media'
	if (inner.reactionMessage) return 'text'
	if (inner.protocolMessage) return 'text'
	if (inner.pollCreationMessage) return 'text'
	if (inner.interactiveMessage || inner.buttonsMessage || inner.listMessage) return 'text'
	return 'text'
}

/** does this content need to be sent to your own other devices as well? */
const isMediaMessage = (message) => {
	const inner = unwrapMessage(message)
	return !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.documentMessage || inner.stickerMessage)
}

module.exports = {
	text,
	extendedText,
	image,
	video,
	audio,
	document,
	sticker,
	viewOnce,
	buttons,
	legacyButtons,
	quickReplyButton,
	urlButton,
	callButton,
	copyButton,
	singleSelectButton,
	buttonsResponse,
	list,
	listResponse,
	reaction,
	location,
	liveLocation,
	contact,
	contacts,
	makeVCard,
	poll,
	pollResult,
	edit,
	deleteMessage,
	buildContextInfo,
	buildMediaContent,
	buildButtonsContent,
	buildListContent,
	generateWAMessageContent,
	generateWAMessage,
	getMessageType,
	isMediaMessage,
	unwrapMessage,
	WA_DEFAULT_EPHEMERAL
}
