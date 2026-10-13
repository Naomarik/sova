// Run: pnpm test -- server/chat-host.test.ts. The router that decides where an ordinary chat runs
// (§app.chat-processes/surface), over a fake driver: each "unit" is a chat-runtime host in this
// process, linked to the router over an in-memory stream pair (the unit tier opens no sockets). On a
// throwaway PI_CODING_AGENT_DIR with no credentials: no model is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import { CHAT_WIRE_PROTO, CHAT_WIRE_MIN_PROTO, DEFAULT_RUNTIME_SETTINGS, type ExitCause } from "../shared/chat-runtime-wire";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-host-router-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chathost-router--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { ChatHostRouter } = await import("./chat-host");
const { ChatRuntimeHost } = await import("./chat-runtime/host");
const { Link, awaitFrame } = await import("./chat-runtime/link");
const { FakeDriver } = await import("./chat-runtime/fake-driver");
const { ChatSupervisor } = await import("./chat-runtime/supervisor");
const { activeConfigFailure, BusyError, ConfigError, disposeAllChats, serverToolSpec } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
// Start times as on Linux (/proc); on macOS none (no ps spawned: the unit tier forbids it), so locks read by pid alone.
const { procStart, setProcStartForTest } = await import("./chat-runtime/writer-lock");
setProcStartForTest((pid) => procStart(pid, "linux"));
const { PROFILE_ENTRY } = await import("../shared/profiles");
const { LINK_MEMBER_ENTRY } = await import("../shared/mesh-links");

after(async () => {
  await disposeAllChats();
});

