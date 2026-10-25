// Run: pnpm test:int -- server/mesh/remote-commands.integration.test.ts
// `sova run <id> --host <peer>` end to end (§mesh.peers/remote-commands), over real hops: the server
// on an ephemeral port, its own peer listener on 127.0.0.1 listed as peer `b` (a stub whois says the
// caller is b's node), and scripts/sova.mjs as a child process. So one run crosses the main listener
// (token), the /peer/b/ proxy, the peer listener's identity and grant checks and the door, and lands
// on the entry's own route. The door's rules in-process: remote-commands.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-remote-commands-int-"));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [],
  }),
  // Every connection to the peer listener is peer b's: here, this same server through its proxy.
  whois: async () => ({ nodeId: "nB", name: "b", tags: [], login: "me" }),
});

const { server } = await import("../index");
const { listenerInfo, stopMesh } = await import("./index");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
const { canonicalPath } = await import("../paths");

let base = "";
const SOVA = resolve(import.meta.dirname, "../../scripts/sova.mjs");
const put = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: "PUT", headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Listed first at a placeholder address, so the listener binds; then at the listener itself.
  assert.equal(await put("/api/mesh/peers", { peers: [{ id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: "http://127.0.0.1:9" }] }), 200);
  await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
  assert.equal(await put("/api/mesh/peers", { peers: [{ id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${listenerInfo()!.port}` }] }), 200);
});

after(() => {
  stopMesh();
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

/** scripts/sova.mjs in a child process, async: this process serves its requests. */
async function sova(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SOVA, ...args, "--url", base], { env: { PATH: process.env.PATH ?? "", HOME: tmp, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}

function session(id: string): string {
  const dir = join(agentDir, "sessions", "--remote--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: tmp })}\n`);
  return canonicalPath(file);
}

test("a `sessions` peer: sova renames a session there (exit 0) and is refused a project verb (exit 2)", async () => {
  assert.equal(await put("/api/mesh/access", { peer: "b", grant: { preset: "sessions" } }), 200);
  const path = session("0197a000-0000-7000-8000-0000000000a1");
  const ok = await sova(["run", "session.title.set", "--session", path, "--title", "Named remotely", "--host", "b"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal((JSON.parse(ok.out) as { title: string }).title, "Named remotely");
  // Read back on this host's own listener: the title really changed.
  const read = await fetch(`${base}/api/sessions/summary?id=0197a000-0000-7000-8000-0000000000a1`, { headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}` } });
  assert.equal(((await read.json()) as { title: string }).title, "Named remotely");

  const verb = await sova(["--host", "b", "run", "project.verb.status", "--project", "/nope"]);
  assert.equal(verb.code, 2, verb.err);
  assert.match(verb.err, /b doesn't grant this host what project\.verb\.status needs/);
});

test("an id the peer doesn't know: refused below `full`, then no such command (exit 3)", async () => {
  assert.equal(await put("/api/mesh/access", { peer: "b", grant: { preset: "full" } }), 200);
  // An id this checkout knows but the peer's door runs only from its own core catalogue: ext.* is
  // never one. The CLI refuses an id it doesn't know itself, so the door's 404 is driven with curl-like fetch.
  const res = await fetch(`${base}/peer/b/api/commands/no.such.command`, { method: "POST", headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /^no command no\.such\.command/);
  assert.equal(await put("/api/mesh/access", { peer: "b", grant: { preset: "sessions" } }), 200);
  const denied = await fetch(`${base}/peer/b/api/commands/no.such.command`, { method: "POST", headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-sova-mesh"), "denied");
});

test("an unknown peer is its own sentence (exit 3)", async () => {
  const r = await sova(["run", "session.list", "--host", "nobody"]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /no peer nobody in this host's mesh/);
});
