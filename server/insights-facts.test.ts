// Run: pnpm test -- server/insights-facts.test.ts. sessionFacts folds only what a session file grew by, and
// must still give what a full read gives. The differential below is the guard: after every step of a
// scripted file history, sessionFacts deep-equals extractFacts over the file's whole text.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-insights-facts-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // before the modules below compute their paths
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { extractFacts, FACTS_LIMITS, sessionFacts } = await import("./insights");
after(() => rmSync(root, { recursive: true, force: true }));

let serial = 0;
const fresh = (): string => join(root, `s${++serial}.jsonl`);
const line = (e: unknown): string => `${JSON.stringify(e)}\n`;
const at = "2026-10-20T10:00:00.000Z";

const header = (id = "sess-1"): string => line({ type: "session", version: 3, id, timestamp: at, cwd: "/tmp/x" });
const user = (id: string, parentId: string | null, text = "hi"): string => line({ type: "message", id, parentId, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string | null, content: unknown[] = [{ type: "text", text: "ok" }]): string =>
  line({ type: "message", id, parentId, timestamp: at, message: { role: "assistant", content } });
const custom = (id: string, parentId: string | null, customType: string, data: unknown): string => line({ type: "custom", id, parentId, timestamp: at, customType, data });
const team = (id: string, parentId: string | null, teamId = "team_1"): string =>
  custom(id, parentId, "subagents-team-v1", {
    version: 1,
    op: "create",
    team: { id: teamId, name: teamId, objective: "o", createdAt: 1 },
    members: [{ workerId: "ag_01", role: "lead", backend: "pi", addedAt: 1 }],
  });
const outline = (id: string, parentId: string | null, now: string): string =>
  custom(id, parentId, "topic-outline", { version: 2, now, overall: "all", state: "fresh", generatedAt: 1, topics: [] });
const report = (id: string, parentId: string | null, worker: string): string =>
  line({ type: "custom_message", id, parentId, timestamp: at, customType: "subagent-complete", content: `### ${worker} (lead) — waiting · task success`, display: true });
const compaction = (id: string, parentId: string | null): string =>
  line({ type: "compaction", id, parentId, timestamp: at, summary: "s", tokensBefore: 10, details: { readFiles: ["a"], modifiedFiles: [] }, firstKeptEntryId: "u1" });
const rewind = (id: string, parentId: string | null): string => custom(id, parentId, "sova-rewind", { targetId: "u1", fromLeafId: "a1" });
const TREE = (path: string) => ({ path, branch: "b", base: "m", status: "active", session: "sess-1", how: "created", at: 1 });
const worktrees = (id: string, parentId: string | null, path: string): string =>
  custom(id, parentId, "worktrees", { version: 1, trees: [TREE(path)] });
const explain = (id: string, parentId: string | null): string =>
  custom(id, parentId, "explain-doc", { id: "x1", topic: "t", createdAt: at, parentSessionId: "sess-1", summary: "s" });
const teamEvent = (id: string, parentId: string | null): string =>
  custom(id, parentId, "subagents-team-event-v1", { version: 1, kind: "pause", teamId: "team_1", workerId: "ag_01", role: "lead", at: 1 });
const manifest = (id: string, parentId: string | null, worker: string, status: string): string =>
  custom(id, parentId, "subagents-worker-manifest", { kind: "worker-manifest", v: 1, workerId: worker, backend: "pi", status, at: 1000, endedAt: 2000 });
const skillRead = (id: string, parentId: string | null): string =>
  assistant(id, parentId, [{ type: "text", text: "x" }, { type: "toolCall", id: "c", name: "read", arguments: { path: "/s/alpha/SKILL.md" } }]);
const skillBash = (id: string, parentId: string | null): string =>
  assistant(id, parentId, [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "cat /s/beta/SKILL.md" } }]);
const skillInvoke = (id: string, parentId: string | null): string =>
  user(id, parentId, `<skill name="gamma" location="/s/gamma/SKILL.md">\nbody\n</skill>\n\nnow go`);
