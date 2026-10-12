// Run: pnpm test:int -- server/chat-runtime/main.integration.test.ts. The chat process for real: `bun
// server/chat-runtime/main.ts` spawned on a throwaway agent dir (no credentials: no model is called),
// dialed over its socket as the server would. It says hello while it boots and again when ready,
// opens its one chat, serves a browser, and exits on purpose with the cause it gave: a drain, SIGTERM,
// or the test hook that fails a start.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_RUNTIME_SETTINGS } from "../../shared/chat-runtime-wire";
import { awaitFrame, connectLink } from "./link";

const root = join(import.meta.dirname, "..", "..");
const base = mkdtempSync(join(tmpdir(), "crm-"));
after(() => rmSync(base, { recursive: true, force: true }));
const kids: ChildProcess[] = [];
after(() => kids.forEach((k) => k.kill("SIGKILL")));

let n = 0;
function chatProcess(extra: Record<string, string> = {}) {
  const dir = join(base, `c${++n}`);
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  const sessions = join(agentDir, "sessions", "--x--");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const id = `01a0-mp${n}`;
  const path = join(sessions, `2026-10-12T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd })}\n`);
  const sock = join(dir, "s", "c.sock");
  let out = "";
  const child = spawn(process.execPath, [join(root, "server/chat-runtime/main.ts")], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, SOVA_CHAT_SOCK: sock, SOVA_CHAT_PATH: path, SOVA_CHAT_ID: id, SOVA_CHAT_UNIT: "u-test", SOVA_CHAT_BUILD: "b1", SOVA_PRICES_FETCH: "off", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, sock, path, id, exited, out: () => out };
}

const dial = (sock: string, epoch: number) =>
  connectLink(sock, { epoch, build: "b1", settings: DEFAULT_RUNTIME_SETTINGS, since: null, retryForMs: 10_000, retryEveryMs: 50, log: () => {} });

test("boots, says ready, opens its chat, serves a browser, and drains on purpose", { timeout: 60_000 }, async () => {
  const p = chatProcess();
  const { link, hello } = await dial(p.sock, 1);
  assert.equal(hello.sessionId, p.id);
  assert.equal(hello.build, "b1");
  if (hello.state !== "ready") await awaitFrame(link, "hello", 30_000, (h) => h.state === "ready");
  const opened = awaitFrame(link, "opened", 30_000);
  link.send({ t: "open", id: "o1", path: p.path, force: true, link: null, served: [] });
  const o = await opened;
  assert.equal(o.ok, true, p.out());
  const sends: string[] = [];
  link.on("client.send", (f) => sends.push(f.json));
  link.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(JSON.parse(sends[0]!).type, "hello");
  link.send({ t: "client.detach", clientId: "k1" });
  const exit = awaitFrame(link, "exit", 30_000);
  link.send({ t: "drain", id: "d1", reason: "idle", force: false });
  assert.deepEqual(await exit, { t: "exit", cause: "idle" });
  assert.deepEqual(await p.exited, { code: 0, signal: null });
});

test("SIGTERM closes it as the operator's stop", { timeout: 60_000 }, async () => {
  const p = chatProcess();
  const { link, hello } = await dial(p.sock, 1);
  if (hello.state !== "ready") await awaitFrame(link, "hello", 30_000, (h) => h.state === "ready");
  const opened = awaitFrame(link, "opened", 30_000);
  link.send({ t: "open", id: "o1", path: p.path, force: true, link: null, served: [] });
  assert.equal((await opened).ok, true, p.out());
  const sends: string[] = [];
  link.on("client.send", (f) => sends.push(f.json));
  link.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await new Promise((r) => setTimeout(r, 300));
  const exit = awaitFrame(link, "exit", 30_000);
  p.child.kill("SIGTERM");
  assert.deepEqual(await exit, { t: "exit", cause: "operator" });
  // The pane reconnects quietly, as after a reload.
  assert.deepEqual(JSON.parse(sends.at(-1)!), { type: "error", code: "reloaded", message: "Reconnecting. Your draft is kept." });
  assert.deepEqual(await p.exited, { code: 0, signal: null });
});

test("the failed-start test hook exits before it listens", { timeout: 30_000 }, async () => {
  const p = chatProcess({ SOVA_CHAT_TEST_FAIL_BOOT: "b1" });
  assert.equal((await p.exited).code, 3);
});
