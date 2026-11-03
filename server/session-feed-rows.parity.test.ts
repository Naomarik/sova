// Run: pnpm test -- server/session-feed-rows.parity.test.ts
//
// The no-regression gate for the list a tab keeps from the feed's `rows` frames: whatever the
// network does to the frames (dropped, duplicated, reordered, delayed), and through a reconnect, a
// tab asleep, a server restart (a new epoch) and a server without rows, once things go quiet and
// the safety net has run, the tab's list equals a fresh GET /api/sessions, on every field a row
// shows and in the same order. The server side is the real SessionFeed (server/session-feed.ts),
// with GET read through feed.snapshot as server/app.ts reads it; the tab side is the real ListRows
// (src/lib/list-rows.ts), driven as the page drives it. Everything goes through JSON, as on the wire.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { SessionFeed } from "./session-feed";
import { ListRows, type ListVersion } from "../src/lib/list-rows";
import { COMPARED_FIELDS, EXEMPT_FIELDS, LIST_VERSION_HEADER, parseListVersion } from "../src/lib/summary-diff";

// ---------------------------------------------------------------------------------------------
// The server: a list we script, a feed over it, GET through its snapshot.
// ---------------------------------------------------------------------------------------------
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));

let clock = Date.parse("2026-11-01T00:00:00.000Z");
const tick = () => new Date((clock += 1_000)).toISOString();
let n = 0;
function row(over: Partial<SessionSummary> = {}): SessionSummary {
  const i = ++n;
  return { id: `s${i}`, path: `/s/${String(i).padStart(4, "0")}.jsonl`, cwd: "/w", title: `t${i}`, createdAt: tick(), lastActiveAt: tick(), model: null, live: null, busy: false, origin: "external", archived: false, ...over };
}

class Server {
  rows = new Map<string, SessionSummary>();
  feed: SessionFeed;
  constructor(public intervalMs = 1_000_000) {
    this.feed = this.makeFeed();
  }
  makeFeed(): SessionFeed {
    return new SessionFeed({ list: async () => this.list(), debounceMs: 0, minGapMs: 0, intervalMs: this.intervalMs });
  }
  /** Sorted as sessions-index sorts (newest first); each call gives fresh objects, as a build does. */
  list(): SessionSummary[] {
    return wire([...this.rows.values()]).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.path < b.path ? -1 : 1));
  }
  /** GET /api/sessions as server/app.ts answers it: the body and its version header. */
  async get(): Promise<{ body: SessionSummary[]; header: string }> {
    const { body, epoch, version } = await this.feed.snapshot(async () => this.list());
    return wire({ body, header: `${epoch}:${version}` });
  }
  /** A change a watch tells the feed of: re-diff now. */
  async changed(): Promise<void> {
    this.feed.nudge(0);
    await settle(this.feed);
  }
  /** A restart: a new feed run (a new epoch). */
  restart(): void {
    this.feed.stop();
    this.feed = this.makeFeed();
  }
}

/** Waits until the feed's queued diffs (and the timers that queue them) have run. */
async function settle(feed: SessionFeed): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await feed.idle();
  }
}

