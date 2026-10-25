// Run: pnpm test -- server/chat-host.test.ts. The router that decides where an ordinary chat runs
// (§app.chat-processes/surface), over a fake driver: each "unit" is a chat-runtime host in this
// process, linked to the router over an in-memory stream pair (the unit tier opens no sockets). On a
// throwaway PI_CODING_AGENT_DIR with no credentials: no model is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, afterEach, test } from "node:test";
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
const { targetDir } = await import("./targets");
// Start times as on Linux (/proc); on macOS none (no ps spawned: the unit tier forbids it), so locks read by pid alone.
const { procStart, setProcStartForTest } = await import("./chat-runtime/writer-lock");
setProcStartForTest((pid) => procStart(pid, "linux"));
const { PROFILE_ENTRY } = await import("../shared/profiles");
const { LINK_MEMBER_ENTRY } = await import("../shared/mesh-links");
const { CHAT_CLOSED_CLOSE_CODE } = await import("../shared/protocol");
const { isPermanentClose } = await import("../src/lib/socket");
const { UNREACHABLE } = await import("./chat-handle-remote");

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

/** Two ends of an in-memory stream, as a connected socket pair. `later`: each write lands on the
    other end on a later turn, as over a socket, so a frame answered at once doesn't re-enter the
    link that is still reading the frame before it. */
function pair(later = false): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  for (let i = 0; i < 2; i++)
    ends.push(
      new Duplex({
        allowHalfOpen: false, // as a socket: one end closing closes the other
        read() {},
        write(chunk, _enc, cb) {
          if (later) setImmediate(() => ends[1 - i]!.push(chunk));
          else ends[1 - i]!.push(chunk);
          cb();
        },
        final(cb) {
          if (later) setImmediate(() => ends[1 - i]!.push(null));
          else ends[1 - i]!.push(null);
          cb();
        },
      }),
    );
  return [ends[0]!, ends[1]!];
}

const quiet = () => {};
let epoch = 1_000;

/** A router over a fake driver whose started units answer as chat-runtime hosts in this process. */
type ResumeCall = { path: string; since: number; done?: () => void };

/** The Bun chat processes run on, on either runtime (the fake driver runs nothing): a test of the
    router never depends on the server's own runtime, which on Node has none (a case passes its own). */
const anyBun = () => process.execPath;

/** What each test made, ended after it: no router, chat host, link or interval outlives its test. */
const made = { routers: [] as { detach(): void }[], hosts: [] as InstanceType<typeof ChatRuntimeHost>[], links: [] as { close(): void }[] };
afterEach(async () => {
  for (const r of made.routers.splice(0)) r.detach();
  for (const l of made.links.splice(0)) l.close();
  await new Promise((r) => setImmediate(r));
  await Promise.all(made.hosts.splice(0).map((h) => h.close("operator", { dispose: true }).catch(() => {})));
});