const offer = (id: string, parentId: string | null, name: string): string =>
  line({ type: "message", id, parentId, timestamp: at, message: { role: "system", sections: { skills: `<skill><name>${name}</name><location>/s/${name}/SKILL.md</location></skill>` } } });

/** A fresh full read: the whole text through parsePiBranch, no state kept. */
const full = (path: string) => extractFacts(readFileSync(path, "utf8"));

/** Runs on every step: the incremental answer equals a fresh full read of the file as it now stands. */
async function same(path: string, step: string): Promise<void> {
  assert.deepEqual(await sessionFacts(path), full(path), step);
}

const probe = await open(process.execPath, "r");
const handleClass = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
await probe.close();

/** Every real read through a file handle, seen at the handle class: an instrument the code under test can't
    bypass by counting wrong. `entered` counts reads begun; while `gate` is set each one waits on it. */
function countReads(): { bytes: number; entered: number; gate: Promise<void> | null; stop: () => void } {
  const original = handleClass.read;
  const reads = {
    bytes: 0,
    entered: 0,
    gate: null as Promise<void> | null,
    stop: () => void (handleClass.read = original),
  };
  handleClass.read = async function (this: FileHandle, ...args: unknown[]) {
    reads.entered++;
    if (reads.gate) await reads.gate;
    const r = await (original as (...a: unknown[]) => Promise<{ bytesRead: number }>).apply(this, args);
    reads.bytes += r.bytesRead;
    return r;
  } as FileHandle["read"];
  return reads;
}

const until = async (done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, "the condition never came");
    await new Promise((r) => setTimeout(r, 1));
  }
};

