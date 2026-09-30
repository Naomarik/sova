// The sender's own files in $SOVA_WA_HOME: state.json and events.json, both 0600, written atomically.
// They never hold a phone number, a message body or a credential.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export const EVENT_RING = 500

const emptyState = () => ({
  v: 1,
  paused: false,
  hold: null, // {state, why, code?} a stop that survives restarts: logged-out, replaced, blocked, down
  reconnects: [], // epoch ms of each automatic connection attempt (the budget)
  sends: [], // epoch ms of each message handed to WhatsApp (the limits)
  idem: {}, // idem → {at, status: sending|sent|failed|unknown, ref?, code?, receipt?}
  seq: 0,
})

const CORRUPT = Symbol('corrupt')

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback()
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return CORRUPT
  }
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** A file-backed store; `memoryStore()` below is the same shape for tests. */
export function fileStore({ stateFile, eventsFile }) {
  const read = readJson(stateFile, emptyState)
  // An unreadable state.json loses the reconnect budget and the idem records: stay down (no connection,
  // no sends) until the operator looks and presses Reconnect, rather than start over with a clean slate.
  const state =
    read === CORRUPT || !read || typeof read !== 'object'
      ? { ...emptyState(), hold: { state: 'down', why: `${stateFile} could not be read.` } }
      : { ...emptyState(), ...read }
  const events = readJson(eventsFile, () => [])
  return {
    state,
    events: Array.isArray(events) ? events : [],
    saveState() {
      writeAtomic(stateFile, state)
    },
    saveEvents() {
      writeAtomic(eventsFile, this.events)
    },
  }
}

export function memoryStore(initial = {}) {
  return {
    state: { ...emptyState(), ...initial },
    events: [],
    saves: 0,
    saveState() {
      this.saves++
    },
    saveEvents() {},
  }
}
