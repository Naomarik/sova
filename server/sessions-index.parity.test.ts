// Run: pnpm test -- server/sessions-index.parity.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
//
// The no-regression gate for the incremental session list: for the same session files and stores,
// the list the feed builds now (re-reading only what the watcher says changed) must be deep-equal to
// what the old full build produced. The old build is the baseline revision's own
// server/sessions-index.ts (the merge base with master unless SOVA_PARITY_BASE names one), loaded
// from git into a scratch file whose relative imports point back at this tree's modules: both
// listings read the same stores, live records and readiness, and the old one keeps its own cache,
// so every call of it is the old code's full pass. Each test makes one kind of change, waits for the
// watcher to report it (an event, never a sleep), and compares.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-list-parity-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsRoot = join(agentDir, "sessions");
const folderA = join(sessionsRoot, "--tmp-parity-a--");
const folderB = join(sessionsRoot, "--tmp-parity-b--");
const liveDir = join(sessionsRoot, "live");
mkdirSync(folderA, { recursive: true });
mkdirSync(folderB, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/** The baseline module: the old sessions-index.ts, its build exported, its imports re-pointed here. */
async function loadBaseline(): Promise<{ build: () => Promise<SessionSummary[]>; rev: string }> {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const rev = process.env.SOVA_PARITY_BASE || git("merge-base", "HEAD", "master");
  let src = git("show", `${rev}:server/sessions-index.ts`);
  src = src.replace(/(from\s+|import\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_m, pre: string, q: string, rel: string) => `${pre}${q}${resolve(here, rel)}${q}`);
  assert.ok(/\nasync function buildSessions\(\)/.test(src), "the baseline still has buildSessions()");
  src += "\nexport { buildSessions as __parityBuild };\n";
  const dir = mkdtempSync(join(tmpdir(), "sova-list-parity-base-"));
  const file = join(dir, "sessions-index.baseline.ts");
  writeFileSync(file, src);
  const mod = await import(file);
  return { build: mod.__parityBuild as () => Promise<SessionSummary[]>, rev };
}

const NEW = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { watchFeedInputs } = await import("./session-feed-watch");
const { setArchived } = await import("./archived-sessions");
const { addWebSession } = await import("./web-sessions");
const { setSessionTitle } = await import("./session-titles");
const { assignSession, createGroup } = await import("./session-groups");
const { canonicalPath } = await import("./paths");
const readiness = await import("./merge-readiness");
const { setDraft } = await import("./drafts");
const baseline = await loadBaseline();
const { EventHub } = await import("./events");

// /ws/events and `sova watch` take their observed events from the feed's list reads (seeList): one
// hub fed the old build's lists and one fed the new ones must record the same events.
const hubSources = () => ({
  onChatEvent: () => () => {},
  onAttention: () => () => {},
  holdFeed: () => () => {},
  isHosted: () => false,
  idOf: (p: string) => NEW.idOf(p),
});
const hubs = { old: new EventHub(hubSources()), new: new EventHub(hubSources()) };
const heardEvents = { old: [] as unknown[], new: [] as unknown[] };
for (const k of ["old", "new"] as const) {
  const r = hubs[k].subscribe({ deliver: (e) => heardEvents[k].push((({ at: _at, stream: _s, ...rest }) => rest)(JSON.parse(e.json))) }, null);
  if ("error" in r) throw new Error(r.error);
}

// ---------------------------------------------------------------------------------------------
// The new side: the feed's listing, wired as server/index.ts wires it. The watcher's `files` notes
// go to the index's file tracker; the feed lists with listSessionsTracked.
// ---------------------------------------------------------------------------------------------
const realNow = Date.now;
const tracked = NEW.trackSessionFiles();
const noteFile = tracked.note;
const newList = (): Promise<SessionSummary[]> => NEW.listSessionsTracked();

// ---------------------------------------------------------------------------------------------
// The watcher, running for the whole file, as the feed runs it while a tab listens.
// ---------------------------------------------------------------------------------------------
let heard = 0;
const noted: (string | null)[] = [];
const waiters = new Set<() => void>();
const wake = () => {
  for (const w of waiters) w();
};
let stopWatch: () => void = () => {};
/** While set, the watcher's notes are dropped before the tracker hears them (the gate's own control). */
let deaf = false;
/** Paths whose watcher notes are dropped (a test notes them itself, when it chooses). */
const muted = new Set<string>();
before(() => {
  stopWatch = watchFeedInputs(
    () => {
      heard++;
      wake();
    },
    {
      liveCheckMs: 50,
      files: (p) => {
        if (deaf || (p !== null && muted.has(p))) return;
        noted.push(p);
        noteFile(p);
        wake();
      },
    } as Parameters<typeof watchFeedInputs>[1],
  );
});
after(() => {
  stopWatch();
  tracked.stop();
  rmSync(agentDir, { recursive: true, force: true });
});

/** Resolves once `ok()` holds, re-checked on every watcher signal; fails after `ms`. */
function until(ok: () => boolean, what: string, ms = 5_000): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((done, fail) => {
    const t = setTimeout(() => {
      waiters.delete(check);
      fail(new Error(`timed out waiting for ${what}`));
    }, ms);
    const check = () => {
      if (!ok()) return;
      clearTimeout(t);
      waiters.delete(check);
      done();
    };
    waiters.add(check);
  });
}
/** Where the signals stood before a change: only what comes after it counts. */
interface Mark {
  heard: number;
  noted: number;
}
const mark = (): Mark => ({ heard, noted: noted.length });
/** Waits for the feed to hear a change made after `from`, and (when given) for the watcher to
    name each file after it. */
