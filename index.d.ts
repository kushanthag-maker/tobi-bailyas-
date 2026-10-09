/**
 * tobi - TypeScript declarations (hand written, kept in sync with index.js).
 */
/// <reference types="node" />

export interface KeyPair {
	public: Buffer
	private: Buffer
}

export interface SignedKeyPair {
	keyId: number
	keyPair: KeyPair
	signature: Buffer
}

export interface AuthenticationCreds {
	noiseKey: KeyPair
	pairingEphemeralKeyPair: KeyPair
	signedIdentityKey: KeyPair
	signedPreKey: SignedKeyPair
	registrationId: number
	advSecretKey: string
	nextPreKeyId: number
	firstUnuploadedPreKeyId: number
	accountSyncCounter: number
	registered: boolean
	pairingCode?: string
	me?: { id: string; name?: string; lid?: string; phoneNumber?: string }
	platform?: string
	account?: any
	routingInfo?: Buffer
	[key: string]: any
}

export interface SignalKeyStore {
	get(type: string, ids: string[]): Promise<Record<string, any>>
	set(data: Record<string, Record<string, any>>): Promise<void>
	clear?(): Promise<void>
}

export interface AuthenticationState {
	creds: AuthenticationCreds
	keys: SignalKeyStore
}

export interface BinaryNode {
	tag: string
	attrs: Record<string, string>
	content?: string | Buffer | BinaryNode[]
}

export interface SocketConfig {
	auth?: AuthenticationState
	logger?: any
	logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'
	version?: [number, number, number]
	browser?: [string, string, string]
	waWebSocketUrl?: string
	connectTimeoutMs?: number
	keepAliveIntervalMs?: number
	defaultQueryTimeoutMs?: number
	qrTimeout?: number
	printQRInTerminal?: boolean
	markOnlineOnConnect?: boolean
	syncFullHistory?: boolean
	emitOwnEvents?: boolean
	countryCode?: string
}

export interface WAMessageKey {
	remoteJid: string
	fromMe?: boolean
	id: string
	participant?: string
}

export interface WAMessage {
	key: WAMessageKey
	message: any
	messageTimestamp?: number
	pushName?: string
	status?: number
}

export declare class TobiSocket {
	constructor(config?: SocketConfig)
	ev: TobiSocket
	authState: AuthenticationState
	readonly user: { id: string; name?: string } | undefined
	connect(): Promise<TobiSocket>
	sendNode(node: BinaryNode): Promise<boolean>
	query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>
	requestPairingCode(phoneNumber: string, customCode?: string): Promise<string>
	sendMessage(jid: string, message: any, options?: any): Promise<WAMessage>
	downloadMedia(message: any, options?: { filePath?: string }): Promise<{ buffer: Buffer; filePath?: string }>
	readMessages(keys: WAMessageKey[]): Promise<void>
	groupMetadata(jid: string, force?: boolean): Promise<any>
	groupCreate(subject: string, participants: string[]): Promise<{ jid: string; metadata: any }>
	groupAdd(jid: string, participants: string[]): Promise<any>
	groupRemove(jid: string, participants: string[]): Promise<any>
	groupPromote(jid: string, participants: string[]): Promise<any>
	groupDemote(jid: string, participants: string[]): Promise<any>
	groupUpdateSubject(jid: string, subject: string): Promise<any>
	groupLeave(jid: string): Promise<any>
	groupInviteCode(jid: string): Promise<string>
	groupAcceptInvite(code: string): Promise<string>
	onWhatsApp(phoneNumber: string): Promise<{ exists: boolean; jid: string }>
	profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>
	updateProfileName(name: string): Promise<BinaryNode>
	updateProfileStatus(status: string): Promise<BinaryNode>
	sendPresenceUpdate(type: 'available' | 'unavailable' | 'composing' | 'paused', toJid?: string): Promise<boolean>
	presenceSubscribe(jid: string): Promise<void>
	logout(message?: string): Promise<void>
	end(error?: Error): Promise<void>
	getUserDevices(jid: string): Promise<Array<{ user: string; device: number; jid: string }>>
	on(event: 'connection.update', listener: (update: any) => void): this
	on(event: 'creds.update', listener: (creds: AuthenticationCreds) => void): this
	on(event: 'messages.upsert', listener: (payload: { messages: WAMessage[]; type: string }) => void): this
	on(event: 'messages.update', listener: (updates: any[]) => void): this
	on(event: 'message-receipt.update', listener: (updates: any[]) => void): this
	on(event: 'groups.update', listener: (updates: any[]) => void): this
	on(event: 'groups.upsert', listener: (groups: any[]) => void): this
	on(event: 'call', listener: (calls: any[]) => void): this
	on(event: string, listener: (...args: any[]) => void): this
}