describe("sessionFacts, against a fresh full read after every step", () => {
  test("a whole file history: appends, torn lines, branches, rewrites, replacement, deletion", async () => {
    const path = fresh();
    // A file that does not exist yet.
    assert.deepEqual((await sessionFacts(path)).teams, []);

    writeFileSync(path, header());
    await same(path, "header only");

    // Every entry kind the facts read, one append at a time.
    let parent: string | null = null;
    const appendOne = async (make: (id: string, parentId: string | null) => string, id: string): Promise<void> => {
      appendFileSync(path, make(id, parent));
      parent = id;
      await same(path, `after ${id}`);
    };
    await appendOne((i, p) => user(i, p), "u1");
    await appendOne((i, p) => assistant(i, p), "a1");
    await appendOne((i, p) => team(i, p), "t1");
    await appendOne((i, p) => outline(i, p, "first"), "o1");
    await appendOne((i, p) => outline(i, p, "first"), "o1b"); // a repeat adds nothing to the series
    await appendOne((i, p) => report(i, p, "ag_01"), "r1");
    await appendOne((i, p) => compaction(i, p), "c1");
    await appendOne((i, p) => rewind(i, p), "w1");
    await appendOne((i, p) => worktrees(i, p, "/tmp/wt1"), "k1");
    await appendOne((i, p) => explain(i, p), "e1");
    await appendOne((i, p) => teamEvent(i, p), "v1");
    await appendOne((i, p) => manifest(i, p, "ag_01", "done"), "m1");
    await appendOne((i, p) => offer(i, p, "alpha"), "s1");
    await appendOne((i, p) => skillRead(i, p), "s2");
    await appendOne((i, p) => skillBash(i, p), "s3");
    await appendOne((i, p) => skillInvoke(i, p), "s4");
    await appendOne((i, p) => offer(i, p, "beta"), "s5");
    const rich = await sessionFacts(path);
    assert.equal(rich.teams.length, 1, "the script reached the team fold");
    assert.equal(rich.outlines.length, 1);
    assert.equal(rich.reports.size, 1);
    assert.equal(rich.compactions.length, 1);
    assert.equal(rich.rewinds.length, 1);
    assert.ok(rich.worktrees, "the script reached the worktrees fold");
    assert.equal(rich.explanations.length, 1);
    assert.equal(rich.teamEvents.length, 1);
    assert.equal(rich.workerRecords.active.length, 1);
    assert.equal(rich.settled.size, 1);
    assert.deepEqual(rich.skills.used.map((u) => u.how), ["read", "shell", "invoked"]);
    assert.equal(rich.skills.offered.length, 2);

    // A write caught mid-line, in pieces: nothing counted, nothing lost, nothing counted twice.
    const torn = outline("o2", parent, "second");
    appendFileSync(path, torn.slice(0, 20));
    await same(path, "first piece of a line");
    appendFileSync(path, torn.slice(20, 50));
    await same(path, "second piece of a line");
    appendFileSync(path, torn.slice(50));
    await same(path, "the line completed");
    assert.equal((await sessionFacts(path)).outline?.now, "second");
    parent = "o2";

    // A whole last line with its newline still to come: a full read counts it.
    const unended = team("t2", parent, "team_2");
    appendFileSync(path, unended.slice(0, -1));
    await same(path, "a complete line without its newline");
    assert.equal((await sessionFacts(path)).teams.length, 2);
    appendFileSync(path, "\n");
    await same(path, "its newline arrived");
    // ...and that same text can stop being a line at all.
    const before = statSync(path).size;
    appendFileSync(path, outline("o3", "t2", "third").slice(0, -1));
    await same(path, "an unended line");
    appendFileSync(path, ' trailing garbage\n');
    await same(path, "the unended line turned out malformed");
    assert.ok(statSync(path).size > before);
    parent = "t2";

    // A torn last line cut back again.
    appendFileSync(path, outline("o4", parent, "fourth").slice(0, -1));
    await same(path, "another unended line");
    truncateSync(path, statSync(path).size - 30);
    await same(path, "cut shorter, the folded lines intact");
    truncateSync(path, before);
    await same(path, "cut back to the last line end");

    // Blank and malformed lines.
    appendFileSync(path, "\n   \nnot json\n[1,2]\n");
    await same(path, "an array line makes the file linear");
    await appendOne((i, p) => outline(i, p, "after array"), "o5");

    // Multi-byte text across every read.
    appendFileSync(path, user("u9", parent, `é€😀${"x".repeat(70_000)}é`));
    await same(path, "a long multi-byte line, longer than one read chunk");
  });

  test("branching: a new leaf that leaves facts behind, and a move back to them", async () => {
    const path = fresh();
    writeFileSync(path, header() + user("u1", null) + team("t1", "u1") + outline("o1", "t1", "main") + manifest("m1", "o1", "ag_01", "done"));
    await same(path, "the main line");
    appendFileSync(path, user("u2", "u1") + outline("o2", "u2", "other"));
    await same(path, "a branch off u1: the team, the outline and the record leave the branch");
    let f = await sessionFacts(path);
    assert.deepEqual(f.teams, []);
    assert.equal(f.outline?.now, "other");
    assert.equal(f.workerRecords.all.length, 1, "a record off the branch stays in `all`");
    assert.equal(f.workerRecords.active.length, 0);
    appendFileSync(path, user("u3", "m1"));
    await same(path, "back onto the first line");
    f = await sessionFacts(path);
    assert.equal(f.teams.length, 1);
    assert.equal(f.workerRecords.active.length, 1);
    appendFileSync(path, user("u4", "gone"));
    await same(path, "a parent not in the file: the branch is the one entry");
    appendFileSync(path, user("u5", "u6") + user("u6", "u5"));
    await same(path, "a parent cycle stops the walk");
  });

  test("duplicate ids: the later entry wins the walk, and an earlier record keeps its id's standing", async () => {
    const path = fresh();
    writeFileSync(path, header() + manifest("x", null, "ag_01", "done") + user("x", null) + user("y", "x"));
    await same(path, "a worker record sharing an id with a user entry on the branch");
    assert.equal((await sessionFacts(path)).workerRecords.active.length, 1);
    appendFileSync(path, user("z", "y"));
    await same(path, "and after an append");
  });

  test("a legacy file without ids is one line of entries, from the first id-less entry on", async () => {
    const path = fresh();
    writeFileSync(path, header() + user("u1", null) + outline("o1", "u1", "kept") + user("u2", "u1") + outline("o2", "u2", "off"));
    await same(path, "ids everywhere");
    appendFileSync(path, line({ type: "custom", customType: "topic-outline", timestamp: at, data: { version: 2, now: "no id", overall: "x", state: "fresh", generatedAt: 1, topics: [] } }));
    await same(path, "an entry without an id flattens the whole file");
    appendFileSync(path, line({ type: "message", timestamp: at, message: { role: "user", content: "s" } }));
    await same(path, "and stays flat");
  });

  test("a file rewritten in place, shorter, same size, or longer", async () => {
    const path = fresh();
    writeFileSync(path, header() + user("u1", null) + outline("o1", "u1", "aaaa") + team("t1", "o1"));
    await same(path, "start");
    const shorter = header() + user("u1", null);
    writeFileSync(path, shorter);
    await same(path, "rewritten shorter");
    writeFileSync(path, shorter + outline("o1", "u1", "aaaa"));
    await same(path, "grown");
    // Same bytes, one letter changed: same size, same line ends, same inode.
    const size = statSync(path).size;
    writeFileSync(path, shorter + outline("o1", "u1", "bbbb"));
    assert.equal(statSync(path).size, size);
    await same(path, "rewritten at the same size");
    assert.equal((await sessionFacts(path)).outline?.now, "bbbb");
    // Longer, with a line end exactly where the folded prefix ended, and different bytes before it.
    writeFileSync(path, shorter + outline("o1", "u1", "cccc") + outline("o2", "o1", "dddd"));
    await same(path, "rewritten longer, a line end at the old offset");
    assert.equal((await sessionFacts(path)).outlines[0]?.now, "cccc");
    // The first line changed, the last 4 KB as they were: the head's window sees it.
    const filler = Array.from({ length: 60 }, (_, i) => user(`f${i}`, i ? `f${i - 1}` : null, "y".repeat(100))).join("");
    writeFileSync(path, header("sess-A") + filler);
    await same(path, "a long file");
    writeFileSync(path, header("sess-B") + filler + user("n", "f59"));
    await same(path, "the header rewritten in place, the rest as it was, and longer");
    assert.equal((await sessionFacts(path)).sessionId, "sess-B");
    writeFileSync(path, "");
    await same(path, "emptied");
  });

  test("a file replaced by rename, same size or larger", async () => {
    const path = fresh();
    const body = header() + user("u1", null) + outline("o1", "u1", "aaaa");
    writeFileSync(path, body);
    await same(path, "start");
    const other = `${path}.new`;
    writeFileSync(other, header() + user("u1", null) + outline("o1", "u1", "bbbb"));
    renameSync(other, path);
    await same(path, "replaced at the same size");
    assert.equal((await sessionFacts(path)).outline?.now, "bbbb");
    writeFileSync(other, `${header()}${user("u1", null)}${outline("o1", "u1", "cccc")}${outline("o2", "o1", "dddd")}`);
    renameSync(other, path);
    await same(path, "replaced by a larger file");
  });

  test("a replacement that differs only between the check windows: the inode tells", async () => {
    const path = fresh();
    const pad = Array.from({ length: 80 }, (_, i) => user(`p${i}`, i ? `p${i - 1}` : null, "y".repeat(100))).join("");
    const pad2 = Array.from({ length: 80 }, (_, i) => user(`q${i}`, i ? `q${i - 1}` : "o1", "y".repeat(100))).join("");
    writeFileSync(path, header() + pad + outline("o1", "p79", "aaaa") + pad2);
    await same(path, "start");
    const other = `${path}.new`;
    writeFileSync(other, header() + pad + outline("o1", "p79", "bbbb") + pad2);
    renameSync(other, path);
    await same(path, "replaced, the first and last 4 KB the same");
    assert.equal((await sessionFacts(path)).outline?.now, "bbbb");
  });

  test("a file deleted, then one at the same path", async () => {
    const path = fresh();
    writeFileSync(path, header() + team("t1", null));
    await same(path, "start");
    rmSync(path);
    const gone = await sessionFacts(path);
    assert.deepEqual(gone.teams, []);
    assert.equal(gone.sessionId, null);
    writeFileSync(path, header("sess-2") + outline("o1", null, "new"));
    await same(path, "a new file at the deleted path");
    assert.equal((await sessionFacts(path)).teams.length, 0);
  });

  test("the golden corpus, written a line at a time, each line in two writes", async () => {
    const dir = join(import.meta.dirname, "harness/pi/golden/fixtures");
    const files = [...readdirSync(join(dir, "synthetic")).map((f) => join("synthetic", f)), ...readdirSync(join(dir, "faux"), { recursive: true }).map((f) => join("faux", String(f)))].filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length >= 17, `only ${files.length} fixtures`);
    for (const file of files) {
      const path = fresh();
      writeFileSync(path, "");
      for (const piece of readFileSync(join(dir, file), "utf8").split(/(?<=\n)/)) {
        const mid = Math.floor(piece.length / 2);
        appendFileSync(path, piece.slice(0, mid));
        await same(path, `${file}: half a line`);
        appendFileSync(path, piece.slice(mid));
        await same(path, `${file}: the line whole`);
      }
    }
  });

  test("an unchanged file is the same answer, read through nothing", async () => {
    const path = fresh();
    writeFileSync(path, header() + team("t1", null));
    const first = await sessionFacts(path);
    const reads = countReads();
    try {
      assert.equal(await sessionFacts(path), first);
      assert.equal(reads.bytes, 0);
    } finally {
      reads.stop();
    }
  });
});