// ---------------------------------------------------------------------------------------------
// The network between the feed and a tab, with faults.
// ---------------------------------------------------------------------------------------------
type Fault = "drop" | "dup" | "hold";
class Net {
  queue: SessionFeedMessage[] = [];
  held: SessionFeedMessage[] = [];
  faults: Fault[] = [];
  constructor(private rand: () => number, public faultRate = 0) {}
  /** Faults hit only frames after the socket's first (rows_hello has its own test). */
  spareHello = true;
  send = (msg: SessionFeedMessage) => {
    const m = wire(msg);
    const f = this.spareHello && m.type === "rows_hello" ? null : this.faults.shift() ?? (this.rand() < this.faultRate ? (["drop", "dup", "hold"] as const)[Math.floor(this.rand() * 3)] : null);
    if (f === "drop") return;
    if (f === "hold") return void this.held.push(m);
    this.queue.push(m);
    if (f === "dup") this.queue.push(wire(m));
  };
  /** Delivers what is queued; held frames go out late, in a shuffled order. */
  take(): SessionFeedMessage[] {
    const out = this.queue;
    this.queue = [];
    if (this.held.length && this.rand() < 0.5) {
      const h = this.held;
      this.held = [];
      for (const m of h) out.splice(Math.floor(this.rand() * (out.length + 1)), 0, m);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// The tab: ListRows driven as the page drives it (a full read on ask; the read's answer and its
// header into snapshot; every frame into message).
// ---------------------------------------------------------------------------------------------
class Tab {
  shown: SessionSummary[] = [];
  net: Net;
  list: ListRows;
  unsub: (() => void) | null = null;
  reads: Promise<void>[] = [];
  /** Reads this tab sent (each one a full GET). */
  gets = 0;
  asleep = false;
  constructor(public server: Server, rand: () => number, faultRate = 0, public rowsServer = true) {
    this.net = new Net(rand, faultRate);
    this.list = new ListRows({
      refetch: () => this.read(),
      publish: (rows) => {
        this.shown = rows;
      },
    });
  }
  read(): void {
    this.gets++;
    this.list.fetchStarted();
    const p = this.server.get().then(
      ({ body, header }) => {
        const at: ListVersion | null = this.rowsServer ? parseListVersion(header) : null;
        this.shown = this.list.snapshot(body, at);
      },
      () => {
        const rows = this.list.fetchFailed();
        if (rows) this.shown = rows;
      },
    );
    this.reads.push(p);
  }
  /** Opens the socket; an old server (rowsServer false) never sends rows_hello. */
  connect(): void {
    this.list.socketOpened();
    const send = this.rowsServer ? this.net.send : (m: SessionFeedMessage) => m.type !== "rows_hello" && m.type !== "rows" && m.type !== "rows_check" && this.net.send(m);
    this.unsub = this.server.feed.add(send, { rows: this.rowsServer });
  }
  disconnect(): void {
    this.unsub?.();
    this.unsub = null;
    this.list.socketClosed();
    this.net.queue = [];
    this.net.held = [];
  }
  /** Hands the tab what the network delivers, and runs its reads to the end. */
  async pump(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await settle(this.server.feed);
      const frames = this.asleep ? [] : this.net.take();
      for (const m of frames) {
        // A legacy list re-reads on list_changed (the old path, throttled in the page).
        if (!this.list.message(m) && m.type === "list_changed") this.read();
      }
      const reads = this.reads;
      this.reads = [];
      await Promise.all(reads);
      if (!frames.length && !reads.length && !this.net.queue.length) return;
    }
  }
}

/** The safety net, as its timer runs it: a re-diff that also sends rows_check. */
async function safetyNet(server: Server): Promise<void> {
  const f = server.feed as unknown as { checkDue: boolean };
  assert.equal(typeof f.checkDue, "boolean", "the feed still keeps checkDue (the safety net's flag)");
  f.checkDue = true;
  server.feed.nudge(0);
  await settle(server.feed);
}

/** What a row shows: every compared field (seenAt is exempt from the tab's comparison already). */
const shown = (rows: readonly SessionSummary[]) =>
  rows.map((s) => {
    const o: Record<string, unknown> = {};
    for (const k of COMPARED_FIELDS) if (s[k] !== undefined) o[k] = s[k];
    return o;
  });

/** The rows that differ, by path, for a readable failure. */
function differences(a: readonly SessionSummary[], b: readonly SessionSummary[]): unknown {
  const sa = shown(a), sb = shown(b);
  const A = new Map(sa.map((r) => [r.path as string, JSON.stringify(r)]));
  const B = new Map(sb.map((r) => [r.path as string, JSON.stringify(r)]));
  const out: Record<string, unknown> = {};
  for (const p of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(p), y = B.get(p);
    if (x === y) continue;
    if (!x || !y) out[p] = x ? "only in the tab" : "only in the GET";
    else {
      const ox = JSON.parse(x), oy = JSON.parse(y);
      out[p] = Object.fromEntries([...new Set([...Object.keys(ox), ...Object.keys(oy)])].filter((k) => JSON.stringify(ox[k]) !== JSON.stringify(oy[k])).map((k) => [k, { tab: ox[k], get: oy[k] }]));
    }
  }
  const orderSame = JSON.stringify(sa.map((r) => r.path)) === JSON.stringify(sb.map((r) => r.path));
  return { rows: out, orderSame };
}

function assertSame(tab: Tab, fresh: SessionSummary[], label: string): void {
  if (JSON.stringify(shown(tab.shown)) !== JSON.stringify(shown(fresh))) assert.fail(`${label}: the tab's list differs from a fresh GET: ${JSON.stringify(differences(tab.shown, fresh))}`);
}

async function assertConverged(tab: Tab, label: string): Promise<void> {
  await tab.pump();
  await safetyNet(tab.server);
  tab.net.faultRate = 0;
  await tab.pump();
  assertSame(tab, (await tab.server.get()).body, label);
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random change to the server's list. */
function mutate(server: Server, rand: () => number, legacy = false): void {
  const paths = [...server.rows.keys()];
  const pick = () => server.rows.get(paths[Math.floor(rand() * paths.length)]!)!;
  const r = rand();
  if (r < 0.2 || paths.length < 3) {
    const s = row();
    server.rows.set(s.path, s);
  } else if (r < 0.3) server.rows.delete(pick().path);
  else if (r < 0.5) {
    const s = pick();
    server.rows.set(s.path, { ...s, lastActiveAt: tick() });
  } else if (r < 0.6) {
    const s = pick();
    server.rows.set(s.path, { ...s, title: `renamed ${Math.floor(rand() * 1e6)}` });
  } else if (r < 0.7) {
    const s = pick();
    server.rows.set(s.path, { ...s, archived: !s.archived });
  } else if (r < 0.8) {
    const s = pick();
    server.rows.set(s.path, { ...s, busy: !s.busy, live: s.live ? null : { pid: 7, status: "streaming" } });
  } else if (r < 0.9) {
    const s = pick();
    const { groupId, ...rest } = s;
    server.rows.set(s.path, groupId ? rest : { ...s, groupId: "g1" });
  } else if (!legacy) {
    // Not in the old list_changed signature: an old tab never re-read for it, then or now.
    const s = pick();
    server.rows.set(s.path, { ...s, seenAt: clock, unread: s.unread ? undefined : true });
  }
}

async function seeded(server: Server, count = 8): Promise<void> {
  for (let i = 0; i < count; i++) {
    const s = row();
    server.rows.set(s.path, s);
  }
}

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

test("the comparison covers every field but the declared exemptions", () => {
  assert.deepEqual(EXEMPT_FIELDS, ["seenAt"], "a new exemption is a change to what this gate checks");
  assert.equal(LIST_VERSION_HEADER, "X-Sova-List-Version");
});

test("a clean network: every delta applied, no full read after the first", async () => {
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, prng(1));
  tab.connect();
  tab.read();
  await tab.pump();
  const first = tab.gets;
  const rand = prng(2);
  for (let i = 0; i < 40; i++) {
    mutate(server, rand);
    await server.changed();
    await tab.pump();
    assertSame(tab, (await server.get()).body, `step ${i}`);
  }
  assert.ok(tab.list.following, "the tab follows the rows");
  assert.equal(tab.gets, first, "no full read while every frame arrives");
});

test("dropped, duplicated and reordered frames (seeded): the tab always converges", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = prng(seed * 7919);
    const server = new Server();
    await seeded(server);
    const tab = new Tab(server, rand, 0.3);
    tab.connect();
    tab.read();
    await tab.pump();
    for (let i = 0; i < 25; i++) {
      const burst = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < burst; j++) mutate(server, rand);
      await server.changed();
      if (rand() < 0.5) await tab.pump();
    }
    await assertConverged(tab, `seed ${seed}`);
  }
});

