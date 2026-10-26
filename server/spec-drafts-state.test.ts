// Which drafts aren't official (§chat.worktrees/readiness, §tools.spec/draft-official): the server calls the
// draft tool's own rule, so these cases hold for the merge round's check too (its tests run the tool). Plain
// temp folders shaped as the draft tool writes them: draft.json, base/, spec/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promotionClaims } from "../pi-config/extensions/spec/core/official.mjs";
import { scratchRoot } from "./test-scratch";
import { unofficialDrafts } from "./spec-drafts-state";

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
