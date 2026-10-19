// Run: pnpm test -- server/chat-host-caller-key.test.ts
// Each chat process's key as the router launches it (§app.command-audit/keys): the launch's env carries
// SOVA_CALLER_KEY, which names that chat while its process runs and nobody once it closed; a worker's
// spec env can't choose it. A router over a fake driver whose units answer as chat-runtime hosts in
// this process (the harness of server/chat-host.test.ts, trimmed).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import { CHAT_WIRE_MIN_PROTO, CHAT_WIRE_PROTO } from "../shared/chat-runtime-wire";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-host-key-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-chathost-key--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { ChatHostRouter } = await import("./chat-host");
const { ChatRuntimeHost } = await import("./chat-runtime/host");
const { Link } = await import("./chat-runtime/link");
const { FakeDriver } = await import("./chat-runtime/fake-driver");
const { disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { procStart, setProcStartForTest } = await import("./chat-runtime/writer-lock");
const { CallerKeys } = await import("./caller-keys");
setProcStartForTest((pid) => procStart(pid, "linux"));

const hosts: InstanceType<typeof ChatRuntimeHost>[] = [];
after(async () => {
  await Promise.all(hosts.map((h) => h.close("operator", { dispose: true }).catch(() => {})));
  await disposeAllChats();
});

let n = 0;
function session(): { path: string; id: string } {
  const id = `01a0-key${n}`;
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_${id}.jsonl`);
  n++;
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "ask" }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
  return { path: canonicalPath(path), id };
}

function pair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  for (let i = 0; i < 2; i++)
    ends.push(
      new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, _enc, cb) {
          setImmediate(() => ends[1 - i]!.push(chunk));
          cb();
        },
        final(cb) {
          setImmediate(() => ends[1 - i]!.push(null));
          cb();
        },
      }),
    );
  return [ends[0]!, ends[1]!];
}

function setup(o: { before?: (keys: InstanceType<typeof CallerKeys>) => void; sweepChildren?: () => Promise<string[]>; prune?: () => string[] } = {}) {
  const driver = new FakeDriver();
  const dir = mkdtempSync(join(agentDir, "sup-"));
  const supervisor = { registryDir: () => join(dir, "registry"), deathsFile: () => join(dir, "deaths.jsonl"), socketPath: (id: string, suffix?: string) => join(dir, `${id}${suffix ?? ""}.sock`), isChatProcess: () => false };
  const bySock = new Map<string, InstanceType<typeof ChatRuntimeHost>>();
  const connect = (async (sock: string, opts: { epoch: number; build: string; since: number | null; settings: never }) => {
    const spec = [...driver.started].reverse().find((s) => s.env.SOVA_CHAT_SOCK === sock);
    if (!spec || !driver.table.has(spec.unit)) throw new Error(`nothing listens on ${sock}`);
    let host = bySock.get(sock);
    if (!host) {
      host = new ChatRuntimeHost({ path: spec.env.SOVA_CHAT_PATH!, sessionId: spec.env.SOVA_CHAT_ID!, unit: spec.unit, build: opts.build, startedAt: 1, exit: () => driver.table.delete(spec.unit), log: () => {}, tickMs: 60_000 });
      bySock.set(sock, host);
      hosts.push(host);
    }
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: () => {} });
    const link = new Link(b as never, { log: () => {} });
    const hello = { t: "hello" as const, proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: 0, ...host.hello() };
    const h = host;
    setImmediate(() => h.onControl(runtimeEnd, { t: "control", proto: CHAT_WIRE_PROTO, epoch: opts.epoch, serverPid: 1, serverStartedAt: 1, build: opts.build, since: opts.since, settings: opts.settings }));
    return { link, hello };
  }) as never;
  const keys = new CallerKeys(() => join(dir, "caller-keys"));
  if (o.prune) keys.prune = o.prune;
  o.before?.(new CallerKeys(() => join(dir, "caller-keys"))); // what an earlier server left
  const router = new ChatHostRouter(Date.now(), "b1", { driver, connect, supervisor, bun: () => process.execPath, resumeCrashed: () => {}, callerKeys: keys, sweepChildren: o.sweepChildren ?? (async () => []) });
  // As the server does at its start: the take-back (nothing to take back here), then the watch.
  router.start();
  return { router, driver, keys, dir };
}

/** Wait (up to 10 s) until `ok()`: the supervisor's watch sees an ended process within its 2 s tick. */
async function until(ok: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ok();
}

test("a chat's process gets its own key: it names that chat while the process runs, nobody after its close", async () => {
  const t = setup();
  await t.router.ready();
  const s = session();
  await t.router.acquire(s.path, false);
  const spec = t.driver.started.at(-1)!;
  const key = spec.env.SOVA_CALLER_KEY;
  assert.ok(key && key.length >= 32, "SOVA_CALLER_KEY is in the launch's env");
  assert.equal(spec.env.SOVA_CHAT_ID, s.id);
  assert.equal(t.keys.callerOf(key), `chat:${s.id}`);
  // A key of another process of the same chat (an earlier start, a reload's other unit) names nobody
  // while this one runs: liveness is the chat AND its unit.
  const stale = t.keys.issue(s.id, `${spec.unit}-r9`);
  assert.equal(t.keys.callerOf(stale), "unattributed");
  assert.equal(t.keys.callerOf(key), `chat:${s.id}`);
  const other = session();
  await t.router.acquire(other.path, false);
  const otherKey = t.driver.started.at(-1)!.env.SOVA_CALLER_KEY!;
  assert.notEqual(otherKey, key, "each process its own key");
  assert.equal(t.keys.callerOf(otherKey), `chat:${other.id}`);
  assert.equal(await t.router.close(s.path, "archived"), true);
  assert.ok(await until(() => t.keys.callerOf(key) === "unattributed"), "its process ended: the key (and any copy of it) names nobody");
  assert.equal(t.keys.callerOf(otherKey), `chat:${other.id}`);
  t.router.detach();
});

test("a worker's spec env can't choose its key", async () => {
  const t = setup();
  const parent = session();
  const spec = { kind: "pi", parent: { sessionId: parent.id, path: parent.path, workerId: "ag_01" }, cwd, model: null, thinking: null, builtins: null, extensions: [], flags: {}, appendSystemPrompt: null, env: { SOVA_CALLER_KEY: "chosen-by-the-loadout-chosen-by-the-loadout" }, agentDir: null, lowered: true as const };
  await t.router.workers.start({ key: "key:w", spec: spec as never, session: { new: { dir: join(agentDir, "sessions", "--w--") } }, task: null });
  const env = t.driver.started.at(-1)!.env;
  assert.notEqual(env.SOVA_CALLER_KEY, "chosen-by-the-loadout-chosen-by-the-loadout");
  assert.match(t.keys.callerOf(env.SOVA_CALLER_KEY), /^chat:/);
  assert.equal(t.keys.callerOf("chosen-by-the-loadout-chosen-by-the-loadout"), "unattributed");
  t.router.detach();
});

test("a prune that throws never stops the start: ready resolves, chats still open", async () => {
  const t = setup({ before: () => {}, prune: () => { throw new Error("injected"); } });
  await t.router.ready();
  const s = session();
  await t.router.acquire(s.path, false);
  assert.match(t.keys.callerOf(t.driver.started.at(-1)!.env.SOVA_CALLER_KEY), /^chat:/);
  t.router.detach();
});

test("a whole take-back prunes the keys of chats it didn't take back; a failed one prunes nothing", async () => {
  const ok = setup({ before: (k) => void k.issue("gone", "unit-gone") });
  await ok.router.ready();
  assert.ok(await until(() => !existsSync(join(ok.dir, "caller-keys", "unit-gone.json"))), "pruned after a whole take-back");
  ok.router.detach();
  const failed = setup({
    before: (k) => void k.issue("survivor", "unit-survivor"),
    sweepChildren: async () => {
      throw new Error("the take-back failed");
    },
  });
  await failed.router.ready();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(existsSync(join(failed.dir, "caller-keys", "unit-survivor.json")), "a failed take-back may not know a survivor: its key stays");
  failed.router.detach();
});

test("a server started from a chat's tools never acts as that chat: its own SOVA_CALLER_KEY is scrubbed and never passed on", async () => {
  const { chatEnv, scrubChatProcessEnv } = await import("./chat-runtime/supervisor");
  const env = chatEnv({ serverEnv: { SOVA_CALLER_KEY: "the-outer-chat-key-the-outer-chat-key", LANG: "C" }, bun: "/opt/bun/bin/bun", home: "/h", agentDir: "/h/a" });
  assert.equal(env.SOVA_CALLER_KEY, undefined);
  const own: NodeJS.ProcessEnv = { SOVA_CALLER_KEY: "the-outer-chat-key-the-outer-chat-key", LANG: "C" };
  assert.ok(scrubChatProcessEnv(own).includes("SOVA_CALLER_KEY"));
  assert.equal(own.SOVA_CALLER_KEY, undefined);
});