let n = 0;
/** A session file, older than the 120 s foreign-write window unless `fresh`. */
function session(o: { extra?: object[]; fresh?: boolean } = {}): { path: string; id: string } {
  const id = `01a0-rt${n}`;
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_${id}.jsonl`);
  n++;
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
    ...(o.extra ?? []),
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  if (!o.fresh) {
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
  }
  return { path: canonicalPath(path), id };
}

/** Two ends of an in-memory stream, as a connected socket pair. */
function pair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  for (let i = 0; i < 2; i++)
    ends.push(
      new Duplex({
        allowHalfOpen: false, // as a socket: one end closing closes the other
        read() {},
        write(chunk, _enc, cb) {
          ends[1 - i]!.push(chunk);
          cb();
        },
        final(cb) {
          ends[1 - i]!.push(null);
          cb();
        },
      }),
    );
  return [ends[0]!, ends[1]!];
}

const quiet = () => {};
let epoch = 1_000;

/** A router over a fake driver whose started units answer as chat-runtime hosts in this process. */
function setup(o: { bun?: string | null; build?: string; gen?: { id: string; dir: string; live: boolean } } = {}) {
  const driver = new FakeDriver();
  // Its own records and socket paths: a later router takes back only these units.
  const dir = mkdtempSync(join(agentDir, "sup-"));
  const supervisor = { registryDir: () => join(dir, "registry"), deathsFile: () => join(dir, "deaths.jsonl"), socketPath: (id: string, suffix?: string) => join(dir, `${id}${suffix ?? ""}.sock`) };
  const hosts = new Map<string, InstanceType<typeof ChatRuntimeHost>>();
  const exits: ExitCause[] = [];
  let connects = 0;
  const connect = (async (sock: string, opts: { epoch: number; build: string; since: number | null; settings: never }) => {
    connects++;
    const spec = driver.started.find((s) => s.env.SOVA_CHAT_SOCK === sock);
    if (!spec || !driver.table.has(spec.unit)) throw new Error(`nothing listens on ${sock}`);
    let host = hosts.get(sock);
    if (!host) {
      host = new ChatRuntimeHost({ path: spec.env.SOVA_CHAT_PATH!, sessionId: spec.env.SOVA_CHAT_ID!, unit: spec.unit, build: opts.build, startedAt: 1, exit: (c) => exits.push(c), log: quiet, tickMs: 60_000 });
      hosts.set(sock, host);
    }
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const link = new Link(b as never, { log: quiet });
    const hello = { t: "hello" as const, proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: 0, ...host.hello() };
    // The control reaches the chat later, as over a socket: after the caller is listening.
    const h = host;
    setImmediate(() => h.onControl(runtimeEnd, { t: "control", proto: CHAT_WIRE_PROTO, epoch: opts.epoch, serverPid: 1, serverStartedAt: 1, build: opts.build, since: opts.since, settings: opts.settings }));
    return { link, hello };
  }) as never;
  const router = new ChatHostRouter(++epoch, o.build ?? "b1", { driver, connect, supervisor, ...("bun" in o ? { bun: () => o.bun ?? null } : {}), ...(o.gen ? { gen: o.gen } : {}) });
  // The next server: a router over the same units (a restart), with a higher epoch.
  // `delayMs`: each of its connects takes that long first (a slow take-back).
  const again = (delayMs = 0) =>
    new ChatHostRouter(++epoch, "b1", {
      driver,
      connect: delayMs ? (((sock: string, opts: never) => new Promise((r) => setTimeout(r, delayMs)).then(() => (connect as (s: string, o: never) => Promise<unknown>)(sock, opts))) as never) : connect,
      supervisor,
    });
  return { router, driver, hosts, exits, connects: () => connects, again, connect: connect as typeof import("./chat-runtime/link").connectLink, supervisor };
}

test("an ordinary chat runs in a process of its own; a link member is ordinary", async () => {
  const t = setup();
  const s = session();
  const h = await t.router.acquire(s.path, false);
  assert.ok(h, "a remote handle");
  assert.equal(h.where, "process");
  assert.equal(t.driver.started.length, 1);
  assert.equal(t.driver.started[0]!.env.SOVA_CHAT_PATH, s.path);
  assert.equal(t.router.get(s.path), h);
  assert.deepEqual(t.router.all(), [h]);
  // Acquired again: the same process, no second unit.
  assert.equal(await t.router.acquire(s.path, false), h);
  assert.equal(t.driver.started.length, 1);

  const member = session({ extra: [{ type: "custom", id: "lm", parentId: "a1", timestamp: "2026-10-12T00:00:03.000Z", customType: LINK_MEMBER_ENTRY, data: { v: 1 } }] });
  const m = await t.router.acquire(member.path, false);
  assert.equal(m?.where, "process");
  assert.equal(t.driver.started.length, 2);
  t.router.detach();
});

test("with no Bun anywhere every chat open is refused, and no process starts", async () => {
  const t = setup({ bun: null });
  await assert.rejects(t.router.acquire(session().path, false), /Chats need Bun to run Sova's chat runtime/);
  assert.equal(t.driver.started.length, 0);
  t.router.detach();
});

test("a chat whose profile grants powers runs in a process of its own too", async () => {
  const t = setup();
  const powers = session({ extra: [{ type: "custom", id: "p1", parentId: "a1", timestamp: "2026-10-12T00:00:03.000Z", customType: PROFILE_ENTRY, data: { v: 1, profile: { id: "ops", name: "Ops", grant: ["shell"], remove: [] } } }] });
  const p = await t.router.acquire(powers.path, false);
  assert.equal(p?.where, "process");
  assert.equal(t.driver.started.length, 1);
  t.router.detach();
});

test("two opens of one chat at once start one process (single-flight)", async () => {
  const t = setup();
  const s = session();
  const [a, b] = await Promise.all([t.router.acquire(s.path, false), t.router.acquire(s.path, false)]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(t.driver.started.length, 1);
  t.router.detach();
});

test("B1: a chat whose process can't start, with no older copy, is refused with the reason; never opened in the server", async () => {
  const t = setup();
  const s = session();
  t.driver.failNextStart = "systemd-run: boom";
  await assert.rejects(t.router.acquire(s.path, false), /This chat's process didn't start: it could not start its process \(.*boom/);
  assert.equal(t.driver.started.length, 0);
  // Not remembered: the next open tries again, and starts.
  const h = await t.router.acquire(s.path, false);
  assert.equal(h.where, "process");
  t.router.detach();
});

test("B1: a chat whose process can't start on the current copy starts on the last good one, and shows why", async () => {
  const { codeRoot, generationDir } = await import("./chat-runtime/generations");
  mkdirSync(generationDir("g1"), { recursive: true });
  writeFileSync(join(generationDir("g1"), ".complete"), "{}\n");
  writeFileSync(join(codeRoot(), "good"), "g1\n");
  const t = setup({ build: "g2", gen: { id: "g2", dir: "/copies/g2", live: false } });
  const s = session();
  t.driver.failNextStart = "systemd-run: boom";
  const h = await t.router.acquire(s.path, false);
  assert.equal(h.where, "process");
  assert.equal(t.driver.started.length, 1);
  assert.equal(t.driver.started[0]!.env.SOVA_CHAT_BUILD, "g1", "on the last good copy");
  assert.equal(t.driver.started[0]!.cwd, generationDir("g1"));
  t.router.detach();
  rmSync(codeRoot(), { recursive: true, force: true });
});

test("a cheap refusal comes before any process: a file written moments ago by someone else", async () => {
  const t = setup();
  const s = session({ fresh: true });
  await assert.rejects(t.router.acquire(s.path, false), (err: unknown) => err instanceof BusyError && err.code === "recent");
  assert.equal(t.driver.started.length, 0);
  assert.equal(t.connects(), 0);
});

test("shutdown: a chat process is told goodbye and runs on; no unit is stopped", async () => {
  const t = setup();
  const s = session();
  const h = await t.router.acquire(s.path, false);
  assert.ok(h);
  t.router.detach();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.driver.stopped, []);
  assert.equal(t.driver.table.get(t.driver.started[0]!.unit)?.status.state, "active");
  assert.deepEqual(t.exits, [], "the chat did not exit");
});

test("a chat process's model calls are counted once in the server (its producer folded), and no longer once it is forgotten", async () => {
  const { snapshot } = await import("../pi-config/extensions/llm-inflight/tracker.ts");
  const t = setup();
  const s = session();
  const h = await t.router.acquire(s.path, false);
  assert.ok(h);
  const r = t.router as unknown as { hooks: { state(h: unknown): void; exit(h: unknown, cause: string): void } };
  const own = snapshot();
  const llm = { ...own, producer: "chat-proc-1", pid: 4242, folded: [], active: 1, approximate: 0, claudeTurns: 0, degraded: false };
  (h as { mirror: object }).mirror = { ...(h as { mirror: object }).mirror, llm };
  r.hooks.state(h);
  r.hooks.state(h); // a repeated state replaces, never adds
  const counted = snapshot();
  assert.ok(counted.folded.includes("chat-proc-1"));
  assert.equal(counted.active, own.active + 1);
  // Its process ended: its counts go with it.
  t.router.detach();
  r.hooks.exit(h, "idle");
  assert.ok(!snapshot().folded.includes("chat-proc-1"));
  assert.equal(snapshot().active, own.active);
});

test("B6: a worker's and a hidden chat's model calls, reported with their state over the link, are in this server's own count", async () => {
  const { snapshot } = await import("../pi-config/extensions/llm-inflight/tracker.ts");
  const { hostCount } = await import("./llm-inflight");
  const t = setup();
  const parent = session();
  const before = hostCount(snapshot(), Date.now()).count;
  const r = t.router as unknown as { hooks: { state(h: unknown): void; exit(h: unknown, cause: string): void }; remotes: Map<string, unknown> };
  const handles: unknown[] = [];
  for (const [i, kind] of (["pi", "btw"] as const).entries()) {
    const spec = { kind, parent: { sessionId: parent.id, path: parent.path, workerId: `ag_0${i + 1}` }, cwd, model: null, thinking: null, builtins: null, extensions: [], flags: {}, appendSystemPrompt: null, env: {}, agentDir: null, lowered: true as const };
    const ref = await t.router.workers.start({ key: `b6:${kind}`, spec: spec as never, session: { new: { dir: join(agentDir, "sessions", "--b6--") } }, task: null });
    const h = r.remotes.get(ref.sessionFile)!;
    assert.ok(h, `${kind}: its process's handle`);
    const llm = { ...snapshot(), producer: `b6-${kind}`, pid: 5000 + i, folded: [], active: 1, approximate: 0, claudeTurns: 0, degraded: false };
    (h as { mirror: object }).mirror = { ...(h as { mirror: object }).mirror, llm };
    r.hooks.state(h);
    handles.push(h);
  }
  assert.equal(hostCount(snapshot(), Date.now()).count, before + 2, "each counted once");
  t.router.detach();
  for (const h of handles) r.hooks.exit(h, "idle");
  assert.equal(hostCount(snapshot(), Date.now()).count, before);
});