async function heardChange(from: Mark, files: string[] = [], what = ""): Promise<void> {
  await until(() => heard > from.heard, `the feed to hear the change${what ? ` (${what})` : ""}`);
  // A null note means "re-read everything": it covers every file.
  const since = () => noted.slice(from.noted);
  for (const f of files) await until(() => since().includes(f) || since().includes(null), `the watcher to name ${f}${what ? ` (${what})` : ""}`);
  // Bun's fs.watch reports no second event for a write to the same file within ~2 ms of the one it
  // just delivered (Node does): the harness's next write waits that out, so each case's change is
  // reported. The product's own exposure to it is its own case below ("a write the watch never reports").
  await new Promise((r) => setTimeout(r, 10));
}

let nullsAtLastCheck = 0;

/** Old builds with readiness drained in between, until two in a row agree. */
async function settledReadiness(): Promise<void> {
  let prev = "";
  for (let i = 0; i < 6; i++) {
    const rows = JSON.stringify(tieStable(await baseline.build()));
    await readiness.readinessIdle();
    if (rows === prev) return;
    prev = rows;
  }
  throw new Error("merge readiness never settled");
}

/** Rows in list order, rows of one lastActiveAt by path: both builds sort by lastActiveAt alone,
    so the order of a tie is the folder listing's, which neither build fixes. */
function tieStable(rows: readonly SessionSummary[]): SessionSummary[] {
  return rows.map((s, i) => ({ s, i })).sort((a, b) => b.s.lastActiveAt.localeCompare(a.s.lastActiveAt) || (a.s.path < b.s.path ? -1 : a.s.path > b.s.path ? 1 : 0)).map((x) => x.s);
}

/** The fields that differ between two rows, for a readable failure. */
function fieldDiff(a: SessionSummary, b: SessionSummary): Record<string, { new: unknown; old: unknown }> {
  const out: Record<string, { new: unknown; old: unknown }> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = (a as any)[k], y = (b as any)[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = { new: x, old: y };
  }
  return out;
}

