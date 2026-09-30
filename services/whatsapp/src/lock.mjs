// One sender per home: an exclusive lock file ($SOVA_WA_HOME/sender.lock) holding the owner's pid,
// created with O_EXCL. A lock whose pid is no longer running (a crash, a SIGKILL) is taken over;
// a live owner's is refused. The socket check in ipc.mjs stays as a second guard.
import { openSync, writeSync, closeSync, readFileSync, renameSync, unlinkSync, constants } from 'node:fs'

export class LockHeld extends Error {
  constructor(file, pid) {
    super(`another sender (pid ${pid}) holds ${file}`)
    this.pid = pid
  }
}

/** Whether a process with this pid is running (EPERM: it runs, as someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const readPid = (file) => {
  try {
    return Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
  } catch {
    return NaN
  }
}

/**
 * Takes the lock or throws LockHeld. Returns {release()}, which removes the file only while it is still ours.
 * `alive` is injectable for tests.
 */
export function acquireLock(file, { pid = process.pid, alive = pidAlive } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      writeSync(fd, `${pid}\n`)
      closeSync(fd)
      return {
        file,
        release() {
          if (readPid(file) === pid) {
            try {
              unlinkSync(file)
            } catch {}
          }
        },
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const holder = readPid(file)
    if (alive(holder)) throw new LockHeld(file, holder)
    // A dead holder (or a torn file): move it aside, atomically, so only one starter takes it over.
    const aside = `${file}.stale.${pid}`
    try {
      renameSync(file, aside)
    } catch (err) {
      if (err.code === 'ENOENT') continue // someone else moved it first; try again
      throw err
    }
    // If what we moved was not the dead holder's (a racing starter's fresh lock), put it back.
    if (readPid(aside) !== holder && !Number.isNaN(readPid(aside))) {
      try {
        renameSync(aside, file)
      } catch {}
      throw new LockHeld(file, readPid(file))
    }
    try {
      unlinkSync(aside)
    } catch {}
  }
  throw new LockHeld(file, readPid(file))
}