test("after a restart, a taken-back chat's server-hosted tools run here: a call queued while no server was there, and a new one", async () => {
  process.env.SOVA_CHAT_TEST_SERVED = "1";
  after(() => void delete process.env.SOVA_CHAT_TEST_SERVED);
  const t = setup();
  const s = session();
  // The previous server, by hand: it started the chat and opened it with its served tools declared.
  // This process never served them, as a restarted server hasn't.
  const prev = new ChatSupervisor({
    driver: t.driver,
    epoch: ++epoch,
    ...t.supervisor,
    launch: (c) => ({ argv: ["bun"], env: { SOVA_CHAT_PATH: c.sessionPath, SOVA_CHAT_ID: c.chatId, SOVA_CHAT_SOCK: c.sock } }),
    log: quiet,
  });
  const rec = await prev.start({ chatId: s.id, sessionPath: s.path, cwd });
  const { link } = await t.connect(rec.sock, { epoch: epoch, build: "b1", settings: DEFAULT_RUNTIME_SETTINGS, since: null });
  const decl = { name: "trial_served_sleep", label: "Trial served sleep", description: "sleeps", parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } };
  const opened = awaitFrame(link, "opened", 5_000);
  link.send({ t: "open", id: "o1", path: s.path, force: true, link: null, served: [decl] });
  assert.equal((await opened).ok, true);
  prev.detach();
  link.close(); // the previous server is gone; the chat runs on
  await new Promise((r) => setTimeout(r, 50));
  const queued = serverToolSpec(s.path, decl).execute("tc-1", { ms: 0 }, undefined, undefined, undefined);

  const next = t.again();
  try {
    next.start();
    await next.ready();
    assert.equal(next.get(s.path)?.where, "process", "taken back");
    const answer = (p: Promise<unknown>) =>
      Promise.race([p.then(() => "ran", (e: Error) => e.message), new Promise<string>((r) => setTimeout(() => r("no answer"), 3_000))]);
    assert.equal(await answer(queued), "ran", "the queued call ran once the chat was taken back");
    assert.equal(await answer(serverToolSpec(s.path, decl).execute("tc-2", { ms: 0 }, undefined, undefined, undefined)), "ran", "a new call runs too");
  } finally {
    next.detach();
  }
});

