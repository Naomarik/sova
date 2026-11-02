// Run: pnpm test -- server/session-list-consumers.parity.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
//
// The no-regression gate for the session list's consumers: each one still gets exactly what it got
// before the incremental list and the rows feed.
// - GET /api/sessions: the same array body (mesh peers' meshSessions, the mesh-lab e2e and every
//   tab parse it as an array), now with an X-Sova-List-Version header while the feed runs.
// - shared/commands session.list (the palette, served commands, the card toolkit, which runs a
//   catalogue entry by id): the route's own answer, unchanged.
// - An old tab or a proxied peer feed (a socket without rows=1): the very frames the baseline
//   revision's own SessionFeed sends for the same list changes (list_changed and marks), whether a
//   rows socket listens beside it or not.
// The rows themselves, /ws/events and the session_list tool's listSessions are in
// sessions-index.parity.test.ts; the rows client in session-feed-rows.parity.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-list-consumers-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-list-consumers--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rev = process.env.SOVA_PARITY_BASE || git("merge-base", "HEAD", "master");

/** A baseline revision's server module, its relative imports pointed back at this tree. */
async function baselineModule(file: string): Promise<Record<string, any>> {
  let src = git("show", `${rev}:${file}`);
  src = src.replace(/(from\s+|import\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_m, pre: string, q: string, rel: string) => `${pre}${q}${resolve(here, rel)}${q}`);
  const dir = mkdtempSync(join(tmpdir(), "sova-list-consumers-base-"));
  const out = join(dir, file.replace(/\//g, "__"));
  writeFileSync(out, src);
  return import(out);
}

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const NEW = await import("./sessions-index");
const feedMod = await import("./session-feed");
const { buildRequest, findCommand } = await import("../shared/commands-catalog");
const { LIST_VERSION_HEADER, parseListVersion } = await import("../src/lib/summary-diff");
const { canonicalPath } = await import("./paths");
const { sessionsChanged } = await import("./list-generation");
const OLD_FEED = await baselineModule("server/session-feed.ts");
const OLD_INDEX = await baselineModule("server/sessions-index.ts").catch(() => null);

let n = 0;
function session(title: string): string {
  const id = `01a1b2c3-d4e5-7f00-9000-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-01T00-00-0${n % 10}-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    `${[
      { type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: title } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
  );
  return canonicalPath(path);
}
for (let i = 0; i < 6; i++) session(`consumer ${i}`);

async function get(url: string): Promise<{ status: number; header: string | null; text: string }> {
  const res = await app.request(url);
  return { status: res.status, header: res.headers.get(LIST_VERSION_HEADER), text: await res.text() };
}
const byPath = (rows: SessionSummary[]) => [...rows].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.path < b.path ? -1 : 1));

test("GET /api/sessions with no feed: an array body equal to the old build, no version header", async () => {
  sessionsChanged();
  const r = await get("/api/sessions");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.ok(Array.isArray(body), "the body is an array (meshSessions, the mesh-lab e2e)");
  assert.equal(r.header, null, "no feed, no version");
  assert.ok(OLD_INDEX, "the baseline sessions-index loads");
  // The old build, the old way (its own listSessions: its own cache and readers).
  const old = await OLD_INDEX!.listSessions();
  assert.deepEqual(byPath(body), byPath(JSON.parse(JSON.stringify(old))));
});

test("session.list (palette, served commands, card toolkit): the route's own answer", async () => {
  const entry = findCommand("session.list");
  assert.ok(entry, "session.list is still a catalogue entry");
  assert.deepEqual(entry!.route, { method: "GET", path: "/api/sessions" });
  const req = buildRequest(entry!, {});
  sessionsChanged();
  const viaEntry = await get(req.url);
  sessionsChanged();
  const direct = await get("/api/sessions");
  assert.equal(viaEntry.status, direct.status);
  assert.deepEqual(byPath(JSON.parse(viaEntry.text)), byPath(JSON.parse(direct.text)));
});

test("GET /api/sessions while the feed runs: the same array, named by the feed's version", async () => {
  const tracked = NEW.trackSessionFiles();
  const feed = feedMod.configureSessionFeed({ list: () => NEW.listSessionsTracked(), intervalMs: 1_000_000, debounceMs: 0, minGapMs: 0 });
  const got: SessionFeedMessage[] = [];
  const off = feed.add((m) => got.push(m), { rows: true });
  try {
    await feed.idle();
    sessionsChanged();
    const r = await get("/api/sessions");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.ok(Array.isArray(body), "still an array");
    const v = parseListVersion(r.header);
    assert.ok(v, `a parseable ${LIST_VERSION_HEADER}: ${r.header}`);
    assert.deepEqual(v, feed.listVersion, "the version the body is at");
    const hello = got.find((m) => m.type === "rows_hello") as Extract<SessionFeedMessage, { type: "rows_hello" }> | undefined;
    assert.equal(hello?.epoch, v!.epoch, "the socket's run");
    const old = await OLD_INDEX!.listSessions();
    assert.deepEqual(byPath(body), byPath(JSON.parse(JSON.stringify(old))), "the body is what the old build lists");
    // A peer reads the body only; a header it doesn't know changes nothing for it.
    assert.deepEqual(Object.keys(body[0] ?? {}).sort(), Object.keys(JSON.parse(JSON.stringify(old))[0] ?? {}).sort());
  } finally {
    off();
    tracked.stop();
    feed.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// An old socket: the baseline SessionFeed and the new one, over the same scripted list.
// ---------------------------------------------------------------------------------------------
let clock = Date.parse("2026-11-01T00:00:00.000Z");
const tick = () => new Date((clock += 1_000)).toISOString();
let m = 0;
function row(over: Partial<SessionSummary> = {}): SessionSummary {
  const i = ++m;
  return { id: `r${i}`, path: `/r/${String(i).padStart(4, "0")}.jsonl`, cwd: "/w", title: `t${i}`, createdAt: tick(), lastActiveAt: tick(), model: null, live: null, busy: false, origin: "external", archived: false, ...over };
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
function mutate(rows: Map<string, SessionSummary>, rand: () => number): void {
  const paths = [...rows.keys()];
  const pick = () => rows.get(paths[Math.floor(rand() * paths.length)]!)!;
  const r = rand();
  const s = paths.length ? pick() : null;
  if (r < 0.15 || !s) {
    const x = row();
    rows.set(x.path, x);
  } else if (r < 0.25) rows.delete(s.path);
  else if (r < 0.4) rows.set(s.path, { ...s, lastActiveAt: tick() });
  else if (r < 0.5) rows.set(s.path, { ...s, busy: !s.busy });
  else if (r < 0.6) rows.set(s.path, { ...s, live: s.live ? null : { pid: 9, status: "idle" } });
  else if (r < 0.7) rows.set(s.path, { ...s, title: `n${Math.floor(rand() * 1e6)}` });
  else if (r < 0.75) rows.set(s.path, { ...s, archived: !s.archived });
  else if (r < 0.8) rows.set(s.path, { ...s, tags: s.tags ? undefined : { auto: ["x"], user: [] } as any });
  else if (r < 0.85) rows.set(s.path, { ...s, signals: s.signals ? undefined : ([{ kind: "asks-user", since: 1 }] as any) });
  else if (r < 0.9) rows.set(s.path, { ...s, unread: s.unread ? undefined : true, seenAt: clock });
  else if (r < 0.95) rows.set(s.path, { ...s, activity: s.activity ? undefined : { state: "working" } });
  else rows.set(s.path, { ...s, groupId: s.groupId ? undefined : "g1" });
}

for (const withRowsSocket of [false, true]) {
  test(`an old socket gets the baseline feed's own frames for the same changes${withRowsSocket ? ", with a rows socket beside it" : ""}`, async () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rand = prng(seed);
      const rows = new Map<string, SessionSummary>();
      for (let i = 0; i < 6; i++) {
        const x = row();
        rows.set(x.path, x);
      }
      const list = async () => JSON.parse(JSON.stringify([...rows.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.path < b.path ? -1 : 1))));
      const opts = { list, intervalMs: 1_000_000, debounceMs: 0, minGapMs: 0 };
      const oldFeed = new OLD_FEED.SessionFeed(opts);
      const newFeed = new feedMod.SessionFeed(opts);
      const heard = { old: [] as string[], new: [] as string[] };
      const offs = [oldFeed.add((x: SessionFeedMessage) => heard.old.push(JSON.stringify(x))), newFeed.add((x: SessionFeedMessage) => heard.new.push(JSON.stringify(x)))];
      if (withRowsSocket) offs.push(newFeed.add(() => {}, { rows: true }));
      const settle = async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 0));
          await oldFeed.idle();
          await newFeed.idle();
        }
      };
      await settle();
      for (let step = 0; step < 30; step++) {
        const burst = 1 + Math.floor(rand() * 2);
        for (let j = 0; j < burst; j++) mutate(rows, rand);
        oldFeed.nudge(0);
        newFeed.nudge(0);
        await settle();
        assert.deepEqual(heard.new, heard.old, `seed ${seed} step ${step}: the old socket's frames`);
      }
      assert.ok(heard.old.some((x) => x.includes('"list_changed"')), `seed ${seed}: the script moves the list (control)`);
      for (const off of offs) off();
      oldFeed.stop();
      newFeed.stop();
    }
  });
}