export declare function makeWASocket(config?: SocketConfig): TobiSocket

export declare function useMultiFileAuthState(folder: string): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	deleteState: () => Promise<void>
}>

export declare function initAuthCreds(): AuthenticationCreds
export declare function signedKeyPair(identityKeyPair: KeyPair, keyId: number): SignedKeyPair
export declare function generateRegistrationId(): number

export declare const proto: any
export declare const WABinary: any
export declare const Signal: any

export declare const DisconnectReason: {
	connectionClosed: number
	connectionLost: number
	connectionReplaced: number
	timedOut: number
	loggedOut: number
	badSession: number
	restartRequired: number
	multideviceMismatch: number
	forbidden: number
	unavailableService: number
}

export declare const Browsers: {
	ubuntu: (b: string) => [string, string, string]
	macOS: (b: string) => [string, string, string]
	baileys: (b: string) => [string, string, string]
	windows: (b: string) => [string, string, string]
	appropriate: (b: string) => [string, string, string]
}

export declare const DEFAULT_CONNECTION_CONFIG: SocketConfig

/* ---------------- message builders ---------------- */

export declare function text(content: string): any
export declare function extendedText(content: string, options?: any): any
export declare function image(content: any): any
export declare function video(content: any): any
export declare function audio(content: any): any
export declare function document(content: any): any
export declare function sticker(content: any): any
export declare function viewOnce(content: any, kind?: 'image' | 'video' | 'audio'): any
export declare function buttons(content: {
	text?: string
	title?: string
	footer?: string
	buttons: Array<any>
	media?: any
}): any
export declare function quickReplyButton(button: { displayText: string; id: string }): any
export declare function urlButton(button: { displayText: string; url: string; merchantUrl?: string }): any
export declare function callButton(button: { displayText: string; phoneNumber: string }): any
export declare function copyButton(button: { displayText: string; copyCode: string }): any
export declare function singleSelectButton(button: { title: string; sections: any[] }): any
export declare function list(content: {
	text?: string
	title?: string
	footer?: string
	buttonText: string
	sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>
}): any
export declare function reaction(content: { text: string; key: WAMessageKey }): any
export declare function location(content: any): any
export declare function contact(vcard: string | any, displayName?: string): any
export declare function poll(content: { name: string; values: string[]; selectableCount?: number }): any
export declare function edit(message: any, key: WAMessageKey): any
export declare function deleteMessage(key: WAMessageKey): any

/* ---------------- media ---------------- */

export declare function prepareWAMessageMedia(socket: TobiSocket, message: any, options?: any): Promise<any>
export declare function downloadMediaMessage(socket: TobiSocket, message: any, options?: { filePath?: string }): Promise<any>
export declare function encryptMediaBuffer(buffer: Buffer, mediaType: string, mediaKey: Buffer): any
export declare function encryptMediaStream(filePath: string, mediaType: string, mediaKey: Buffer): Promise<any>
export declare function decryptMediaBuffer(encBuffer: Buffer, mediaType: string, mediaKey: Buffer): Buffer
export declare function getMediaKeys(mediaKey: Buffer, type: string): {
	iv: Buffer
	cipherKey: Buffer
	macKey: Buffer
	refKey: Buffer
}
export declare function getMediaType(mimeType?: string, fileName?: string): string

/* ---------------- utils ---------------- */

export declare function jidEncode(user: string, server: string, device?: number, agent?: number): string
export declare function jidDecode(jid: string): { user: string; server: string; device?: number; agent?: number } | undefined
export declare function jidNormalizedUser(jid: string): string
export declare function generateMessageIDV2(): string
export declare function generatePairingCode(): string
export declare function resolvePairingCode(custom?: string): string
export declare function formatPairingCode(code: string): string
export declare function isValidPairingCode(code: string): boolean
export declare function unixTimestampSeconds(date?: Date): number
export declare function delay(ms: number): Promise<void>
export declare const Logger: any
export declare const crypto: any
