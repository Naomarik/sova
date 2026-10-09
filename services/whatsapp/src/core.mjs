// The sender's state machine: one connection, minimal reconnects, per-number limits, idempotent sends.
// It knows nothing about Baileys (see baileys.mjs, the driver) or the socket protocol (see ipc.mjs),
// so the fake sender and the unit tests run exactly this code.
import { EventEmitter } from 'node:events'
import { EVENT_RING } from './store.mjs'
import { maskMe } from './log.mjs'

export const MINUTE = 60e3
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const IDEM_TTL = DAY // the same idem never sends twice within this
const RECORD_TTL = 7 * DAY // records stay this long so late receipts still find their idem
const BACKOFF_FIRST = 30e3
const BACKOFF_MAX = 30 * MINUTE
const STABLE_OPEN = 10 * MINUTE // an open this long resets the backoff
const LINK_MAX = 3 * MINUTE // a link attempt nobody finishes ends here at the latest
const CHECK_TTL = DAY
const MAX_TEXT = 4096

/** Close codes worth one more try after a backoff (WhatsApp's routine drops and restarts). */
export const TRANSIENT = new Set([428, 408, 503, 515])

/** The close codes that stop the sender until a person acts: everything else WhatsApp or the network
    can cause is ridden out, after a backoff or at the reconnect budget's next free slot. */
export const HELD = new Set([401, 440, 403])

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
}

const fail = (code, why, extra = {}) => ({ ok: false, code, retryable: code === 'not-connected' || code === 'limited', why, ...extra })
const DIGITS = /^\d{7,15}$/

const RANK = { delivered: 1, read: 2, failed: 3 }

/**
 * What the WebSocket said as it ended, for the log (is it WhatsApp ending the connection, or the path to
 * it?): whether the server sent a stream error or ended the stream, the WebSocket's close code and whether
 * a close frame came (1006 = none: the connection just dropped). Codes and flags only, never a reason's text.
 */
export function wireWords(wire) {
  if (!wire) return ''
  const parts = []
  if (wire.streamError) parts.push('server sent a stream error')
  if (wire.streamEnd) parts.push('server ended the stream')
  if (typeof wire.wsCode === 'number') parts.push(`websocket ${wire.wsCode}`, wire.closeFrame ? 'close frame received' : 'no close frame')
  else parts.push('websocket closed by the sender')
  return ` [${parts.join(', ')}]`
}

export class Sender extends EventEmitter {
  /**
   * driver: {isPaired(), open({link, handlers}) → handle, refreshVersion(), wipe()} where a handle is
   * {end(), logout(), onWhatsApp(digits) → {exists, jid}, sendMessage(jid, text) → ref, requestPairingCode(phone)}.
   */
  constructor({ config, store, driver, clock = realClock, log = () => {}, version = '0.0.0' }) {
    super()
    this.config = config
    this.store = store
    this.driver = driver
    this.clock = clock
    this.log = log
    this.version = version
    this.state = 'connecting'
    this.why = undefined
    this.retryAt = undefined
    this.me = undefined
    this.sock = null // the open handle
    this.pending = null // the handle being opened
    this.gen = 0 // bumps on every open, so a stale socket's late events are ignored
    this.streak = 0 // transient closes since the last stable open
    this.openedAt = 0
    this.versionRefetched = false
    this.linking = null // {phone?} while a link is in progress
    this.retryTimer = null
    this.linkTimer = null
    this.inflight = new Map() // idem → Promise of the result
    this.checks = new Map() // digits → {exists, jid, at}; memory only
    this.queue = Promise.resolve()
    this.lastSendAt = 0
    this.stopped = false
  }

  get s() {
    return this.store.state
  }

  now() {
    return this.clock.now()
  }

  sleep(ms) {
    return new Promise((r) => this.clock.setTimeout(r, Math.max(0, ms)))
  }

  // ---- lifecycle