type Connect = typeof import("./chat-runtime/link").connectLink;
/** `wrap`: the router's connect seen through it (a link that misbehaves). */
/** `sup`: the supervisor's own knobs (its clock, idle time, exit wait). */
/** `deps`: the router's test-only waits; `openTrail`: each in-process chat host's open trail. */
function setup(o: { bun?: string | null; build?: string; gen?: { id: string; dir: string; live: boolean }; resumes?: ResumeCall[]; wrap?: (c: Connect) => Connect; sup?: { now?: () => number; idleMs?: number; exitWaitMs?: number }; later?: boolean; deps?: { bootWaitMs?: number; openWaitMs?: number; slowStartMs?: number }; openTrail?: ConstructorParameters<typeof ChatRuntimeHost>[0]["openTrail"] } = {}) {
  const driver = new FakeDriver();
  // Its own records and socket paths: a later router takes back only these units.
  const dir = mkdtempSync(join(agentDir, "sup-"));
  // The fake driver's pids are no real process's (and a unit test runs no ps).
  const supervisor = { registryDir: () => join(dir, "registry"), deathsFile: () => join(dir, "deaths.jsonl"), socketPath: (id: string, suffix?: string) => join(dir, `${id}${suffix ?? ""}.sock`), isChatProcess: () => false };
  const hosts = new Map<string, InstanceType<typeof ChatRuntimeHost>>();
  /** Per chat, as serveLink keeps them: the highest controller epoch seen, and the link in control. */
  const control = new Map<string, { epoch: number; link: InstanceType<typeof Link> | null }>();
  const startOf = new Map<string, unknown>();
  const exits: ExitCause[] = [];
  let connects = 0;
  const connect = (async (sock: string, opts: { epoch: number; build: string; since: number | null; settings: never }) => {
    connects++;
    // The latest start on this socket: a new start is a new process (its own controller epoch).
    const spec = [...driver.started].reverse().find((s) => s.env.SOVA_CHAT_SOCK === sock);
    if (!spec || !driver.table.has(spec.unit)) throw new Error(`nothing listens on ${sock}`);
    let host = hosts.get(sock);
    if (!host || startOf.get(sock) !== spec) {
      startOf.set(sock, spec);
      control.delete(sock);
      host = new ChatRuntimeHost({ path: spec.env.SOVA_CHAT_PATH!, sessionId: spec.env.SOVA_CHAT_ID!, unit: spec.unit, build: opts.build, startedAt: 1, exit: (c) => exits.push(c), log: quiet, tickMs: 60_000, ...(o.openTrail ? { openTrail: o.openTrail } : {}) });
      hosts.set(sock, host);
      made.hosts.push(host);
    }
    const [a, b] = pair(o.later);
    const runtimeEnd = new Link(a as never, { log: quiet });
    const link = new Link(b as never, { log: quiet });
    made.links.push(runtimeEnd, link);
    const hello = { t: "hello" as const, proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: 0, ...host.hello() };
    // The control reaches the chat later, as over a socket: after the caller is listening.
    const h = host;
    setImmediate(() => {
      // serveLink's rule: a stale epoch, or an equal one while its controller is linked, is refused.
      const c = control.get(sock) ?? { epoch: 0, link: null };
      control.set(sock, c);
      if (opts.epoch < c.epoch) return runtimeEnd.close({ reason: "closed" }, { t: "refuse", reason: "stale-epoch", message: `epoch ${opts.epoch} is below ${c.epoch}` });
      if (opts.epoch === c.epoch && c.link?.isOpen) return runtimeEnd.close({ reason: "closed" }, { t: "refuse", reason: "busy-controller", message: `epoch ${c.epoch} already controls this chat` });
      c.epoch = opts.epoch;
      const before = c.link;
      c.link = runtimeEnd;
      if (before?.isOpen) before.close({ reason: "replaced" });
      h.onControl(runtimeEnd, { t: "control", proto: CHAT_WIRE_PROTO, epoch: opts.epoch, serverPid: 1, serverStartedAt: 1, build: opts.build, since: opts.since, settings: opts.settings });
    });
    return { link, hello };
  }) as never;
  // A crash resume, recorded (never sent: its 5 s wait is the test's to end, or a server stop's), in
  // every test: the real one would act on the shared in-flight markers.
  const resumes = o.resumes ?? [];
  const resumeCrashed = (path: string, since: number, _before: unknown, done?: () => void) => void resumes.push({ path, since, ...(done ? { done } : {}) });
  const router = new ChatHostRouter(++epoch, o.build ?? "b1", { driver, connect: o.wrap ? o.wrap(connect) : connect, supervisor: { ...supervisor, ...o.sup }, bun: "bun" in o ? () => o.bun ?? null : anyBun, ...(o.gen ? { gen: o.gen } : {}), resumeCrashed, ...o.deps });
  made.routers.push(router);
  // The next server: a router over the same units (a restart), with a higher epoch.
  // `delayMs`: each of its connects takes that long first (a slow take-back).
  const again = (delayMs = 0) => {
    const next = new ChatHostRouter(++epoch, "b1", {
      driver,
      connect: delayMs ? (((sock: string, opts: never) => new Promise((r) => setTimeout(r, delayMs)).then(() => (connect as (s: string, o: never) => Promise<unknown>)(sock, opts))) as never) : connect,
      supervisor,
      bun: anyBun,
      resumeCrashed,
    });
    made.routers.push(next);
    return next;
  };
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

/** A tab on chat `h`, as the server holds it (attach in this process would run the pane's whole
    greeting through the in-memory link at once), and the chat's state as it reports it: `quiet`,
    with that tab attached. */
function paneOn(router: unknown, h: unknown, client: { send(m: unknown): void; close(code?: number): void }, quiet = true): void {
  const handle = h as { clients: Map<string, unknown>; ids: Map<unknown, string>; mirror: { quiet: { quiet: boolean; clients: number; since: number } } };
  handle.clients.set("k1", client);
  handle.ids.set(client, "k1");
  handle.mirror = { ...handle.mirror, quiet: { ...handle.mirror.quiet, quiet, clients: 1, since: Date.now() } };
  (router as { hooks: { state(h: unknown): void } }).hooks.state(h);
}

test("idle stop: a quiet chat with a tab attached closes after the idle time; the tab is told it closed, and only its next open starts the chat again", async () => {
  // The supervisor's clock, moved on by hand (its waits still pass in real time).
  let ahead = 0;
  const t = setup({ later: true, sup: { now: () => Date.now() + ahead, idleMs: 30 * 60_000, exitWaitMs: 50 } });
  const sup = (t.router as unknown as { sup: InstanceType<typeof ChatSupervisor> }).sup;
  const s = session();
  const h = await t.router.acquire(s.path, false);
  const got: { type: string; code?: string; reason?: string }[] = [];
  const closes: number[] = [];
  // A tab attached, as ws.ts attaches one; the chat reports its state with it attached.
  h.attach({ wire: 2, send: (m) => void got.push(m as never), close: (code) => void closes.push(code ?? 0) });
  const said = () => (h as unknown as { mirror: { quiet: { quiet: boolean; clients: number } } }).mirror.quiet;
  for (let i = 0; i < 50 && said().clients !== 1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(said().clients, 1, "the chat says the tab is attached");
  assert.equal(said().quiet, true);
  assert.ok(got.some((m) => m.type === "hello"), "the tab had its hello");
  // 29 minutes on: still running.
  ahead += 29 * 60_000;
  await sup.tick();
  assert.deepEqual(t.exits, []);
  assert.equal(t.router.get(s.path), h);
  // 31: asked to close, it accepts though the tab is attached.
  ahead += 2 * 60_000;
  await sup.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.exits, ["idle"]);
  assert.equal(t.router.get(s.path), undefined, "the router is done with it");
  // The tab: told it closed, never told to reconnect; its socket closed by the server.
  assert.deepEqual(got.filter((m) => m.type === "closed" || m.type === "error"), [{ type: "closed", reason: "idle" }]);
  assert.deepEqual(closes, [CHAT_CLOSED_CLOSE_CODE], "a code no tab retries: an older bundle, which doesn't know `closed`, stays down too");
  assert.ok(isPermanentClose(CHAT_CLOSED_CLOSE_CODE));
  // Nothing starts it again on its own.
  ahead += 60 * 60_000;
  await sup.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.driver.started.length, 1, "no second process");
  // The tab's send opens it again (ws.ts acquires on its connect, then hands the message on): one new process.
  const again = await t.router.acquire(s.path, false);
  assert.notEqual(again, h);
  assert.equal(t.driver.started.length, 2);
  t.router.detach();
});

