// Run: pnpm test server/merge-queue/thread.test.ts
// The merge thread: when a project's chat is reused or replaced (24 h, half its context, archived,
// gone, open in a terminal), that `notify` never delays the queue (a hung or failing thread costs
// nothing), and a stand-in model following the playbook: a branch touching statecharts gets the
// statecharts check picked through merge.extend, and both conflict judgements reach merge.resolve.
// Sessions, the clock and the model are fakes; git runs on throwaway repos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { realGit } from "./guard";
import { makeScratchCopy } from "./scratch";
import {
  DEFAULT_PLAYBOOK_DIR,
  MergeThread,
  PROJECT_PLAYBOOK,
  THREAD_GRACE_MS,
  THREAD_MAX_AGE_MS,
  eventText,
  firstText,
  hasMergeThread,
  mergeThread,
  playbookDir,
  replaceReason,
  setMergeThread,
  threadOf,
  type ThreadDeps,
  type ThreadEvent,
  type ThreadSession,
} from "./thread";
// @ts-expect-error: a plain .mjs script of the shipped playbook, typed by use here
import { blastRadius } from "../../playbooks/merge-queue/scripts/blast-radius.mjs";
// @ts-expect-error: as above
import { hunksOf } from "../../playbooks/merge-queue/scripts/conflict-hunks.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-02T10:00:00Z");

const entry = (id = "mq_1", over: Partial<{ branch: string; commit: string; target: string }> = {}) => ({ id, branch: "feat/x", commit: "a".repeat(40), target: "master", ...over });
const queued = (id?: string): ThreadEvent => ({ kind: "queued", entry: entry(id) });

/** A fake Sova: sessions by id, the clock, what was created and woken. */
function fakeSova(dir: string, over: Partial<ThreadDeps> = {}) {
  let clock = T0;
  let n = 0;
  const sessions = new Map<string, ThreadSession>();
  const created: { root: string; text: string; title: string; id: string }[] = [];
  const woken: { path: string; text: string }[] = [];
  const logs: string[] = [];
  const deps: ThreadDeps = {
    now: () => clock,
    file: join(dir, "threads.json"),
    async session(id) {
      return sessions.get(id) ?? null;
    },
    async create(root, text, title) {
      const id = `s${++n}`;
      sessions.set(id, { id, path: `/sessions/${id}.jsonl`, createdAt: new Date(clock).toISOString() });
      created.push({ root, text, title, id });
      return { ok: true, id, path: `/sessions/${id}.jsonl` };
    },
    async wake(path, text) {
      woken.push({ path, text });
      return { ok: true };
    },
    log: (l) => logs.push(l),
    retryMs: [0, 0],
    ...over,
  };
  return { deps, sessions, created, woken, logs, tick: (ms: number) => (clock += ms), set: (id: string, s: Partial<ThreadSession>) => sessions.set(id, { ...sessions.get(id)!, ...s }) };
}

// ---- the replace rules -------------------------------------------------------------------------

test("replaceReason: reuse a young, light chat; replace one gone, archived, live, older than 24 h or past half its context", () => {
  const rec = { sessionId: "s1", path: "/p", startedAt: T0, playbook: "/pb" };
  const s: ThreadSession = { id: "s1", path: "/p", createdAt: new Date(T0).toISOString(), context: { tokens: 10_000, window: 200_000 } };
  assert.equal(replaceReason(rec, s, T0 + HOUR), null);
  assert.equal(replaceReason(undefined, null, T0), "no thread yet");
  assert.equal(replaceReason(rec, null, T0), "its chat is gone");
  assert.equal(replaceReason(rec, { ...s, archived: true }, T0), "its chat was archived");
  assert.equal(replaceReason(rec, { ...s, live: true }, T0), "its chat is open in a terminal");
  assert.equal(replaceReason(rec, s, T0 + THREAD_MAX_AGE_MS), null, "exactly 24 h is still reused");
  assert.equal(replaceReason(rec, s, T0 + THREAD_MAX_AGE_MS + 1), "it is more than 24 h old");
  assert.equal(replaceReason(rec, { ...s, context: { tokens: 100_000, window: 200_000 } }, T0), null, "exactly half is still reused");
  assert.equal(replaceReason(rec, { ...s, context: { tokens: 100_001, window: 200_000 } }, T0), "it is past half its context");
  assert.equal(replaceReason(rec, { ...s, context: { tokens: 900_000, window: null } }, T0), null, "an unknown window never replaces");
});

