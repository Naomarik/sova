#!/usr/bin/env node
// sova-whatsapp: run | pair [--code <digits>] | status [--json] | unlink --yes | check-config
// See docs/outreach/whatsapp.md for the guide and IPC.md for the protocol.
import { quietConsole } from '../src/quiet-console.mjs' // first: before any dependency can print keys
import { existsSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { resolveConfig, problems } from '../src/config.mjs'
import { makeLog } from '../src/log.mjs'
import { fileStore } from '../src/store.mjs'
import { Sender } from '../src/core.mjs'
import { serveIpc, socketAlive, connectIpc } from '../src/ipc.mjs'

// Every file this process creates (creds, signal keys, state) is owner-only.
process.umask(0o077)

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const out = (s = '') => process.stdout.write(s + '\n')
const die = (code, msg) => {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => rest.includes(`--${name}`)
const value = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined
}

let config
try {
  config = resolveConfig()
} catch (err) {
  die(2, `sova-whatsapp: ${err.message}`)
}
const log = makeLog(config.logLevel)
if (config.logLevel === 'debug') quietConsole((line) => log('debug', line))

function refuseOnProblems() {
  const p = problems(config)
  if (p.length) die(2, `sova-whatsapp refuses to start:\n${p.map((x) => `  - ${x}`).join('\n')}`)
}

/** The in-process sender: the one owner of the auth dir while it runs. */
async function startSender() {
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  refuseOnProblems()
  const { createBaileysDriver } = await import('../src/baileys.mjs')
  const driver = createBaileysDriver({ authDir: config.authDir, deviceName: config.deviceName, logLevel: config.logLevel, log })
  const core = new Sender({ config, store: fileStore(config), driver, log, version: VERSION })
  let ipc
  try {
    ipc = await serveIpc({ core, path: config.socket, log })
  } catch (err) {
    die(3, `sova-whatsapp: ${err.message}. Only one sender may own ${config.authDir}.`)
  }
  const shutdown = async (code = 0) => {
    core.stop() // ends the socket; never logs out
    await ipc.close()
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  return { core, ipc, shutdown }
}

function printQr(qr) {
  return import('qrcode-terminal').then(({ default: qrcode }) =>
    qrcode.generate(qr, { small: true }, (s) => out(`\nScan with the phone: WhatsApp → Settings → Linked devices → Link a device\n${s}`)),
  )
}

function describeStatus(s) {
  const lines = [`state:      ${s.state}${s.why ? ` — ${s.why}` : ''}`]
  if (s.retryAt) lines.push(`next try:   ${s.retryAt}`)
  lines.push(`paused:     ${s.paused ? 'yes' : 'no'}`)
  if (s.me) lines.push(`linked to:  ${s.me}`)
  lines.push(`sends:      ${s.usage.hour}/${s.limits.perHour} this hour, ${s.usage.day}/${s.limits.perDay} today (≥ ${s.limits.gapS} s apart)`)
  lines.push(`reconnects: ${s.reconnects.hour}/${s.reconnects.perHour} this hour, ${s.reconnects.day}/${s.reconnects.perDay} today`)
  lines.push(`version:    ${s.version}`)
  return lines.join('\n')
}

async function pair() {
  const phone = value('code')
  if (flag('code') && !phone) die(2, 'pair --code needs the phone number: digits, country code first, no +')
  let client
  let events
  let finish
  const done = new Promise((r) => (finish = r))
  const onEvent = (e) => {
    if (e.ev === 'qr') printQr(e.qr)
    if (e.ev === 'paired') {
      out(`Linked to ${e.me}. Waiting for the connection to settle…`)
    }
    if (e.ev === 'state' && e.state === 'open') finish(0)
    if (e.ev === 'state' && e.state === 'unpaired') {
      out(`Not linked: ${e.why}`)
      finish(1)
    }
  }
  let local
  if (await socketAlive(config.socket)) {
    // A sender is running: ask it to link, so it stays the only owner of the auth dir.
    client = await connectIpc(config.socket)
    client.onEvent(onEvent)
    await client.request('hello', { v: 1, since: Number.MAX_SAFE_INTEGER })
    events = (op, f) => client.request(op, f)
  } else {
    const { isPairedDir } = await import('../src/baileys.mjs')
    if (isPairedDir(config.authDir)) die(1, `Cannot pair: ${config.authDir} already holds a linked device. Unlink it first to link another.`)
    local = await startSender()
    local.core.start() // unpaired: it opens nothing until the link below
    local.core.on('event', onEvent)
    events = async (op, f) => local.core[op](f)
  }
  const r = await events('link', phone ? { phone } : {})
  if (!r.ok) die(1, `Cannot pair: ${r.why}`)
  if (r.pairingCode) out(`On the phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, and type: ${r.pairingCode}`)
  const code = await done
  if (code === 0) out('Paired and connected.')
  if (local) {
    await new Promise((r) => setTimeout(r, 5000)) // let the first key uploads and creds writes land
    await local.shutdown(code)
  }
  client?.close()
  process.exit(code)
}

async function status() {
  if (await socketAlive(config.socket)) {
    const client = await connectIpc(config.socket)
    const s = await client.request('status')
    client.close()
    return out(flag('json') ? JSON.stringify(s) : `running:    yes\n${describeStatus(s)}`)
  }
  const { isPairedDir } = await import('../src/baileys.mjs')
  const store = existsSync(config.stateFile) ? fileStore(config).state : null
  const offline = { running: false, paired: isPairedDir(config.authDir), hold: store?.hold ?? null, paused: store?.paused ?? false }
  if (flag('json')) return out(JSON.stringify(offline))
  out('running:    no')
  out(`paired:     ${offline.paired ? 'yes' : 'no'}`)
  if (offline.hold) out(`stopped as: ${offline.hold.state} — ${offline.hold.why}`)
  out(`paused:     ${offline.paused ? 'yes' : 'no'}`)
}

async function unlink() {
  if (!flag('yes')) die(2, 'unlink logs this device out of WhatsApp and deletes its credentials. Run it again with --yes to do it.')
  if (await socketAlive(config.socket)) {
    const client = await connectIpc(config.socket)
    const r = await client.request('unlink', { confirm: true })
    client.close()
    if (!r.ok) die(1, `Cannot unlink: ${r.why}`)
    return out(r.loggedOut ? 'Unlinked and credentials deleted.' : 'Credentials deleted. Also remove this device on the phone: WhatsApp → Linked devices.')
  }
  const local = await startSender()
  local.core.start()
  if (local.core.state === 'connecting') await local.core.waitOpen()
  const r = await local.core.unlink({ confirm: true })
  out(r.loggedOut ? 'Unlinked and credentials deleted.' : 'Credentials deleted. Also remove this device on the phone: WhatsApp → Linked devices.')
  await local.shutdown(0)
}

async function checkConfig() {
  const { isPairedDir } = await import('../src/baileys.mjs').catch(() => ({ isPairedDir: null }))
  const p = problems(config)
  const src = (k) => `(${config.sources[k]})`
  out(`home:             ${config.home} ${src('SOVA_WA_HOME')}`)
  out(`config file:      ${config.configFile}${existsSync(config.configFile) ? '' : ' (absent)'}`)
  out(`auth dir:         ${config.authDir} ${src('SOVA_WA_AUTH_DIR')}${existsSync(config.authDir) ? '' : ' (absent)'}`)
  out(`socket:           ${config.socket} ${src('SOVA_WA_SOCKET')}`)
  out(`limits:           ≥ ${config.limits.gapS} s apart, ${config.limits.perHour}/hour, ${config.limits.perDay}/day ${src('SOVA_WA_LIMITS')}`)
  out(`reconnect budget: ${config.reconnectBudget.perHour}/hour, ${config.reconnectBudget.perDay}/day ${src('SOVA_WA_RECONNECT_BUDGET')}`)
  out(`send wait:        ${config.sendWaitS} s ${src('SOVA_WA_SEND_WAIT_S')}`)
  out(`device name:      ${config.deviceName} ${src('SOVA_WA_DEVICE_NAME')}`)
  out(`log level:        ${config.logLevel} ${src('SOVA_WA_LOG_LEVEL')}`)
  if (isPairedDir) out(`paired:           ${isPairedDir(config.authDir) ? 'yes' : 'no'}`)
  else out('paired:           unknown (dependencies not installed: pnpm install --frozen-lockfile)')
  out(`running:          ${(await socketAlive(config.socket)) ? 'yes' : 'no'}`)
  if (p.length) die(1, `problems:\n${p.map((x) => `  - ${x}`).join('\n')}`)
  out('problems:         none')
}

const USAGE = `sova-whatsapp ${VERSION}: Sova's WhatsApp sender
  run                   hold the connection and serve Sova on the local socket
  pair [--code <digits>] link this host to a phone (QR, or a pairing code for that number)
  status [--json]       the sender's state, from the running sender or its files
  unlink --yes          log this device out and delete its credentials
  check-config          print the resolved configuration and any problem`

switch (cmd) {
  case 'run':
    ;(await startSender()).core.start()
    break
  case 'pair':
    await pair()
    break
  case 'status':
    await status()
    break
  case 'unlink':
    await unlink()
    break
  case 'check-config':
    await checkConfig()
    break
  case undefined:
  case 'help':
  case '--help':
    out(USAGE)
    break
  default:
    die(2, USAGE)
}
