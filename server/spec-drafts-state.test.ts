// Which drafts aren't official (§chat.worktrees/readiness, §tools.spec/draft-official): the server calls the
// draft tool's own rule, so these cases hold for the merge round's check too (its tests run the tool). Plain
// temp folders shaped as the draft tool writes them: draft.json, base/, spec/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promotionClaims } from "../pi-config/extensions/spec/core/official.mjs";
import { scratchRoot } from "./test-scratch";
import { draftSettle, draftsFingerprint, draftsHash, draftsStamp, draftWork, landedReceiptOf, unofficialDrafts } from "./spec-drafts-state";

const draftCount = (dir: string) => unofficialDrafts(dir)?.length;

const root = scratchRoot("sova-spec-drafts-state-");
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const F = "claims/a.md";
/** A claim file with two claims; `x` and `y` are their prose. */
const file = (x: string, y = "y says one thing.") => `# §a — A\n\nThe lede.\n\n## §a/x — X\n\n${x}\n\n## §a/y — Y\n\n${y}\n`;
const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const spec = (wt: string) => join(wt, ".sova", "spec");
const dir = (wt: string, name: string) => join(spec(wt), "drafts", name);

/** A draft of `wt` made from its current a.md, proposing `prop`. */
function draft(wt: string, name: string, prop: string) {
  const d = dir(wt, name);
  const base = readFileSync(join(spec(wt), F), "utf8");
  put(join(d, "base", F), base);
  put(join(d, "spec", F), prop);
  put(join(d, "draft.json"), JSON.stringify({ format: "sova-spec-draft/1", name, base: { files: { [F]: sha(base) } }, evidence: [], promotions: [] }));
}
/** Promote it as the tool does: current a.md becomes `wrote`, and the receipt records it (`legacy`: no claims). */
function promote(wt: string, name: string, wrote: string, legacy = false) {
  const d = dir(wt, name);
  const meta = JSON.parse(readFileSync(join(d, "draft.json"), "utf8"));
  const claims = promotionClaims(F, readFileSync(join(d, "base", F)), readFileSync(join(d, "spec", F)), Buffer.from(wrote));
  meta.promotions.push({ at: new Date().toISOString(), ids: ["§a/x"], files: [F], after: { [F]: sha(wrote) }, ...(legacy ? {} : { claims }) });
  writeFileSync(join(d, "draft.json"), JSON.stringify(meta));
  writeFileSync(join(spec(wt), F), wrote);
}
let n = 0;
function tree(): string {
  const wt = join(root, `wt${n++}`);
  put(join(spec(wt), F), file("x says one thing."));
  return wt;
}

test("no drafts folder: undefined; a claim not yet current: not official; once current: official", () => {
  const wt = tree();
  assert.equal(draftCount(wt), undefined);
  draft(wt, "feat", file("x says another."));
  assert.deepEqual(unofficialDrafts(wt), ["feat"]);
  writeFileSync(join(spec(wt), F), file("x says another."));
  assert.equal(draftCount(wt), 0);
});

test("(a) draft A promoted, then draft B rewords the same claim and is promoted: A is official", () => {
  for (const legacy of [false, true]) {
    const wt = tree();
    draft(wt, "a", file("x as A says it."));
    promote(wt, "a", file("x as A says it."));
    draft(wt, "b", file("x as B rewords it."));
    assert.deepEqual(unofficialDrafts(wt), ["b"], "B's reword isn't current yet");
    promote(wt, "b", file("x as B rewords it."), legacy);
    assert.deepEqual(unofficialDrafts(wt), [], `A's claim reads what B's promotion wrote${legacy ? " (a receipt from before claims were recorded)" : ""}`);
  }
});

test("(b) draft A promoted, then a catch-up merge takes master's bytes: A isn't official; a hand edit isn't either", () => {
  const wt = tree();
  draft(wt, "a", file("x as A says it."));
  promote(wt, "a", file("x as A says it."));
  assert.equal(draftCount(wt), 0);
  writeFileSync(join(spec(wt), F), file("x as master says it."));
  assert.deepEqual(unofficialDrafts(wt), ["a"], "the merge overwrote what the promotion wrote");
  writeFileSync(join(spec(wt), F), file("x as A says it, edited by hand."));
  assert.deepEqual(unofficialDrafts(wt), ["a"]);
});

