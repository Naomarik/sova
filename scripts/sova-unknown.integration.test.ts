// Run: pnpm test:int -- scripts/sova-unknown.integration.test.ts
// Exit 5 of the command line (§app.chat-actions/never-replay): an in-chat action whose outcome is
// unknown. A 202 `{outcome:"unknown"}` from POST /api/chat/action, or a connection that opened and
// then broke before any answer, exits 5, with the one line that says Sova may have acted; a
// connection that never opened stays exit 1; every other command keeps exit 1 for a broken
// connection; and nothing is ever sent twice. Against loopback stand-ins for the server (sockets:
// the integration tier), through the script's own `main`.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
// @ts-expect-error: a plain .mjs script, no declarations
import { CliError, EXIT, main, UNKNOWN_LINE } from "./sova.mjs";

const env = { SOVA_TOKEN: "test-token" } as Record<string, string>;
const SESSION = "/sessions/--x--/2026-10-18T00-00-00-000Z_s1.jsonl";
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

interface Stub {
  base: string;
  /** Requests seen, as "METHOD path". */
  seen: string[];
  /** TCP connections accepted. */
  connections: () => number;
}

async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
  const seen: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`);
    // Read the whole body first: the request has been read when the handler acts.
    req.resume();
    req.on("end", () => handler(req, res));
  });
  server.on("connection", () => connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, connections: () => connections };
}

/** `main`'s exit code, from a return or a CliError, with stdout/stderr kept quiet and captured. */
async function exitOf(argv: string[]): Promise<{ code: number; err: string }> {
  const writes = { out: process.stdout.write, err: process.stderr.write };
  let err = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv, env), err };
  } catch (e) {
    if (e instanceof CliError) return { code: (e as unknown as { code: number }).code, err: `${err}${(e as Error).message}` };
    throw e;
  } finally {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("exit 5 is its own class; 0 to 4 are as they were", () => {
  assert.deepEqual(EXIT, { done: 0, failed: 1, refused: 2, invalid: 3, busy: 4, unknown: 5 });
  assert.match(UNKNOWN_LINE, /Sova may have acted/);
  assert.match(UNKNOWN_LINE, /Check the chat before you run it again/);
});

test("a 202 unknown from an in-chat action exits 5, with the line; one request", async () => {
  const s = await stub((_q, res) => json(res, 202, { outcome: "unknown", requestId: "act-1", waitedMs: 5, heard: [] }));
  const r = await exitOf(["run", "chat.stop", "--session", SESSION, "--url", s.base]);
  assert.equal(r.code, EXIT.unknown);
  assert.match(r.err, /Sova may have acted/);
  assert.deepEqual(s.seen, ["POST /api/chat/action"]);
});

test("a 202 with an outcome is done (exit 0); a 409 refusal is exit 2", async () => {
  const done = await stub((_q, res) => json(res, 200, { outcome: "stopped", wasRunning: false }));
  assert.equal((await exitOf(["run", "chat.stop", "--session", SESSION, "--url", done.base])).code, EXIT.done);
  const refused = await stub((_q, res) => json(res, 409, { error: "Session is open in another pi process (pid 1, tui); it is read-only here. Use watch instead.", outcome: "refused" }));
  assert.equal((await exitOf(["run", "chat.rewind", "--session", SESSION, "--entry", "e1", "--url", refused.base])).code, EXIT.refused);
});

test("a connection that opened and broke before any answer exits 5, after exactly one request", async () => {
  const s = await stub((req) => req.socket.destroy());
  const r = await exitOf(["run", "chat.rewind", "--session", SESSION, "--entry", "e1", "--url", s.base]);
  assert.equal(r.code, EXIT.unknown, r.err);
  assert.match(r.err, /Sova may have acted/);
  // Never retried: one request, one connection.
  assert.deepEqual(s.seen, ["POST /api/chat/action"]);
  assert.equal(s.connections(), 1);
});

test("a connection that broke during the answer (headers sent, body cut) exits 5, after one request", async () => {
  const s = await stub((req, res) => {
    res.writeHead(202, { "content-type": "application/json", "content-length": "500" });
    res.write('{"outcome":');
    setTimeout(() => req.socket.destroy(), 20);
  });
  const r = await exitOf(["run", "chat.compact", "--session", SESSION, "--url", s.base]);
  assert.equal(r.code, EXIT.unknown, r.err);
  assert.match(r.err, /Sova may have acted/);
  assert.deepEqual(s.seen, ["POST /api/chat/action"]);
});

test("a kept-alive connection reused for the action, then broken, exits 5 (one action request)", async () => {
  const s = await stub((req, res) => {
    if (req.url?.startsWith("/api/sessions/summary")) return json(res, 200, { id: "s1", path: SESSION });
    req.socket.destroy();
  });
  const r = await exitOf(["run", "chat.stop", "--session", "s1", "--url", s.base]);
  assert.equal(r.code, EXIT.unknown, r.err);
  assert.deepEqual(s.seen, ["GET /api/sessions/summary", "POST /api/chat/action"]);
  // The action rode the lookup's socket: no `connect` of its own, so `reusedSocket` is what says it opened.
  assert.equal(s.connections(), 1);
});

test("a connection that never opened is exit 1: nothing was delivered", async () => {
  const s = await stub(() => {});
  const port = new URL(s.base).port;
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  const r = await exitOf(["run", "chat.stop", "--session", SESSION, "--url", `http://127.0.0.1:${port}`]);
  assert.equal(r.code, EXIT.failed);
  assert.match(r.err, /cannot reach Sova/);
});

test("every other command keeps exit 1 for a broken connection", async () => {
  const s = await stub((req) => req.socket.destroy());
  const r = await exitOf(["run", "session.title.set", "--session", SESSION, "--title", "x", "--url", s.base]);
  assert.equal(r.code, EXIT.failed);
  assert.match(r.err, /cannot reach Sova/);
  assert.deepEqual(s.seen, ["POST /api/sessions/title"]);
});
