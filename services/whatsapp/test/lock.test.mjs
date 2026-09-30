// One sender per home. The process tests run the real CLI's `run` on an empty temp home: unpaired, it opens
// no WhatsApp connection.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, LockHeld, pidAlive } from '../src/lock.mjs'

const dirs = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sova-wa-lock-')))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A pid that certainly ran and has exited. */
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const pid = Number(r.stdout)
  assert.equal(pidAlive(pid), false)
  return pid
}

test('a second acquire refuses while a live holder has the lock; release frees it', () => {
  const file = join(tmp(), 'sender.lock')
  const a = acquireLock(file)
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid))
  assert.throws(() => acquireLock(file, { pid: process.pid + 1 }), (e) => e instanceof LockHeld && e.pid === process.pid)
  a.release()
  assert.equal(existsSync(file), false)
  acquireLock(file).release()
})

test("a dead holder's lock is taken over; a torn lock file too", () => {
  const dir = tmp()
  const file = join(dir, 'sender.lock')
  writeFileSync(file, `${deadPid()}\n`)
  const l = acquireLock(file)
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid))
  l.release()
  writeFileSync(file, 'garbage')
  acquireLock(file).release()
  assert.deepEqual(
    (spawnSync('ls', [dir], { encoding: 'utf8' }).stdout || '').trim(),
    '',
    'no stale leftovers',
  )
})

test('release never removes a lock someone else took since', () => {
  const file = join(tmp(), 'sender.lock')
  const l = acquireLock(file)
  writeFileSync(file, '424242\n')
  l.release()
  assert.equal(readFileSync(file, 'utf8').trim(), '424242')
})

const bin = fileURLToPath(new URL('../bin/sova-whatsapp.mjs', import.meta.url))
const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('sova-whatsapp run: a second start refuses (exit 3); after a SIGKILL the next start takes over', async () => {
  const home = join(tmp(), 'wa')
  const env = { PATH: process.env.PATH, HOME: '/nonexistent-home', SOVA_WA_HOME: home }
  const first = spawn(process.execPath, [bin, 'run'], { env, stdio: 'ignore' })
  await waitFor(() => existsSync(join(home, 'sender.sock')))
  assert.equal(readFileSync(join(home, 'sender.lock'), 'utf8').trim(), String(first.pid))

  const second = spawnSync(process.execPath, [bin, 'run'], { env, encoding: 'utf8', timeout: 15_000 })
  assert.equal(second.status, 3)
  assert.match(second.stderr, new RegExp(`another sender \\(pid ${first.pid}\\) holds .*sender\\.lock`))

  const gone = new Promise((r) => first.once('exit', r))
  first.kill('SIGKILL') // no cleanup: the lock and the socket file stay behind
  await gone
  assert.ok(existsSync(join(home, 'sender.lock')))

  const third = spawn(process.execPath, [bin, 'run'], { env, stdio: 'ignore' })
  await waitFor(() => existsSync(join(home, 'sender.lock')) && readFileSync(join(home, 'sender.lock'), 'utf8').trim() === String(third.pid))
  await waitFor(() => spawnSync(process.execPath, [bin, 'status', '--json'], { env, encoding: 'utf8' }).stdout.includes('"state"'))
  const exited = new Promise((r) => third.once('exit', r))
  third.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.equal(existsSync(join(home, 'sender.lock')), false, 'a clean stop removes the lock')
})