test("each fault alone: a dropped frame is caught by the digest; a duplicate and a late frame are ignored", async () => {
  for (const fault of ["drop", "dup", "hold"] as const) {
    const server = new Server();
    await seeded(server);
    const tab = new Tab(server, prng(3));
    tab.connect();
    tab.read();
    await tab.pump();
    const s = [...server.rows.values()][2]!;
    tab.net.faults.push(fault);
    server.rows.set(s.path, { ...s, title: `after ${fault}` });
    await server.changed();
    await tab.pump();
    const s2 = [...server.rows.values()][4]!;
    server.rows.set(s2.path, { ...s2, title: `next after ${fault}` });
    await server.changed();
    await tab.pump();
    await assertConverged(tab, fault);
  }
});

test("a dropped LAST frame (no later delta shows the gap): the safety net's digest re-reads", async () => {
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, prng(4));
  tab.connect();
  tab.read();
  await tab.pump();
  const s = [...server.rows.values()][1]!;
  tab.net.faults.push("drop");
  server.rows.set(s.path, { ...s, title: "lost" });
  await server.changed();
  await tab.pump();
  assert.notDeepEqual(shown(tab.shown), shown((await server.get()).body), "control: the tab is stale before the safety net");
  const gets = tab.gets;
  await assertConverged(tab, "lost last frame");
  assert.ok(tab.gets > gets, "the digest asked for a full read");
});

test("a lost or late rows_hello: the tab still converges", async () => {
  for (const fault of ["drop", "hold", "dup"] as const) {
    const rand = prng(13);
    const server = new Server();
    await seeded(server);
    const tab = new Tab(server, rand);
    tab.net.spareHello = false;
    tab.net.faults.push(fault);
    tab.connect();
    tab.read();
    await tab.pump();
    for (let i = 0; i < 5; i++) {
      mutate(server, rand);
      await server.changed();
      await tab.pump();
    }
    await assertConverged(tab, `hello ${fault}`);
  }
});

test("a reconnect, with changes made while the socket was down", async () => {
  const rand = prng(5);
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, rand);
  tab.connect();
  tab.read();
  await tab.pump();
  // A second tab keeps the feed running (so the epoch stays) while this one is away.
  const other = new Tab(server, prng(55));
  other.connect();
  other.read();
  await other.pump();
  tab.disconnect();
  for (let i = 0; i < 6; i++) {
    mutate(server, rand);
    await server.changed();
  }
  tab.connect();
  await assertConverged(tab, "reconnect, same epoch");
  // The last listener gone and back: a new run of the feed (a new epoch).
  tab.disconnect();
  other.disconnect();
  for (let i = 0; i < 4; i++) mutate(server, rand);
  tab.connect();
  await assertConverged(tab, "reconnect, new run");
});

