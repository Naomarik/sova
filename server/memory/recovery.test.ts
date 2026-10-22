// Memory that gets stuck recovers on its own (§chat.memory/recovery, §chat.memory/summarizer, §chat.memory/tree):
// a fake summarizer, a fake clock and fake timers; no model call, no process. Files only under a temp dir.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry } from "../../shared/harness";
import { DecisionError } from "../decide";
import { CVIEW_HARD, CVIEW_MAX, FAILURE_STREAK, MemoryEngine, NODE_RETRY_MS, PAUSE_FIRST_MS, PAUSE_MAX_MS, type EngineDeps, type EngineTimer } from "./engine";
import { messagesOf } from "./log";
import { COMPACTION_GUIDE } from "./prompts";
import { MemoryStore, type MemoryFileState, type MemoryRetryState } from "./store";
import type { SummaryCall } from "./summarizer";
import { bytes, lineOf, viewBytes, type NodeRef, type TreeNode } from "./tree";

const root = mkdtempSync(join(tmpdir(), "sova-memory-recovery-"));
after(() => {
  chmodTree(root, true);
  rmSync(root, { recursive: true, force: true });
});
let n = 0;

const at = "2026-10-22T12:00:00.000Z";
const user = (text: string, eid: string): HEntry => ({ id: eid, parentId: null, at, kind: "user", blocks: [{ type: "text", text }] });
/** A message over 512 bytes: its leaf is a summarizer call. */
const long = (k: number) => `m${k} ${"word ".repeat(150)}`;
const chat = (count: number, tag = "e") => Array.from({ length: count }, (_, k) => user(long(k), `${tag}${k}`));

/** A clock and the timers the engine sets on it; `advance` fires those due. */
function fakeTime(start = Date.parse(at)) {
  let now = start;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number): EngineTimer {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { clear: () => void (t.live = false) };
    },
    pending: () => timers.filter((t) => t.live).length,
    set: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.live && x.at <= now)) {
        t.live = false;
        t.fn();
      }
    },
  };
}

const leafOf = (c: SummaryCall) => /compress message (\d+)/.exec(c.prompt)?.[1];
const isMerge = (c: SummaryCall) => /merge lines/.test(c.prompt);

function newDir(): string {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a sidecar: built nodes (leaves get their message's source), a state and retries. */
function seed(dir: string, branch: HEntry[], nodes: { l: number; i: number; text: string }[], state: Partial<MemoryFileState>, retry?: MemoryRetryState) {
  const log = messagesOf(branch);
  const store = new MemoryStore(dir);
  store.rewriteNodes(nodes.map((x): TreeNode => ({ ...x, size: bytes(x.text), ...(x.l === 0 ? { src: log[x.i]!.src } : {}) })));
  store.saveState({ v: 1, view: [], merging: false, cview: [], cmerging: false, ...state });
  if (retry) store.saveRetry(retry);
}

const leaves = (count: number, text: (k: number) => string) => Array.from({ length: count }, (_, k) => ({ l: 0, i: k, text: text(k) }));
const leafRefs = (count: number): NodeRef[] => Array.from({ length: count }, (_, k) => [0, k] as const);

/** Every merge whose two halves are built is built too. */
function allMergesBuilt(e: MemoryEngine, messages: number): boolean {
  for (let l = 0; 2 ** l < messages; l++)
    for (let i = 0; (i + 2) * 2 ** l <= messages; i += 2) if (e.get(l, i) && e.get(l, i + 1) && !e.get(l + 1, i / 2)) return false;
  return true;
}

const stateOf = (dir: string): MemoryFileState => new MemoryStore(dir).loadState();
const retryOf = (dir: string): MemoryRetryState => new MemoryStore(dir).loadRetry();
const cviewBytes = (e: MemoryEngine, dir: string) => viewBytes(e, stateOf(dir).cview);

function chmodTree(dir: string, writable: boolean) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) chmodTree(p, writable);
    else chmodSync(p, writable ? 0o600 : 0o400);
  }
  chmodSync(dir, writable ? 0o700 : 0o500);
}

