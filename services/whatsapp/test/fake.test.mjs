// scripts/fake-whatsapp-sender.mjs as Sova's hermetic tests run it: a real process on a temp home.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectIpc } from '../src/ipc.mjs'

const fake = fileURLToPath(new URL('../../../scripts/fake-whatsapp-sender.mjs', import.meta.url))
const home = realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-fake-')))
after(() => rmSync(home, { recursive: true, force: true }))

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('the fake serves IPC, sends with receipts, and exits promptly on SIGTERM with a client connected', async () => {
  const child = spawn(process.execPath, [fake], { env: { PATH: process.env.PATH, SOVA_WA_HOME: home, SOVA_WA_LOG_LEVEL: 'warn' }, stdio: 'ignore' })
  const sock = join(home, 'sender.sock')
  await waitFor(() => existsSync(sock))
  const c = await connectIpc(sock)
  const events = []
  c.onEvent((e) => events.push(e))
  await c.request('hello', { v: 1 })
  await waitFor(() => events.some((e) => e.ev === 'state' && e.state === 'open'))
  const sent = await c.request('send', { idem: 'local:t', digits: '15550001234', text: 'hi' })
  assert.equal(sent.ok, true)
  await waitFor(() => events.some((e) => e.ev === 'receipt' && e.status === 'read'))
  const t = Date.now()
  const exited = new Promise((r) => child.once('exit', (code) => r(code)))
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.ok(Date.now() - t < 2000, `exit took ${Date.now() - t} ms`)
  assert.equal(existsSync(sock), false)
})

test('a second fake on the same home refuses while the first holds the lock', async () => {
  const env = { PATH: process.env.PATH, SOVA_WA_HOME: home, SOVA_WA_LOG_LEVEL: 'warn' }
  const first = spawn(process.execPath, [fake], { env, stdio: 'ignore' })
  await waitFor(() => existsSync(join(home, 'sender.sock')))
  const second = spawn(process.execPath, [fake], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  second.stderr.on('data', (d) => (err += d))
  const code = await new Promise((r) => second.once('exit', r))
  assert.equal(code, 3)
  assert.match(err, /holds .*sender\.lock/)
  const exited = new Promise((r) => first.once('exit', r))
  first.kill('SIGTERM')
  await exited
})

test('a fake link: QRs refresh, expire (408), and `scan` pairs; a pairing code links the same way', async () => {
  const linkHome = realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-fake-link-')))
  const env = { PATH: process.env.PATH, SOVA_WA_HOME: linkHome, SOVA_WA_LOG_LEVEL: 'warn', SOVA_WA_FAKE_QR_MS: '150' }
  const child = spawn(process.execPath, [fake, '--unpaired'], { env, stdio: 'ignore' })
  try {
    const sock = join(linkHome, 'sender.sock')
    await waitFor(() => existsSync(sock))
    const c = await connectIpc(sock)
    const events = []
    c.onEvent((e) => events.push(e))
    await c.request('hello', { v: 1 })
    const scan = () => c.request('fake', { do: 'scan' })
    assert.equal((await scan()).code, 'not-linking')
    // Left alone: 5 QRs, each new, then it expires.
    assert.equal((await c.request('link', {})).started, true)
    await waitFor(() => events.some((e) => e.ev === 'state' && e.state === 'unpaired' && /expired/.test(e.why)))
    const qrs = events.filter((e) => e.ev === 'qr').map((e) => e.qr)
    assert.equal(qrs.length, 5)
    assert.equal(new Set(qrs).size, 5)
    // Scanned: paired, then open.
    events.length = 0
    await c.request('link', {})
    await waitFor(() => events.some((e) => e.ev === 'qr'))
    assert.equal((await scan()).ok, true)
    await waitFor(() => events.some((e) => e.ev === 'paired'))
    await waitFor(() => events.some((e) => e.ev === 'state' && e.state === 'open'))
    // Unlink, then a pairing code: no QR, and the scan links it.
    assert.equal((await c.request('unlink', { confirm: true })).state, 'unpaired')
    events.length = 0
    const r = await c.request('link', { phone: '15550001234' })
    assert.equal(r.pairingCode, 'FAKE1234')
    assert.equal((await scan()).ok, true)
    await waitFor(() => events.some((e) => e.ev === 'state' && e.state === 'open'))
    assert.equal(events.filter((e) => e.ev === 'qr').length, 0)
    c.close()
  } finally {
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    await exited
    rmSync(linkHome, { recursive: true, force: true })
  }
})
