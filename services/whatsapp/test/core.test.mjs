import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rig, baseConfig } from './helpers.mjs'
import { memoryStore } from '../src/store.mjs'
import { HOUR, DAY, MINUTE } from '../src/core.mjs'

const SECOND = 1000
const msg = (idem, digits = '15550002222') => ({ idem, digits, text: 'Your link: https://example.com/h/x' })

// ---- start

test('start: unpaired opens nothing; paired connects once and spends one reconnect', async () => {
  const u = rig({ paired: false })
  u.core.start()
  await u.clock.tick(0)
  assert.equal(u.core.state, 'unpaired')
  assert.equal(u.driver.opens, 0)

  const p = rig()
  p.core.start()
  await p.open()
  assert.equal(p.core.state, 'open')
  assert.equal(p.driver.opens, 1)
  assert.equal(p.store.state.reconnects.length, 1)
  assert.equal(p.core.status().me, '…111')
})

// ---- reconnect budget and backoff

test('transient closes back off from 30 s, doubling, and stop at the hourly budget as down', async () => {
  const r = rig()
  r.core.start() // attempt 1 of 3 this hour
  await r.open()
  await r.close(428)
  assert.equal(r.core.state, 'connecting')
  assert.equal(r.core.retryAt - r.clock.now(), 30 * SECOND)
  await r.clock.tick(29 * SECOND)
  assert.equal(r.driver.opens, 1, 'no attempt before the backoff')
  await r.clock.tick(1 * SECOND)
  assert.equal(r.driver.opens, 2)
  await r.close(408) // closes before open: attempt 3 waits 60 s
  assert.equal(r.core.retryAt - r.clock.now(), 60 * SECOND)
  await r.clock.tick(60 * SECOND)
  assert.equal(r.driver.opens, 3)
  await r.close(503) // the budget (3/hour) is spent
  assert.equal(r.core.state, 'down')
  assert.match(r.core.why, /budget/)
  assert.deepEqual(r.store.state.hold.state, 'down')
  await r.clock.tick(2 * HOUR)
  assert.equal(r.driver.opens, 3, 'down never reconnects on its own')
})

test('backoff caps at 30 minutes and the daily budget holds too', async () => {
  const r = rig({ config: baseConfig({ reconnectBudget: { perHour: 100, perDay: 10 } }) })
  r.core.start()
  await r.clock.tick(0)
  const waits = []
  for (let i = 0; i < 9; i++) {
    await r.close(428)
    waits.push((r.core.retryAt - r.clock.now()) / MINUTE)
    await r.clock.tick(r.core.retryAt - r.clock.now())
  }
  assert.deepEqual(waits, [0.5, 1, 2, 4, 8, 16, 30, 30, 30])
  assert.equal(r.store.state.reconnects.length, 10)
  await r.close(428)
  assert.equal(r.core.state, 'down')
  assert.match(r.core.why, /last day/)
})

test('an open that lasts 10 minutes resets the backoff', async () => {
  const r = rig({ config: baseConfig({ reconnectBudget: { perHour: 10, perDay: 10 } }) })
  r.core.start()
  await r.open()
  await r.close(428)
  await r.clock.tick(30 * SECOND)
  await r.open()
  await r.clock.tick(10 * MINUTE)
  await r.close(428)
  assert.equal(r.core.retryAt - r.clock.now(), 30 * SECOND)
})

test('the budget and a hold survive a restart: a new process stays down and opens nothing', async () => {
  const store = memoryStore()
  const a = rig({ store })
  a.core.start()
  await a.open()
  await a.close(500)
  assert.equal(a.core.state, 'down')
  const b = rig({ store })
  b.core.start()
  await b.clock.tick(HOUR)
  assert.equal(b.core.state, 'down')
  assert.equal(b.driver.opens, 0)
  // The operator's Reconnect clears the hold and connects outside the budget.
  assert.equal(b.core.reconnect().ok, true)
  await b.open()
  assert.equal(b.core.state, 'open')
  assert.equal(store.state.hold, null)
})