test("the first event starts a chat in the project's root; later ones wake it; one past 24 h or half its context is replaced", async () => {
  const dir = scratchRoot("mq-thread-");
  const f = fakeSova(dir);
  const t = new MergeThread(f.deps);
  t.notify("/proj", queued("mq_1"));
  await t.idle("/proj");
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.root, "/proj");
  assert.match(f.created[0]!.title, /^Merge thread · proj · 2026-11-02$/);
  assert.match(f.created[0]!.text, /You are the merge thread for the project at \/proj/);
  assert.match(f.created[0]!.text, /Queued: entry mq_1/);

  f.tick(HOUR);
  t.notify("/proj", queued("mq_2"));
  await t.idle("/proj");
  assert.equal(f.created.length, 1, "a young thread is reused");
  assert.deepEqual(f.woken.map((w) => w.path), ["/sessions/s1.jsonl"]);
  assert.match(f.woken[0]!.text, /^Queued: entry mq_2/);

  f.set("s1", { context: { tokens: 150_000, window: 200_000 } });
  t.notify("/proj", queued("mq_3"));
  await t.idle("/proj");
  assert.equal(f.created.length, 2, "past half its context: a fresh one");
  assert.ok(f.logs.some((l) => l.includes("past half its context")));

  f.tick(THREAD_MAX_AGE_MS + 1);
  t.notify("/proj", queued("mq_4"));
  await t.idle("/proj");
  assert.equal(f.created.length, 3, "past 24 h: a fresh one");
  assert.equal(t.record("/proj")!.sessionId, "s3");
});

test("an archived, vanished or terminal-held thread is replaced; a refused wake starts a fresh one", async () => {
  for (const change of [{ archived: true }, { live: true }, "gone", "refuse"] as const) {
    const dir = scratchRoot("mq-thread-");
    const refuse = { on: false };
    const f = fakeSova(dir, {});
    const wake = f.deps.wake;
    f.deps.wake = async (p, x) => (refuse.on ? { ok: false, error: "That is a baton session" } : wake(p, x));
    const t = new MergeThread(f.deps);
    t.notify("/p", queued());
    await t.idle("/p");
    if (change === "gone") f.sessions.delete("s1");
    else if (change === "refuse") refuse.on = true;
    else f.set("s1", change);
    t.notify("/p", queued("mq_2"));
    await t.idle("/p");
    assert.equal(f.created.length, 2, `${JSON.stringify(change)}: a fresh thread`);
    assert.equal(t.record("/p")!.sessionId, "s2");
  }
});

test("each project has its own thread; events of one project are delivered in order, one chat started", async () => {
  const dir = scratchRoot("mq-thread-");
  const f = fakeSova(dir);
  const t = new MergeThread(f.deps);
  t.notify("/a", queued("mq_1"));
  t.notify("/a", queued("mq_2"));
  t.notify("/b", queued("mq_3"));
  t.notify("/a", { kind: "paused", why: "setup failed on master twice" });
  await Promise.all([t.idle("/a"), t.idle("/b")]);
  assert.deepEqual(f.created.map((c) => c.root).sort(), ["/a", "/b"]);
  const toA = f.woken.filter((w) => w.path === `/sessions/${t.record("/a")!.sessionId}.jsonl`).map((w) => w.text.split("\n")[0]);
  assert.deepEqual(toA, ["Queued: entry mq_2 · feat/x at aaaaaaa, onto master.", "The queue paused: setup failed on master twice."]);
});

test("isThreadChat: the recorded chat of that project, and the one it replaced for an hour", async () => {
  const dir = scratchRoot("mq-thread-");
  const f = fakeSova(dir);
  const t = new MergeThread(f.deps);
  t.notify("/p", queued());
  await t.idle("/p");
  assert.equal(t.isThreadChat("/p", "s1"), true);
  assert.equal(t.isThreadChat("/other", "s1"), false);
  assert.equal(t.isThreadChat("/p", "s9"), false);
  assert.equal(t.isThreadChat("/p", ""), false);
  f.set("s1", { archived: true });
  t.notify("/p", queued("mq_2"));
  await t.idle("/p");
  assert.equal(t.isThreadChat("/p", "s2"), true);
  assert.equal(t.isThreadChat("/p", "s1"), true, "the replaced thread may finish its turn");
  f.tick(THREAD_GRACE_MS + 1);
  assert.equal(t.isThreadChat("/p", "s1"), false);
});

// ---- memory: one thread that lasts (UniiChat) ---------------------------------------------------

/** A fake Sova whose new chats run with memory on, as the live keeper's threadMemoryOn makes them. */
function memorySova(dir: string, over: Partial<ThreadDeps> = {}) {
  const f = fakeSova(dir, over);
  const create = f.deps.create;
  f.deps.create = async (root, text, title) => {
    const r = await create(root, text, title);
    return r.ok ? { ...r, memory: { type: "uniichat" } } : r;
  };
  return f;
}