test("opening a chat while the next server is still taking chats back waits for it: the surviving process, never a second one", async () => {
  const t = setup();
  const s = session();
  const first = await t.router.acquire(s.path, false);
  assert.equal(first?.where, "process");
  t.router.detach();
  const next = t.again(300);
  try {
    next.start();
    // No ready() first: an open that comes before the take-back is done (a boot sweep, a slow build).
    const h = await next.acquire(s.path, false);
    assert.equal(h?.where, "process", "the chat taken back");
    assert.equal(t.driver.started.length, 1, "no second unit");
    assert.equal(t.connects(), 2, "the first open and the take-back: no start attempted meanwhile");
  } finally {
    next.detach();
  }
});

test("while another chat's take-back is slow, a chat with no process left opens at once; the taken-back one waits for its own", async () => {
  const t = setup();
  const kept = session();
  await t.router.acquire(kept.path, false);
  t.router.detach();
  const slow = t.driver.started[0]!.env.SOVA_CHAT_SOCK;
  const later = (sock: string) => (sock === slow ? new Promise((r) => setTimeout(r, 1_500)) : Promise.resolve());
  const next = new ChatHostRouter(++epoch, "b1", {
    driver: t.driver,
    connect: ((sock: string, opts: never) => later(sock).then(() => t.connect(sock, opts))) as never,
    supervisor: t.supervisor,
  });
  try {
    next.start();
    let back = false;
    const keptOpen = next.acquire(kept.path, false).then((h) => ((back = true), h));
    const fresh = await next.acquire(session().path, false);
    assert.equal(fresh?.where, "process");
    assert.equal(back, false, "opened before the other chat was taken back");
    assert.equal((await keptOpen)?.where, "process", "the surviving process");
    assert.equal(t.driver.started.length, 2, "one new unit, never a second for the surviving chat");
  } finally {
    next.detach();
  }
});

