// The CLI's refusals, run for real in temp dirs. None of these reaches WhatsApp: each stops before a connection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/sova-whatsapp.mjs', import.meta.url))
const cli = (args, env) => spawnSync(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, HOME: '/nonexistent-home', ...env }, encoding: 'utf8', timeout: 20_000 })
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-cli-')))

test('run refuses a group/world-accessible auth dir before opening anything', () => {
  const home = join(tmp(), 'wa')
  mkdirSync(join(home, 'auth'), { recursive: true })
  chmodSync(home, 0o700)
  chmodSync(join(home, 'auth'), 0o755)
  const r = cli(['run'], { SOVA_WA_HOME: home })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /refuses to start/)
  assert.match(r.stderr, /mode 0755/)
  assert.equal(existsSync(join(home, 'sender.sock')), false)
})

test('run refuses an auth dir inside a git work tree', () => {
  const repo = tmp()
  mkdirSync(join(repo, '.git'))
  const r = cli(['run'], { SOVA_WA_HOME: join(repo, 'wa') })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /inside the git work tree/)
})

test('check-config prints the resolved values and exits non-zero on a problem', () => {
  const home = join(tmp(), 'wa')
  mkdirSync(home, { mode: 0o700 })
  const ok = cli(['check-config'], { SOVA_WA_HOME: home, SOVA_WA_LIMITS: '5/10/30' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /limits: +≥ 5 s apart, 10\/hour, 30\/day \(env\)/)
  assert.match(ok.stdout, /paired: +no/)
  assert.match(ok.stdout, /problems: +none/)
  chmodSync(home, 0o755)
  const bad = cli(['check-config'], { SOVA_WA_HOME: home })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /group\/world-accessible/)
  assert.equal(cli(['check-config'], { SOVA_WA_HOME: home, SOVA_WA_LIMITS: 'lots' }).status, 2)
})

test('status without a running sender reads the files; unlink without --yes does nothing', () => {
  const home = join(tmp(), 'wa')
  mkdirSync(home, { mode: 0o700 })
  const s = cli(['status', '--json'], { SOVA_WA_HOME: home })
  assert.equal(s.status, 0, s.stderr)
  assert.deepEqual(JSON.parse(s.stdout), { running: false, paired: false, hold: null, paused: false })
  const u = cli(['unlink'], { SOVA_WA_HOME: home })
  assert.equal(u.status, 2)
  assert.match(u.stderr, /--yes/)
})
