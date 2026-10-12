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
import { CHAT_WIRE_PROTO, CHAT_WIRE_MIN_PROTO, type ExitCause } from "../shared/chat-runtime-wire";

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
const { Link } = await import("./chat-runtime/link");
const { FakeDriver } = await import("./chat-runtime/fake-driver");
const { activeConfigFailure, BusyError, ConfigError, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
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
function setup(o: { out?: boolean } = {}) {
  const driver = new FakeDriver();
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
    host.onControl(runtimeEnd, { t: "control", proto: CHAT_WIRE_PROTO, epoch: opts.epoch, serverPid: 1, serverStartedAt: 1, build: opts.build, since: opts.since, settings: opts.settings });
    return { link, hello };
  }) as never;
  const router = new ChatHostRouter(++epoch, "b1", { driver, connect, out: () => o.out ?? true });
  return { router, driver, hosts, exits, connects: () => connects };
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

test("a chat whose profile grants powers stays in the server; so does every chat with the switch off", async () => {
  const t = setup();
  const powers = session({ extra: [{ type: "custom", id: "p1", parentId: "a1", timestamp: "2026-10-12T00:00:03.000Z", customType: PROFILE_ENTRY, data: { v: 1, profile: { id: "ops", name: "Ops", grant: ["shell"] } } }] });
  assert.equal(await t.router.acquire(powers.path, false), null);
  assert.equal(t.driver.started.length, 0, "no unit for a chat that stays in");

  const off = setup({ out: false });
  assert.equal(await off.router.acquire(session().path, false), null);
  assert.equal(off.driver.started.length, 0);
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

test("a start that fails leaves the chat in the server until it restarts, never retried", async () => {
  const t = setup();
  const s = session();
  t.driver.failNextStart = "systemd-run: boom";
  assert.equal(await t.router.acquire(s.path, false), null);
  assert.equal(await t.router.acquire(s.path, false), null);
  assert.equal(t.driver.started.length, 0);
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