/** The gate itself: the new listing deep-equals the old full build, row for row and in order. */
async function assertParity(label: string, opts: { full?: boolean } = {}): Promise<SessionSummary[]> {
  // Merge readiness answers in the background, and a build may queue a read: let the old build's
  // reads finish (answers stop moving) before either side is taken, so both see the same answers.
  await settledReadiness();
  const fullBefore = NEW.trackedStats.full;
  const fresh = await newList();
  // A tracked build that quietly read everything would pass for the wrong reason. Unless the watch
  // said it couldn't name what changed (a null note: Bun sends a nameless event now and then).
  const nulls = noted.filter((n) => n === null).length;
  const nullSince = nulls > nullsAtLastCheck;
  nullsAtLastCheck = nulls;
  if (!opts.full && !nullSince) assert.equal(NEW.trackedStats.full, fullBefore, `${label}: the new list was built from the noted files only (re-read-all notes so far: ${noted.filter((n) => n === null).length})`);
  const old = await baseline.build();
  // Both are sorted newest first; a tie's order is the folder listing's.
  for (const [name, l] of [["new", fresh], ["old", old]] as const)
    for (let i = 1; i < l.length; i++) assert.ok(l[i - 1]!.lastActiveAt >= l[i]!.lastActiveAt, `${label}: the ${name} list is newest first`);
  const f = tieStable(fresh), o = tieStable(old);
  const fp = new Set(f.map((s) => s.path)), op = new Set(o.map((s) => s.path));
  const missing = o.filter((s) => !fp.has(s.path)).map((s) => s.path);
  const extra = f.filter((s) => !op.has(s.path)).map((s) => s.path);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: the same rows`);
  const byPath = new Map(o.map((s) => [s.path, s]));
  const diffs = f.map((s) => ({ path: s.path, diff: fieldDiff(s, byPath.get(s.path)!) })).filter((d) => Object.keys(d.diff).length);
  assert.deepEqual(diffs, [], `${label}: every row equal`);
  assert.deepEqual(f, o, `${label}: same order`);
  // Every other caller (GET /api/sessions, session.list, the session_list tool, the Overseer, mesh
  // peers through GET) lists with listSessions, a full pass over the new readers: the same rows too.
  sessionsChanged(); // past its one-second reuse window, as a later caller would be
  const fullNew = tieStable(await NEW.listSessions());
  const fullDiffs = fullNew.map((s) => ({ path: s.path, diff: byPath.has(s.path) ? fieldDiff(s, byPath.get(s.path)!) : { row: { new: "present", old: "absent" } } })).filter((d) => Object.keys(d.diff).length);
  assert.deepEqual(fullDiffs, [], `${label}: listSessions (full) rows equal the old build's`);
  assert.deepEqual(fullNew, o, `${label}: listSessions (full) equals the old build`);
  const from = { old: heardEvents.old.length, new: heardEvents.new.length };
  hubs.old.seeList(old);
  hubs.new.seeList(fresh);
  // One list read's events, as a set: within one read they follow list order, and a tie's order is
  // the folder listing's (as for the rows). Their seqs follow the same order.
  const batch = (k: "old" | "new") =>
    heardEvents[k]
      .slice(from[k])
      .map((e) => JSON.stringify((({ seq: _seq, ...rest }) => rest)(e as Record<string, unknown>)))
      .sort();
  assert.deepEqual(batch("new"), batch("old"), `${label}: the observed events (/ws/events, sova watch) are the same`);
  return old;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
let seq = 0;
const uuid = () => {
  const n = (++seq).toString(16).padStart(12, "0");
  return `01a1b2c3-d4e5-7f00-8000-${n}`;
};
const header = (id: string, cwd: string, extra: object = {}) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd, ...extra });
let eid = 0;
const nextId = () => `p${String(++eid).padStart(7, "0")}`;
let lastEntry: Record<string, string | null> = {};
function entry(path: string, body: object): string {
  const id = nextId();
  const e = JSON.stringify({ id, parentId: lastEntry[path] ?? null, timestamp: new Date(realNow()).toISOString(), ...body });
  lastEntry[path] = id;
  return e;
}
const userMsg = (path: string, text: string) => entry(path, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantMsg = (path: string, text: string) =>
  entry(path, { type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 1240 } } });

/** A session file with a user message and a reply; returns its canonical path and id. */
function makeSession(dir: string, title: string, opts: { reply?: boolean; husk?: boolean; parent?: string } = {}): { path: string; id: string } {
  const id = uuid();
  const raw = join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  const path = canonicalPath(raw);
  const lines = [header(id, "/tmp/parity", opts.parent ? { parentSession: opts.parent } : {})];
  if (!opts.husk) {
    lines.push(userMsg(path, title));
    if (opts.reply !== false) lines.push(assistantMsg(path, `reply to ${title}`));
  }
  writeFileSync(raw, `${lines.join("\n")}\n`);
  return { path, id };
}

const sessions: { path: string; id: string }[] = [];

/** The cases build on each other's files: after the first failure the rest are skipped, so the
    failure that matters is the one reported. */
