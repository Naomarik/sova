import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, problems } from '../src/config.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-test-')))

test('defaults follow PI_CODING_AGENT_DIR, then ~/.pi/agent; nothing else is assumed', () => {
  const home = '/home/someone'
  const c = resolveConfig({}, { home })
  assert.equal(c.home, '/home/someone/.pi/agent/sova/whatsapp')
  assert.equal(c.authDir, '/home/someone/.pi/agent/sova/whatsapp/auth')
  assert.equal(c.socket, '/home/someone/.pi/agent/sova/whatsapp/sender.sock')
  assert.deepEqual(c.limits, { gapS: 3, perHour: 20, perDay: 60 })
  assert.deepEqual(c.reconnectBudget, { perHour: 3, perDay: 10 })
  assert.equal(c.deviceName, 'Sova')
  const h = resolveConfig({ PI_CODING_AGENT_DIR: '~/wt/.agent' }, { home })
  assert.equal(h.socket, '/home/someone/wt/.agent/sova/whatsapp/sender.sock')
})

test('env wins over config.json, which wins over defaults; the file is parsed strictly', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ SOVA_WA_LIMITS: '5/10/30', SOVA_WA_DEVICE_NAME: 'Office' }))
  const c = resolveConfig({ SOVA_WA_HOME: dir, SOVA_WA_DEVICE_NAME: 'Desk' })
  assert.deepEqual(c.limits, { gapS: 5, perHour: 10, perDay: 30 })
  assert.equal(c.deviceName, 'Desk')
  assert.equal(c.sources.SOVA_WA_LIMITS, 'file')
  assert.equal(c.sources.SOVA_WA_DEVICE_NAME, 'env')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ SOVA_WA_LIMIT: '1/1/1' }))
  assert.throws(() => resolveConfig({ SOVA_WA_HOME: dir }), /unknown key "SOVA_WA_LIMIT"/)
  writeFileSync(join(dir, 'config.json'), '{nope')
  assert.throws(() => resolveConfig({ SOVA_WA_HOME: dir }), /not valid JSON/)
  assert.throws(() => resolveConfig({ SOVA_WA_HOME: tmp(), SOVA_WA_LIMITS: '3/20' }), /SOVA_WA_LIMITS/)
  assert.throws(() => resolveConfig({ SOVA_WA_HOME: tmp(), SOVA_WA_LOG_LEVEL: 'trace' }), /SOVA_WA_LOG_LEVEL/)
})

test('refuses a group/world-accessible home or auth dir', () => {
  const dir = tmp()
  const home = join(dir, 'wa')
  mkdirSync(join(home, 'auth'), { recursive: true })
  chmodSync(home, 0o700)
  chmodSync(join(home, 'auth'), 0o755)
  const c = resolveConfig({ SOVA_WA_HOME: home })
  const p = problems(c)
  assert.equal(p.length, 1)
  assert.match(p[0], /SOVA_WA_AUTH_DIR .* group\/world-accessible \(mode 0755\)/)
  chmodSync(join(home, 'auth'), 0o700)
  chmodSync(home, 0o750)
  assert.match(problems(c)[0], /SOVA_WA_HOME .* \(mode 0750\)/)
  chmodSync(home, 0o700)
  assert.deepEqual(problems(c), [])
})

test('refuses an auth dir inside a git work tree, even one not created yet', () => {
  const repo = tmp()
  mkdirSync(join(repo, '.git'))
  const home = join(repo, 'state', 'wa')
  const p = problems(resolveConfig({ SOVA_WA_HOME: home }))
  assert.equal(p.length, 2)
  assert.ok(p.every((x) => x.includes(`inside the git work tree ${repo}`)))
})

test('refuses a socket path too long for a Unix socket', () => {
  const dir = tmp()
  chmodSync(dir, 0o700)
  const p = problems(resolveConfig({ SOVA_WA_HOME: dir, SOVA_WA_SOCKET: join(dir, 'x'.repeat(120)) }))
  assert.match(p.join('\n'), /too long for a Unix socket/)
})