  start() {
    let changed = false
    for (const rec of Object.values(this.s.idem)) {
      // Handed to WhatsApp (maybe) but never recorded as sent: the outcome is unknown, and stays so.
      if (rec.status === 'sending') (rec.status = 'unknown'), (changed = true)
    }
    this.prune()
    // An older sender held `down` for good after a spent budget, a bad session (500), an unknown close or a
    // failed open. Each is a wait now, so that hold is dropped and this start retries within the budget. A
    // second 405 (the sender needs an update) and an unreadable state.json stay held for a person.
    const h = this.s.hold
    if (h?.state === 'down' && h.code !== 405 && h.code !== 'unreadable') {
      this.log('warn', `dropping a saved down hold (${h.why}): the sender retries on its own now`)
      this.s.hold = null
      changed = true
    }
    if (changed) this.save()
    if (this.s.hold) return this.setState(this.s.hold.state, this.s.hold.why)
    if (!this.driver.isPaired()) return this.setState('unpaired', 'No device is linked yet: run `sova-whatsapp pair` on this host.')
    this.connect('start')
  }

  stop() {
    this.stopped = true
    this.clearRetry()
    this.clock.clearTimeout(this.linkTimer)
    this.endSock()
  }

  save() {
    this.store.saveState()
  }

  prune() {
    const now = this.now()
    this.s.reconnects = this.s.reconnects.filter((t) => now - t < DAY)
    this.s.sends = this.s.sends.filter((t) => now - t < DAY)
    for (const [k, rec] of Object.entries(this.s.idem)) if (now - rec.at >= RECORD_TTL) delete this.s.idem[k]
  }

  setState(state, why, retryAt) {
    if (this.state === state && this.why === why && this.retryAt === retryAt) return
    this.state = state
    this.why = state === 'open' ? undefined : why
    this.retryAt = retryAt
    if (state !== 'connecting' || !retryAt) this.log(state === 'open' ? 'info' : 'warn', `state ${state}${why ? `: ${why}` : ''}`)
    else this.log('warn', `state ${state}: ${why} Next attempt at ${new Date(retryAt).toISOString()}.`)
    this.event('state', this.stateFields())
    this.emit('state', state)
  }

  stateFields() {
    return { state: this.state, why: this.why, retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : undefined, paused: this.s.paused }
  }

  /** A stop that survives restarts: no automatic connection until an operator acts. */
  hold(state, why, code) {
    this.clearRetry()
    this.s.hold = { state, why, ...(code ? { code } : {}) }
    if (state === 'blocked') this.s.paused = true
    this.save()
    this.endSock()
    this.setState(state, why)
  }

  endSock() {
    const h = this.sock || this.pending
    this.sock = null
    this.pending = null
    this.gen++ // whatever that socket says next is stale
    if (h) {
      try {
        h.end()
      } catch {}
    }
  }