describe("sessionFacts reads only what changed", () => {
  test("an append reads the new bytes and the two small check windows, not the file", async () => {
    const path = fresh();
    const lines = [header(), user("f0", null)];
    for (let i = 1; i < 3000; i++) lines.push(user(`f${i}`, `f${i - 1}`, "y".repeat(1000)));
    writeFileSync(path, lines.join(""));
    await sessionFacts(path);
    const added = outline("o1", "f2999", "new");
    appendFileSync(path, added);
    const size = statSync(path).size;
    assert.ok(size > 2_000_000);
    const reads = countReads();
    try {
      const facts = await sessionFacts(path);
      assert.ok(reads.bytes >= added.length, "the new bytes came through a handle (a whole-file read would show none)");
      assert.ok(reads.bytes <= added.length + 2 * 4096, `read ${reads.bytes} bytes of ${size}`);
      assert.equal(facts.outline?.now, "new");
    } finally {
      reads.stop();
    }
    await same(path, "the fold agrees with the full read");
  });

  test("a replaced file is read whole, so the small read above is the append's and not a broken check", async () => {
    const path = fresh();
    const lines = [header(), user("f0", null)];
    for (let i = 1; i < 500; i++) lines.push(user(`f${i}`, `f${i - 1}`, "y".repeat(1000)));
    writeFileSync(path, lines.join(""));
    await sessionFacts(path);
    lines[1] = user("f0", null, "bye");
    lines[lines.length - 1] = user("f499", "f498", "z".repeat(1000));
    writeFileSync(path, lines.join(""));
    const size = statSync(path).size;
    const reads = countReads();
    try {
      await sessionFacts(path);
      assert.ok(reads.bytes >= size, `read ${reads.bytes} of ${size}`);
    } finally {
      reads.stop();
    }
  });
});

