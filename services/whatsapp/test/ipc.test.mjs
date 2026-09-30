import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveIpc, connectIpc } from '../src/ipc.mjs'
import { Sender, realClock } from '../src/core.mjs'
import { memoryStore } from '../src/store.mjs'
import { fakeDriver, baseConfig } from './helpers.mjs'

async function served() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-ipc-')))
  const path = join(dir, 'sender.sock')
  const driver = fakeDriver()
  const core = new Sender({ config: baseConfig({ authDir: join(dir, 'auth'), limits: { gapS: 0, perHour: 20, perDay: 60 } }), store: memoryStore(), driver, clock: realClock, version: 't' })
  const ipc = await serveIpc({ core, path })
  core.start()
  await new Promise((r) => setImmediate(r))
  driver.last.handlers.onOpen('15550001111')
  return { dir, path, core, driver, ipc }
}

const raw = (path, line) =>
  new Promise((resolve) => {
    const s = net.connect(path)
    let buf = ''
    s.on('data', (d) => {
      buf += d
      if (buf.includes('\n')) (s.end(), resolve(JSON.parse(buf.split('\n')[0])))
    })
    s.on('connect', () => s.write(line + '\n'))
  })

test('the socket is 0600, one sender per path, and bad lines get bad-request', async () => {
  const { path, core, ipc } = await served()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  await assert.rejects(serveIpc({ core, path }), /already listening/)
  assert.deepEqual(await raw(path, 'not json'), { id: null, ok: false, code: 'bad-request', retryable: false, why: 'not JSON' })
  assert.equal((await raw(path, '{"id":7,"op":"nope"}')).code, 'bad-request')
  assert.equal((await raw(path, '{"id":8,"op":"toString"}')).code, 'bad-request')
  core.stop()
  await ipc.close()
})

test('hello answers first, replays after `since`, then streams live events; no hello, no events', async () => {
  const { path, core, ipc } = await served()
  const quiet = await connectIpc(path)
  const heardQuiet = []
  quiet.onEvent((e) => heardQuiet.push(e))
  assert.equal((await quiet.request('status')).state, 'open')

  const c = await connectIpc(path)
  const heard = []
  c.onEvent((e) => heard.push(e))
  const h = await c.request('hello', { v: 1, since: 1 })
  assert.equal(h.ok, true)
  assert.equal(h.state, 'open')
  assert.ok(h.seq >= 2)
  assert.equal(typeof h.authDir, 'string')
  assert.equal((await c.request('hello', { v: 2 })).code, 'version')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(
    heard.map((e) => e.seq),
    core.store.events.filter((e) => e.seq > 1).map((e) => e.seq),
  )
  const sent = await c.request('send', { idem: 'local:1', digits: '15550002222', text: 'hi' })
  assert.equal(sent.ok, true)
  core.driver.last.handlers.onReceipt(sent.ref, 'delivered')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(heard.at(-1).ev, 'receipt')
  assert.equal(heard.at(-1).idem, 'local:1')
  assert.equal(heardQuiet.length, 0)
  quiet.close()
  c.close()
  core.stop()
  await ipc.close()
})