let broken: string | null = null;
function step(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (broken) return t.skip(`after the failure in "${broken}"`);
    try {
      await fn();
    } catch (err) {
      broken = name;
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

step(`baseline loads (rev ${baseline.rev.slice(0, 12)}) and the starting list matches`, async () => {
  for (let i = 0; i < 6; i++) sessions.push(makeSession(i % 2 ? folderB : folderA, `starting session ${i}`));
  sessions.push(makeSession(folderA, "", { husk: true })); // an empty husk: listed by neither
  sessions.push(makeSession(folderB, "a forked one", { parent: sessions[0]!.path }));
  addWebSession(sessions[1]!.id);
  sessionsChanged(); // the first listing of a fresh process reads everything anyway
  const rows = await assertParity("start", { full: true });
  assert.equal(rows.length, 7, "six sessions and the fork; the husk is hidden");
});

step("a new session", async () => {
  const h = mark();
  const s = makeSession(folderA, "a brand new session");
  sessions.push(s);
  await heardChange(h, [s.path]);
  const rows = await assertParity("new session");
  assert.ok(rows.some((r) => r.path === s.path));
});

step("an appended line (a reply, then a model change)", async () => {
  const s = sessions[2]!;
  let h = mark();
  appendFileSync(s.path, `${assistantMsg(s.path, "a later reply with more words")}\n`);
  await heardChange(h, [s.path]);
  await assertParity("appended reply");
  h = mark();
  appendFileSync(s.path, `${entry(s.path, { type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" })}\n${userMsg(s.path, "and another question")}\n`);
  await heardChange(h, [s.path]);
  await assertParity("appended model change and prompt");
});

step("a partial line, then its completion (a writer mid-append)", async () => {
  const s = sessions[3]!;
  const line = assistantMsg(s.path, "half written");
  let h = mark();
  appendFileSync(s.path, line.slice(0, 20));
  await heardChange(h, [s.path]);
  await assertParity("partial line");
  h = mark();
  appendFileSync(s.path, `${line.slice(20)}\n`);
  await heardChange(h, [s.path]);
  await assertParity("completed line");
});

step("a rename: the title store (user, then cleared)", async () => {
  const s = sessions[0]!;
  let h = mark();
  setSessionTitle(s.id, "My own title");
  await heardChange(h);
  await assertParity("title set");
  h = mark();
  setSessionTitle(s.id, null);
  await heardChange(h);
  await assertParity("title cleared");
});

step("a rename: the file moved to a new name in another folder", async () => {
  const s = sessions[4]!;
  const to = canonicalPath(join(folderB, `2026-10-01T00-00-01-000Z_${s.id}.jsonl`));
  const h = mark();
  renameSync(s.path, to);
  await heardChange(h, [s.path, to]);
  sessions[4] = { path: to, id: s.id };
  await assertParity("file moved");
});

step("archive and unarchive", async () => {
  const s = sessions[5]!;
  let h = mark();
  setArchived(s.id, true);
  await heardChange(h);
  const rows = await assertParity("archived");
  assert.equal(rows.find((r) => r.path === s.path)?.archived, true);
  h = mark();
  setArchived(s.id, false);
  await heardChange(h);
  await assertParity("unarchived");
});

step("archiveSession on a husk deletes it, and the list matches", async () => {
  const husk = makeSession(folderB, "", { husk: true });
  let h = mark();
  await heardChange(h, [husk.path]);
  await assertParity("husk added (hidden)");
  addWebSession(husk.id); // a husk this server spawned: archiving deletes it
  h = mark();
  const r = await NEW.archiveSession(husk.path, true);
  assert.equal(r.ok, true);
  await heardChange(h, [husk.path]);
  await assertParity("husk archived away");
});

step("a husk becomes a draft row and back (drafts store)", async () => {
  const husk = makeSession(folderA, "", { husk: true });
  let h = mark();
  await heardChange(h, [husk.path]);
  h = mark();
  setDraft(husk.id, "something I'm typing");
  await heardChange(h);
  const rows = await assertParity("draft on a husk");
  assert.ok(rows.some((r) => r.path === husk.path && r.hasDraft), "the draft row shows");
  h = mark();
  setDraft(husk.id, "");
  await heardChange(h);
  await assertParity("draft cleared");
});

step("a husk becomes a real session (its first message), and a real session with no title (an image-only message)", async () => {
  const husk = makeSession(folderB, "", { husk: true });
  let h = mark();
  await heardChange(h, [husk.path], "husk");
  let rows = await assertParity("husk hidden");
  assert.ok(!rows.some((r) => r.path === husk.path));
  h = mark();
  appendFileSync(husk.path, `${userMsg(husk.path, "now it says something")}\n`);
  await heardChange(h, [husk.path], "husk gets a message");
  rows = await assertParity("husk became real");
  assert.ok(rows.some((r) => r.path === husk.path && r.title === "now it says something"));
  // Input, but nothing that titles it: listed as Untitled, never a husk.
  const linked = makeSession(folderA, "", { husk: true });
  h = mark();
  await heardChange(h, [linked.path], "untitled");
  h = mark();
  appendFileSync(linked.path, `${entry(linked.path, { type: "message", message: { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } })}\n`);
  await heardChange(h, [linked.path], "an image-only message");
  rows = await assertParity("real untitled");
  assert.equal(rows.find((r) => r.path === linked.path)?.title, "Untitled", "the fixture is a real session with no title");
  sessions.push(husk, linked);
});

step("delete", async () => {
  const s = sessions.splice(1, 1)[0]!;
  const h = mark();
  unlinkSync(s.path);
  await heardChange(h, [s.path]);
  const rows = await assertParity("deleted");
  assert.ok(!rows.some((r) => r.path === s.path));
});

step("the fork's parent deleted: the fork keeps its cached parent until it is touched (both builds)", async () => {
  const parent = sessions.shift()!;
  let h = mark();
  unlinkSync(parent.path);
  await heardChange(h, [parent.path]);
  await assertParity("parent gone");
});

step("a group change: assigned, moved, unassigned", async () => {
  const s = sessions[0]!;
  const g1 = createGroup("Parity one");
  const g2 = createGroup("Parity two");
  assert.ok(g1.ok && g2.ok);
  let h = mark();
  assignSession(s.id, g1.group.id);
  await heardChange(h);
  await assertParity("assigned");
  h = mark();
  assignSession(s.id, g2.group.id, "a label");
  await heardChange(h);
  await assertParity("moved with a label");
  h = mark();
  assignSession(s.id, null);
  await heardChange(h);
  await assertParity("unassigned");
});

// A live record's owner: a pid this test decides is alive or dead (process.kill(pid, 0) is how
// live.ts asks), so a death needs no real process.
const FAKE_PID = 2_000_000_001;
let fakeAlive = true;
const realKill = process.kill.bind(process);
process.kill = ((pid: number, sig?: string | number) => {
  if (pid === FAKE_PID && (sig === 0 || sig === undefined)) {
    if (fakeAlive) return true;
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }
  return realKill(pid, sig as any);
}) as typeof process.kill;
after(() => {
  process.kill = realKill;
});

step("a live record: start, status change, stop, and a death without a write", async () => {
  const s = sessions[1]!;
  const rec = join(liveDir, `p${FAKE_PID}-parity.json`);
  const write = (status: string, activity?: object) =>
    writeFileSync(rec, JSON.stringify({ heartbeat: realNow(), session: { pid: FAKE_PID, sessionFile: s.path, mode: "tui" }, presence: { status, ...(activity ? { activity } : {}) } }));
  let h = mark();
  write("idle");
  await heardChange(h);
  let rows = await assertParity("live start");
  assert.equal(rows.find((r) => r.path === s.path)?.live?.pid, FAKE_PID);
  h = mark();
  write("streaming", { state: "working", since: 5 });
  await heardChange(h);
  await assertParity("live working");
  h = mark();
  unlinkSync(rec);
  await heardChange(h);
  await assertParity("live stop");
  h = mark();
  write("idle");
  await heardChange(h);
  await assertParity("live again");
  h = mark();
  fakeAlive = false; // the owner dies; nothing is written
  await heardChange(h);
  rows = await assertParity("live death");
  assert.equal(rows.find((r) => r.path === s.path)?.live, null);
  fakeAlive = true;
  unlinkSync(rec);
});

step("seen, viewing and tags: the unread dot clears and comes back, a tag set and cleared", async () => {
  const { markSeen, trackViewer } = await import("./seen");
  const { setUserTags } = await import("./session-tags");
  const s = sessions[2]!;
  let h = mark();
  markSeen(s.id, realNow() + 60_000);
  await heardChange(h);
  await assertParity("seen");
  h = mark();
  appendFileSync(s.path, `${assistantMsg(s.path, "a newer reply")}\n`);
  await heardChange(h, [s.path]);
  await assertParity("a reply after seen (the clock is behind the mark: still read)");
  trackViewer(s.id, 1); // in memory: the next listing reads it (both builds)
  await assertParity("viewed");
  trackViewer(s.id, -1);
  await assertParity("no longer viewed");
  h = mark();
  setUserTags(s.id, ["parity"], s.path);
  await heardChange(h);
  await assertParity("tagged");
  h = mark();
  setUserTags(s.id, null, s.path);
  await heardChange(h);
  await assertParity("untagged");
});

step("worker sessions: the owner names a worker (only the owner's file changes); a self-marked worker; a live record's worker", async () => {
  const owner = sessions[0]!;
  const worker = makeSession(folderA, "a worker's task");
  let h = mark();
  await heardChange(h, [worker.path], "worker file");
  await assertParity("worker listed as a plain session");
  // The owner's completion message: only the OWNER's file is written, the worker's row changes.
  h = mark();
  appendFileSync(owner.path, `${entry(owner.path, { type: "custom_message", customType: "subagent-complete", content: `### ag_01 (helper) \u2014 done\nSession: ${worker.path}\nModel: zai/glm-5.3\n\nall done`, display: true })}\n`);
  await heardChange(h, [owner.path], "owner append");
  let rows = await assertParity("owner names the worker");
  assert.equal(rows.find((r) => r.path === worker.path)?.workerSession, true, "the fixture flags the worker");
  // A worker that marks itself.
  const self = makeSession(folderB, "self-marked worker");
  h = mark();
  appendFileSync(self.path, `${entry(self.path, { type: "custom", customType: "subagents-worker-session", data: { workerId: "ag_02" } })}\n`);
  await heardChange(h, [self.path], "self marker");
  rows = await assertParity("self-marked worker");
  assert.equal(rows.find((r) => r.path === self.path)?.workerSession, true);
  // A live record naming a worker by file: no session file changes at all.
  const liveWorker = makeSession(folderA, "a live record's worker");
  h = mark();
  await heardChange(h, [liveWorker.path], "live worker file");
  const rec = join(liveDir, `p${process.pid}-parityw.json`);
  h = mark();
  writeFileSync(rec, JSON.stringify({ heartbeat: realNow(), session: { sessionFile: owner.path, pid: process.pid, mode: "rpc", status: "idle" }, presence: { status: "idle", workers: [{ id: "ag_03", name: "w", status: "running", backend: "pi", sessionFile: liveWorker.path }] } }));
  await heardChange(h, [], "live record written");
  rows = await assertParity("live record names a worker");
  assert.equal(rows.find((r) => r.path === liveWorker.path)?.workerSession, true);
  // This server's own record going away moves no live signature here (as on master), so there is
  // no signal to wait for: the next listing must still match.
  unlinkSync(rec);
  await assertParity("live worker record gone");
});

step("merge readiness moving (git faked): the answer arrives, then changes", async () => {
  const id = uuid();
  const raw = join(folderA, `2026-10-01T00-00-02-000Z_${id}.jsonl`);
  const path = canonicalPath(raw);
  const tree = { path: "/wt/parity", branch: "feat/parity", base: "b0", baseBranch: "master", status: "active", session: id, how: "created", at: 1 };
  writeFileSync(
    raw,
    `${[header(id, "/tmp/parity"), userMsg(path, "make a branch"), entry(path, { type: "custom", customType: "worktrees", data: { version: 1, trees: [tree] } }), assistantMsg(path, "Done. Shall I merge the branch into master?")].join("\n")}\n`,
  );
  sessions.push({ path, id });
  let status = { path: "/wt/parity", source: "session" as const, exists: true, branch: "feat/parity", base: "master", merged: "no" as const, ahead: 1, behind: 0, dirty: false, head: "h1" };
  let now = 1_000_000;
  readiness.configureReadiness({ insights: { treeStatus: async () => status } as any, git: async () => ({ code: 1, stdout: "", stderr: "" }), asksUser: () => undefined, now: () => now, processStart: 0 });
  try {
    let h = mark();
    await heardChange(h, [path]);
    await assertParity("readiness row added (no answer yet)");
    await readiness.readinessIdle();
    await assertParity("readiness answer arrived");
    const first = (await baseline.build()).find((r) => r.path === path)?.readiness;
    assert.ok(first, "the fixture produces a readiness answer");
    status = { ...status, ahead: 0, merged: "ancestor" as any };
    now += readiness.READINESS_TTL_MS + 1;
    h = mark();
    await assertParity("readiness aged (re-read queued)");
    await readiness.readinessIdle();
    await assertParity("readiness changed");
    const second = (await baseline.build()).find((r) => r.path === path)?.readiness;
    assert.notDeepEqual(second, first, "the answer moved");
  } finally {
    await readiness.readinessIdle();
    readiness.resetReadiness();
  }
});

step("a file touched without a change (same bytes, same mtime)", async () => {
  const s = sessions[0]!;
  const st = statSync(s.path);
  const h = mark();
  utimesSync(s.path, st.atime, st.mtime);
  await heardChange(h, [s.path]);
  await assertParity("touched, unchanged");
});

step("a file touched to a new mtime (same bytes)", async () => {
  const s = sessions[0]!;
  const h = mark();
  const t = new Date(realNow() + 5_000);
  utimesSync(s.path, t, t);
  await heardChange(h, [s.path]);
  await assertParity("touched, new mtime");
});

step("a same-size rewrite (an atomic replace with different bytes)", async () => {
  const s = sessions[2]!;
  const size = statSync(s.path).size;
  const body = `${header(s.id, "/tmp/parity")}\n${userMsg(s.path, "REWRITTEN")}\n`;
  const pad = size - Buffer.byteLength(body);
  const tmp = `${s.path}.tmp`;
  writeFileSync(tmp, pad > 1 ? `${body}${" ".repeat(pad - 1)}\n` : body);
  const h = mark();
  renameSync(tmp, s.path);
  await heardChange(h, [s.path]);
  await assertParity("same-size replace");
});

step("many changes in one burst", async () => {
  const h = mark();
  const touched: string[] = [];
  for (let i = 0; i < 25; i++) {
    const s = makeSession(i % 2 ? folderA : folderB, `burst ${i}`);
    sessions.push(s);
    touched.push(s.path);
  }
  for (const s of sessions.slice(0, 4)) {
    appendFileSync(s.path, `${userMsg(s.path, "burst follow-up")}\n`);
    touched.push(s.path);
  }
  const gone = sessions.splice(5, 2);
  for (const s of gone) {
    unlinkSync(s.path);
    touched.push(s.path);
  }
  setSessionTitle(sessions[3]!.id, "burst title");
  setArchived(sessions[6]!.id, true);
  await heardChange(h, touched);
  await assertParity("burst");
});

step("a folder added (with sessions written before its watch existed), then removed", async () => {
  const folderC = join(sessionsRoot, "--tmp-parity-c--");
  const h = mark();
  mkdirSync(folderC);
  const inside = [makeSession(folderC, "in a new folder"), makeSession(folderC, "also in it")];
  // No change is announced for a new folder itself (as before): only its watch's "re-read" note,
  // or its files' own events.
  void h;
  await until(() => noted.includes(null) || inside.every((s) => noted.includes(s.path)), "the watcher to cover the new folder");
  await assertParity("folder added", { full: true });
  const h2 = mark();
  const nulls = noted.filter((n) => n === null).length;
  rmSync(folderC, { recursive: true, force: true });
  await until(() => heard > h2.heard || noted.filter((n) => n === null).length > nulls, "the watcher to hear the folder go");
  await assertParity("folder removed");
});

step("an unnamed watcher event (re-read everything)", async () => {
  // A lost watch or an event with no file name: the tracker must fall back to a full read.
  const s = sessions[0]!;
  const h = mark();
  noteFile(null);
  appendFileSync(s.path, `${assistantMsg(s.path, "written while the watch said nothing useful")}\n`);
  await heardChange(h, [s.path]);
  await assertParity("after a null note", { full: true });
});

step("full listings (GET, other callers) racing tracked builds while files grow: no row goes back in time", async () => {
  // GET /api/sessions and every other caller list with listSessions (a full stat pass) while the
  // feed lists tracked. Both share one summary cache; a slow read finishing after a newer one must
  // never leave the older summary behind for a tracked build, which never stats a clean file.
  const growing = sessions.slice(0, 6);
  for (let round = 0; round < 30; round++) {
    const h = mark();
    const s = growing[round % growing.length]!;
    const big = "x".repeat(round % 3 === 0 ? 300_000 : 2_000); // past the tail window now and then
    appendFileSync(s.path, `${assistantMsg(s.path, `round ${round} ${big}`)}\n`);
    const racing = [NEW.listSessions(), newList(), NEW.listSessions(), NEW.getSessionSummary(s.path)];
    appendFileSync(s.path, `${entry(s.path, { type: "model_change", provider: round % 2 ? "anthropic" : "zai", modelId: round % 2 ? "claude-opus-5-5" : "glm-5.3" })}\n`);
    racing.push(NEW.listSessions(), newList());
    await Promise.all(racing);
    await heardChange(h, [s.path], `round ${round}`);
    await assertParity(`race round ${round}`);
  }
});

step("a slow full pass that stat'ed a file before its append, finishing after the tracked build that read it: the next tracked build is still current", async () => {
  // A full pass (listSessions: GET, the Overseer, schedules...) stats every file, then reads the
  // ones whose stamp moved, all at once; the feed's tracked build reads one. If the slow pass's
  // older summary lands in the cache after the tracked build's newer one, a tracked build (which
  // never stats a clean file) must not serve it.
  const many: { path: string; id: string }[] = [];
  for (let i = 0; i < 200; i++) many.push(makeSession(i % 2 ? folderA : folderB, `bulk ${i} ${"y".repeat(40_000)}`));
  const f = sessions[0]!;
  for (const s of many) noteFile(s.path);
  await assertParity("bulk files added", { full: true }); // 200 creates may overflow into a re-read-all note
  // From here this test alone tells the tracker about these files, so no late watch event re-reads f.
  for (const s of [...many, f]) muted.add(s.path);
  for (let round = 0; round < 5; round++) {
    // Move every stamp the tracker isn't told of yet, so the full pass must re-read them all, f too.
    const t = new Date(realNow() + 10_000 * (round + 1));
    for (const s of [...many, f]) utimesSync(s.path, t, t);
    const slow = NEW.listSessions(); // stats now, reads ~200 files
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    appendFileSync(f.path, `${assistantMsg(f.path, `after the slow pass's stat, round ${round}`)}\n`);
    noteFile(f.path);
    const fast = newList(); // reads f alone
    await Promise.all([slow, fast]);
    for (const s of many) noteFile(s.path); // what the watch would have said of the touches
    await assertParity(`slow pass round ${round}`);
  }
  muted.clear();
  for (const s of many) {
    unlinkSync(s.path);
    noteFile(s.path);
  }
  await assertParity("bulk files removed", { full: true });
});

step("the gate fails when the tracker misses a change (control)", async () => {
  // The instrument must tell a stale list from a fresh one: a reply the watcher never names.
  const s = sessions[0]!;
  deaf = true;
  try {
    const h = mark();
    appendFileSync(s.path, `${assistantMsg(s.path, "a reply nobody named")}\n`);
    await heardChange(h);
    await assert.rejects(assertParity("unnamed change"), /every row equal|same order/, "a stale row is a difference");
  } finally {
    deaf = false;
  }
  noteFile(s.path);
  await assertParity("named at last");
});

step("idle: nothing changes, the list stays equal", async () => {
  await assertParity("idle 1");
  await assertParity("idle 2");
});

step("(last: it moves the clock) a write the watch never reports is listed within the safety net's minute, as before", async () => {
  // Bun's watch merges a second write to a file landing within ~2 ms of the event it delivered, so a
  // build reading between the two never hears of the second. On master the feed's once-a-minute
  // safety net (SAFETY_NET_MS) was a full stat pass and healed it within a minute; the tracked list
  // must do no worse.
  const { SAFETY_NET_MS } = await import("./session-feed");
  const s = sessions[1]!;
  muted.add(s.path);
  try {
    appendFileSync(s.path, `${assistantMsg(s.path, "a write no event reported")}\n`);
    const skew = SAFETY_NET_MS + 1_000;
    const now = Date.now;
    Date.now = () => now() + skew;
    try {
      const sweeps = (NEW.trackedStats as { statSweeps?: number }).statSweeps ?? 0;
      await assertParity("one safety-net period after an unreported write");
      assert.ok(((NEW.trackedStats as { statSweeps?: number }).statSweeps ?? 0) > sweeps, "healed by a stat pass, not a full read");
    } finally {
      Date.now = now;
    }
  } finally {
    muted.delete(s.path);
  }
});
