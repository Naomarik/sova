#!/usr/bin/env node
// The anchor of a confined conformance run (§app.project-services/confined): it runs inside the
// run's private network namespace and answers Sova's readiness probes there, over a Unix socket
// (a socket path crosses network namespaces; a TCP port of the namespace can't be reached from
// the host). One JSON request per connection, one JSON line back:
//   {"op":"tcp","port":4000}                → {"ok":true}
//   {"op":"http","port":4000,"path":"/"}    → {"ok":true,"status":200,"type":"text/html"}
//   {"op":"ping"}                           → {"ok":true}
// Node builtins only; it never runs anything.

import { rmSync } from "node:fs";
import { connect, createServer } from "node:net";

const socket = process.argv[2];
if (!socket) {
  console.error("netns-agent: give the socket path");
  process.exit(2);
}

function tcp(port, timeoutMs = 1_000) {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (ok) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

async function http(port, path, timeoutMs = 2_000) {
  try {
    // Loopback inside the namespace: never through the run's proxy.
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await r.body?.cancel().catch(() => undefined);
    return { ok: r.status < 500, status: r.status, type: r.headers.get("content-type") };
  } catch {
    return { ok: false };
  }
}

const valid = (p) => Number.isInteger(p) && p > 0 && p < 65536;

async function answer(req) {
  if (req?.op === "ping") return { ok: true };
  if (req?.op === "tcp" && valid(req.port)) return { ok: await tcp(req.port) };
  if (req?.op === "http" && valid(req.port) && typeof req.path === "string" && req.path.startsWith("/")) return http(req.port, req.path);
  return { ok: false, error: "bad request" };
}

rmSync(socket, { force: true });
const server = createServer((c) => {
  let buf = "";
  c.setEncoding("utf8");
  c.on("error", () => undefined);
  c.on("data", async (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) {
      if (buf.length > 4096) c.destroy();
      return;
    }
    let req = null;
    try {
      req = JSON.parse(buf.slice(0, nl));
    } catch {
      // answered as a bad request
    }
    c.end(`${JSON.stringify(await answer(req))}\n`);
  });
});
server.listen(socket);
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
