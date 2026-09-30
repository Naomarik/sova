import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baileysLogger, makeLog, redact } from '../src/log.mjs'

test('digit runs of 7 or more keep only their last 3 digits', () => {
  assert.equal(redact('to 15550001234@s.whatsapp.net at 12:30'), 'to …234@s.whatsapp.net at 12:30')
})

test("Baileys's logger passes its text at the configured level, never an object", () => {
  const out = []
  const l = baileysLogger('warn', (s) => out.push(s))
  l.child({ class: 'x' }).warn({ jid: '15550001234@s.whatsapp.net', node: { privKey: 'k' } }, 'stream errored 15550001234')
  l.info('connected to 15550001234')
  l.error({ err: { message: 'boom' } })
  l.warn({ only: 'an object' })
  assert.equal(out.length, 2)
  assert.match(out[0], /warn baileys: stream errored …234$/)
  assert.match(out[1], /error baileys: boom$/)
  assert.ok(!out.join('\n').includes('privKey'))
})

test('the sender log drops what is below its level', () => {
  const out = []
  const log = makeLog('warn', (s) => out.push(s))
  log('info', 'quiet')
  log('warn', 'loud 15550001234')
  assert.equal(out.length, 1)
  assert.match(out[0], /warn loud …234$/)
})
