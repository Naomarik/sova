// Logging: one line per event to stderr, digits redacted. Never a message body, a number or a JID in full.
const ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

/** Keeps the last 3 digits of any run of 7+ digits (phone numbers, JID user parts). */
export const redact = (s) => String(s).replace(/\d{7,}/g, (d) => `…${d.slice(-3)}`)

export const maskMe = (digits) => (digits ? `…${String(digits).slice(-3)}` : undefined)

export function makeLog(level = 'warn', write = (line) => process.stderr.write(line + '\n')) {
  const at = ORDER.indexOf(level)
  const log = (lvl, msg) => {
    if (ORDER.indexOf(lvl) < at) return
    write(`${new Date().toISOString()} ${lvl} ${redact(msg)}`)
  }
  return log
}

/**
 * A pino-shaped logger for Baileys: its default logs JIDs and whole protocol nodes at info.
 * This one passes only the message text of warn and above (or the configured level), redacted,
 * and never an object (objects can carry other chats).
 */
export function baileysLogger(level = 'warn', write) {
  const log = makeLog(level, write)
  const make = () => {
    const l = { level, child: () => make() }
    for (const name of ORDER) {
      l[name] = (obj, msg) => {
        const text = typeof obj === 'string' ? obj : msg || obj?.err?.message || obj?.error?.message || ''
        if (text) log(name, `baileys: ${text}`)
      }
    }
    return l
  }
  return make()
}
