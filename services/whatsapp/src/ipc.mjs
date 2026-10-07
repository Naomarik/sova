// IPC v1 (see ../IPC.md): NDJSON over a Unix socket, 0600 in a 0700 directory. Never a network listener.
import net from 'node:net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_LINE = 64 * 1024

const bad = (why) => ({ ok: false, code: 'bad-request', retryable: false, why })

/** True when something answers on the socket (another sender is running). */
export function socketAlive(path) {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false)
    const c = net.connect(path)
    c.once('connect', () => (c.destroy(), resolve(true)))
    c.once('error', () => resolve(false))
  })
}

/**
 * The IPC of `core` (a Sender) on any stream with a socket's surface, with no listener: `attach`
 * serves one connection, `close` stops events and ends every connection. serveIpc attaches each
 * socket it accepts; Sova's tests attach an in-memory stream.
 */
export function ipcSessions({ core, extraOps = {}, log = () => {} }) {
  const ops = {
    hello: (req, conn) => {
      if (req.v !== 1) return { ok: false, code: 'version', retryable: false, why: `This sender speaks IPC v1, not v${req.v}.` }
      if (req.since != null && typeof req.since !== 'number') return bad('since must be a number')
      const { gap } = core.eventsSince(req.since)
      // The reply first, then the replay, then live events: the replay and the subscription happen in one
      // synchronous step after the reply is written, so no event falls between them.
      conn.after = () => {
        for (const e of core.eventsSince(req.since).events) conn.write(e)
        conn.subscribed = true
      }
      return { ok: true, v: 1, version: core.version, state: core.state, seq: core.s.seq, paused: core.s.paused, authDir: core.config.authDir, ...(gap ? { gap: true } : {}) }
    },
    status: () => core.status(),
    check: (req) => core.check(req),
    send: (req) => core.send(req),
    pause: (req) => core.pause(req),
    link: (req) => core.link(req),
    reconnect: () => core.reconnect(),
    unlink: (req) => core.unlink(req),
    ...extraOps,
  }

  const conns = new Set()
  const sockets = new Set() // raw client sockets, destroyed on close so a stop never waits on a client
  const onEvent = (e) => {
    for (const c of conns) if (c.subscribed) c.write(e)
  }
  core.on('event', onEvent)

  function attach(sock) {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    const conn = {
      subscribed: false,
      write: (obj) => sock.writable && sock.write(JSON.stringify(obj) + '\n'),
    }
    conns.add(conn)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      if (buf.length > MAX_LINE && !buf.includes('\n')) return sock.destroy()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) handle(line)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => conns.delete(conn))

    async function handle(line) {
      if (line.length > MAX_LINE) return sock.destroy()
      let req
      try {
        req = JSON.parse(line)
      } catch {
        return conn.write({ id: null, ...bad('not JSON') })
      }
      if (!req || typeof req !== 'object' || Array.isArray(req)) return conn.write({ id: null, ...bad('a request is a JSON object') })
      const id = req.id ?? null
      const op = ops[req.op]
      if (!op || !Object.hasOwn(ops, req.op)) return conn.write({ id, ...bad(`unknown op "${req.op}"`) })
      let res
      try {
        res = await op(req, conn)
      } catch (err) {
        log('error', `op ${req.op} threw: ${err.message}`)
        res = { ok: false, code: 'failed', retryable: false, why: `The sender hit an internal error: ${err.message}` }
      }
      conn.write({ id, ...res })
      if (conn.after) {
        const after = conn.after
        conn.after = null
        after()
      }
    }
  }

  return {
    attach,
    close() {
      core.off('event', onEvent)
      for (const c of conns) c.subscribed = false
      for (const sock of sockets) sock.destroy()
    },
  }
}

/**
 * Serves `core` (a Sender) on `path`. `extraOps` adds ops (the fake sender's `fake`).
 * Refuses when another process already answers on the path; removes a stale socket file.
 */
export async function serveIpc({ core, path, extraOps = {}, log = () => {} }) {
  if (await socketAlive(path)) throw new Error(`another sender is already listening on ${path}`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) unlinkSync(path)

  const sessions = ipcSessions({ core, extraOps, log })
  const server = net.createServer(sessions.attach)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    const old = process.umask(0o177)
    server.listen(path, () => {
      process.umask(old)
      resolve()
    })
  })
  chmodSync(path, 0o600)
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        sessions.close()
        try {
          unlinkSync(path)
        } catch {}
      }),
  }
}

/** A small client: request(op, fields) → response; onEvent(cb). Used by the CLI, the fake's ctl and tests. */
export function connectIpc(path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path)
    const waiting = new Map()
    const listeners = new Set()
    let next = 1
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (msg.ev) for (const l of listeners) l(msg)
        else if (waiting.has(msg.id)) {
          waiting.get(msg.id)(msg)
          waiting.delete(msg.id)
        }
      }
    })
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.off('error', reject)
      sock.on('error', () => {})
      resolve({
        request(op, fields = {}) {
          const id = next++
          return new Promise((r) => {
            waiting.set(id, r)
            sock.write(JSON.stringify({ id, op, ...fields }) + '\n')
          })
        },
        onEvent(cb) {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        close: () => sock.end(),
        socket: sock,
      })
    })
  })
}
