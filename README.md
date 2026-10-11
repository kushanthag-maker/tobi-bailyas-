# tobi

A **from-scratch** WhatsApp multi-device (WhatsApp Web) library for Node.js — written by `tobi-devv`.
No Baileys code anywhere: the Noise transport, the WABinary codec, the pairing flows, the send/receive
pipeline, media upload and the button/list builders are all implemented here.

Supports **both** linking methods: **QR code** and **8-character pairing code** (including *your own*
custom code, e.g. `TOBIDEVV`).

```bash
npm i
npm test          # offline self-test (no WhatsApp account needed)
node example/bot.js qr
```

---

## Features

| Area | What you get |
|---|---|
| Linking | QR code **and** pairing code, custom 8-char codes supported |
| Transport | `Noise_XX_25519_AESGCM_SHA256` handshake, AES-256-GCM frames, 3-byte framing |
| Wire format | Full WABinary encoder/decoder (token dictionary, JID pairs, nibble/hex packing) |
| Crypto | X25519, XEdDSA, HKDF-SHA256, PBKDF2 pairing key derivation |
| E2E | Signal Protocol (X3DH + Double Ratchet + Sender Keys) via the standalone `libsignal` package |
| Messages | text, media, replies/quotes, mentions, reactions, edits, deletes, polls, location, contacts |
| Buttons | Modern `interactiveMessage` / `nativeFlowMessage` (renders on regular accounts) **and** legacy `buttonsMessage` |
| Lists | `listMessage` single-select + `listResponseMessage` |
| Media | streaming encrypt/upload/download — **large movie files without loading them into RAM** |
| Groups | create, add/remove/promote/demote, subject, description, invite codes, metadata |
| Misc | presence, read receipts, retries, `onWhatsApp` check, profile picture, history sync events |

---

## Install

```bash
npm install            # installs: libsignal, protobufjs, ws, qrcode-terminal
```

Optional (only needed for QR images / terminal QR):
`qrcode`, `qrcode-terminal`.

> **Not published to npm.** Install straight from GitHub:
> ```bash
> npm install github:<your-user>/tobi
> ```

---

## Quick start — QR code

```js
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('tobi-baileys')

const start = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('./tobi_auth')

	const sock = makeWASocket({
		auth: state,
		browser: Browsers.baileys('Chrome'),
		printQRInTerminal: true          // set false and render `qr` yourself
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
		if (qr) console.log('scan this QR:', qr)
		if (connection === 'open') console.log('connected!')
		if (connection === 'close') {
			const code = lastDisconnect?.statusCode
			if (code === DisconnectReason.loggedOut) console.log('logged out')
		}
	})

	sock.ev.on('messages.upsert', ({ messages, type }) => {
		if (type !== 'notify') return
		for (const m of messages) {
			console.log(m.key.remoteJid, m.message?.conversation)
		}
	})
}

start()
```

## Quick start — pairing code

```js
const sock = makeWASocket({ auth: state })

sock.ev.on('connection.update', async ({ qr, connection }) => {
	if (connection === 'connecting' || qr) {
		// random code
		const code = await sock.requestPairingCode('94771234567')
		console.log('type this on your phone:', code)   // e.g. 4K7Q-M2PX

		// or YOUR OWN code (exactly 8 chars, A-Z 0-9; dashes/spaces are stripped)
		// const mine = await sock.requestPairingCode('94771234567', 'TOBIDEVV')
	}
})
```

On the phone: **WhatsApp → Linked devices → Link with phone number → type the code**.
The code lives for a few minutes; the socket reconnects automatically after a successful link.

`requestPairingCode(phoneNumber, customCode?)` rules:

* `phoneNumber` — E.164 **without** `+` (e.g. `94771234567`)
* `customCode` — optional, must be **exactly 8 characters** `A-Z 0-9`
  (`tobi-devv`, `TOBI DEV V` are normalised to `TOBIDEVV`; anything else throws)

---

## Sending messages

```js
const { text, image, video, document, buttons, quickReplyButton, urlButton, list, reaction } = require('tobi-baileys')

// text
await sock.sendMessage(jid, text('hello'))

// reply / quote
await sock.sendMessage(jid, text('nice one'), { quoted: someMessage })

// image / video / movie from disk (streamed, safe for multi-GB files)
await sock.sendMessage(jid, { image: { filePath: './photo.jpg', caption: 'hi' } })
await sock.sendMessage(jid, { video: { filePath: './movie.mp4', caption: 'movie night 🎬', seconds: 120 } })

// document
await sock.sendMessage(jid, { document: { filePath: './report.pdf', fileName: 'report.pdf' } })

// view once
await sock.sendMessage(jid, { video: { filePath: './secret.mp4' }, viewOnce: true })

// buttons (modern interactive — works on regular accounts)
await sock.sendMessage(jid, buttons({
	text: 'What next?',
	title: 'tobi',
	footer: 'choose',
	buttons: [
		quickReplyButton({ displayText: 'Say hi', id: 'hi' }),
		urlButton({ displayText: 'Open site', url: 'https://example.com' })
	]
}))

// list
await sock.sendMessage(jid, list({
	text: 'Pick a colour',
	buttonText: 'Open',
	sections: [{ title: 'Cool', rows: [{ id: 'blue', title: 'Blue', description: 'calm' }] }]
}))

// reaction
await sock.sendMessage(jid, reaction({ text: '🔥', key: someMessage.key }))
```