test('the start itself spends the budget: restarts cannot loop past it', async () => {
  const store = memoryStore()
  for (let i = 0; i < 3; i++) {
    const r = rig({ store })
    r.core.start()
    await r.clock.tick(0)
    r.core.stop()
  }
  const r = rig({ store })
  r.core.start()
  await r.clock.tick(0)
  assert.equal(r.core.state, 'down')
  assert.equal(r.driver.opens, 0)
})

// ---- close codes

for (const [code, state] of [
  [401, 'logged-out'],
  [440, 'replaced'],
  [403, 'blocked'],
  [500, 'down'],
  [411, 'down'],
  [undefined, 'down'],
]) {
  test(`close ${code} → ${state}, held, never reconnected`, async () => {
    const r = rig()
    r.core.start()
    await r.open()
    await r.close(code)
    assert.equal(r.core.state, state)
    assert.equal(r.store.state.hold.state, state)
    await r.clock.tick(DAY)
    assert.equal(r.driver.opens, 1)
    assert.equal(r.driver.wiped, 0, 'creds are never deleted on their own')
    if (code === 403) assert.equal(r.store.state.paused, true)
  })
}

test('405 refetches the WA Web version once and retries at once; a second 405 is down', async () => {
  const r = rig()
  r.core.start()
  await r.clock.tick(0)
  await r.close(405)
  await r.clock.tick(0)
  assert.equal(r.driver.refreshed, 1)
  assert.equal(r.driver.opens, 2)
  await r.close(405)
  assert.equal(r.core.state, 'down')
  assert.equal(r.driver.refreshed, 1)
})

test('a QR on saved creds is never shown: the sender holds logged-out and ends the socket', async () => {
  const r = rig()
  r.core.start()
  await r.clock.tick(0)
  r.driver.last.handlers.onQr('2@abc')
  await r.clock.tick(0)
  assert.equal(r.core.state, 'logged-out')
  assert.equal(r.driver.last.ended, true)
  assert.equal(r.events.filter((e) => e.ev === 'qr').length, 0)
})

test('a stale socket closing after a newer one opened changes nothing', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const old = r.driver.last
  await r.close(428)
  await r.clock.tick(30 * SECOND)
  await r.open()
  old.handlers.onClose(401)
  await r.clock.tick(0)
  assert.equal(r.core.state, 'open')
})

test('reconnect is refused when open, unpaired or logged out', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  assert.equal(r.core.reconnect().code, 'open')
  await r.close(401)
  assert.equal(r.core.reconnect().code, 'needs-link')
  const u = rig({ paired: false })
  u.core.start()
  assert.equal(u.core.reconnect().code, 'needs-link')
})

// ---- limits

test('sends queue 3 s apart instead of being refused', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const times = []
  r.driver.sendImpl = async () => (times.push(r.clock.now()), `R${times.length}`)
  const a = r.core.send(msg('local:a'))
  const b = r.core.send(msg('local:b'))
  await r.clock.tick(10 * SECOND)
  assert.equal((await a).ok, true)
  assert.equal((await b).ok, true)
  assert.equal(times[1] - times[0], 3 * SECOND)
})

test('hourly and daily limits refuse with retryAt; pause refuses and keeps the connection', async () => {
  const r = rig({ config: baseConfig({ limits: { gapS: 0, perHour: 2, perDay: 3 } }) })
  r.core.start()
  await r.open()
  assert.equal((await r.core.send(msg('local:1'))).ok, true)
  await r.clock.tick(10 * MINUTE)
  assert.equal((await r.core.send(msg('local:2'))).ok, true)
  const limited = await r.core.send(msg('local:3'))
  assert.equal(limited.code, 'limited')
  assert.equal(limited.retryable, true)
  assert.equal(Date.parse(limited.retryAt), r.clock.now() - 10 * MINUTE + HOUR)
  await r.clock.tick(HOUR)
  assert.equal((await r.core.send(msg('local:3'))).ok, true, 'a refused idem may be tried again')
  const daily = await r.core.send(msg('local:4'))
  assert.equal(daily.code, 'limited')
  assert.match(daily.why, /daily/)
  assert.equal(r.core.pause({ on: true }).paused, true)
  await r.clock.tick(DAY)
  assert.equal((await r.core.send(msg('local:5'))).code, 'paused')
  assert.equal(r.core.state, 'open')
  r.core.pause({ on: false })
  assert.equal((await r.core.send(msg('local:5'))).ok, true)
})

