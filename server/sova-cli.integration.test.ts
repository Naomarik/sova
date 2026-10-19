// Run: node scripts/run-tests.mjs server/sova-cli.integration.test.ts
// The command line against the real server (§app.commands/cli, /watch, /extension-commands): the
// whole server on an ephemeral port in a throwaway PI_CODING_AGENT_DIR (~/.pi is never read or
// written), `node scripts/sova.mjs` as a real process with the server's token, and a stand-in
// extension backend that echoes what reached it. list, describe, create, title set and reset, a
// refusal's exit class, an ext.* action through the proxy (Sova's token never reaches the backend),
// and watch printing a rename.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-cli-int-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
process.env.PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });
const work = join(tmp, "work");
mkdirSync(work);
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");

const { server } = await import("./index");
const { sovaToken } = await import("./auth");

/** What the stand-in backend last received on its command route. */
let lastCall: { url: string; method: string; headers: IncomingHttpHeaders; body: string } | null = null;
let backend: Server;
let base = "";

before(async () => {
  backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    lastCall = { url: req.url ?? "", method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ echoed: JSON.parse(lastCall.body || "null") }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const port = (backend.address() as { port: number }).port;
  writeFileSync(
    process.env.SOVA_EXTENSIONS_FILE!,
    JSON.stringify({ version: 1, extensions: [{ id: "stub", dist, api: `http://127.0.0.1:${port}`, commands: [{ name: "echo", label: "Echo", params: { text: { type: "string", required: true } } }] }] }),
  );
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  backend.close();
  rmSync(tmp, { recursive: true, force: true });
});

const CLI = fileURLToPath(new URL("../scripts/sova.mjs", import.meta.url));
const env = () => ({ ...process.env, SOVA_TOKEN: sovaToken(), SOVA_URL: base, SOVA_CHAT_ID: "" });

/** One CLI run → its exit code, stdout and stderr. `node`: the runtime a person runs it with. */
function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: { ...env(), ...extraEnv }, cwd: work });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}

test("list and describe", async () => {
  const list = await cli(["list"]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^session\.title\.set\s+changes\s+Rename Session$/m);
  assert.match(list.out, /^ext\.stub\.echo\s+changes\s+Echo$/m);
  const d = await cli(["describe", "session.title.set"]);
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(JSON.parse(d.out).route, { method: "POST", path: "/api/sessions/title" });
});

test("create a session, rename it by id, reset its title: the routes' own answers", async () => {
  const made = await cli(["run", "session.create", "--cwd", "."]);
  assert.equal(made.code, 0, made.err);
  const s = JSON.parse(made.out) as { id: string; path: string; title: string };
  assert.equal(typeof s.id, "string");
  const set = await cli(["run", "session.title.set", "--session", s.id, "--title", "Named from a terminal"]);
  assert.equal(set.code, 0, set.err);
  assert.equal(JSON.parse(set.out).title, "Named from a terminal");
  const got = await cli(["run", "session.get", "--session", s.id]);
  assert.equal(JSON.parse(got.out).title, "Named from a terminal");
  const reset = await cli(["run", "session.title.reset", "--session", s.path]);
  assert.equal(reset.code, 0, reset.err);
  assert.notEqual(JSON.parse(reset.out).title, "Named from a terminal");
  const direct = await fetch(`${base}/api/sessions/summary?id=${s.id}`, { headers: { "x-sova-token": sovaToken() } });
  assert.equal(JSON.parse(reset.out).title, ((await direct.json()) as { title: string }).title);
});

test("exit classes from a real answer: unknown session 3, bad value 3, a host that isn't this machine 2, no token 2", async () => {
  const unknown = await cli(["run", "session.title.set", "--session", "no-such-id", "--title", "x"]);
  assert.equal(unknown.code, 3, unknown.err);
  assert.match(unknown.err, /No session with that id/);
  const made = JSON.parse((await cli(["run", "session.create", "--cwd", "."])).out) as { path: string };
  const bad = await cli(["run", "session.title.set", "--session", made.path, "--title", "a\u0001b"]);
  assert.equal(bad.code, 3, bad.out);
  const away = await cli(["list", "--url", "http://192.0.2.1:4800"]);
  assert.equal(away.code, 2);
  const noToken = await cli(["run", "session.list"], { SOVA_TOKEN: "wrong-token" });
  assert.equal(noToken.code, 2, noToken.out);
});

test("an extension's own action runs through the proxy, and Sova's token never reaches its backend", async () => {
  const r = await cli(["run", "ext.stub.echo", "--text", "hello"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { echoed: { text: "hello" } });
  assert.equal(lastCall?.method, "POST");
  assert.equal(lastCall?.url, "/api/commands/echo");
  assert.equal(lastCall?.headers["x-sova-token"], undefined);
  assert.equal(lastCall?.headers["x-sova-origin"], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const missing = await cli(["run", "ext.stub.echo"]);
  assert.equal(missing.code, 3);
});

test("watch prints a rename made while it runs, and changes nothing", async () => {
  // A session with a message of its own: an empty new one is left out of the list.
  const id = "0a0b0c0d-watch-test";
  const dir = join(tmp, "agent", "sessions", "--tmp-sova-cli-int--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `2026-10-17T00-00-00-000Z_${id}.jsonl`),
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: work }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } }),
    ].join("\n") + "\n",
  );
  const made = { id };
  const p = spawn("node", [CLI, "watch", "--events", "renamed"], { env: env(), cwd: work });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  try {
    const deadline = Date.now() + 30_000;
    let n = 0;
    while (!out.includes('"renamed"') && Date.now() < deadline) {
      await cli(["run", "session.title.set", "--session", made.id, "--title", `Watched ${++n}`]);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const line = out.split("\n").find((l) => l.includes('"renamed"'));
    assert.ok(line, `no renamed event in: ${out} (stderr: ${err})`);
    const ev = JSON.parse(line!) as { event: string; id: string; title: string; at: number };
    assert.equal(ev.id, made.id);
    assert.match(ev.title, /^Watched \d+$/);
    assert.equal(typeof ev.at, "number");
    // --events filtered everything else out, the relayed feed frames included.
    assert.ok(out.trim().split("\n").every((l) => JSON.parse(l).event === "renamed"));
  } finally {
    p.kill();
  }
});