test("a thread with memory never ages out: days later it is still woken; past half its context it is still replaced", async () => {
  const dir = scratchRoot("mq-thread-");
  const f = memorySova(dir);
  const t = new MergeThread(f.deps);
  t.notify("/proj", queued("mq_1"));
  await t.idle("/proj");
  assert.deepEqual(t.record("/proj")!.memory, { type: "uniichat" });
  f.tick(10 * THREAD_MAX_AGE_MS);
  t.notify("/proj", queued("mq_2"));
  await t.idle("/proj");
  assert.equal(f.created.length, 1, "ten days on, the same chat");
  assert.equal(f.woken.length, 1);
  assert.equal(replaceReason(t.record("/proj"), { id: "s1", path: "/p", createdAt: new Date(T0).toISOString() }, T0 + 30 * THREAD_MAX_AGE_MS), null);
  f.set("s1", { context: { tokens: 150_000, window: 200_000 } });
  t.notify("/proj", queued("mq_3"));
  await t.idle("/proj");
  assert.equal(f.created.length, 2, "the half-context safety net still holds");
  const h = t.history("/proj");
  assert.equal(h.length, 1);
  assert.equal(h[0]!.sessionId, "s1");
  assert.equal(h[0]!.why, "it is past half its context");
  assert.deepEqual(h[0]!.memory, { type: "uniichat" });
});

test("a refused wake is tried twice more, with the waits between, before the thread is replaced; a retry that takes keeps it", async () => {
  const dir = scratchRoot("mq-thread-");
  const waits: number[] = [];
  let refusals = 0;
  const f = memorySova(dir, { retryMs: [5_000, 20_000], sleep: async (ms) => void waits.push(ms) });
  const wake = f.deps.wake;
  f.deps.wake = async (p, x) => (refusals-- > 0 ? { ok: false, error: "It is running a turn" } : wake(p, x));
  const t = new MergeThread(f.deps);
  t.notify("/p", queued("mq_1"));
  await t.idle("/p");

  refusals = 2;
  t.notify("/p", queued("mq_2"));
  await t.idle("/p");
  assert.deepEqual(waits, [5_000, 20_000]);
  assert.equal(f.created.length, 1, "the third try took: same thread");
  assert.equal(f.woken.length, 1);

  refusals = 3;
  waits.length = 0;
  t.notify("/p", queued("mq_3"));
  await t.idle("/p");
  assert.deepEqual(waits, [5_000, 20_000]);
  assert.equal(f.created.length, 2, "three refusals: a fresh thread");
  assert.match(t.history("/p")[0]!.why, /^it refused messages \(It is running a turn\)$/);
});

