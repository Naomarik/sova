// Test doubles: a manual clock and a fake WhatsApp driver. No Baileys, no network, no real auth dir.
import { Sender } from '../src/core.mjs'
import { memoryStore } from '../src/store.mjs'

export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

export function fakeClock(start = Date.parse('2026-01-01T09:00:00Z')) {
  let now = start
  let timers = []
  let ids = 0
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { id: ++ids, at: now + Math.max(0, ms || 0), fn }
      timers.push(t)
      return t.id
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id)
    },
    pending: () => timers.length,
    /** Advances time, running every timer that falls due, in order, with microtasks flushed between. */
    async tick(ms = 0) {
      const end = now + ms
      for (;;) {
        await flush()
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
      }
      now = end
      await flush()
    },
  }
}

export function fakeDriver({ paired = true } = {}) {
  const d = {
    paired,
    opens: 0,
    opensLink: 0,
    refreshed: 0,
    wiped: 0,
    sent: [],
    lookups: 0,
    absent: new Set(),
    sendImpl: null,
    handles: [],
    last: null,
    isPaired: () => d.paired,
    refreshVersion: async () => void d.refreshed++,
    wipe: async () => {
      d.wiped++
      d.paired = false
    },
    openFail: 0, // the next n opens throw, as a refused network connection
    async open({ link, handlers }) {
      d.opens++
      if (link) d.opensLink++
      if (d.openFail > 0) {
        d.openFail--
        throw new Error('connect ECONNREFUSED')
      }
      const h = {
        handlers,
        link,
        ended: false,
        loggedOut: false,
        end() {
          h.ended = true
        },
        async logout() {
          h.loggedOut = true
        },
        async onWhatsApp(digits) {
          d.lookups++
          return { exists: !d.absent.has(digits), jid: `${digits}@s.whatsapp.net` }
        },
        async sendMessage(jid, text) {
          if (d.sendImpl) return d.sendImpl(jid, text)
          d.sent.push({ jid, text })
          return `REF${d.sent.length}`
        },
        async requestPairingCode() {
          return 'ABCD1234'
        },
      }
      d.handles.push(h)
      d.last = h
      return h
    },
  }
  return d
}

export const baseConfig = (over = {}) => ({
  authDir: '/nonexistent/auth',
  limits: { gapS: 3, perHour: 20, perDay: 60 },
  reconnectBudget: { perHour: 3, perDay: 10 },
  sendWaitS: 15,
  ...over,
})

/** A sender on fakes; `open()` makes the latest connection open. */
export function rig({ paired = true, store = memoryStore(), config = baseConfig(), clock = fakeClock() } = {}) {
  const driver = fakeDriver({ paired })
  const logs = []
  const core = new Sender({ config, store, driver, clock, log: (lvl, msg) => logs.push(`${lvl} ${msg}`), version: 'test' })
  const events = []
  core.on('event', (e) => events.push(e))
  return {
    core,
    driver,
    clock,
    store,
    logs,
    events,
    async open(me = '15550001111') {
      await clock.tick(0)
      driver.last.handlers.onOpen(me)
      await clock.tick(0)
    },
    async close(code, wire) {
      driver.last.handlers.onClose(code, 'test', wire)
      await clock.tick(0)
    },
  }
}