test("a merge that changes only another claim of the same file changes nothing; a promotion that merged inside the claim counts", () => {
  const wt = tree();
  draft(wt, "a", file("x as A says it."));
  promote(wt, "a", file("x as A says it."));
  writeFileSync(join(spec(wt), F), file("x as A says it.", "y as master moved it."));
  assert.equal(draftCount(wt), 0, "master's edit to y leaves A's x as A says it");
  // Promoted into a spec that had moved inside x itself: the receipt records what it wrote.
  const wt2 = tree();
  draft(wt2, "a", file("x as A says it."));
  promote(wt2, "a", file("x as A says it, and master's line."));
  assert.equal(draftCount(wt2), 0);
});

test("a Git merge of another block of the same claim keeps it official; a new claim beside master's new one too", () => {
  const wt = tree();
  draft(wt, "a", file("x says one thing.\n\n- one more line from A"));
  promote(wt, "a", file("x says one thing.\n\n- one more line from A"));
  // master changed x's first paragraph; merge-claims merged the blocks: neither side's text, both changes.
  writeFileSync(join(spec(wt), F), file("x as master says it.\n\n- one more line from A"));
  assert.equal(draftCount(wt), 0, "A's added block is there");
  writeFileSync(join(spec(wt), F), file("x as master says it."));
  assert.deepEqual(unofficialDrafts(wt), ["a"], "A's added block is gone");
  // A adds a claim; master adds another to the same file (more blank lines between declarations).
  const wt2 = tree();
  draft(wt2, "a", `${file("x says one thing.")}\n## §a/z — Z\n\nA's new claim.\n`);
  promote(wt2, "a", `${file("x says one thing.")}\n## §a/z — Z\n\nA's new claim.\n`);
  writeFileSync(join(spec(wt2), F), `${file("x says one thing.")}\n## §a/w — W\n\nMaster's new claim.\n\n## §a/z — Z\n\nA's new claim.\n`);
  assert.equal(draftCount(wt2), 0);
});

test("a draft changed again after its promotion isn't official, though current still reads what it wrote", () => {
  const wt = tree();
  draft(wt, "a", file("x as A says it."));
  promote(wt, "a", file("x as A says it, and master's line."));
  writeFileSync(join(dir(wt, "a"), "spec", F), file("x as A says it now."));
  assert.deepEqual(unofficialDrafts(wt), ["a"]);
});

test("an unreadable draft isn't official: its state is unknown, as the merge round's check reads it too", () => {
  const wt = tree();
  put(join(dir(wt, "x"), "draft.json"), "{}");
  assert.deepEqual(unofficialDrafts(wt), ["x"]);
});

/** A file every draft keeps as its base has it: the draft says nothing about it until someone edits it. */
function sibling(wt: string, name: string, text: string) {
  const F2 = "claims/b.md";
  put(join(spec(wt), F2), text);
  put(join(dir(wt, name), "base", F2), text);
  put(join(dir(wt, name), "spec", F2), text);
  const meta = JSON.parse(readFileSync(join(dir(wt, name), "draft.json"), "utf8"));
  meta.base.files[F2] = sha(text);
  writeFileSync(join(dir(wt, name), "draft.json"), JSON.stringify(meta));
}

test("an edit to a draft's file it hadn't changed ends the kept answer, and so does a new file in it", () => {
  const b = "# §b — B\n\nb says one thing.\n";
  const wt = tree();
  draft(wt, "feat", file("x says one thing."));
  sibling(wt, "feat", b);
  assert.equal(draftCount(wt), 0);
  writeFileSync(join(dir(wt, "feat"), "spec", "claims/b.md"), "# §b — B\n\nb says another thing.\n");
  assert.deepEqual(unofficialDrafts(wt), ["feat"]);
  writeFileSync(join(dir(wt, "feat"), "spec", "claims/b.md"), b);
  assert.equal(draftCount(wt), 0);
  put(join(dir(wt, "feat"), "spec", "claims/c.md"), "# §c — C\n\nNew.\n");
  assert.deepEqual(unofficialDrafts(wt), ["feat"]);
});