describe("the summarizer's reading stays small (§chat.memory/summarizer)", () => {
  test("a 600-message backlog with a summarizer that fails over 128 KB: every leaf and merge built, the compaction view under its size", async () => {
    const dir = newDir();
    let biggest = 0;
    const deps: EngineDeps = {
      summarize: async (c) => {
        biggest = Math.max(biggest, bytes(c.system));
        if (bytes(c.system) > 128_000) throw new Error("spawn E2BIG");
        const leaf = leafOf(c);
        return { text: leaf ? `summary of message ${leaf}. ${"s".repeat(440)}` : `merged. ${"t".repeat(300)}`, model: "fake" };
      },
    };
    const e = new MemoryEngine("big", new MemoryStore(dir), deps);
    const branch = chat(600);
    e.sync(branch);
    await e.idle();
    for (let k = 0; k < 600; k++) assert.ok(e.get(0, k) && !e.get(0, k)!.excerpt, `leaf ${k} summarized`);
    assert.ok(allMergesBuilt(e, 600), "every ready merge built");
    assert.ok(cviewBytes(e, dir) <= CVIEW_MAX, `compaction view ${cviewBytes(e, dir)} B`);
    assert.ok(biggest <= CVIEW_HARD + bytes(COMPACTION_GUIDE) + 200, `system prompt at most ${biggest} B`);
    assert.equal(e.status().problem, undefined);
  });

  test("past the cap the oldest lines are left out in fixed steps: 8 leaf summaries share ≤ 2 system prompts and save ≤ 2 prefixes", async () => {
    const dir = newDir();
    const branch = chat(158);
    // 150 built leaves of ~700 B in the compaction view (~106 KB), their merges all waiting out a retry.
    const text = (k: number) => `line ${k}. ${"x".repeat(680)}`;
    const merges = Array.from({ length: 75 }, (_, k) => ({ l: 1, i: k, attempts: 1, retryAt: Date.parse(at) + 3_600_000 }));
    seed(dir, branch, leaves(150, text), { cview: leafRefs(150) }, { v: 1, nodes: merges });
    const systems: string[] = [];
    const prefixes: string[] = [];
    class Counting extends MemoryStore {
      override saveState(s: MemoryFileState) {
        const p = JSON.stringify(s.cprefix ?? null);
        if (prefixes.at(-1) !== p) prefixes.push(p);
        super.saveState(s);
      }
    }
    const time = fakeTime();
    const e = new MemoryEngine("cap", new Counting(dir), {
      summarize: async (c) => {
        assert.ok(!isMerge(c), "merges wait out their retry");
        systems.push(c.system);
        return { text: `summary of message ${leafOf(c)}.`, model: "fake" };
      },
      concurrency: 1,
      now: time.now,
      setTimer: time.setTimer,
    });
    e.sync(branch);
    await e.idle();
    assert.equal(systems.length, 8, "8 leaf summaries");
    assert.ok(new Set(systems).size <= 2, `${new Set(systems).size} distinct system prompts`);
    assert.ok(prefixes.filter((p) => p !== "null").length <= 2, `${prefixes.length} saved prefixes`);
    for (const s of systems) assert.ok(bytes(s) <= CVIEW_HARD + bytes(COMPACTION_GUIDE) + 200, `system ${bytes(s)} B`);
    assert.match(systems[0]!, /\(messages 0 to \d+ are left out of this reading\)/);
    assert.ok(bytes(JSON.stringify(stateOf(dir).cprefix)) <= CVIEW_HARD + 2000, "the saved prefix is under the cap");
    e.dispose();
  });
});