test("a tab asleep (frames held, nothing read) then woken; and a tab hidden that misses frames", async () => {
  const rand = prng(6);
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, rand);
  tab.connect();
  tab.read();
  await tab.pump();
  tab.asleep = true;
  for (let i = 0; i < 10; i++) {
    mutate(server, rand);
    await server.changed();
  }
  tab.asleep = false;
  await assertConverged(tab, "woken with every frame queued");
  // Asleep long enough that the socket dropped frames (the OS froze it): a gap, then the digest.
  for (let i = 0; i < 5; i++) {
    tab.net.faults.push("drop");
    mutate(server, rand);
    await server.changed();
  }
  await assertConverged(tab, "woken after frames were lost");
});

test("an epoch change under a connected tab (the server restarted)", async () => {
  const rand = prng(7);
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, rand);
  tab.connect();
  tab.read();
  await tab.pump();
  tab.disconnect(); // the restart closes the socket
  server.restart();
  for (let i = 0; i < 5; i++) mutate(server, rand);
  tab.connect();
  await assertConverged(tab, "after a restart");
  // A frame from the old run arriving late (held across the restart) must not apply.
  const stale: SessionFeedMessage = { type: "rows", epoch: "oldrun", from: 0, to: 1, upsert: [{ ...[...server.rows.values()][0]!, title: "from the old run" }], remove: [] };
  tab.net.queue.push(stale);
  await assertConverged(tab, "a late frame of the old run");
});

test("a read crossing deltas: GET answered while frames are in flight, in both orders", async () => {
  const rand = prng(8);
  for (let round = 0; round < 20; round++) {
    const server = new Server();
    await seeded(server);
    const tab = new Tab(server, rand);
    tab.connect();
    await settle(server.feed);
    // The page's first read starts, then changes and frames land before its answer.
    tab.read();
    mutate(server, rand);
    await server.changed();
    if (round % 2) await tab.pump();
    mutate(server, rand);
    await server.changed();
    await assertConverged(tab, `crossing ${round}`);
  }
});

test("a first read answered before the socket's first diff, with a change in between", async () => {
  // The page reads the list and opens the feed at once. Nobody else listens, so the feed starts a
  // run on connect; a change between the read and that first diff must still reach the tab.
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, prng(9));
  tab.read();
  await Promise.all(tab.reads);
  tab.reads = [];
  const s = [...server.rows.values()][0]!;
  server.rows.set(s.path, { ...s, title: "changed before the feed's first diff" });
  tab.connect();
  await tab.pump();
  assertSame(tab, (await server.get()).body, "without waiting for the safety net");
});

test("a server without rows (an older server or peer): list_changed, re-read, same list", async () => {
  const rand = prng(10);
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, rand, 0, false);
  tab.connect();
  tab.read();
  await tab.pump();
  for (let i = 0; i < 15; i++) {
    mutate(server, rand, true);
    await server.changed();
    await tab.pump();
    assertSame(tab, (await server.get()).body, `legacy step ${i}`);
  }
  assert.equal(tab.list.following, false, "it never follows rows");
});

test("an old tab (no rows=1) beside a rows tab: it still gets list_changed, never a rows frame", async () => {
  const server = new Server();
  await seeded(server);
  const got: SessionFeedMessage[] = [];
  const off = server.feed.add((m) => got.push(wire(m)));
  const tab = new Tab(server, prng(11));
  tab.connect();
  tab.read();
  await tab.pump();
  await settle(server.feed);
  const s = [...server.rows.values()][0]!;
  server.rows.set(s.path, { ...s, lastActiveAt: tick(), busy: true });
  await server.changed();
  await safetyNet(server);
  assert.ok(got.some((m) => m.type === "list_changed"), "the old socket heard list_changed");
  assert.ok(!got.some((m) => m.type === "rows" || m.type === "rows_hello" || m.type === "rows_check"), "and nothing it doesn't know");
  await assertConverged(tab, "beside an old tab");
  off();
});

test("a change too big for a frame: list_changed on the rows socket, then a full read", async () => {
  const server = new Server();
  await seeded(server);
  const tab = new Tab(server, prng(12));
  tab.connect();
  tab.read();
  await tab.pump();
  for (let i = 0; i < 260; i++) {
    const s = row();
    server.rows.set(s.path, s);
  }
  const gets = tab.gets;
  await server.changed();
  await tab.pump();
  assert.ok(tab.gets > gets, "a full read");
  await assertConverged(tab, "big change");
});