// ---- idempotency

test('the same idem never sends twice within 24 h, also while in flight', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const [a, b] = await Promise.all([r.core.send(msg('local:x')), r.core.send(msg('local:x'))])
  assert.equal(r.driver.sent.length, 1)
  assert.equal(a.ref, b.ref)
  assert.equal(b.dup, true)
  await r.clock.tick(23 * HOUR)
  const c = await r.core.send(msg('local:x'))
  assert.equal(c.dup, true)
  assert.equal(r.driver.sent.length, 1)
  await r.clock.tick(2 * HOUR)
  const d = await r.core.send(msg('local:x'))
  assert.equal(d.dup, undefined)
  assert.equal(r.driver.sent.length, 2)
})

test('a send left in flight by a crash is unknown after restart and never resent', async () => {
  const store = memoryStore()
  const a = rig({ store })
  a.core.start()
  await a.open()
  a.driver.sendImpl = () => new Promise(() => {}) // WhatsApp never answers; the process "dies"
  a.core.send(msg('local:crash'))
  await a.clock.tick(0)
  assert.equal(store.state.idem['local:crash'].status, 'sending')
  const b = rig({ store })
  b.core.start()
  await b.open()
  const r = await b.core.send(msg('local:crash'))
  assert.equal(r.code, 'unknown')
  assert.equal(r.retryable, false)
  assert.equal(b.driver.sent.length, 0)
})

test('Baileys 428 on send means nothing went out: not-connected, retryable, idem free again', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  r.driver.sendImpl = async () => {
    throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } })
  }
  const a = await r.core.send(msg('local:y'))
  assert.equal(a.code, 'not-connected')
  assert.equal(a.retryable, true)
  r.driver.sendImpl = null
  await r.clock.tick(3 * SECOND)
  assert.equal((await r.core.send(msg('local:y'))).ok, true)
})

test('any other send error is recorded failed and answered again for that idem', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  r.driver.sendImpl = async () => {
    throw new Error('boom')
  }
  assert.equal((await r.core.send(msg('local:z'))).code, 'failed')
  r.driver.sendImpl = null
  const again = await r.core.send(msg('local:z'))
  assert.equal(again.code, 'failed')
  assert.equal(again.dup, true)
  assert.equal(r.driver.sent.length, 0)
})

// ---- validation, lookup, waiting

test('invalid requests, unknown numbers and a closed connection are refused plainly', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  assert.equal((await r.core.send({ idem: 'local:v', digits: '+15550002222', text: 'x' })).code, 'invalid')
  assert.equal((await r.core.send({ idem: 'local:v', digits: '123', text: 'x' })).code, 'invalid')
  assert.equal((await r.core.send({ idem: '', digits: '15550002222', text: 'x' })).code, 'invalid')
  assert.equal((await r.core.send({ idem: 'local:v', digits: '15550002222', text: 'x'.repeat(4097) })).code, 'invalid')
  r.driver.absent.add('15550009999')
  assert.equal((await r.core.send(msg('local:v', '15550009999'))).code, 'not-on-whatsapp')
  assert.deepEqual(await r.core.check({ digits: '15550009999' }), { ok: true, exists: false })
  assert.equal(r.driver.lookups, 1, 'lookups are cached')
  await r.close(401)
  assert.equal((await r.core.send(msg('local:w'))).code, 'logged-out')
})

test('a send waits for the connection up to the send wait, then says not-connected', async () => {
  const r = rig()
  r.core.start()
  await r.clock.tick(0) // connecting, not open yet
  const early = r.core.send(msg('local:early'))
  await r.clock.tick(2 * SECOND)
  r.driver.last.handlers.onOpen('15550001111')
  await r.clock.tick(0)
  assert.equal((await early).ok, true)
  await r.close(428)
  const late = r.core.send(msg('local:late'))
  await r.clock.tick(15 * SECOND)
  const res = await late
  assert.equal(res.code, 'not-connected')
  assert.equal(res.retryable, true)
})