describe("repair on load (§chat.memory/recovery)", () => {
  test("a stuck chat: a 150 KB saved prefix, 567 leaves in the compaction view, no merges; it catches up and preparing ends", async () => {
    const dir = newDir();
    const branch = chat(620);
    const text = (k: number) => `line ${k}. ${"y".repeat(250)}`;
    seed(dir, branch, leaves(567, text), { cview: leafRefs(567) });
    const store = new MemoryStore(dir);
    const probe = new MemoryEngine("probe", store, { summarize: async () => ({ text: "", model: "" }), concurrency: 0 });
    const cprefix = leafRefs(567).map((r) => lineOf(probe, r));
    store.saveState({ ...store.loadState(), cprefix });
    assert.ok(bytes(cprefix.join("\n")) > 150_000);
    let biggest = 0;
    const statuses: string[] = [];
    const e = new MemoryEngine("stuck", new MemoryStore(dir), {
      summarize: async (c) => {
        biggest = Math.max(biggest, bytes(c.system));
        if (bytes(c.system) > 128_000) throw new Error("spawn E2BIG");
        return { text: leafOf(c) ? `summary of message ${leafOf(c)}. ${"s".repeat(200)}` : `merged. ${"t".repeat(200)}`, model: "fake" };
      },
      onStatus: (s) => statuses.push(s.state),
    });
    e.sync(branch);
    assert.equal(statuses[0], "preparing", "53 unbuilt leaves and no view: preparing");
    const reloaded = stateOf(dir).cprefix;
    assert.ok(!reloaded || bytes(reloaded.join("\n")) <= CVIEW_HARD, "the oversized saved prefix is thrown away at load");
    await e.idle();
    for (let k = 0; k < 620; k++) assert.ok(e.get(0, k), `leaf ${k}`);
    assert.notEqual(e.status().state, "preparing");
    assert.ok(cviewBytes(e, dir) <= CVIEW_MAX);
    assert.ok(biggest <= CVIEW_HARD + bytes(COMPACTION_GUIDE) + 200);
    const saved = stateOf(dir).cprefix;
    assert.ok(!saved || bytes(saved.join("\n")) <= CVIEW_HARD);
  });

  test("a whole tree with an oversized compaction view merges it down at load, with no new message and no call", () => {
    const dir = newDir();
    const branch = chat(256);
    const nodes: { l: number; i: number; text: string }[] = [];
    for (let l = 0; 2 ** l <= 256; l++) for (let i = 0; (i + 1) * 2 ** l <= 256; i++) nodes.push({ l, i, text: `node ${l}:${i}. ${"z".repeat(240)}` });
    seed(dir, branch, nodes, { cview: leafRefs(256) });
    let calls = 0;
    const e = new MemoryEngine("full", new MemoryStore(dir), { summarize: async () => (calls++, { text: "x", model: "f" }) });
    assert.ok(viewBytes(e, stateOf(dir).cview) > CVIEW_MAX, "starts over its size");
    e.sync(branch);
    assert.ok(cviewBytes(e, dir) <= CVIEW_MAX, `merged down at load: ${cviewBytes(e, dir)} B`);
    assert.equal(calls, 0);
    e.dispose();
  });

  test("the cold outline's engine (concurrency 0) writes nothing and sets no timer; a held one repairs the same files", () => {
    const dir = newDir();
    const branch = chat(256);
    const nodes: { l: number; i: number; text: string }[] = [];
    for (let l = 0; 2 ** l <= 256; l++) for (let i = 0; (i + 1) * 2 ** l <= 256; i++) nodes.push({ l, i, text: `node ${l}:${i}. ${"z".repeat(240)}` });
    const big = Array.from({ length: 400 }, (_, k) => `${k}+1|${"q".repeat(300)}`);
    const later = Date.parse(at) + 600_000;
    seed(dir, chat(257), nodes, { cview: leafRefs(256), cprefix: big }, { v: 1, nodes: [{ l: 0, i: 256, attempts: 1, retryAt: later, src: messagesOf(chat(257))[256]!.src }], pause: { until: later, step: PAUSE_FIRST_MS, problem: "The memory summarizer's login failed: check Settings → Accounts." } });
    const before = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    chmodTree(dir, false);
    const time = fakeTime();
    try {
      // Exactly what routes.ts's coldOutline builds.
      const cold = new MemoryEngine("cold", new MemoryStore(dir), { summarize: async () => { throw new Error("not held"); }, concurrency: 0, now: time.now, setTimer: time.setTimer });
      cold.sync(chat(257));
      cold.currentView();
      cold.sync([...chat(200), user("other", "o200")]); // a rewind: dropped in memory only
      assert.equal(cold.get(0, 200), undefined);
      cold.sync(chat(257));
      assert.match(cold.status().problem ?? "", /login failed.*Retrying at/);
      assert.equal(time.set(), 0, "no timer");
    } finally {
      chmodTree(dir, true);
    }
    const now = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    assert.deepEqual(now, before, "no file written");
    // The same files under a held engine: repaired, and its timer set (the check above can tell the two apart).
    const held = new MemoryEngine("held", new MemoryStore(dir), { summarize: async () => new Promise(() => {}), now: time.now, setTimer: time.setTimer });
    held.sync(chat(257));
    assert.equal(stateOf(dir).cprefix, undefined);
    assert.ok(cviewBytes(held, dir) <= CVIEW_MAX);
    assert.ok(time.pending() > 0);
    held.dispose();
  });
});

