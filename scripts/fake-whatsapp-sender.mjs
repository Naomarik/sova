#!/usr/bin/env node
// A stand-in for the WhatsApp sender (services/whatsapp) in hermetic runs, like fake-claude.mjs for `claude`.
// It runs the sender's real state machine and IPC (services/whatsapp/src) over a fake WhatsApp: no Baileys,
// no network, no credentials, no `pnpm install` in services/whatsapp. Protocol: services/whatsapp/IPC.md.
//
//   PI_CODING_AGENT_DIR=$PWD/.agent node scripts/fake-whatsapp-sender.mjs [--unpaired]
//   node scripts/fake-whatsapp-sender.mjs ctl close 401 | ctl ack-error 463 | ctl send-throw | ctl open-fail [n]
//
// It listens where the real sender would ($SOVA_WA_SOCKET, else <PI_CODING_AGENT_DIR>/sova/whatsapp/sender.sock)
// and refuses to run on the real default directory. Every number exists except those in SOVA_WA_FAKE_ABSENT
// (comma-separated digits); receipts follow SOVA_WA_FAKE_RECEIPTS: delivered,read (default) | delivered | none.
// SOVA_WA_FAKE_TIME_SCALE=<n> runs the sender's clock n times faster (60: an hour's reconnect wait takes a
// minute), so a budget wait can be watched end to end; its times (retryAt, events) are on that fast clock.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../services/whatsapp/src/config.mjs'
import { fileStore } from '../services/whatsapp/src/store.mjs'
import { Sender } from '../services/whatsapp/src/core.mjs'
import { serveIpc, connectIpc } from '../services/whatsapp/src/ipc.mjs'
import { makeLog } from '../services/whatsapp/src/log.mjs'
import { acquireLock } from '../services/whatsapp/src/lock.mjs'
import { mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
const env = process.env
let config
try {
  config = resolveConfig(env)
} catch (err) {
  process.stderr.write(`fake-whatsapp-sender: ${err.message}\n`)
  process.exit(2)
}

if (argv[0] === 'ctl') {
  const [, what, code] = argv
  const c = await connectIpc(config.socket).catch((err) => {
    process.stderr.write(`fake-whatsapp-sender: no sender answers on ${config.socket} (${err.code || err.message})\n`)
    process.exit(1)
  })
  const r = await c.request('fake', { do: what, ...(code ? { code: Number(code) } : {}) })
  process.stdout.write(JSON.stringify(r) + '\n')
  c.close()
  process.exit(r.ok ? 0 : 1)
}

const realDefault = join(homedir(), '.pi/agent/sova/whatsapp')
if (!env.PI_CODING_AGENT_DIR && !env.SOVA_WA_HOME) {
  process.stderr.write('fake-whatsapp-sender: set PI_CODING_AGENT_DIR (e.g. $PWD/.agent) or SOVA_WA_HOME; it never runs on the real default directory\n')
  process.exit(2)
}
if (config.home === realDefault || config.authDir.startsWith(realDefault)) {
  process.stderr.write(`fake-whatsapp-sender: refusing to run on the real sender directory ${realDefault}\n`)
  process.exit(2)
}

// The same one-sender-per-home lock as the real sender.
mkdirSync(config.home, { recursive: true, mode: 0o700 })
let lock
try {
  lock = acquireLock(config.lockFile)
} catch (err) {
  process.stderr.write(`fake-whatsapp-sender: ${err.message}\n`)
  process.exit(3)
}
process.on('exit', () => lock.release())

const log = makeLog(env.SOVA_WA_LOG_LEVEL || 'info')
const absent = new Set((env.SOVA_WA_FAKE_ABSENT || '').split(',').map((s) => s.trim()).filter(Boolean))
const receipts = (env.SOVA_WA_FAKE_RECEIPTS ?? 'delivered,read').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none')
const ME = '0000000000'

let paired = !argv.includes('--unpaired')
let current = null // the open fake socket's handlers
const next = { ackError: null, sendThrow: false, openFail: 0 }

// The sender's clock, SOVA_WA_FAKE_TIME_SCALE times faster than the wall's (1: the real clock).
const scale = Number(env.SOVA_WA_FAKE_TIME_SCALE || 1)
if (!(scale >= 1)) {
  process.stderr.write('fake-whatsapp-sender: SOVA_WA_FAKE_TIME_SCALE must be a number ≥ 1\n')
  process.exit(2)
}
const t0 = Date.now()
const clock = {
  now: () => t0 + (Date.now() - t0) * scale,
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms) / scale),
  clearTimeout: (t) => clearTimeout(t),
}
let n = 0