### Receiving

```js
sock.ev.on('messages.upsert', async ({ messages, type }) => {
	for (const m of messages) {
		if (m.message?.imageMessage || m.message?.videoMessage) {
			const { buffer } = await sock.downloadMedia(m)                    // in memory
			// or stream to disk:
			// await sock.downloadMedia(m, { filePath: './downloads/clip.mp4' })
		}
	}
})
```

---

## Events

| Event | Payload |
|---|---|
| `connection.update` | `{ connection, qr, lastDisconnect, isNewLogin, receivedPendingNotifications }` |
| `creds.update` | the updated `creds` object (persist it!) |
| `messages.upsert` | `{ messages: WAMessage[], type: 'notify' \| 'append' }` |
| `messages.update` | edits, deletes, ephemeral setting changes |
| `message-receipt.update` | delivery / read / played |
| `groups.update`, `groups.upsert` | group changes |
| `call` | incoming call signalling |
| `messaging-history.set` | history sync chunks |
| `presence.update`, `notification`, `node`, `iq` | low-level hooks |

---

## Groups

```js
const { jid, metadata } = await sock.groupCreate('My group', ['9477...@s.whatsapp.net'])
await sock.groupAdd(jid, [otherJid])
await sock.groupRemove(jid, [otherJid])
await sock.groupPromote(jid, [otherJid])
await sock.groupUpdateSubject(jid, 'New name')
await sock.groupLeave(jid)
const meta = await sock.groupMetadata(jid)
const code = await sock.groupInviteCode(jid)
await sock.groupAcceptInvite(code)
```

---

## Architecture

```
index.js                     public API
lib/
  Defaults/                  protocol constants, browser/platform, disconnect reasons
  Proto/                     WAProto.proto + protobufjs loader (proto.<Type>)
  WABinary/                  constants.js (token dictionary), encode.js, decode.js
  Utils/
    crypto.js                HKDF, AES-GCM/CTR/CBC, X25519, Ed25519
    noise-handler.js         Noise_XX handshake + transport state + framing
    generics.js              jids, ids, crockford pairing codes
    auth-utils.js            creds generation, signed key pairs, pair-success
    validate-connection.js   ClientPayload (login/register), pairing nodes, QR payload
    pre-key-manager.js       pre-key pool + upload
    messages.js              message builders (text/media/buttons/list/...)
    media-upload.js          media key derivation, streaming encrypt/upload/download
    logger.js                tiny logger
  Signal/
    curve.js                 libsignal wrapper (normalises key formats)
    repository.js            sessions, pre-keys, sender keys, encrypt/decrypt
    store.js                 useMultiFileAuthState
    buffer-json.js           Buffer-safe JSON
  Socket/
    index.js                 the socket: connect, handshake, dispatch, sendMessage
    messages-send.js         relayMessage: per-device Signal encryption
    messages-recv.js         decrypt inbound, receipts, retries, notifications
    usync.js                 device list resolution
    groups.js                group operations
```

### Handshake sequence

```
client                                    server
  |  WS connect wss://web.whatsapp.com/ws/chat
  |  -> clientHello { ephemeral, static }      (Noise XX first message)
  |  <- serverHello { ephemeral, static, payload(cert chain) }
  |  -> clientFinish { static: enc(noisePub), payload: enc(ClientPayload) }
  |  transport established (AES-256-GCM, counter IV)
  |  <- <success>
  |  -> <iq xmlns="passive"><active/></iq>, presence, pre-key upload, digest
```

---

## Notes, limits and honesty

* The library speaks the same public wire protocol as WhatsApp Web. It is **unofficial** and not
  affiliated with WhatsApp/Meta — use it within their Terms of Service, no spam or bulk messaging.
* `libsignal` is a standalone Signal-Protocol implementation. It is the one non-trivial dependency;
  everything WhatsApp-specific is written here. If `libsignal` is missing, tobi falls back to
  `libsignal-protocol`.
* **Buttons**: the modern `interactiveMessage` / `nativeFlowMessage` form is the one that currently
  renders on normal accounts; the legacy `buttonsMessage` builder is kept for compatibility. If a
  button ever stops rendering, that is a server-side policy change, not a code bug.
* **Media upload** uses the `mmg.whatsapp.net` flow (`<media_conn>` iq → signed POST). It is
  implemented for the current protocol; if WhatsApp rotates the endpoint the constant lives in
  `lib/Defaults/index.js` (`MEDIA_PATH_MAP`) and `lib/Utils/media-upload.js`.
* **History sync** is decoded and emitted as `messaging-history.set`; full app-state (contact/chat
  sync) is intentionally minimal.
* **Tested locally**: token dictionary, WABinary round trips, protobuf encode/decode, pairing-code
  rules, Noise key schedule, media encrypt/decrypt (buffer + streaming), message builders — see
  `npm test`. A real login requires your own WhatsApp account.

## License

MIT — see `LICENSE`. "WhatsApp" is a trademark of Meta Platforms, Inc.