describe("failures (§chat.memory/recovery)", () => {
  test("one message that always fails: others carry on; tried after 5 min and 2 h across restarts, then an excerpt", async () => {
    const dir = newDir();
    const time = fakeTime();
    const tries: number[] = [];
    const deps: EngineDeps = {
      summarize: async (c) => {
        const leaf = leafOf(c);
        if (leaf === "2") {
          tries.push(time.now());
          throw new Error("the summarizer returned an empty line");
        }
        return { text: `summary ${leaf ?? "merge"}.`, model: "f" };
      },
      now: time.now,
      setTimer: time.setTimer,
    };
    const branch = chat(6);
    let e = new MemoryEngine("one", new MemoryStore(dir), deps);
    e.sync(branch);
    await e.idle();
    for (const k of [0, 1, 3, 4, 5]) assert.ok(e.get(0, k), `leaf ${k} built`);
    assert.ok(e.get(1, 0) && e.get(1, 2), "merges not touching it are built");
    assert.equal(e.get(0, 2), undefined);
    assert.equal(e.status().problem, undefined, "one node's failure sets no problem");
    assert.deepEqual(retryOf(dir).nodes, [{ l: 0, i: 2, attempts: 1, retryAt: Date.parse(at) + NODE_RETRY_MS[0]!, src: messagesOf(branch)[2]!.src }]);

    // The chat's process restarts: the try is remembered, nothing runs before its time.
    e.dispose();
    e = new MemoryEngine("one", new MemoryStore(dir), deps);
    e.sync(branch);
    await e.idle();
    assert.equal(tries.length, 1);
    time.advance(NODE_RETRY_MS[0]!);
    await e.idle();
    assert.equal(tries.length, 2, "tried again by itself after 5 minutes");
    assert.equal(retryOf(dir).nodes[0]!.attempts, 2);

    e.dispose();
    e = new MemoryEngine("one", new MemoryStore(dir), deps);
    e.sync([...branch, user("short", "x6")]); // a new message doesn't reset or hurry it
    await e.idle();
    assert.equal(tries.length, 2);
    time.advance(NODE_RETRY_MS[1]! - 1);
    await e.idle();
    assert.equal(tries.length, 2);
    time.advance(1);
    await e.idle();
    assert.equal(tries.length, 3, "the third try, 2 hours after the second");
    const ex = e.get(0, 2)!;
    assert.ok(ex.excerpt, "after 3 failed tries its line is an excerpt");
    assert.match(ex.text, /^user: m2 word/);
    assert.ok(bytes(ex.text) <= 512);
    assert.match(readFileSync(join(dir, "tree.jsonl"), "utf8"), /"i":2,"text":"user: m2[^\n]*"excerpt":true/);
    assert.equal(existsSync(join(dir, "retry.json")), false);
    assert.ok(e.get(1, 1) && e.get(2, 0), "its merges follow");
    assert.equal(e.zoom(2, 1), `2|user: ${long(2)}`, "the whole message is one zoom away");
    e.dispose();
  });

  test("a failure that stops every summary pauses the queue, says when it retries, retries on its own and clears", async () => {
    const dir = newDir();
    const time = fakeTime();
    let down = true;
    let calls = 0;
    const e = new MemoryEngine("auth", new MemoryStore(dir), {
      summarize: async () => {
        calls++;
        if (down) throw new DecisionError("auth", "401");
        return { text: "s.", model: "f" };
      },
      now: time.now,
      setTimer: time.setTimer,
    });
    const branch = chat(5);
    e.sync(branch);
    await e.idle();
    const first = calls;
    assert.ok(first >= 1 && first <= 4);
    assert.match(e.status().problem ?? "", /^The memory summarizer's login failed: check Settings → Accounts\. Retrying at 12:05 PM\.$/);
    assert.deepEqual(retryOf(dir).pause, { until: Date.parse(at) + PAUSE_FIRST_MS, step: PAUSE_FIRST_MS, problem: "The memory summarizer's login failed: check Settings → Accounts." });
    assert.equal(retryOf(dir).nodes.length, 0, "no node's tries are spent");
    // Still down at the next try: the wait doubles.
    time.advance(PAUSE_FIRST_MS);
    await e.idle();
    assert.ok(calls > first);
    assert.match(e.status().problem ?? "", /Retrying at 12:15 PM\.$/);
    // Back up: the timer alone (no sync, no message) finishes the work and clears the problem.
    down = false;
    time.advance(2 * PAUSE_FIRST_MS);
    await e.idle();
    for (let k = 0; k < 5; k++) assert.ok(e.get(0, k));
    assert.equal(e.status().problem, undefined);
    assert.equal(existsSync(join(dir, "retry.json")), false);
    e.dispose();
  });

  test("a new message lifts the pause at once", async () => {
    const time = fakeTime();
    let down = true;
    const e = new MemoryEngine("lift", new MemoryStore(newDir()), {
      summarize: async () => {
        if (down) throw new DecisionError("quota", "out of credits");
        return { text: "s.", model: "f" };
      },
      now: time.now,
      setTimer: time.setTimer,
    });
    e.sync(chat(3));
    await e.idle();
    assert.match(e.status().problem ?? "", /usage limit/);
    down = false;
    e.sync([...chat(3), user("next", "n3")]);
    await e.idle();
    assert.ok(e.get(0, 0) && e.get(0, 2));
    assert.equal(e.status().problem, undefined);
    e.dispose();
  });

  test(`${FAILURE_STREAK} different nodes failing in a row: the summarizer counts as down and the queue pauses`, async () => {
    const time = fakeTime();
    let calls = 0;
    const e = new MemoryEngine("streak", new MemoryStore(newDir()), {
      summarize: async () => {
        calls++;
        throw new DecisionError("malformed-answer", "claude returned no line");
      },
      now: time.now,
      setTimer: time.setTimer,
    });
    e.sync(chat(12));
    await e.idle();
    assert.equal(calls, FAILURE_STREAK);
    assert.match(e.status().problem ?? "", /^Memory summaries are failing: claude returned no line\. Retrying at 12:05 PM\.$/);
    e.dispose();
  });

  for (const [failure, message] of [
    ["timeout", "claude did not start within 90000 ms (waiting for a Claude Code slot)"],
    ["timeout", "claude did not answer within 90000 ms"],
    ["network", "claude: spawn failed"],
    ["overloaded", "529 overloaded"],
  ] as const) {
    test(`a ${failure} failure ("${message}") never spends a message's tries: past 5 min + 2 h, no excerpt`, async () => {
      const dir = newDir();
      const time = fakeTime();
      let down = true;
      const e = new MemoryEngine(`transient-${failure}`, new MemoryStore(dir), {
        summarize: async () => {
          if (down) throw new DecisionError(failure, message);
          return { text: "s.", model: "f" };
        },
        now: time.now,
        setTimer: time.setTimer,
      });
      const branch = chat(6);
      e.sync(branch);
      await e.idle();
      assert.match(e.status().problem ?? "", /Retrying at/);
      // Well past every node retry: 5 min + 2 h, in the pause's own steps.
      for (let t = 0; t < 5 * 60_000 + 2 * 3_600_000 + 60_000; t += 60_000) {
        time.advance(60_000);
        await e.idle();
      }
      for (let k = 0; k < 6; k++) assert.ok(!e.get(0, k)?.excerpt, `leaf ${k} is no excerpt`);
      assert.deepEqual(retryOf(dir).nodes, [], "no node's tries counted");
      down = false;
      time.advance(PAUSE_MAX_MS);
      await e.idle();
      for (let k = 0; k < 6; k++) assert.ok(e.get(0, k) && !e.get(0, k)!.excerpt, `leaf ${k} summarized once it works`);
      assert.equal(e.status().problem, undefined);
      e.dispose();
    });
  }

  test("a rewind drops the tries of messages past it", async () => {
    const dir = newDir();
    const time = fakeTime();
    const e = new MemoryEngine("rewind", new MemoryStore(dir), {
      summarize: async (c) => {
        if (leafOf(c) === "3") throw new Error("garbled");
        return { text: "s.", model: "f" };
      },
      now: time.now,
      setTimer: time.setTimer,
    });
    e.sync(chat(5));
    await e.idle();
    assert.equal(retryOf(dir).nodes.length, 1);
    e.sync([...chat(3), user("other", "o3")]);
    await e.idle();
    assert.equal(existsSync(join(dir, "retry.json")), false);
    e.dispose();
  });
});