describe("sessionFacts called at once for one path", () => {
  test("concurrent callers share one read and no byte is folded twice", async () => {
    const path = fresh();
    writeFileSync(path, header() + team("t1", null) + outline("o1", "t1", "one"));
    await sessionFacts(path);
    const added = report("r1", "o1", "ag_01") + outline("o2", "r1", "two");
    appendFileSync(path, added);
    const reads = countReads();
    try {
      const all = await Promise.all(Array.from({ length: 8 }, () => sessionFacts(path)));
      for (const f of all) assert.deepEqual(f, full(path));
      assert.ok(reads.bytes <= added.length + 2 * 4096, `read ${reads.bytes} bytes for eight callers`);
    } finally {
      reads.stop();
    }
    assert.equal((await sessionFacts(path)).outlines.length, 2, "each snapshot once");
  });

  test("a call made during a read sees what was appended before it", async () => {
    const path = fresh();
    writeFileSync(path, header() + outline("o1", null, "one"));
    await sessionFacts(path);
    appendFileSync(path, outline("o2", "o1", "two"));
    const reads = countReads();
    let release = () => {};
    reads.gate = new Promise<void>((r) => (release = r));
    try {
      const during = sessionFacts(path);
      await until(() => reads.entered > 0); // it has its stat, and is held at its first read
      appendFileSync(path, outline("o3", "o2", "three"));
      const later = sessionFacts(path);
      const alsoLater = sessionFacts(path);
      reads.gate = null;
      release();
      assert.equal((await during).outlines.at(-1)?.now, "two", "the held read answers for the file it stat'ed");
      assert.deepEqual(await later, full(path));
      assert.equal(await alsoLater, await later, "callers during one read share the next");
    } finally {
      reads.stop();
    }
  });
});