test("the playbook changed since the thread read it: its next event starts with the reread line, once", async () => {
  const dir = scratchRoot("mq-thread-");
  const root = join(dir, "proj");
  const own = join(root, PROJECT_PLAYBOOK);
  mkdirSync(join(own, "references"), { recursive: true });
  writeFileSync(join(own, "PLAYBOOK.md"), "# Our merge playbook\n");
  writeFileSync(join(own, "references", "names.md"), "v1\n");
  const f = memorySova(dir);
  const t = new MergeThread(f.deps);
  t.notify(root, queued("mq_1"));
  await t.idle(root);
  t.notify(root, queued("mq_2"));
  await t.idle(root);
  assert.match(f.woken[0]!.text, /^Queued: entry mq_2/, "unchanged: no reread line");

  writeFileSync(join(own, "references", "names.md"), "v2\n");
  t.notify(root, queued("mq_3"));
  t.notify(root, queued("mq_4"));
  await t.idle(root);
  const [third, fourth] = [f.woken[1]!.text, f.woken[2]!.text];
  assert.ok(third.startsWith("The playbook changed since you read it: read "), third);
  assert.ok(third.includes(join(own, "PLAYBOOK.md")) && third.includes(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md")));
  assert.match(third, /\n\nQueued: entry mq_3/);
  assert.match(fourth, /^Queued: entry mq_4/, "said once, then the new hash is the one read");
  assert.equal(f.created.length, 1, "a playbook change never replaces the thread");
});

test("Start Fresh: the current thread goes to the history and is retired; the next event starts a new one; none twice", async () => {
  const dir = scratchRoot("mq-thread-");
  const retired: string[] = [];
  const f = memorySova(dir, { retire: async (p) => void retired.push(p) });
  const t = new MergeThread(f.deps);
  assert.equal(await t.startFresh("/p"), false, "no thread yet: nothing to do");
  t.notify("/p", queued("mq_1"));
  await t.idle("/p");
  f.tick(HOUR);
  assert.equal(await t.startFresh("/p"), true);
  assert.deepEqual(retired, ["/sessions/s1.jsonl"]);
  assert.equal(t.record("/p"), undefined, "no current thread until the next event");
  assert.equal(t.isThreadChat("/p", "s1"), false, "the old thread loses its verbs");
  assert.deepEqual(t.history("/p").map((h) => [h.sessionId, h.why, h.endedAt - h.startedAt]), [["s1", "you started a fresh one", HOUR]]);
  assert.equal(await t.startFresh("/p"), false);
  t.notify("/p", queued("mq_2"));
  await t.idle("/p");
  assert.equal(t.record("/p")!.sessionId, "s2");
  assert.equal(t.record("/p")!.previous, undefined, "a fresh start leaves no grace to the old one");
  assert.deepEqual(t.history("/p").map((h) => h.sessionId), ["s1"], "the history survives the new thread");
  assert.match(f.created[1]!.text, /You are the merge thread/);
});

// ---- off the critical path ---------------------------------------------------------------------

test("thread down: notify returns at once while the thread hangs or throws, and the next event still goes out", async () => {
  const dir = scratchRoot("mq-thread-");
  let hang = true;
  const f = fakeSova(dir);
  const create = f.deps.create;
  f.deps.create = (root, text, title) => (hang ? new Promise(() => {}) : create(root, text, title));
  f.deps.timeoutMs = 50;
  const t = new MergeThread(f.deps);
  const started = performance.now();
  t.notify("/p", queued("mq_1"));
  t.notify("/p", queued("mq_2"));
  assert.ok(performance.now() - started < 20, "notify never waits on the thread");
  await t.idle("/p");
  assert.equal(f.created.length, 0);
  assert.equal(f.logs.filter((l) => /starting the thread took longer/.test(l)).length, 2, "each hung start gives up on its own");
  assert.equal(t.record("/p"), undefined, "nothing recorded for a start that never answered");

  f.deps.create = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => t.notify("/p", queued("mq_3")));
  await t.idle("/p");
  assert.ok(f.logs.some((l) => l.includes("boom")));

  hang = false;
  f.deps.create = create;
  t.notify("/p", queued("mq_4"));
  await t.idle("/p");
  assert.equal(f.created.length, 1, "a thread back up takes the next event");
  assert.match(f.created[0]!.text, /mq_4/);
});

test("with no thread wired, the server's notify is a no-op and no chat is a thread; wired, hasMergeThread and threadOf say so", async () => {
  assert.equal(hasMergeThread(), false);
  assert.equal(threadOf("/p"), null);
  assert.doesNotThrow(() => mergeThread().notify("/p", queued()));
  assert.equal(mergeThread().isThreadChat("/p", "s1"), false);
  const t = new MergeThread(fakeSova(scratchRoot("mq-thread-")).deps);
  setMergeThread(t);
  try {
    assert.equal(hasMergeThread(), true);
    assert.equal(mergeThread(), t);
    assert.equal(threadOf("/p"), null);
    t.notify("/p", queued());
    await t.idle("/p");
    assert.deepEqual(threadOf("/p"), { session: "s1", startedAt: new Date(T0).toISOString() });
  } finally {
    setMergeThread(null);
  }
});

// ---- texts and playbook choice -----------------------------------------------------------------

test("the project's own playbook is read after the method; without one the method alone", () => {
  const dir = scratchRoot("mq-thread-pb-");
  assert.equal(playbookDir(dir), DEFAULT_PLAYBOOK_DIR);
  const own = join(dir, PROJECT_PLAYBOOK);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "PLAYBOOK.md"), "# x\n");
  assert.equal(playbookDir(dir), own);
  const withOwn = firstText(dir, own, queued());
  assert.ok(withOwn.includes(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md")) && withOwn.includes(join(own, "PLAYBOOK.md")));
  assert.match(withOwn, /wins where they differ/);
  const alone = firstText("/q", DEFAULT_PLAYBOOK_DIR, queued());
  assert.doesNotMatch(alone, /wins where they differ/);
  assert.ok(readFileSync(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md"), "utf8").includes("## What's worth noting"));
});

test("each event names the verbs it is answered with, all of them merge verbs the contract lists", async () => {
  const { MERGE_VERBS } = await import("../../shared/project-contract");
  const evs: ThreadEvent[] = [queued(), { kind: "conflict", entry: entry(), run: "mr_1", files: ["a.ts"] }, { kind: "failed", entry: entry(), run: "mr_1", summary: "unit" }, { kind: "paused", why: "x" }, { kind: "names", file: "/s/names.json", target: "main" }, { kind: "idle", entry: entry() }];
  for (const ev of evs) {
    const verbs = [...eventText(ev).matchAll(/\bmerge\.[a-z]+/g)].map((m) => m[0]);
    for (const v of verbs) assert.ok((MERGE_VERBS as readonly string[]).includes(v), `${ev.kind} names ${v}, not a merge verb`);
  }
  for (const f of ["PLAYBOOK.md", "references/picks.md", "references/notes.md", "references/conflicts.md", "references/failures.md", "references/names.md"]) {
    const text = readFileSync(join(DEFAULT_PLAYBOOK_DIR, f), "utf8");
    for (const m of text.matchAll(/`(merge\.[a-z]+)/g)) assert.ok((MERGE_VERBS as readonly string[]).includes(m[1]!), `${f} names ${m[1]}, not a merge verb`);
  }
});

test("conflict: the message names Sova's scratch copy to resolve in, or says none could be made and what to answer", () => {
  const withCopy = eventText({ kind: "conflict", entry: entry("mq_5"), run: "mr_1", files: ["a.ts"], scratch: "/p/.worktrees/proj-conflict-mq_5" });
  assert.match(withCopy, /Sova made a scratch copy for it at \/p\/\.worktrees\/proj-conflict-mq_5: a worktree with no branch, at master's head\. Resolve there, and never make a worktree of your own/);
  assert.match(withCopy, /your resolution commit from the scratch copy/);
  assert.doesNotMatch(withCopy, /side worktree/);
  const none = eventText({ kind: "conflict", entry: entry("mq_5"), run: "mr_1", files: ["a.ts"], scratchError: "git worktree add failed: disk full" });
  assert.match(none, /Sova couldn't make a scratch copy for it \(git worktree add failed: disk full\): judge it from the diff and answer with no commit: verdict "chat-fixes" when it needs no decision of the user's, else "needs-user"/);
});

test("idle: the queue is quiet; the newest landing and the target's head are named; the playbook decides, merge.hold is offered", () => {
  const text = eventText({ kind: "idle", entry: entry("mq_9"), lastLanded: { id: "mq_8", branch: "feat/x", sha: "c".repeat(40) }, head: "d".repeat(40) });
  assert.match(text, /^Idle: the queue has nothing left to check and nothing running \(the last change: entry mq_9 · /);
  assert.match(text, /The newest landing: entry mq_8 · feat\/x as ccccccc\. master is at ddddddd\./);
  assert.match(text, /"When the queue is idle"/);
  assert.match(text, /merge\.hold \{action: "set"\}/);
  assert.match(text, /Otherwise nothing is needed: end your turn\./);
  const bare = eventText({ kind: "idle", entry: entry("mq_9") });
  assert.doesNotMatch(bare, /newest landing|is at/);
});

test("queued: the diff and the picks read from the base the entry was queued against, so a landed branch still shows its changes", () => {
  const withBase = eventText({ kind: "queued", entry: entry("mq_9"), base: "b".repeat(40) });
  assert.match(withBase, /onto master \(at bbbbbbb\)\./);
  assert.ok(withBase.includes(`git diff ${"b".repeat(40)}...${"a".repeat(40)}`));
  assert.ok(withBase.includes(`blast-radius.mjs --base ${"b".repeat(40)} --tip ${"a".repeat(40)}`));
  const without = eventText(queued("mq_9"));
  assert.ok(without.includes(`git diff master...${"a".repeat(40)}`), "no base: the target's name");
});

test("names: the thread is told the project's names file and target, and to ask through merge.ask, never waiting in its chat", async () => {
  const text = eventText({ kind: "names", file: "/state/merge-queue/p1/names.json", target: "main" });
  assert.match(text, /every push of main is held\. Landings go on\./);
  assert.ok(text.includes(`${join(DEFAULT_PLAYBOOK_DIR, "scripts", "discover-names.mjs")} --file /state/merge-queue/p1/names.json --target main`));
  assert.match(text, /merge\.ask \{text, entry\?\}/);
  assert.match(text, /Never wait for them in your chat/);
  assert.doesNotMatch(text, /here, in your chat/);
  const first = firstText("/p", DEFAULT_PLAYBOOK_DIR, { kind: "names", file: "/f", target: "main" });
  assert.match(first, /You never move main,/);
  const dir = scratchRoot("mq-thread-");
  const f = fakeSova(dir);
  const t = new MergeThread(f.deps);
  t.notify("/p", { kind: "names", file: "/f", target: "main" });
  await t.idle("/p");
  assert.equal(f.created.length, 1, "a names event starts the thread like any other");
  const names = readFileSync(join(DEFAULT_PLAYBOOK_DIR, "references", "names.md"), "utf8");
  assert.ok(names.includes("You never wait for the user in your own chat: every question goes through `merge.ask"));
  assert.ok(!names.includes("in your chat:"), "no step of the interview runs in the thread's own chat");
  const method = readFileSync(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md"), "utf8");
  assert.ok(method.includes("| `merge.ask {text, entry?}` |") && method.includes("## On your own"));
});

// ---- a stand-in model following the playbook ---------------------------------------------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(dir: string): string {
  const r = join(dir, "proj");
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q", "-b", "master");
  git(r, "config", "user.email", "t@example.com");
  git(r, "config", "user.name", "t");
  git(r, "config", "merge.conflictStyle", "diff3");
  return r;
}
function commitFile(r: string, file: string, text: string, msg: string): string {
  mkdirSync(join(r, file, ".."), { recursive: true });
  writeFileSync(join(r, file), text);
  git(r, "add", file);
  git(r, "commit", "-q", "-m", msg);
  return git(r, "rev-parse", "HEAD");
}

type VerbCall = { verb: string; args: Record<string, unknown> };

/**
 * A stand-in for the model: reads the event out of the message the way the playbook says and answers
 * through the (fake) merge verbs. Queued → the blast-radius script's rule (in process; the CLI itself
 * is driven in thread.integration.test.ts), then merge.extend per pick and merge.note.
 * Conflict → a side worktree, the conflict-hunks script's parser, a judgement (only additions on both sides: no
 * behaviour change), then merge.resolve.
 */
function standInModel(root: string, map: string, calls: VerbCall[]) {
  return async (text: string) => {
    const q = /Queued: entry (\S+) · (\S+) at \w+, onto (\S+)\./.exec(text);
    if (q) {
      const [, id, branch, target] = q;
      const paths = git(root, "diff", "--name-only", `${target}...${branch}`).split("\n").filter(Boolean);
      const out = blastRadius(paths, JSON.parse(readFileSync(map, "utf8"))) as { picks: { id: string; why: string; select?: string[] }[] };
      for (const p of out.picks) calls.push({ verb: "merge.extend", args: { entry: id, checks: [p.id], why: p.why, ...(p.select ? { select: p.select } : {}) } });
      calls.push({ verb: "merge.note", args: { entry: id, note: "" } });
      return;
    }
    const c = /Conflict: entry (\S+) · (\S+) at (\w+) conflicts with (\S+) in/.exec(text);
    if (c) {
      const [, id, branch, , target] = c;
      // The copy Sova names in the message, as the playbook says; a message without one: none to work in.
      const named = /Sova made a scratch copy for it at (\S+): /.exec(text)?.[1];
      const side = named ?? join(root, "..", `resolve-${id}`);
      if (!named) git(root, "worktree", "add", "-q", "--detach", side, target!);
      try {
        git(side, "merge", "--no-ff", "--no-commit", branch!);
      } catch {
        /* stops on the conflict, as the playbook expects */
      }
      const unmerged = git(side, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
      const hunks = { files: unmerged.map((file) => ({ file, hunks: hunksOf(readFileSync(join(side, file), "utf8")) as { base: string[] | null; ours: string[]; theirs: string[] }[] })), other: [] as string[] };
      const files = hunks.files.map((f) => f.file);
      // Only additions: each side keeps every base line → both survive unchanged.
      const additive = !hunks.other.length && hunks.files.every((f) => f.hunks.every((h) => h.base !== null && h.base.every((l) => h.ours.includes(l) && h.theirs.includes(l))));
      if (!additive) {
        calls.push({ verb: "merge.resolve", args: { entry: id, verdict: "behaviour-differs", files, ours: "the target changed the line", theirs: "the branch changed it differently", proposal: "keep the target's value" } });
        return;
      }
      for (const f of hunks.files) {
        const lines = readFileSync(join(side, f.file), "utf8").split("\n");
        const out: string[] = [];
        let part: "o" | "b" | "t" | null = null;
        for (const l of lines) {
          if (l.startsWith("<<<<<<<")) part = "o";
          else if (l.startsWith("|||||||")) part = "b";
          else if (l === "=======") part = "t";
          else if (l.startsWith(">>>>>>>")) part = null;
          else if (part === "b") continue;
          else if (part === "t" && out.includes(l)) continue;
          else out.push(l);
        }
        writeFileSync(join(side, f.file), out.join("\n"));
        git(side, "add", f.file);
      }
      git(side, "commit", "-q", "--no-edit");
      calls.push({ verb: "merge.resolve", args: { entry: id, verdict: "no-behaviour-change", files, ours: "the target added an item", theirs: "the branch added another", proposal: "both sides added items; kept both", commit: git(side, "rev-parse", "HEAD") } });
    }
  };
}

function wiredThread(dir: string, model: (text: string) => Promise<void>) {
  const f = fakeSova(dir);
  const pending: Promise<void>[] = [];
  const create = f.deps.create;
  f.deps.create = async (root, text, title) => {
    const r = await create(root, text, title);
    pending.push(model(text));
    return r;
  };
  f.deps.wake = async (_p, text) => {
    pending.push(model(text));
    return { ok: true };
  };
  return { t: new MergeThread(f.deps), f, settle: () => Promise.all(pending) };
}

test("blast radius: a branch touching statecharts gets the statecharts check picked, with its reason; one touching only docs gets none", async () => {
  const dir = scratchRoot("mq-thread-pick-");
  const r = repo(dir);
  commitFile(r, "README.md", "x\n", "base");
  git(r, "checkout", "-q", "-b", "feat/charts");
  commitFile(r, "statecharts/src/org.cljs", "(ns org)\n", "chart");
  commitFile(r, "docs/a.md", "a\n", "doc");
  git(r, "checkout", "-q", "-b", "feat/docs", "master");
  commitFile(r, "docs/b.md", "b\n", "doc");
  git(r, "checkout", "-q", "master");
  const calls: VerbCall[] = [];
  const map = join(REPO, ".sova", "playbooks", "merge-queue", "references", "blast-radius.json");
  const { t, settle } = wiredThread(dir, standInModel(r, map, calls));
  t.notify(r, { kind: "queued", entry: entry("mq_charts", { branch: "feat/charts", commit: git(r, "rev-parse", "feat/charts") }) });
  t.notify(r, { kind: "queued", entry: entry("mq_docs", { branch: "feat/docs", commit: git(r, "rev-parse", "feat/docs") }) });
  await t.idle(r);
  await settle();
  const extend = calls.filter((c) => c.verb === "merge.extend");
  assert.equal(extend.length, 1, JSON.stringify(calls));
  assert.equal(extend[0]!.args.entry, "mq_charts");
  assert.deepEqual(extend[0]!.args.checks, ["statecharts"]);
  assert.match(String(extend[0]!.args.why), /statecharts changed.*statecharts\/src\/org\.cljs/);
  assert.deepEqual(calls.filter((c) => c.verb === "merge.note").map((c) => c.args.entry), ["mq_charts", "mq_docs"]);
});

test("conflicts: both sides adding items is resolved as no behaviour change with a side commit on the target and the pinned commit; one value changed two ways waits for the user", async () => {
  const dir = scratchRoot("mq-thread-conflict-");
  const r = repo(dir);
  commitFile(r, "list.txt", "alpha\nomega\n", "base");
  git(r, "checkout", "-q", "-b", "feat/add");
  const pinned = commitFile(r, "list.txt", "alpha\nbeta\nomega\n", "add beta");
  git(r, "checkout", "-q", "-b", "feat/change", "master");
  commitFile(r, "list.txt", "ALPHA-BRANCH\nomega\n", "change alpha");
  git(r, "checkout", "-q", "master");
  const targetHead = commitFile(r, "list.txt", "alpha\ngamma\nomega\n", "add gamma");
  const calls: VerbCall[] = [];
  const { t, settle } = wiredThread(dir, standInModel(r, "/nonexistent", calls));
  const scratch = await makeScratchCopy(realGit, { root: r, entry: "mq_add", base: targetHead });
  t.notify(r, { kind: "conflict", entry: entry("mq_add", { branch: "feat/add", commit: pinned }), run: "mr_1", files: ["list.txt"], scratch });
  await t.idle(r);
  await settle();
  const ok = calls.find((c) => c.args.entry === "mq_add")!;
  assert.equal(ok.verb, "merge.resolve");
  assert.equal(ok.args.verdict, "no-behaviour-change");
  const commit = String(ok.args.commit);
  assert.deepEqual(git(r, "rev-list", "--parents", "-n1", commit).split(" ").slice(1), [targetHead, pinned], "parents: the target first, the pinned commit second (what conflicts.ts checks)");
  assert.equal(git(r, "show", `${commit}:list.txt`), "alpha\ngamma\nbeta\nomega");
  assert.equal(ok.args.note, undefined, "no separate note: Sova notes the resolution from its proposal");
  assert.equal(git(r, "rev-parse", "master"), targetHead, "the target never moves");

  git(r, "checkout", "-q", "-b", "tmp", "master");
  const masterChange = commitFile(r, "list.txt", "ALPHA-MASTER\ngamma\nomega\n", "change alpha on master");
  git(r, "checkout", "-q", "master");
  git(r, "merge", "-q", "--ff-only", masterChange);
  t.notify(r, { kind: "conflict", entry: entry("mq_change", { branch: "feat/change", commit: git(r, "rev-parse", "feat/change") }), run: "mr_2", files: ["list.txt"] });
  await t.idle(r);
  await settle();
  assert.equal(git(scratch, "rev-parse", "HEAD"), commit, "the resolution was made in Sova's scratch copy");
  const differs = calls.find((c) => c.args.entry === "mq_change")!;
  assert.equal(differs.verb, "merge.resolve");
  assert.equal(differs.args.verdict, "behaviour-differs");
  assert.equal(differs.args.commit, undefined);
});

// ---- picks carry their select; the method is reread at every event ----------------------------------

test("queued: the pick's call shape carries select, as the method's picks page says", () => {
  const text = eventText(queued("mq_9"));
  assert.ok(text.includes('merge.extend {entry: "mq_9", checks: [id], why, select}'), text);
  assert.match(text, /select is part of the pick/);
  const picks = readFileSync(join(DEFAULT_PLAYBOOK_DIR, "references", "picks.md"), "utf8");
  assert.ok(picks.includes("`merge.extend {entry, checks: [id], why, select}`"));
  assert.ok(readFileSync(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md"), "utf8").includes("`merge.extend {entry, checks: [id], why, select}`"));
});

test("every event tells the thread to read its moment's Read as you go row now, never from memory, and the method has a row for each", async () => {
  const { READ_AS_YOU_GO } = await import("./thread");
  const evs: ThreadEvent[] = [
    queued(),
    { kind: "conflict", entry: entry(), run: "mr_1", files: ["a.ts"] },
    { kind: "failed", entry: entry(), run: "mr_1" },
    { kind: "paused", why: "x" },
    { kind: "idle", entry: entry() },
    { kind: "names", file: "/s/names.json", target: "main" },
    { kind: "answer", ask: { id: "ak_1", question: "q?" }, text: "yes", from: "the user" },
    { kind: "unattributed", entry: entry(), run: "mr_1", summary: "unit failed on both" },
    { kind: "review", entry: entry(), run: "mr_1", findings: "dead code in a.ts" },
    { kind: "resolution-failed", entry: entry(), run: "mr_1", files: ["a.ts"] },
    { kind: "drafts-changed", entry: entry(), names: ["d"] },
    { kind: "fix", entry: entry(), request: "rq_1", asked: "fix the unit test", commit: "b".repeat(40) },
    { kind: "chat-answer", entry: entry(), request: "rq_1", answer: "cant", text: "no way" },
  ];
  assert.deepEqual(evs.map((e) => e.kind).sort(), Object.keys(READ_AS_YOU_GO).sort(), "every event kind the thread is sent has a moment");
  const method = readFileSync(join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md"), "utf8");
  const table = method.slice(method.indexOf("## Read as you go"), method.indexOf("## Each event"));
  assert.ok(table.length > 20, "the method has its Read as you go section");
  for (const ev of evs) {
    const text = eventText(ev);
    const moment = READ_AS_YOU_GO[ev.kind];
    assert.ok(text.endsWith(`read your playbook's "Read as you go" row for ${moment} and the pages it names, now, never from memory (the project's own playbook wins where its list differs).`), `${ev.kind}: ${text}`);
    assert.ok(table.includes(`| **${moment}** |`), `the method's table has a ${moment} row`);
  }
  // Memory is for history only; the project's own table may override the rows.
  assert.match(method, /use it for history only/);
  assert.match(method, /never from memory/);
  assert.match(table, /A project's own playbook may give its own "Read as you go" table: its row wins where it differs/);
});

test("the rulings: each moment names merge.rule's rulings, and what is the user's goes with every one that may raise it", () => {
  const failed = eventText({ kind: "failed", entry: entry("mq_9"), run: "mr_9", summary: "unit failed" });
  assert.match(failed, /merge\.rule \{entry: "mq_9", ruling: "chat-fixes", text: <your diagnosis/);
  assert.match(failed, /ruling: "needs-user"/);
  assert.match(failed, /The user's: anything a person sees or does differently/);
  assert.match(failed, /Not the user's: regenerated files, recorded test outputs, lockfiles/);
  const conflict = eventText({ kind: "conflict", entry: entry("mq_9"), run: "mr_9", files: ["a.ts"], scratch: "/p/s" });
  assert.match(conflict, /verdict "chat-fixes"/);
  assert.match(conflict, /verdict "needs-user" with your question in text and its choices/);
  assert.doesNotMatch(conflict, /behaviour-differs/, "the old word isn't taught");
  const un = eventText({ kind: "unattributed", entry: entry("mq_9"), run: "mr_9" });
  assert.match(un, /nothing went to the branch's chat/);
  assert.match(un, /ruling: "try-again".*counts no try/);
  const review = eventText({ kind: "review", entry: entry("mq_9"), run: "mr_9", findings: "dead code in a.ts" });
  assert.match(review, /went back to the branch's chat by themselves:\ndead code in a\.ts/);
  const rf = eventText({ kind: "resolution-failed", entry: entry("mq_9"), run: "mr_9", files: ["a.ts"], scratch: "/p/s2" });
  assert.match(rf, /The branch isn't blamed and nothing went to its chat/);
  assert.match(rf, /fresh scratch copy at \/p\/s2/);
  const fix = eventText({ kind: "fix", entry: entry("mq_9"), request: "rq_7", asked: "fix the unit test", commit: "c".repeat(40) });
  assert.match(fix, /request: "rq_7", ruling: "checked"/);
  assert.match(fix, /ruling: "beyond", text: <what more it changes>/);
  assert.match(fix, /What was asked: fix the unit test/);
  const cant = eventText({ kind: "chat-answer", entry: entry("mq_9"), request: "rq_7", answer: "cant", text: "no way" });
  assert.match(cant, /You may try one other approach: merge\.rule \{entry: "mq_9", ruling: "try-again"/);
  const cant2 = eventText({ kind: "chat-answer", entry: entry("mq_9"), request: "rq_7", answer: "cant", text: "no way", otherTried: true });
  assert.match(cant2, /You already tried another approach for it: raise it to the user/);
  const needs = eventText({ kind: "chat-answer", entry: entry("mq_9"), request: "rq_7", answer: "needs-you", text: "which wording?" });
  assert.match(needs, /you can't overrule it/);
});

test("the fix check asks whether the fix decides something that is the user's, and says to rule needs-user then", () => {
  const fix = eventText({ kind: "fix", entry: entry("mq_9"), request: "rq_7", asked: "make the save test pass", commit: "c".repeat(40) });
  assert.match(fix, /does it decide nothing that is the user's\?/);
  assert.match(fix, /e\.g\. it picked "Store" where the branch said "Save changes"\): merge\.rule \{entry: "mq_9", ruling: "needs-user"/);
  assert.match(fix, /never "checked", even when it was the only way to make it pass/);
  assert.match(fix, /The user's: anything a person sees or does differently/);
  const page = readFileSync(join(DEFAULT_PLAYBOOK_DIR, "references", "fixes.md"), "utf8");
  assert.match(page, /Does it decide something that is the user's\?/);
  assert.match(page, /ruling: "needs-user", text, choices/);
});
