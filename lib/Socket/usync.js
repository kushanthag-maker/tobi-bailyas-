'use strict'
/**
 * tobi - usync helpers: resolve the device list (and LID) of any user.
 *
 * Every WhatsApp account is multi device: a message has to be encrypted
 * separately for each of the recipient's devices (and for your own other
 * devices). `getUSyncDevices` asks the server for that list.
 */
const { generateMessageID } = require('../Utils/generics')
const { S_WHATSAPP_NET } = require('../Defaults')
const { getBinaryNodeChild, getBinaryNodeChildren } = require('../WABinary')
const { jidDecode } = require('../Utils/generics')

const USYNC_DEVICE_VERSION = '2'

const deviceCache = new Map()
const DEVICE_CACHE_TTL = 5 * 60 * 1000

/**
 * Query the server for the devices of the given jids.
 * @returns {Promise<Array<{user:string, device:number, jid:string, lid?:string}>>}
 */
const fetchUsyncDevices = async (socket, jids) => {
	const sid = generateMessageID()
	const userNodes = jids.map((jid) => ({ tag: 'user', attrs: { jid } }))

	const node = {
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync', id: generateMessageID() },
		content: [
			{
				tag: 'usync',
				attrs: {
					sid,
					mode: 'query',
					last: 'true',
					index: '0',
					context: 'message'
				},
				content: [
					{
						tag: 'query',
						attrs: {},
						content: [
							{ tag: 'devices', attrs: { version: USYNC_DEVICE_VERSION } },
							{ tag: 'lid', attrs: {} }
						]
					},
					{ tag: 'list', attrs: {}, content: userNodes }
				]
			}
		]
	}

	const result = await socket.query(node)
	const usyncNode = getBinaryNodeChild(result, 'usync')
	if (!usyncNode) throw new Error('tobi: usync response missing <usync>')

	const devices = []
	const listNode = getBinaryNodeChild(usyncNode, 'list')
	for (const userNode of getBinaryNodeChildren(listNode, 'user')) {
		const decoded = jidDecode(userNode.attrs.jid)
		if (!decoded) continue
		const user = decoded.user
		const server = decoded.server
		const lidAttr = userNode.attrs.lid
		const devicesNode = getBinaryNodeChild(userNode, 'devices')
		if (!devicesNode) continue

		// <device-list><device id="0" key-index="1" is_hosted="false"/></device-list>
		const deviceList = getBinaryNodeChild(devicesNode, 'device-list')
		const deviceNodes = getBinaryNodeChildren(deviceList, 'device')
		const ids = deviceNodes.length
			? deviceNodes.map((d) => +d.attrs.id)
			: [0] // at minimum the primary device

		for (const deviceId of ids) {
			devices.push({
				user,
				server,
				device: deviceId,
				jid: `${user}${deviceId ? `:${deviceId}` : ''}@${server}`,
				lid: lidAttr
			})
		}
	}
	return devices
}

/**
 * Cached version used by the send pipeline. `ignoreZeroDevices` skips the
 * primary device (used when only companion devices need the message).
 */
const getUSyncDevices = async (socket, jids, useCache = true, ignoreZeroDevices = false) => {
	const results = []
	const missing = []

	for (const jid of jids) {
		const decoded = jidDecode(jid)
		if (!decoded) continue
		const bare = `${decoded.user}@${decoded.server}`
		const cached = deviceCache.get(bare)
		if (useCache && cached && cached.expires > Date.now()) {
			results.push(...cached.devices)
		} else {
			missing.push(jid)
		}
	}

	if (missing.length) {
		const fetched = await fetchUsyncDevices(socket, missing)
		const grouped = new Map()
		for (const device of fetched) {
			const bare = `${device.user}@${device.server}`
			if (!grouped.has(bare)) grouped.set(bare, [])
			grouped.get(bare).push(device)
		}
		for (const [bare, devices] of grouped) {
			deviceCache.set(bare, { devices, expires: Date.now() + DEVICE_CACHE_TTL })
			results.push(...devices)
		}
	}

	const filtered = ignoreZeroDevices ? results.filter((d) => d.device !== 0) : results
	// de-duplicate
	const seen = new Set()
	return filtered.filter((d) => {
		if (seen.has(d.jid)) return false
		seen.add(d.jid)
		return true
	})
}

/** every device of our own account (needed so your other devices get the message) */
const getOwnDevices = async (socket) => {
	const me = socket.authState.creds.me
	if (!me?.id) return []
	try {
		const devices = await getUSyncDevices(socket, [me.id], true, false)
		// exclude the device we are running on
		return devices.filter((d) => d.jid !== me.id)
	} catch (err) {
		socket.logger?.warn?.(`usync own devices failed: ${err.message}`)
		return []
	}
}

const invalidateDeviceCache = () => deviceCache.clear()

module.exports = { fetchUsyncDevices, getUSyncDevices, getOwnDevices, invalidateDeviceCache, USYNC_DEVICE_VERSION }
