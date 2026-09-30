// libsignal prints whole SessionEntry objects (ratchet private keys included) through console when a
// session opens or closes. This drives the real libsignal those calls come from, in a child process,
// and checks that nothing of the session reaches stdout or stderr once quiet-console is loaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('../src/quiet-console.mjs', import.meta.url))
const PRIV = Buffer.alloc(32, 7).toString('base64')
const ROOT = Buffer.alloc(32, 9).toString('base64')

// The child: optionally the guard (with a debug sink, as `SOVA_WA_LOG_LEVEL=debug` sets it), then libsignal.
const child = (mode) => `
${mode === 'none' ? '' : `const { quietConsole } = await import(${JSON.stringify(guard)})`}
${mode === 'debug' ? 'quietConsole((line) => process.stderr.write(line + "\\n"))' : ''}
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.resolve('@whiskeysockets/baileys'))
const { SessionRecord } = require('libsignal')
const record = new SessionRecord()
const entry = new (require('libsignal/src/session_record.js').SessionEntry ?? Object)()
entry.indexInfo = { closed: -1, baseKey: Buffer.alloc(33, 5), used: Date.now() }
entry.currentRatchet = {
  rootKey: Buffer.from(${JSON.stringify(ROOT)}, 'base64'),
  ephemeralKeyPair: { privKey: Buffer.from(${JSON.stringify(PRIV)}, 'base64'), pubKey: Buffer.alloc(33, 1) },
}
record.closeSession(entry)   // console.info('Closing session:', entry)
record.closeSession(entry)   // console.warn('Session already closed', entry)
record.openSession(entry)    // console.info('Opening session:', entry)
console.log('plain', { privKey: 'x' }, ${JSON.stringify(PRIV)})
console.error(new Error('with a stack'))
`

const run = (mode) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child(mode)], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout + r.stderr
}

const leaks = (text) => ['privKey', 'rootKey', 'SessionEntry', 'currentRatchet', PRIV, ROOT, Buffer.from(PRIV, 'base64').toString('hex')].filter((s) => text.includes(s))

test('control: without the guard, libsignal prints the private keys', () => {
  assert.ok(leaks(run('none')).length > 0)
})

test('with the guard at the default level, dependencies print nothing at all', () => {
  assert.equal(run('default'), '')
})

test('with the guard at debug, only words survive: objects and key-like runs are dropped', () => {
  const out = run('debug')
  assert.deepEqual(leaks(out), [])
  assert.match(out, /Closing session: <object dropped>/)
  assert.match(out, /<long run dropped>/)
})
