// The session feed's tracked listing (listSessionsTracked): it reads only the files a watch named,
// and otherwise gives exactly listSessions' rows. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-sessions-tracked-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-tracked--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { listIo, listSessions, listSessionsTracked, trackSessionFiles, trackedStats } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
const id = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const header = (sid: string) => JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) => JSON.stringify({ type: "message", id: `m${n}`, parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });
const assistant = (text: string) =>
  JSON.stringify({ type: "message", id: `a${n}`, parentId: null, timestamp: "2026-09-21T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text }], provider: "zai", model: "glm-5.3", stopReason: "stop", timestamp: 1_790_000_000_000 } });

let tick = 0;
/** Distinct, increasing mtimes so the sort is deterministic. */
function stamp(path: string): void {
  const t = new Date(Date.UTC(2026, 8, 21) + ++tick * 1000);
  utimesSync(path, t, t);
}
function session(title: string | null): string {
  const sid = id();
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${sid}.jsonl`);
  writeFileSync(path, `${[header(sid), ...(title === null ? [] : [user(title)])].join("\n")}\n`);
  stamp(path);
  return canonicalPath(path);
}

/** A fresh full listing (a new generation, so no reuse). */
async function fresh() {
  sessionsChanged();
  return listSessions();
}

test("tracked listing: equals the full listing through appends, adds, deletes and renames it was told of", async () => {
  const a = session("alpha");
  const b = session("beta");
  session(null); // a husk: never listed, in either
  const t = trackSessionFiles();
  try {
    assert.deepEqual(await listSessionsTracked(), await fresh());
    appendFileSync(a, `${assistant("hello")}\n`);
    stamp(a);
    t.note(a);
    const c = session("gamma");
    t.note(c);
    unlinkSync(b);
    t.note(b);
    const fullBefore = trackedStats.full;
    const rows = await listSessionsTracked();
    assert.equal(trackedStats.full, fullBefore, "an incremental build");
    assert.deepEqual(rows, await fresh());
    assert.deepEqual(
      rows.map((r) => r.title),
      ["gamma", "alpha"],
    );
    const moved = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id()}.jsonl`);
    renameSync(c, moved);
    t.note(c);
    t.note(moved);
    assert.deepEqual(await listSessionsTracked(), await fresh());
  } finally {
    t.stop();
  }
});

test("tracked listing: a file nobody named is not read until a note, a null note or the sweep", async () => {
  const a = session("one");
  const t = trackSessionFiles();
  try {
    await listSessionsTracked();
    appendFileSync(a, `${assistant("unseen")}\n`);
    stamp(a);
    // No note: the tracked build neither stats nor reads it, so the row is the old one.
    const stale = (await listSessionsTracked()).find((r) => r.path === a)!;
    const real = (await fresh()).find((r) => r.path === a)!;
    assert.notEqual(stale.lastActiveAt, real.lastActiveAt, "untold change stays unread");
    t.note(null);
    const full = trackedStats.full;
    assert.deepEqual(await listSessionsTracked(), await fresh());
    assert.equal(trackedStats.full, full + 1, "a null note is a full build");
  } finally {
    t.stop();
  }
});

test("tracked listing: without a tracker it is listSessions", async () => {
  session("solo");
  const builds = trackedStats.builds;
  sessionsChanged(); // past listSessions' reuse window
  const rows = await listSessionsTracked();
  assert.equal(rows.some((r) => r.title === "solo"), true);
  assert.deepEqual(rows, await fresh());
  assert.equal(trackedStats.builds, builds);
});

test("husk check: a husk that gains a user message is listed, cached or not", async () => {
  const h = session(null);
  const t = trackSessionFiles();
  try {
    assert.equal((await listSessionsTracked()).some((r) => r.path === h), false);
    appendFileSync(h, `${user("now real")}\n`);
    stamp(h);
    t.note(h);
    assert.equal((await listSessionsTracked()).find((r) => r.path === h)?.title, "now real");
    assert.deepEqual(await listSessionsTracked(), await fresh());
  } finally {
    t.stop();
  }
});

test("an incremental build with one named file stats two paths for it (watch path, summary) and opens it once", async () => {
  const a = session("io one");
  session("io two");
  session("io three");
  const t = trackSessionFiles();
  try {
    await listSessionsTracked();
    appendFileSync(a, `${assistant("more")}\n`);
    stamp(a);
    t.note(a);
    const before = { ...listIo };
    const rows = await listSessionsTracked();
    assert.deepEqual({ stats: listIo.stats - before.stats, opens: listIo.opens - before.opens }, { stats: 2, opens: 1 });
    assert.deepEqual(rows, await fresh());
    const idle = { ...listIo };
    await listSessionsTracked();
    assert.deepEqual({ ...listIo }, idle, "nothing named: no session file stat'ed or opened");
  } finally {
    t.stop();
  }
});

test("a write no watch reported is read within STAT_SWEEP_MS, without a folder read", async () => {
  const { STAT_SWEEP_MS } = await import("./sessions-index");
  const a = session("lost event");
  const t = trackSessionFiles();
  const realNow = Date.now;
  try {
    await listSessionsTracked();
    appendFileSync(a, `${assistant("unreported")}\n`);
    stamp(a);
    const full = trackedStats.full;
    const base = realNow();
    Date.now = () => base + STAT_SWEEP_MS + 1;
    const rows = await listSessionsTracked();
    Date.now = realNow;
    assert.equal(trackedStats.full, full, "a stat pass, not a full build");
    assert.deepEqual(rows, await fresh());
  } finally {
    Date.now = realNow;
    t.stop();
  }
});

test("an unchanged row is the last listing's object; a changed one is new and equal to a full read", async () => {
  const a = session("same object");
  const b = session("changes");
  const t = trackSessionFiles();
  try {
    const first = await listSessionsTracked();
    appendFileSync(b, `${assistant("moved")}\n`);
    stamp(b);
    t.note(b);
    const second = await listSessionsTracked();
    const row = (l: typeof first, p: string) => l.find((r) => r.path === p)!;
    assert.equal(row(second, a), row(first, a), "unchanged: the same object");
    assert.notEqual(row(second, b), row(first, b), "changed: a new object");
    assert.deepEqual(second, await fresh());
  } finally {
    t.stop();
  }
});
