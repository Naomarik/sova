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