test("an edit in another draft's receipt, or the current spec, is seen after a shared pass", () => {
  const wt = tree();
  draft(wt, "one", file("x says another."));
  draft(wt, "two", file("x says one thing.", "y says another."));
  assert.deepEqual(unofficialDrafts(wt), ["one", "two"]);
  promote(wt, "one", file("x says another."));
  assert.deepEqual(unofficialDrafts(wt), ["two"]);
  writeFileSync(join(spec(wt), F), file("x says one thing."));
  assert.deepEqual(unofficialDrafts(wt), ["one", "two"]);
});

test("the same content, name apart, is judged once: many drafts and worktrees share reads and cuts", () => {
  const wts = [tree(), tree()];
  for (const wt of wts) writeFileSync(join(spec(wt), F), file("x says something only this test says."));
  for (const wt of wts) for (const n of ["a1", "a2", "a3", "a4"]) draft(wt, n, file(`x says ${n}.`));
  const start = { ...draftWork };
  const first = unofficialDrafts(wts[0]!);
  const firstWork = { reads: draftWork.reads - start.reads, cuts: draftWork.cuts - start.cuts };
  assert.deepEqual(first, ["a1", "a2", "a3", "a4"]);
  // One current file, one shared base and 4 proposals, each cut once; without sharing each draft cuts its own 3.
  assert.equal(firstWork.cuts, 1 + 4, "cuts by name and content");
  // Each draft's own file is hashed, then read and shared for the cut: never a file read per draft per reader.
  assert.ok(firstWork.reads <= 4 * 3 + 1, `reads ${firstWork.reads}`);
  const before = draftWork.cuts;
  assert.deepEqual(unofficialDrafts(wts[1]!), first);
  assert.equal(draftWork.cuts, before, "the second worktree's same files are not cut again");
});

test("a rewrite of a draft's file with its time put back is still seen", () => {
  const wt = tree();
  const b = "# §b — B\n\nb says one thing.\n";
  draft(wt, "feat", file("x says one thing."));
  sibling(wt, "feat", b);
  const old = new Date(Date.now() - 60_000);
  for (const f of [F, "claims/b.md"]) utimesSync(join(dir(wt, "feat"), "spec", f), old, old);
  // ctime can't be set back: a hash taken this soon after the write isn't kept, so the rewrite below can't hide.
  assert.equal(draftCount(wt), 0);
  writeFileSync(join(dir(wt, "feat"), "spec", "claims/b.md"), "# §b — B\n\nb says two thing.\n");
  utimesSync(join(dir(wt, "feat"), "spec", "claims/b.md"), old, old);
  assert.deepEqual(unofficialDrafts(wt), ["feat"]);
});

/** Every file under `d`, relative and sorted, read straight from disk. */
const walk = (d: string, rel = ""): string[] =>
  readdirSync(join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])).sort();
/** What the three readings say of `wt`, worked out by hand from the files as they are now: draftsHash's lines
    `<draft>/<path under spec/> <sha256>` (sorted, joined), draftsFingerprint's `<path> <sha256>` over the whole folder, and
    each draft's receipt as draft.json holds it. */
function byHand(wt: string) {
  const drafts = join(spec(wt), "drafts");
  const hashOf = (lines: string[]) => sha([...lines].sort().join("\n"));
  const names = readdirSync(drafts).sort();
  const lines = (n: string) => walk(join(drafts, n, "spec")).map((r) => `${n}/${r} ${sha(readFileSync(join(drafts, n, "spec", r), "utf8"))}`);
  return {
    hash: { hash: hashOf(names.flatMap(lines)), names, each: Object.fromEntries(names.map((n) => [n, hashOf(lines(n))])) },
    print: sha(walk(drafts).map((r) => `${r} ${sha(readFileSync(join(drafts, r), "utf8"))}`).join("\n")),
    receipts: names.map((n) => JSON.parse(readFileSync(join(drafts, n, "draft.json"), "utf8")).landed ?? null),
  };
}
const readings = (wt: string) => ({ hash: draftsHash(wt), print: draftsFingerprint(wt), receipts: readdirSync(join(spec(wt), "drafts")).sort().map((n) => landedReceiptOf(dir(wt, n))) });