// ---- receipts

test('receipts move forward only and carry the idem; unknown refs are ignored', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const { ref } = await r.core.send(msg('local:r'))
  const h = r.driver.last.handlers
  h.onReceipt(ref, 'delivered')
  h.onReceipt(ref, 'delivered')
  h.onReceipt(ref, 'read')
  h.onReceipt(ref, 'delivered')
  h.onReceipt('SOMEONE-ELSES', 'read')
  const receipts = r.events.filter((e) => e.ev === 'receipt')
  assert.deepEqual(
    receipts.map((e) => [e.ref, e.idem, e.status]),
    [
      [ref, 'local:r', 'delivered'],
      [ref, 'local:r', 'read'],
    ],
  )
})

test('ack error 463 fails the message, holds blocked, pauses, and later sends say restricted', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const { ref } = await r.core.send(msg('local:q'))
  r.driver.last.handlers.onReceipt(ref, 'failed', '463')
  await r.clock.tick(0)
  const failed = r.events.find((e) => e.ev === 'receipt')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.code, '463')
  assert.equal(r.core.state, 'blocked')
  assert.equal(r.store.state.paused, true)
  assert.equal((await r.core.send(msg('local:q2'))).code, 'restricted')
  assert.equal(r.driver.sent.length, 1, 'never resent')
})

// ---- linking and unlinking

test('link: QR frames, pair-success restart (515), then open and a paired event; refused while linked', async () => {
  const r = rig({ paired: false })
  r.core.start()
  const res = await r.core.link()
  assert.deepEqual(res, { ok: true, started: true })
  assert.equal(r.core.state, 'linking')
  r.driver.last.handlers.onQr('2@qr1')
  r.driver.paired = true // the phone scanned: pair-success writes the creds
  r.driver.last.handlers.onClose(515)
  await r.clock.tick(0)
  assert.equal(r.driver.opens, 2)
  await r.open('15550003333')
  assert.equal(r.core.state, 'open')
  assert.deepEqual(r.events.filter((e) => e.ev === 'qr').map((e) => e.qr), ['2@qr1'])
  assert.equal(r.events.find((e) => e.ev === 'paired').me, '…333')
  assert.equal(r.store.events.some((e) => e.ev === 'qr' || e.ev === 'paired'), false, 'qr and paired are never kept')
  assert.equal(r.store.state.reconnects.length, 0, 'linking spends no reconnect budget')
  assert.equal((await r.core.link()).code, 'linked')
})

test('link with a phone returns a pairing code and shows no QR; an expired link is unpaired again', async () => {
  const r = rig({ paired: false })
  r.core.start()
  const res = await r.core.link({ phone: '15550004444' })
  assert.equal(res.pairingCode, 'ABCD1234')
  r.driver.last.handlers.onQr('2@qr')
  await r.close(408)
  assert.equal(r.events.filter((e) => e.ev === 'qr').length, 0)
  assert.equal(r.core.state, 'unpaired')
  assert.match(r.core.why, /expired/)
})

test('unlink needs confirm, logs out when connected and wipes the creds', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  assert.equal((await r.core.unlink({})).code, 'bad-request')
  const h = r.driver.last
  const res = await r.core.unlink({ confirm: true })
  assert.equal(res.loggedOut, true)
  assert.equal(h.loggedOut, true)
  assert.equal(r.driver.wiped, 1)
  assert.equal(r.core.state, 'unpaired')
})

// ---- events

test('events are kept for replay with a monotonic seq; a gap is reported past the ring', async () => {
  const r = rig()
  r.core.start()
  await r.open()
  const seq = r.store.state.seq
  assert.ok(seq >= 2)
  assert.deepEqual(r.core.eventsSince(seq - 1).events.map((e) => e.seq), [seq])
  assert.equal(r.core.eventsSince(seq - 1).gap, false)
  for (let i = 0; i < 600; i++) r.core.pause({ on: i % 2 === 0 })
  assert.equal(r.store.events.length, 500)
  assert.equal(r.core.eventsSince(1).gap, true)
})