test("archive: a tab on the chat is told it closed, never to reconnect (which would start the archived chat again)", async () => {
  const t = setup({ later: true });
  const s = session();
  const h = await t.router.acquire(s.path, false);
  const got: { type: string; code?: string; reason?: string }[] = [];
  const closes: number[] = [];
  h.attach({ wire: 2, send: (m) => void got.push(m as never), close: (code) => void closes.push(code ?? 0) });
  for (let i = 0; i < 50 && !got.some((m) => m.type === "hello"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.some((m) => m.type === "hello"), "the tab had its hello");
  // As archiveSession closes it (sessions-index.ts).
  assert.equal(await t.router.close(s.path, "Session archived; its runtime was closed.", { quiet: "archived" }), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(t.exits, ["archived"]);
  assert.deepEqual(got.filter((m) => m.type === "closed" || m.type === "error"), [{ type: "closed", reason: "archived" }], "no `reloaded`: a tab that reconnects reopens the chat");
  assert.deepEqual(closes, [CHAT_CLOSED_CLOSE_CODE], "a code no tab retries: an older bundle, which doesn't know `closed`, stays down too");
  assert.ok(isPermanentClose(CHAT_CLOSED_CLOSE_CODE));
  assert.equal(t.router.get(s.path), undefined);
  assert.equal(t.driver.started.length, 1);
  t.router.detach();
});

test("archive: what the chat took before it closed reaches its tab first (a send's answer) or its caller (a call's), never handed back as unreachable", async () => {
  const t = setup({ later: true });
  const s = session();
  const h = await t.router.acquire(s.path, false);
  const got: { type: string; clientId?: string; code?: string }[] = [];
  const client = { wire: 2 as const, send: (m: unknown) => void got.push(m as never), close: () => {} };
  h.attach(client);
  for (let i = 0; i < 50 && !got.some((m) => m.type === "hello"); i++) await new Promise((r) => setTimeout(r, 20));
  // A send from the tab and a call from the server, both on their way when the archive starts.
  h.clientMessage(client, { type: "prompt", text: "taken before the archive", clientId: "c-taken" } as never);
  const call = h.send({ text: "a server's send", origin: "server" }).then(
    (r) => ({ ok: true as const, r }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  );
  await t.router.close(s.path, "Session archived; its runtime was closed.", { quiet: "archived" });
  await new Promise((r) => setTimeout(r, 100));
  const named = got.findIndex((m) => m.clientId === "c-taken");
  const closed = got.findIndex((m) => m.type === "closed");
  assert.ok(closed >= 0, "told closed");
  assert.ok(named >= 0 && named < closed, `the chat's answer to the send reached the tab before \`closed\`: ${JSON.stringify(got.slice(-6))}`);
  assert.notEqual(got[named]!.code, "refused", "the chat took it");
  assert.ok(!got.some((m) => m.type === "error" && m.code === "reloaded"), "no reconnect");
  const outcome = await call;
  assert.ok(outcome.ok || !outcome.message.includes(UNREACHABLE), `a call the chat took is answered by it, never failed as unreachable: ${JSON.stringify(outcome)}`);
  t.router.detach();
});

test("a close for a cleared Overseer or a moved project still tells its tabs to reconnect (they reopen the chat)", async () => {
  const t = setup({ later: true });
  const s = session();
  const h = await t.router.acquire(s.path, false);
  const got: { type: string; code?: string }[] = [];
  h.attach({ wire: 2, send: (m) => void got.push(m as never), close: () => {} });
  for (let i = 0; i < 50 && !got.some((m) => m.type === "hello"); i++) await new Promise((r) => setTimeout(r, 20));
  await t.router.close(s.path, "The Overseer was cleared. Opening the new conversation.");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(got.some((m) => m.type === "error" && m.code === "reloaded"), "told to reconnect");
  assert.ok(!got.some((m) => m.type === "closed"));
  t.router.detach();
});

test("idle stop: a chat with a working worker, a tab attached or not, is never asked to close", async () => {
  let ahead = 0;
  const t = setup({ later: true, sup: { now: () => Date.now() + ahead, idleMs: 30 * 60_000, exitWaitMs: 50 } });
  const sup = (t.router as unknown as { sup: InstanceType<typeof ChatSupervisor> }).sup;
  const s = session();
  const h = await t.router.acquire(s.path, false);
  // The chat says a worker works (not quiet), with the tab attached.
  paneOn(t.router, h, { send: () => {}, close: () => {} }, false);
  ahead += 120 * 60_000;
  await sup.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.exits, [], "never asked: not quiet");
  assert.equal(t.router.get(s.path), h);
  t.router.detach();
});

test("with no Bun anywhere every chat open is refused, and no process starts", async () => {
  const t = setup({ bun: null });
  await assert.rejects(t.router.acquire(session().path, false), /Chats need Bun to run Sova's chat runtime/);
  assert.equal(t.driver.started.length, 0);
  t.router.detach();
});

test("a link that ends at once each time it is dialed again is dialed about once a second, never in a spin", async () => {
  let flapping = false;
  let last: { close(end?: unknown): void } | null = null;
  const t = setup({
    wrap: (c) =>
      (async (sock: string, opts: never) => {
        const r = await (c as (s: string, o: never) => Promise<{ link: { close(end?: unknown): void } }>)(sock, opts);
        last = r.link;
        if (flapping) setTimeout(() => r.link.close({ reason: "closed" }), 5);
        return r;
      }) as never,
  });
  const s = session();
  const h = await t.router.acquire(s.path, false);
  assert.equal(h?.where, "process");
  const before = t.connects();
  flapping = true;
  last!.close({ reason: "closed" });
  await new Promise((r) => setTimeout(r, 2_500));
  flapping = false;
  const dials = t.connects() - before;
  assert.ok(dials >= 2 && dials <= 4, `dialed ${dials} times in 2.5 s`);
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(t.router.get(s.path), h, "the chat is still this server's");
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
    bun: anyBun,
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

test("a remote chat whose placeholder folder is gone is refused before any process, and remembered until the folder is back", async () => {
  const t = setup();
  const gone = targetDir("acme", "/srv/gone");
  mkdirSync(gone, { recursive: true });
  const s = session();
  writeFileSync(s.path, readFileSync(s.path, "utf8").replace(JSON.stringify(cwd), JSON.stringify(gone)));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(s.path, old, old);
  rmSync(gone, { recursive: true });
  for (let i = 0; i < 2; i++) await assert.rejects(t.router.acquire(s.path, false), (err: unknown) => err instanceof ConfigError && err.cwd === gone);
  assert.ok(activeConfigFailure(s.path) instanceof ConfigError, "remembered");
  assert.equal(t.driver.started.length, 0, "no process for a doomed open");
  mkdirSync(gone, { recursive: true });
  assert.equal(activeConfigFailure(s.path), undefined, "the folder came back");
  const h = await t.router.acquire(s.path, false);
  assert.equal(h?.where, "process");
  t.router.detach();
});

test("a local chat whose folder is gone is not refused: its process starts, to open it in the home folder (§app.shell/missing-folder-home)", async () => {
  const t = setup();
  const gone = join(agentDir, "gone-local");
  const s = session();
  writeFileSync(s.path, readFileSync(s.path, "utf8").replace(JSON.stringify(cwd), JSON.stringify(gone)));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(s.path, old, old);
  const h = await t.router.acquire(s.path, false);
  assert.equal(h?.where, "process");
  assert.equal(activeConfigFailure(s.path), undefined);
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
  const next = new ChatHostRouter(++epoch, "g1", { driver: t.driver, connect: t.connect, supervisor: t.supervisor, bun: anyBun, gen: { id: "g1", dir: "/copies/g1", live: false } });
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
    // Its process is gone: its link to this server ends with it (the next process takes control anew).
    (first as unknown as { link: { close(): void } }).link.close();
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

test("a crash resume the server had not sent yet when it stopped is sent by the next server once; the resumed run cut off again is not resumed", async () => {
  const resumes: ResumeCall[] = [];
  const t = setup({ resumes });
  const s = session();
  const { inflightDir } = await import("./chat-runtime/inflight");
  const marker = join(inflightDir(), `${encodeURIComponent(s.id)}.json`);
  mkdirSync(inflightDir(), { recursive: true });
  const died = (r: unknown) => (r as { died(d: unknown): void }).died({ chatId: s.id, sessionPath: s.path, exit: 1, signal: null, logTail: [], at: new Date().toISOString(), endedAt: new Date().toISOString() });
  // It dies mid-run: one resume scheduled. The server stops within its delay (the timer goes with it).
  writeFileSync(marker, JSON.stringify({ v: 1, path: s.path, since: 1000 }));
  died(t.router);
  assert.equal(resumes.length, 1);
  t.router.detach();
  // The next server, once it has taken its chats back: the resume, once.
  const next = t.again();
  next.start();
  await next.ready();
  assert.equal(resumes.length, 2, "the next server sends it");
  assert.deepEqual({ path: resumes[1]!.path, since: resumes[1]!.since }, { path: s.path, since: 1000 });
  // It was sent: the resumed run started (its process writes a marker of its own, an automatic resume's).
  writeFileSync(marker, JSON.stringify({ v: 1, path: s.path, since: 2000, auto: true }));
  resumes[1]!.done?.();
  const third = t.again();
  third.start();
  await third.ready();
  assert.equal(resumes.length, 2, "a marker of a run in flight is no resume to send");
  // That resumed run is cut off too: not resumed a second time.
  died(third);
  assert.equal(resumes.length, 2);
});

test("a death the next server finds at its start: the dead process's last writes are the server's when its end is known, never an append after it, nor with its end unknown", async () => {
  const t = setup();
  const { lockFileOf, locksDir, readLock } = await import("./chat-runtime/writer-lock");
  const { recentForeignWriteAgeSec } = await import("./write-guard");
  const DEAD = 0x3ffffff;
  const die = (s: { path: string; id: string }, endedAt: string | undefined) => {
    mkdirSync(locksDir(), { recursive: true });
    writeFileSync(lockFileOf(s.path), JSON.stringify({ pid: DEAD, start: "S0", at: 1, unit: "u", path: s.path }));
    // No handle and no record in this server: as found at boot.
    (t.router as unknown as { died(d: unknown): void }).died({ chatId: s.id, sessionPath: s.path, unit: "u", cause: "lost", exit: null, signal: null, logTail: [], pid: DEAD, ...(endedAt ? { endedAt } : {}), at: new Date().toISOString() });
  };
  // Written a moment before it ended (after its last own-write record): the server's.
  const a = session({ fresh: true });
  die(a, new Date(Date.now() + 1000).toISOString());
  assert.equal(recentForeignWriteAgeSec(a.path), null, "opens for chat at once");
  assert.equal(readLock(a.path), null, "its lock let go");
  // Appended after it ended: not the server's.
  const b = session({ fresh: true });
  die(b, new Date(Date.now() - 60_000).toISOString());
  assert.notEqual(recentForeignWriteAgeSec(b.path), null);
  // When it ended is unknown (the detached driver): not taken for the server's; its lock still goes.
  const c = session({ fresh: true });
  die(c, undefined);
  assert.notEqual(recentForeignWriteAgeSec(c.path), null);
  assert.equal(readLock(c.path), null);
});

// ---- the start-up trail (§app.chat-processes/boot-log) -------------------------------------------------

/** What the router logs (`[chat-host] …`) while `fn` runs. */
async function routerLog<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: PromiseSettledResult<T> }> {
  const lines: string[] = [];
  const was = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const result = await fn().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    return { lines: lines.filter((l) => l.startsWith("[chat-host]")), result };
  } finally {
    console.log = was;
  }
}

/** A chat process that answers on its socket and then never gets further: still booting (with the steps
    `boot` sends, none for older code), or ready with an open that never answers (`opening` steps). */
function stuckRuntime(driver: () => InstanceType<typeof FakeDriver>, o: { state: "booting" | "ready"; boot?: object[]; opening?: object[] }): Connect {
  return (async (sock: string, opts: { build: string }) => {
    const spec = [...driver().started].reverse().find((s) => s.env.SOVA_CHAT_SOCK === sock)!;
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const link = new Link(b as never, { log: quiet });
    made.links.push(runtimeEnd, link);
    const hello = { t: "hello" as const, proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: 0, build: opts.build, pid: 4242, startedAt: 1, unit: spec.unit, sessionId: spec.env.SOVA_CHAT_ID!, path: spec.env.SOVA_CHAT_PATH!, state: o.state, seq: 0 };
    setImmediate(() => {
      for (const f of o.boot ?? []) runtimeEnd.send(f as never);
    });
    runtimeEnd.on("open", () => {
      for (const f of o.opening ?? []) runtimeEnd.send(f as never);
    });
    return { link, hello };
  }) as never;
}

const deathsOf = (t: { supervisor: { deathsFile(): string } }) =>
  readFileSync(t.supervisor.deathsFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { detail?: string });

test("a start that never says ready: the server's log and the stopped chat's record name the step it was stuck in; the error is unchanged", async () => {
  let t: ReturnType<typeof setup>;
  t = setup({
    deps: { bootWaitMs: 150 },
    wrap: () =>
      stuckRuntime(() => t.driver, {
        state: "booting",
        boot: [
          { t: "boot", phase: "starting", step: "chat code", stepMs: 0, totalMs: 40 },
          { t: "boot", phase: "starting", step: "extensions start", stepMs: 1_500, totalMs: 2_000 },
        ],
      }),
  });
  const s = session();
  const { lines, result } = await routerLog(() => t.router.acquire(s.path, false));
  assert.equal(result.status, "rejected");
  assert.equal((result as PromiseRejectedResult).reason.message, "This chat's process didn't start: it could not start its process (The chat process didn't answer (hello) in time.)");
  const said = lines.find((l) => l.includes(`${s.id}: not ready after`));
  assert.match(said ?? lines.join("\n"), /: not ready after \d+\.\d s; stuck in extensions start for 1\.\d s \(answered after \d+\.\d s\)$/);
  const detail = deathsOf(t).at(-1)?.detail ?? "";
  assert.match(detail, /^no hello: The chat process didn't answer \(hello\) in time\.; stuck in extensions start for 1\.\d s \(answered after \d+\.\d s\)$/);
});

test("a start on older code reports no step: the record says so", async () => {
  let t: ReturnType<typeof setup>;
  t = setup({ deps: { bootWaitMs: 100 }, wrap: () => stuckRuntime(() => t.driver, { state: "booting" }) });
  const s = session();
  const { lines, result } = await routerLog(() => t.router.acquire(s.path, false));
  assert.equal(result.status, "rejected");
  assert.match(lines.find((l) => l.includes(`${s.id}: not ready after`)) ?? "", /; no step reported \(answered after/);
  assert.match(deathsOf(t).at(-1)?.detail ?? "", /; no step reported \(answered after \d+\.\d s\)$/);
});

test("an open that never answers: the server's log names the step the open was in; the error is unchanged", async () => {
  let t: ReturnType<typeof setup>;
  t = setup({ deps: { openWaitMs: 150 }, wrap: () => stuckRuntime(() => t.driver, { state: "ready", opening: [{ t: "boot", phase: "opening", step: "extensions start", stepMs: 0, totalMs: 300 }] }) });
  const s = session();
  const { lines, result } = await routerLog(() => t.router.acquire(s.path, false));
  assert.equal(result.status, "rejected");
  assert.equal((result as PromiseRejectedResult).reason.message, "This chat's process didn't start: it did not open in its process (The chat process didn't answer (opened) in time.)");
  assert.match(
    lines.find((l) => l.includes(`${s.id}: its open got no answer`)) ?? lines.join("\n"),
    /: its open got no answer after \d+\.\d s \(The chat process didn't answer \(opened\) in time\.\): stuck in extensions start for 0\.\d s$/,
  );
});

test("a chat's open names its steps in order, and its server hears them; a fast start adds no line to the server's log, a slow one adds one", async () => {
  const steps: string[] = [];
  const ends: boolean[] = [];
  const heard: string[] = [];
  const t = setup({
    openTrail: (send) => ({
      step: (name) => {
        steps.push(name);
        send({ t: "boot", phase: "opening", step: name, stepMs: 0, totalMs: 0 });
      },
      finish: (ok = true) => void ends.push(ok),
    }),
    wrap: (c) =>
      (async (sock: string, opts: never) => {
        const r = await (c as (s: string, o: never) => Promise<{ link: InstanceType<typeof Link> }>)(sock, opts);
        r.link.on("boot", (f) => void heard.push(f.step));
        return r;
      }) as never,
  });
  const fast = await routerLog(() => t.router.acquire(session().path, false));
  assert.equal(fast.result.status, "fulfilled");
  assert.deepEqual(steps, ["open file", "loadout", "extensions load", "session", "extensions start", "finish"]);
  assert.deepEqual(ends, [true]);
  assert.deepEqual(heard, steps, "each step reached the server");
  assert.deepEqual(fast.lines.filter((l) => / started in /.test(l)), []);

  const slow = setup({ deps: { slowStartMs: 0 } });
  const s = session();
  const logged = await routerLog(() => slow.router.acquire(s.path, false));
  assert.equal(logged.result.status, "fulfilled");
  assert.match(logged.lines.find((l) => l.includes(`${s.id}: started in`)) ?? "", /: started in \d+\.\d s \(answered after \d+\.\d s, ready after \d+\.\d s, opened after \d+\.\d s\)$/);
});