describe("the facts cache is bounded", () => {
  const saved = { ...FACTS_LIMITS };
  after(() => Object.assign(FACTS_LIMITS, saved));

  const firstReadCost = async (path: string): Promise<number> => {
    const reads = countReads();
    try {
      await sessionFacts(path);
      return reads.bytes;
    } finally {
      reads.stop();
    }
  };

  test("by file count: the oldest used file is read again from its start", async () => {
    FACTS_LIMITS.files = 2;
    FACTS_LIMITS.weight = saved.weight;
    const [a, b, c] = [fresh(), fresh(), fresh()];
    for (const p of [a, b, c]) writeFileSync(p, header() + user("u1", null));
    const size = statSync(a).size;
    await sessionFacts(a);
    await sessionFacts(b);
    await sessionFacts(c); // a leaves
    assert.equal(await firstReadCost(b), 0, "b is still held");
    await sessionFacts(b);
    assert.equal(await firstReadCost(a), size, "a is read whole");
    assert.deepEqual(await sessionFacts(a), full(a));
  });

  test("a deleted file gives up its place", async () => {
    FACTS_LIMITS.files = 2;
    FACTS_LIMITS.weight = saved.weight;
    const [kept, deleted, next] = [fresh(), fresh(), fresh()];
    for (const p of [kept, deleted, next]) writeFileSync(p, header() + user("u1", null));
    await sessionFacts(kept);
    await sessionFacts(deleted);
    rmSync(deleted);
    await sessionFacts(deleted); // sees it gone
    await sessionFacts(next); // two files held: `kept` stays, as it could not if the deleted one held a place
    assert.equal(await firstReadCost(kept), 0);
  });

  test("by weight: a file over the budget stays alone, the others leave", async () => {
    FACTS_LIMITS.files = 64;
    FACTS_LIMITS.weight = 400;
    const [small, big] = [fresh(), fresh()];
    writeFileSync(small, header() + user("u1", null));
    writeFileSync(big, header() + Array.from({ length: 10 }, (_, i) => user(`u${i}`, i ? `u${i - 1}` : null)).join(""));
    await sessionFacts(small);
    assert.equal(await firstReadCost(small), 0, "small is held");
    await sessionFacts(big);
    assert.equal(await firstReadCost(big), 0, "the file just read stays, whatever it weighs");
    assert.equal(await firstReadCost(small), statSync(small).size, "small was pushed out");
  });
});