test("a worker's own session file is refused for good with the subagent-session text", async () => {
  {
    const t = setup();
    const s = session({ extra: [{ type: "custom", customType: "subagents-worker-session", id: "w1", parentId: "a1", timestamp: "2026-10-12T00:00:03.000Z", data: {} }] });
    await assert.rejects(t.router.acquire(s.path, false), (e: Error) => e instanceof ConfigError && /is a subagent's own session; act on the session that runs it\.$/.test(e.message));
    assert.equal(t.driver.started.length, 0);
  }
});

test("a chat whose folder is gone is refused before any process, and remembered until the folder is back", async () => {
  const t = setup();
  const gone = join(agentDir, "gone");
  mkdirSync(gone);
  const s = session();
  writeFileSync(s.path, readFileSync(s.path, "utf8").replace(JSON.stringify(cwd), JSON.stringify(gone)));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(s.path, old, old);
  rmSync(gone, { recursive: true });
  for (let i = 0; i < 2; i++) await assert.rejects(t.router.acquire(s.path, false), (err: unknown) => err instanceof ConfigError && err.cwd === gone);
  assert.ok(activeConfigFailure(s.path) instanceof ConfigError, "remembered");
  assert.equal(t.driver.started.length, 0, "no process for a doomed open");
  mkdirSync(gone);
  assert.equal(activeConfigFailure(s.path), undefined, "the folder came back");
  const h = await t.router.acquire(s.path, false);
  assert.equal(h?.where, "process");
  t.router.detach();
});

test("a chat starting again on its previous code after a failed open keeps that code in use until it has started", async () => {
  const t = setup({ build: "g2", gen: { id: "g2", dir: "/copies/g2", live: false } });
  const priv = t.router as unknown as {
    builds: Map<string, string>;
    startOnce: (path: string) => Promise<unknown>;
    rollout: { deps: { onReloadOpenFailed(id: string, path: string, reason: string): void } };
  };
  let started!: () => void;
  priv.startOnce = () => new Promise<void>((r) => (started = r));
  priv.builds.set("c1", "g1");
  try {
    priv.rollout.deps.onReloadOpenFailed("c1", "/s/c1.jsonl", "the chat did not open on the new code");
    assert.ok(t.router.buildsInUse().includes("g1"), "between the forget and the new record: kept");
    started();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!t.router.buildsInUse().includes("g1"), "started (its record names it from now on): no longer held here");
  } finally {
    t.router.detach();
  }
});

test("a take-back that fails starts no collection of unused code (a chat it missed may run from one), yet opens go on", async () => {
  const t = setup();
  const next = new ChatHostRouter(++epoch, "g1", { driver: t.driver, connect: t.connect, supervisor: t.supervisor, gen: { id: "g1", dir: "/copies/g1", live: false } });
  const priv = next as unknown as { sup: { adopt: () => Promise<unknown> }; gc: unknown };
  priv.sup.adopt = async () => {
    throw new Error("registry unreadable");
  };
  try {
    next.start();
    await next.ready();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(priv.gc, null, "no collection this server life");
    const h = await next.acquire(session().path, false);
    assert.equal(h?.where, "process", "an open does not wait on the failed take-back");
  } finally {
    next.detach();
  }
});

test("an open that waited on a chat whose process went meanwhile (an operator stop) opens it anew, never failing as unreachable", async () => {
  const t = setup();
  const s = session();
  const first = await t.router.acquire(s.path, false);
  assert.equal(first?.where, "process");
  const { noAnswer } = await import("../shared/chat-runtime");
  const priv = t.router as unknown as { forget: (path: string) => void };
  // The reacquire was waiting for the link when the process exited on the operator's word: forgotten, then failed.
  (first as unknown as { call: () => Promise<never> }).call = async () => {
    priv.forget(s.path);
    throw noAnswer("The chat's process is not reachable right now.");
  };
  try {
    const again = await t.router.acquire(s.path, false);
    assert.notEqual(again, first);
    assert.equal(again?.where, "process", "opened in a new process");
  } finally {
    t.router.detach();
  }
});
