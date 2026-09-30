// Imported first by the entry point, before Baileys loads. libsignal (a Baileys dependency) calls
// console.info('Closing session:', session) / 'Opening session:' / 'Removing old closed session:' and
// console.warn('Session already closed', session) with the whole SessionEntry, whose ratchet PRIVATE keys
// (privKey, rootKey, chain keys) would land on stdout and in journald. The sender itself never writes
// through console (see log.mjs), so every console method is replaced: any non-string argument is dropped
// unseen, and what is left goes to the logger at debug level only, digits redacted. At the default
// level (warn) no dependency console output is written at all.
import { redact } from './log.mjs'

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table']

let sink = null

/** Routes dependency console output to `write(line)` at debug, or drops it (write null). */
export function quietConsole(write = null) {
  sink = write
  for (const name of METHODS) {
    console[name] = (...args) => {
      if (!sink) return
      // Strings keep their words; long key-like runs (base64, hex) and digit runs go, even at debug.
      const kept = args.map((a) => (typeof a === 'string' ? redact(a.replace(/[A-Za-z0-9+/=_-]{24,}/g, '<long run dropped>')) :['number', 'boolean', 'bigint'].includes(typeof a) ? String(a) : `<${a === null ? 'null' : typeof a} dropped>`))
      sink(`console.${name}: ${kept.join(' ')}`)
    }
  }
}

quietConsole()
