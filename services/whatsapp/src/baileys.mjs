// The one place that talks to Baileys: opens the socket on the auth dir and adapts it to the driver shape
// core.mjs expects. Inbound messages and the history bootstrap are never read; only our own messages'
// status updates are passed on, by message id.
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import makeWASocket, { Browsers, fetchLatestWaWebVersion, useMultiFileAuthState, proto } from '@whiskeysockets/baileys'
import { baileysLogger } from './log.mjs'

const S = proto.WebMessageInfo.Status
const RECEIPT = { [S.DELIVERY_ACK]: 'delivered', [S.READ]: 'read', [S.PLAYED]: 'read', [S.ERROR]: 'failed' }
const KEEP_SENT = 24 * 60 * 60e3

/** Paired means the phone accepted this device: pair-success writes `account` (a pairing code alone writes `me`). */
export function isPairedDir(authDir) {
  const file = join(authDir, 'creds.json')
  if (!existsSync(file)) return false
  try {
    const creds = JSON.parse(readFileSync(file, 'utf8'))
    return !!creds.me && !!creds.account
  } catch {
    return false
  }
}

export function createBaileysDriver({ authDir, deviceName, logLevel, log }) {
  let version // the WA Web version to claim; a stale bundled one shows up as 405 closes
  let versionFetched = false
  // Our own sent messages, in memory only, for a day: Baileys asks for them again when the recipient's
  // phone could not decrypt the first copy (a retry receipt). Never written to disk.
  const sent = new Map()

  async function refreshVersion() {
    const r = await fetchLatestWaWebVersion().catch((error) => ({ error }))
    versionFetched = true
    if (r.version && r.isLatest) version = r.version
    else log('warn', `could not fetch the current WA Web version (${r.error?.message ?? 'no answer'}); using the bundled one`)
  }

  return {
    isPaired: () => isPairedDir(authDir),
    refreshVersion,

    async wipe() {
      if (!existsSync(authDir)) return
      for (const name of readdirSync(authDir)) rmSync(join(authDir, name), { recursive: true, force: true })
    },

    async open({ handlers }) {
      mkdirSync(authDir, { recursive: true, mode: 0o700 })
      chmodSync(authDir, 0o700)
      if (!versionFetched) await refreshVersion()
      const { state, saveCreds } = await useMultiFileAuthState(authDir)
      const sock = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        browser: Browsers.ubuntu(deviceName),
        logger: baileysLogger(logLevel), // its own lines, at the configured level, redacted
        printQRInTerminal: false,
        markOnlineOnConnect: false, // stay "offline" so the phone keeps its notifications
        // The default history policy stays: turning sync off loses the LID mappings and privacy tokens that
        // 1:1 sends need. The bootstrap arrives in memory only and nothing here listens for it.
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => sent.get(key.id)?.message,
      })
      let firstQr
      const qrSeen = new Promise((r) => (firstQr = r))
      // What the WebSocket itself says as it ends, for the close's log line (core.mjs wireWords): its close
      // code (1006: no close frame came), and whether the server sent a stream error (WhatsApp's own 503, 515 …)
      // or ended the stream first. Prepended, so it is known before Baileys's own listeners turn it into a
      // connection.update; Baileys stops listening for the close once it ends the connection itself, so then
      // no WebSocket code is known. Codes and flags only, never a reason's text or a stanza.
      const wire = {}
      sock.ws.prependListener('close', (code) => {
        wire.wsCode = typeof code === 'number' ? code : undefined
        wire.closeFrame = typeof code === 'number' && code !== 1006
      })
      sock.ws.prependListener('CB:xmlstreamend', () => (wire.streamEnd = true))
      sock.ws.prependListener('CB:stream:error', () => (wire.streamError = true))
      sock.ev.on('creds.update', saveCreds)
      sock.ev.on('connection.update', (u) => {
        if (u.qr) {
          firstQr()
          handlers.onQr(u.qr)
        }
        if (u.connection === 'open') handlers.onOpen((sock.user?.id ?? '').split('@')[0].split(':')[0])
        if (u.connection === 'close') {
          const err = u.lastDisconnect?.error
          handlers.onClose(err?.output?.statusCode, err?.message, { ...wire })
        }
      })
      sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
          // By id only (the chat may be keyed by LID or number); the core drops ids it did not send.
          if (!key?.fromMe || update?.status == null) continue
          const status = RECEIPT[update.status]
          if (status) handlers.onReceipt(key.id, status, status === 'failed' ? update.messageStubParameters?.[0] : undefined)
        }
      })

      return {
        end: () => sock.end(undefined),
        logout: () => sock.logout(),
        async onWhatsApp(digits) {
          // Unknown numbers come back as [] (observed), sometimes as exists:false.
          const [hit] = (await sock.onWhatsApp(digits)) ?? []
          return { exists: !!hit?.exists, jid: hit?.jid }
        },
        async sendMessage(jid, text) {
          const msg = await sock.sendMessage(jid, { text, linkPreview: null })
          const now = Date.now()
          sent.set(msg.key.id, { message: msg.message, at: now })
          for (const [id, s] of sent) if (now - s.at > KEEP_SENT) sent.delete(id)
          return msg.key.id
        },
        async requestPairingCode(phone) {
          await qrSeen // the documented moment: the socket is up and asked for a QR
          return sock.requestPairingCode(phone)
        },
      }
    },
  }
}
