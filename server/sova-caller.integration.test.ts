// Run: node scripts/run-tests.mjs server/sova-caller.integration.test.ts
// Who ran what, end to end (§app.command-audit/attribution, /record, /list): the whole server on an
// ephemeral port in a throwaway PI_CODING_AGENT_DIR, `node scripts/sova.mjs` as a real process with
// the server's token and a chat's key in SOVA_CALLER_KEY, and a stand-in extension backend. One row
// per run naming its command and the key's chat; no param value anywhere in the record; a key
// without the token is refused exactly as no credential is; the key never reaches a backend.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-caller-int-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
process.env.PORT = "0";
delete process.env.SOVA_CALLER_KEY;
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });
const work = join(tmp, "work");
mkdirSync(work);
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");

const { server } = await import("./index");
const { sovaToken } = await import("./auth");
const { callerKeys } = await import("./caller-keys");
const { commandAudit } = await import("./command-audit");

let lastHeaders: IncomingHttpHeaders | null = null;
let backend: Server;
let base = "";
// A chat this test stands in for: its key names it while "its process runs".
const { chatHostHealth } = await import("./chat-host");
let key = "";
/** A chat this test stands in for. The server's chat router registers its supervisor's liveness when
    it is made, and its take-back prunes every key whose process it doesn't run: so the key is issued
    after that, and the liveness stood in for again before each run. */
function standIn(): void {
  callerKeys.setLiveness((chatId, unit) => chatId === "chat-int" && unit === "unit-int");
  if (!key || callerKeys.callerOf(key) !== "chat:chat-int") key = callerKeys.issue("chat-int", "unit-int");
}

before(async () => {
  backend = createServer(async (req, res) => {
    for await (const _ of req) void _;
    if (req.url === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    lastHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const port = (backend.address() as { port: number }).port;
  writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version: 1, extensions: [{ id: "stub", dist, api: `http://127.0.0.1:${port}`, commands: [{ name: "echo", label: "Echo", params: { text: { type: "string" } } }] }] }));
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  for (let i = 0; i < 200 && chatHostHealth().driver === "starting"; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200)); // the take-back's prune, on an empty registry
  standIn();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  backend.close();
  rmSync(tmp, { recursive: true, force: true });
});

const CLI = fileURLToPath(new URL("../scripts/sova.mjs", import.meta.url));
function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  standIn();
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: { ...process.env, SOVA_TOKEN: sovaToken(), SOVA_URL: base, SOVA_CHAT_ID: "", SOVA_CALLER_KEY: key, ...extraEnv }, cwd: work });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}
type Row = { at: string; caller: string; command?: string; method: string; route: string; status: number };
const audit = async (q = "--limit 1000"): Promise<Row[]> => {
  const r = await cli(["run", "audit.list", ...q.split(" ")]);
  assert.equal(r.code, 0, r.err);
  return (JSON.parse(r.out) as { rows: Row[] }).rows;
};

test("one row per run, naming its command and the key's chat", async () => {
  const before = (await audit()).filter((r) => r.command === "models.list").length;
  const run = await cli(["run", "models.list"]);
  assert.equal(run.code, 0, run.err);
  const rows = await audit();
  assert.equal(rows.filter((r) => r.command === "models.list").length, before + 1);
  assert.deepEqual(rows[0], { at: rows[0]!.at, caller: "chat:chat-int", command: "models.list", method: "GET", route: "/api/models", status: 200 } as Row);
  // A key that names no running chat, and none at all.
  await cli(["run", "models.list"], { SOVA_CALLER_KEY: "Zz9-not-a-live-key-Zz9-not-a-live-key" });
  await cli(["run", "models.list"], { SOVA_CALLER_KEY: "" });
  const [none, dead] = await audit("--limit 2 --command models.list");
  assert.equal(dead!.caller, "unattributed");
  assert.equal(none!.caller, "no-key");
  assert.deepEqual((await audit("--caller chat:chat-int --command models.list --limit 1")).length, 1);
});

test("no param value is ever recorded: a rename's title and session are nowhere in the record", async () => {
  const made = JSON.parse((await cli(["run", "session.create", "--cwd", "."])).out) as { id: string; path: string };
  const set = await cli(["run", "session.title.set", "--session", made.id, "--title", "Zebracorn private title"]);
  assert.equal(set.code, 0, set.err);
  const rows = await audit();
  assert.equal(rows.filter((r) => r.command === "session.title.set").length, 1, "the look-up of --session names no command");
  await commandAudit.flush();
  const text = readFileSync(commandAudit.file(), "utf8") + JSON.stringify(rows);
  for (const leak of ["Zebracorn", made.id, made.path, key, sovaToken()]) assert.ok(!text.includes(leak), `${leak.slice(0, 12)} is in the record`);
});

test("a key without the token is refused exactly as no credential is, and leaves no row", async () => {
  const empty = join(tmp, "no-token-agent");
  mkdirSync(empty, { recursive: true });
  const noCred = await cli(["run", "session.list"], { SOVA_TOKEN: "", PI_CODING_AGENT_DIR: empty, SOVA_CALLER_KEY: "" });
  const keyOnly = await cli(["run", "session.list"], { SOVA_TOKEN: "", PI_CODING_AGENT_DIR: empty });
  assert.equal(noCred.code, 2, noCred.err);
  assert.deepEqual(keyOnly, noCred);
  const direct = await fetch(`${base}/api/sessions`, { headers: { "x-sova-caller": key } });
  const bare = await fetch(`${base}/api/sessions`);
  assert.equal(direct.status, 401);
  assert.deepEqual([direct.status, await direct.text()], [bare.status, await bare.text()]);
  const rows = await audit();
  assert.equal(rows.filter((r) => r.route === "/api/sessions" && r.status === 401).length, 0);
});

test("the key never reaches an extension's backend; the run is recorded under the extension's command", async () => {
  const r = await cli(["run", "ext.stub.echo", "--text", "hello"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(lastHeaders?.["x-sova-caller"], undefined);
  assert.equal(lastHeaders?.["x-sova-token"], undefined);
  const [row] = await audit("--limit 1 --command ext.stub.echo");
  assert.equal(row!.caller, "chat:chat-int");
});