const driver = {
  isPaired: () => paired,
  refreshVersion: async () => {},
  wipe: async () => {
    paired = false
  },
  async open({ link, handlers }) {
    if (!link && next.openFail > 0) {
      next.openFail--
      throw new Error('fake: the connection could not be opened')
    }
    current = handlers
    const alive = () => current === handlers
    if (link) {
      // Two QR refreshes, then the phone "scans": pair-success, then WhatsApp's restart request (515).
      setTimeout(() => alive() && handlers.onQr(`FAKE-QR-${Date.now()}-1`), 100)
      setTimeout(() => alive() && handlers.onQr(`FAKE-QR-${Date.now()}-2`), 1000)
      setTimeout(() => {
        if (!alive()) return
        paired = true
        handlers.onClose(515, 'restart required')
      }, 2000)
    } else {
      setTimeout(() => alive() && (paired ? handlers.onOpen(ME) : handlers.onQr('FAKE-QR-unexpected')), 300)
    }
    return {
      end: () => alive() && (current = null),
      logout: async () => {
        paired = false
      },
      onWhatsApp: async (digits) => ({ exists: !absent.has(digits), jid: `${digits}@s.whatsapp.net` }),
      async sendMessage() {
        if (next.sendThrow) {
          next.sendThrow = false
          throw new Error('fake: the socket threw')
        }
        const ref = `FAKE${(++n).toString(16).padStart(8, '0').toUpperCase()}`
        if (next.ackError) {
          const code = next.ackError
          next.ackError = null
          setTimeout(() => handlers.onReceipt(ref, 'failed', String(code)), 300)
        } else {
          receipts.forEach((status, i) => setTimeout(() => handlers.onReceipt(ref, status, undefined), 500 * (i + 1)))
        }
        return ref
      },
      requestPairingCode: async () => 'FAKE1234',
    }
  },
}

const core = new Sender({ config, store: fileStore(config), driver, clock, log, version: 'fake' })
const ipc = await serveIpc({
  core,
  path: config.socket,
  log,
  extraOps: {
    fake(req) {
      switch (req.do) {
        case 'close':
          if (!current) return { ok: false, code: 'not-connected', retryable: false, why: 'No fake connection to close.' }
          current.onClose(Number(req.code), 'fake close', { wsCode: 1006, closeFrame: false })
          return { ok: true }
        case 'open-fail':
          // The next `code` opens (default 1) throw, as a network that refuses the connection would.
          next.openFail = Number(req.code) || 1
          return { ok: true }
        case 'ack-error':
          next.ackError = Number(req.code) || 463
          return { ok: true }
        case 'send-throw':
          next.sendThrow = true
          return { ok: true }
      }
      return { ok: false, code: 'bad-request', retryable: false, why: 'fake do: close | ack-error | send-throw | open-fail' }
    },
  },
}).catch((err) => {
  process.stderr.write(`fake-whatsapp-sender: ${err.message}\n`)
  process.exit(3)
})
const stop = async () => {
  core.stop()
  await ipc.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
core.start()
log('info', `fake WhatsApp sender listening on ${config.socket} (${paired ? 'paired' : 'unpaired'})`)