test("drafts unchanged since the last pass are read again from no file and no folder; any edit is seen at once", async () => {
  // The kept hashes, listings and receipts stand on stats alone. Each edit below must show in all three readings on the
  // very next pass, as reading every file would show it, including a rewrite that keeps the size and puts the time back
  // (only its ctime moves: a stamp of size and mtime alone misses it, as the stand-in at the end shows).
  const receipt = (c: string) => ({ commit: c.repeat(40), target: "master", hash: "a".repeat(64), at: "", by: "t" });
  const keepTime = (p: string, edit: () => void) => {
    const was = statSync(p);
    edit();
    utimesSync(p, was.atime, was.mtime);
  };
  const edits: [string, (wt: string) => void][] = [
    ["a spec file rewritten, same size, its time put back", (wt) => keepTime(join(dir(wt, "feat"), "spec", F), () => writeFileSync(join(dir(wt, "feat"), "spec", F), file("x says one THING.")))],
    ["a new file in a new nested folder", (wt) => put(join(dir(wt, "feat"), "spec", "claims/deep/c.md"), "# §c — C\n")],
    ["a file removed", (wt) => rmSync(join(dir(wt, "feat"), "spec", F))],
    ["a file renamed, its content kept", (wt) => renameSync(join(dir(wt, "feat"), "spec", F), join(dir(wt, "feat"), "spec", "claims/z.md"))],
    ["a base file rewritten, same size, its time put back", (wt) => keepTime(join(dir(wt, "feat"), "base", F), () => writeFileSync(join(dir(wt, "feat"), "base", F), file("x says one THING.")))],
    ["a receipt rewritten, same size, its time put back", (wt) => {
      const p = join(dir(wt, "feat"), "draft.json");
      keepTime(p, () => writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), landed: receipt("b") })));
    }],
    ["a new draft", (wt) => draft(wt, "more", file("x says more."))],
  ];
  const tick = () => new Promise((r) => setTimeout(r, 30));
  /** Every draft file at a whole second, which a time put back then matches to the nanosecond. */
  const wholeSecond = (wt: string) => {
    const t = Math.floor(Date.now() / 1000) - 60;
    for (const r of walk(join(spec(wt), "drafts"))) utimesSync(join(spec(wt), "drafts", r), t, t);
  };
  draftSettle.ms = 0;
  try {
    for (const [what, edit] of edits) {
      const wt = tree();
      draft(wt, "feat", file("x says one thing."));
      const meta = join(dir(wt, "feat"), "draft.json");
      writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), landed: receipt("a") }));
      wholeSecond(wt);
      await tick();
      const before = readings(wt);
      const stamp = draftsStamp(wt);
      assert.deepEqual(before, byHand(wt), what);
      const work = { ...draftWork };
      assert.deepEqual(readings(wt), before, what);
      assert.equal(draftsStamp(wt), stamp, what);
      assert.deepEqual([draftWork.files - work.files, draftWork.listings - work.listings], [0, 0], `${what}: a pass with nothing moved reads nothing`);
      await tick();
      edit(wt);
      assert.deepEqual(readings(wt), byHand(wt), what);
      assert.notDeepEqual(readings(wt), before, `${what}: the edit shows`);
      assert.notEqual(draftsStamp(wt), stamp, `${what}: the stamp moves`);
    }
    // The stand-in: size and mtime alone don't move for the first edit.
    const wt = tree();
    draft(wt, "feat", file("x says one thing."));
    wholeSecond(wt);
    const p = join(dir(wt, "feat"), "spec", F);
    const sizeMtime = () => { const st = statSync(p, { bigint: true }); return `${st.size}:${st.mtimeNs}`; };
    const was = sizeMtime();
    edits[0]![1](wt);
    assert.equal(sizeMtime(), was);
  } finally {
    draftSettle.ms = 2000;
  }
});