  clearRetry() {
    this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  budget() {
    const now = this.now()
    const hour = this.s.reconnects.filter((t) => now - t < HOUR).length
    const day = this.s.reconnects.filter((t) => now - t < DAY).length
    return { hour, day, ...this.config.reconnectBudget }
  }

  /** Records one automatic attempt; false, recording nothing, when the budget is spent. */
  spendBudget() {
    this.prune()
    const b = this.budget()
    if (b.hour >= b.perHour || b.day >= b.perDay) return false
    this.s.reconnects.push(this.now())
    this.save()
    return true
  }

  /** When the budget has a slot again: the attempt that has to leave each window leaves it. */
  nextSlot() {
    const now = this.now()
    const { perHour, perDay } = this.config.reconnectBudget
    const sorted = [...this.s.reconnects].sort((a, b) => a - b)
    let at = now
    for (const [span, per] of [
      [HOUR, perHour],
      [DAY, perDay],
    ]) {
      const inside = sorted.filter((t) => now - t < span)
      if (inside.length >= per) at = Math.max(at, inside[inside.length - per] + span)
    }
    return at
  }

  /**
   * The budget is spent: `down` until its next free slot, then one automatic attempt, on its own.
   * `cause` says what ended the connection. A budget of 0 never refills: held for a person.
   */
  waitForBudget(cause) {
    this.clearRetry()
    this.endSock()
    const b = this.budget()
    const day = b.day >= b.perDay
    const per = day ? b.perDay : b.perHour
    const limit = `The reconnect limit of ${per} ${day ? 'a day' : 'an hour'} is reached.`
    const why = cause ? `${cause} ${limit}` : limit
    if (per <= 0) return this.hold('down', `${why} Automatic reconnects are off (SOVA_WA_RECONNECT_BUDGET).`)
    const at = this.nextSlot()
    this.setState('down', why, at)
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      this.connect('auto')
    }, at - this.now())
  }

  /** kind: start | auto (both spend the budget) | scheduled (spent when scheduled) | operator | relink (the restart right after pairing). */
  async connect(kind) {
    if (this.stopped) return
    if ((kind === 'start' || kind === 'auto') && !this.spendBudget()) return void this.waitForBudget('')
    this.clearRetry()
    this.endSock()
    const gen = this.gen
    const linking = !!this.linking && kind === 'link'
    this.setState(linking ? 'linking' : 'connecting', linking ? 'Waiting for the phone to link this device.' : 'Connecting to WhatsApp.')
    const live = () => gen === this.gen && !this.stopped
    const handlers = {
      onQr: (qr) => live() && this.onQr(qr),
      onOpen: (me) => live() && this.onOpen(me),
      onClose: (code, message, wire) => live() && this.onClose(code, message, wire),
      onReceipt: (ref, status, code) => this.onReceipt(ref, status, code),
    }
    let handle
    try {
      handle = await this.driver.open({ link: linking, handlers })
    } catch (err) {
      if (!live()) return
      this.log('error', `open failed: ${err.message}`)
      if (this.linking) return this.endLink(`Linking failed: ${err.message}`)
      // The network or WhatsApp: tried again after a backoff, within the budget, like a transient close.
      return void this.scheduleReconnect(undefined, undefined, `The connection could not be opened: ${err.message}`)
    }
    if (!live()) {
      try {
        handle.end()
      } catch {}
      return
    }
    if (this.state === 'open') this.sock = handle // opened while awaiting
    else this.pending = handle
    if (linking && this.linking.phone) {
      try {
        this.linking.code = await handle.requestPairingCode(this.linking.phone)
      } catch (err) {
        this.linking.codeError = err.message
      }
    }
    return handle
  }

  onQr(qr) {
    if (this.linking) {
      if (!this.linking.phone) this.event('qr', { qr }, { keep: false })
      return
    }
    // Never pair on our own: saved creds that WhatsApp answers with a QR are not accepted any more.
    this.hold('logged-out', 'WhatsApp asked to link this device again: the saved credentials were not accepted.')
  }

  onOpen(me) {
    this.sock = this.pending || this.sock
    this.pending = null
    this.me = me
    this.openedAt = this.now()
    if (this.linking) {
      this.clock.clearTimeout(this.linkTimer)
      this.linking = null
      this.event('paired', { me: maskMe(me) }, { keep: false })
    }
    if (this.s.hold) {
      this.s.hold = null
      this.save()
    }
    this.setState('open')
  }

  /** `wire`: what the WebSocket itself said ({wsCode?, closeFrame?, streamEnd?}), for the log only. */
  onClose(code, message, wire) {
    const wasOpenFor = this.openedAt ? this.now() - this.openedAt : 0
    this.openedAt = 0
    this.sock = null
    this.pending = null
    this.gen++
    if (wasOpenFor >= STABLE_OPEN) this.streak = 0
    this.log('warn', `connection closed: ${code ?? 'no code'}${message ? ` (${message})` : ''}${wireWords(wire)}`)
    if (this.linking) {
      // Pairing ends with WhatsApp asking for a restart (515): that one reconnect finishes the link.
      if (code === 515 && this.driver.isPaired()) return void this.connect('relink')
      if (code !== 408) return this.endLink(`Linking stopped (${code ?? 'closed'}).`)
      return this.endLink(this.linking.phone ? 'The pairing code expired before it was typed on the phone.' : 'The QR code expired before the phone scanned it.')
    }
    switch (code) {
      case 401:
        return this.hold('logged-out', 'The phone unlinked this device (401). Its credentials are kept.', 401)
      case 440:
        return this.hold('replaced', 'Another process opened these credentials (440).', 440)
      case 403:
        return this.hold('blocked', 'WhatsApp refused this account (403), possibly a ban. Sending is paused.', 403)
      case 500:
        return this.scheduleReconnect(500, undefined, 'WhatsApp reported a bad session (500).')
      case 405:
        if (!this.versionRefetched) {
          this.versionRefetched = true
          return void this.refetchAndReconnect()
        }
        return this.hold('down', 'WhatsApp rejects this WA Web version (405) even after refetching it: update the sender.', 405)
    }
    if (TRANSIENT.has(code)) return this.scheduleReconnect(code)
    this.scheduleReconnect(code, undefined, `The connection closed with ${code ?? 'no code'}.`)
  }

  async refetchAndReconnect() {
    try {
      await this.driver.refreshVersion()
    } catch (err) {
      this.log('warn', `version refetch failed: ${err.message}`)
    }
    this.scheduleReconnect(405, 0)
  }

  /** One automatic attempt after a backoff, `connecting` meanwhile; past the budget, `down` until its next slot. */
  scheduleReconnect(code, delay, why = `WhatsApp closed the connection (${code}).`) {
    if (!this.spendBudget()) return this.waitForBudget(why)
    this.clearRetry()
    this.streak++
    const wait = delay ?? Math.min(BACKOFF_FIRST * 2 ** (this.streak - 1), BACKOFF_MAX)
    const at = this.now() + wait
    this.setState('connecting', why, at)
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      this.connect('scheduled')
    }, wait)
  }

  // ---- operator ops

  reconnect() {
    if (this.state === 'open') return fail('open', 'Already connected.')
    if (this.linking) return fail('busy', 'A link is in progress.')
    if (this.state === 'unpaired' || this.state === 'logged-out' || !this.driver.isPaired()) {
      return fail('needs-link', 'No usable linked device: unlink if needed, then pair.')
    }
    this.s.hold = null
    this.save()
    this.streak = 0
    this.versionRefetched = false
    this.connect('operator')
    return { ok: true, state: this.state }
  }

  async link({ phone, cancel } = {}) {
    if (cancel === true) {
      if (!this.linking) return fail('not-linking', 'No link is in progress.')
      this.endLink('Linking was cancelled.')
      return { ok: true, state: this.state }
    }
    if (this.linking) return fail('busy', 'A link is already in progress.')
    if (this.driver.isPaired()) return fail('linked', 'A device is already linked. Unlink it first to link another.')
    if (phone != null && !DIGITS.test(String(phone))) return fail('invalid', 'The phone number must be 7 to 15 digits, country code first, no +.')
    this.clearRetry()
    this.s.hold = null
    this.save()
    // Not paired, so whatever is in the auth dir is a half-finished link (a pairing code writes `me` before
    // the phone accepts, and Baileys would then try a login instead of a registration): start clean.
    this.linking = { phone: phone != null ? String(phone) : undefined }
    await this.driver.wipe()
    this.linkTimer = this.clock.setTimeout(() => this.linking && this.endLink('Nobody finished linking in time.'), LINK_MAX)
    const handle = await this.connect('link')
    if (!handle || !this.linking) return fail('failed', this.why || 'Linking could not start.')
    if (this.linking.phone) {
      if (!this.linking.code) {
        const why = `No pairing code: ${this.linking.codeError || 'WhatsApp did not answer'}`
        this.endLink(why)
        return fail('failed', why)
      }
      return { ok: true, started: true, pairingCode: this.linking.code }
    }
    return { ok: true, started: true }
  }

  endLink(why) {
    this.clock.clearTimeout(this.linkTimer)
    this.linking = null
    this.endSock()
    this.setState('unpaired', why)
  }

  async unlink({ confirm } = {}) {
    if (confirm !== true) return fail('bad-request', 'unlink needs {confirm: true}: it logs this device out and deletes its credentials.')
    this.clearRetry()
    if (this.linking) {
      this.clock.clearTimeout(this.linkTimer)
      this.linking = null
    }
    let loggedOut = false
    const h = this.state === 'open' ? this.sock : null
    this.gen++ // the logout's own 401 close is ours, not news
    if (h) {
      try {
        await Promise.race([h.logout(), this.sleep(10_000).then(() => Promise.reject(new Error('timed out')))])
        loggedOut = true
      } catch (err) {
        this.log('warn', `logout failed: ${err.message}`)
      }
    }
    this.endSock()
    await this.driver.wipe()
    this.me = undefined
    this.s.hold = null
    this.save()
    this.setState(
      'unpaired',
      loggedOut ? 'Unlinked: the device is logged out and its credentials are deleted.' : 'Credentials deleted. Also remove this device on the phone: WhatsApp → Linked devices.',
    )
    return { ok: true, state: 'unpaired', loggedOut }
  }

  pause({ on } = {}) {
    if (typeof on !== 'boolean') return fail('bad-request', 'pause needs {on: true|false}.')
    if (this.s.paused !== on) {
      this.s.paused = on
      this.save()
      this.log('warn', on ? 'sending paused' : 'sending resumed')
      this.event('state', this.stateFields())
    }
    return { ok: true, paused: on }
  }

  // ---- reads

  usage() {
    const now = this.now()
    return { hour: this.s.sends.filter((t) => now - t < HOUR).length, day: this.s.sends.filter((t) => now - t < DAY).length }
  }

  status() {
    const b = this.budget()
    return {
      ok: true,
      ...this.stateFields(),
      me: maskMe(this.me),
      limits: { ...this.config.limits },
      usage: this.usage(),
      reconnects: { hour: b.hour, day: b.day, perHour: b.perHour, perDay: b.perDay },
      version: this.version,
    }
  }

  // ---- sending

  /** The refusal for the current state, or null when a send may wait for or use the connection. */
  stateRefusal() {
    switch (this.state) {
      case 'unpaired':
      case 'linking':
        return fail('unpaired', 'No device is linked to send from.')
      case 'logged-out':
        return fail('logged-out', this.why)
      case 'replaced':
        return fail('replaced', this.why)
      case 'blocked':
        return fail(this.s.hold?.code === 463 ? 'restricted' : 'blocked', this.why)
      case 'down':
        // Waiting for the budget: it reconnects on its own at retryAt. Otherwise a person has to act.
        if (this.retryAt) return fail('not-connected', this.why, { retryAt: new Date(this.retryAt).toISOString() })
        return { ...fail('not-connected', this.why), retryable: false }
    }
    return null
  }

  /** Waits for `open` up to the configured time; false when it didn't come (or a stop state did). */
  waitOpen() {
    if (this.state === 'open') return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (v) => {
        this.clock.clearTimeout(timer)
        this.off('state', onState)
        resolve(v)
      }
      const onState = (st) => {
        if (st === 'open') done(true)
        else if (st !== 'connecting') done(false)
      }
      const timer = this.clock.setTimeout(() => done(false), this.config.sendWaitS * 1000)
      this.on('state', onState)
    })
  }

  limitRefusal() {
    if (this.s.paused) return fail('paused', 'Sending is paused.')
    const now = this.now()
    const { perHour, perDay } = this.config.limits
    const inHour = this.s.sends.filter((t) => now - t < HOUR)
    const inDay = this.s.sends.filter((t) => now - t < DAY)
    if (inDay.length >= perDay) {
      return fail('limited', `The daily limit (${perDay}) is reached.`, { retryAt: new Date(Math.min(...inDay) + DAY).toISOString() })
    }
    if (inHour.length >= perHour) {
      return fail('limited', `The hourly limit (${perHour}) is reached.`, { retryAt: new Date(Math.min(...inHour) + HOUR).toISOString() })
    }
    return null
  }

  async ready() {
    const refusal = this.stateRefusal()
    if (refusal) return refusal
    if (!(await this.waitOpen())) {
      return this.stateRefusal() || fail('not-connected', `Not connected to WhatsApp within ${this.config.sendWaitS} s.`)
    }
    return null
  }

  async lookup(digits) {
    const hit = this.checks.get(digits)
    if (hit && this.now() - hit.at < CHECK_TTL) return hit
    const r = await this.sock.onWhatsApp(digits)
    const entry = { exists: !!r?.exists, jid: r?.jid, at: this.now() }
    this.checks.set(digits, entry)
    return entry
  }

  async check({ digits } = {}) {
    if (!DIGITS.test(String(digits ?? ''))) return fail('invalid', 'digits must be 7 to 15 digits, country code first, no +.')
    const refusal = await this.ready()
    if (refusal) return refusal
    try {
      return { ok: true, exists: (await this.lookup(String(digits))).exists }
    } catch (err) {
      return fail('not-connected', `WhatsApp did not answer the lookup: ${err.message}`)
    }
  }

  send(req = {}) {
    const { idem, digits, text } = req
    if (typeof idem !== 'string' || !idem || idem.length > 512) return Promise.resolve(fail('invalid', 'idem must be a non-empty string of at most 512 characters.'))
    if (!DIGITS.test(String(digits ?? ''))) return Promise.resolve(fail('invalid', 'digits must be 7 to 15 digits, country code first, no +.'))
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return Promise.resolve(fail('invalid', `text must be 1 to ${MAX_TEXT} characters.`))
    const running = this.inflight.get(idem)
    if (running) return running.then((r) => ({ ...r, dup: true }))
    const rec = this.s.idem[idem]
    if (rec && this.now() - rec.at < IDEM_TTL) return Promise.resolve({ ...this.recorded(rec), dup: true })
    const p = this.sendOnce(idem, String(digits), text).finally(() => this.inflight.delete(idem))
    this.inflight.set(idem, p)
    return p
  }

  recorded(rec) {
    if (rec.status === 'sent') return { ok: true, ref: rec.ref, at: new Date(rec.at).toISOString() }
    if (rec.status === 'failed') return fail(rec.code || 'failed', rec.why || 'The send failed.')
    return fail('unknown', 'The sender stopped while this message was being sent; whether it went out is unknown, so it is never sent again.')
  }

  async sendOnce(idem, digits, text) {
    const early = (await this.ready()) || this.limitRefusal()
    if (early) return early
    // One send at a time, and a gap between them: queue rather than refuse.
    const turn = this.queue.then(async () => {
      const gap = this.lastSendAt + this.config.limits.gapS * 1000 - this.now()
      if (gap > 0) await this.sleep(gap)
      const late = this.stateRefusal() || this.limitRefusal() || (this.state !== 'open' ? fail('not-connected', 'The connection dropped before the send.') : null)
      if (late) return late
      return this.deliver(idem, digits, text)
    })
    this.queue = turn.catch(() => {})
    return turn
  }

  async deliver(idem, digits, text) {
    const sock = this.sock
    let target
    try {
      target = await this.lookup(digits)
    } catch (err) {
      return fail('not-connected', `WhatsApp did not answer the number lookup: ${err.message}`)
    }
    if (!target.exists) return fail('not-on-whatsapp', 'That number has no WhatsApp account.')
    const at = this.now()
    // Recorded before the hand-off: if the process dies before the outcome, this idem reads `unknown` forever.
    this.s.idem[idem] = { at, status: 'sending' }
    this.save()
    this.lastSendAt = at
    let ref
    try {
      ref = await sock.sendMessage(target.jid, text)
    } catch (err) {
      const status = err?.output?.statusCode ?? err?.statusCode
      if (status === 428) {
        // Baileys refuses before writing anything when the socket is closed: nothing went out.
        delete this.s.idem[idem]
        this.save()
        return fail('not-connected', 'The connection closed before the send.')
      }
      this.s.idem[idem] = { at, status: 'failed', code: 'failed', why: `WhatsApp did not take the message: ${err.message}` }
      this.save()
      this.log('warn', `send failed: ${err.message}`)
      return fail('failed', this.s.idem[idem].why)
    }
    this.s.sends.push(at)
    this.s.idem[idem] = { at, status: 'sent', ref }
    this.save()
    this.log('info', `sent ${ref}`)
    return { ok: true, ref, at: new Date(at).toISOString() }
  }

  onReceipt(ref, status, code) {
    if (!RANK[status]) return
    const entry = Object.entries(this.s.idem).find(([, r]) => r.ref === ref)
    if (!entry) return // not ours (the phone's own chats are never reported)
    const [idem, rec] = entry
    const had = RANK[rec.receipt] ?? 0
    if (status !== 'failed' && RANK[status] <= had) return
    if (rec.receipt === 'failed') return
    rec.receipt = status
    this.save()
    this.event('receipt', { ref, idem, status, ...(code != null ? { code: String(code) } : {}) })
    if (status === 'failed' && String(code) === '463') {
      this.hold('blocked', 'WhatsApp restricted this account from starting new chats (463). Sending is paused.', 463)
    }
  }

  // ---- events

  event(ev, fields, { keep = true } = {}) {
    const e = { ev, seq: ++this.s.seq, at: new Date(this.now()).toISOString(), ...fields }
    if (keep) {
      this.store.events.push(e)
      if (this.store.events.length > EVENT_RING) this.store.events.splice(0, this.store.events.length - EVENT_RING)
      this.store.saveEvents()
    }
    this.save()
    this.emit('event', e)
    return e
  }

  /** Kept events after `since`, and whether some were lost to the ring. */
  eventsSince(since) {
    const kept = this.store.events
    const from = typeof since === 'number' ? since : 0
    const oldest = kept[0]?.seq
    const gap = typeof since === 'number' && since < this.s.seq && (oldest == null ? true : since < oldest - 1)
    return { events: kept.filter((e) => e.seq > from), gap }
  }
}
