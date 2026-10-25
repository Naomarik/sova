import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readSpecFs, serialize } from "../pi-config/extensions/spec/core/layout.mjs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DecisionRow } from "../shared/decisions";
import { promoteEdit } from "./spec-draft-writer";
import { CANDIDATE_MARK } from "./spec-lookup-projection";
import { clearHandlesForTest, mainLineOf, projectOverview, setLookupPlaceForTest, specEntries, specLookupTools } from "./spec-lookup";
import { scratchRoot } from "./test-scratch";

// The review check (§app.spec-lookup/outsider-view): a decision promoted with a known quote and name,
// looked up the way a gathering session looks it up (the outsider view, the real spec tools, the main
// line): neither the quote nor the name appears. A candidate record shows the marker. Uncommitted spec
// edits are never read.

const QUOTE = "Never charge anyone for the first archery lesson, I mean it";
const NAME = "Alperen Kaya";
let root: string;
const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
/** Add records to the spec at `root`, in its own layout (a spec started here is in format 2: beside each claim file). */
function addRecords(added: Record<string, Record<string, unknown>>) {
  const s = readSpecFs(root);
  if (s.state !== "present" || !s.manifest) throw new Error("no readable spec");
  const spec = join(root, ".sova", "spec");
  for (const [rel, text] of serialize(s.layout, { ...s.manifest, claims: { ...s.records, ...added } }, { prevRecordFiles: s.recordFiles }))
    if (text !== null) { mkdirSync(join(spec, rel, ".."), { recursive: true }); writeFileSync(join(spec, rel), text); }
}
const commit = (m: string) => {
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", m);
};

const row: DecisionRow = {
  id: "sess1:m1",
  orgId: "o1",
  projectId: "p1",
  area: "Lessons",
  areaKey: "lessons",
  statement: "The first archery lesson is free.",
  quote: QUOTE,
  by: "per1",
  name: NAME,
  at: "2026-10-17T10:00:00Z",
  sessionId: "sess1",
  entryId: "e1",
  markerId: "m1",
  authorOwnsArea: true,
  sessionPath: null,
  state: "drafted",
  recordId: "§requirements.lessons/first-lesson-free",
} as DecisionRow;

before(async () => {
  root = scratchRoot("spec-lookup-int");
  g("init", "-q", "-b", "master");
  writeFileSync(join(root, "index.html"), "<h1>Mamluk Arabia</h1>\n");
  commit("site");
  await promoteEdit(root, { rows: [row], supersededBy: new Map() }, () => "test");
  // A proposal beside it, written by hand as the spec tools would label it.
  const spec = join(root, ".sova", "spec");
  mkdirSync(join(spec, "claims", "site"), { recursive: true });
  writeFileSync(join(spec, "claims", "site", "shop.md"), "# §site/shop — The shop\n\nWhat the shop sells.\n\n## §site.shop/gift-cards — Gift cards\n\nPeople can buy gift cards.\n");
  addRecords({ "§site/shop": { kind: "surface", authority: "accepted" }, "§site.shop/gift-cards": { kind: "behavior", authority: "candidate" } });
  commit("spec");
  setLookupPlaceForTest(() => ({ root, name: "Mamluk Arabia", names: [NAME, "Omar"] }));
});
after(() => setLookupPlaceForTest(null));

const run = async (t: { execute: Function }, params: Record<string, unknown>) => (await t.execute("c", params, undefined, undefined, { branch: () => [] })).content[0].text as string;

test("the stored record holds the quote and the name (the fixture is real)", () => {
  const text = g("show", "HEAD:.sova/spec/claims/requirements/lessons.md");
  assert.ok(text.includes(QUOTE) && text.includes(NAME));
});

test("a gathering's look-up: neither the quote nor the name appears", async () => {
  clearHandlesForTest();
  const [spec] = specLookupTools({ sessionId: "gathering-1", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "outsider" });
  const found = await run(spec!, { op: "find", words: "first archery lesson free" });
  const ref = /- (s\d+) — The first archery lesson is free/.exec(found)?.[1];
  assert.ok(ref, found);
  const read = await run(spec!, { op: "read", ref });
  assert.ok(read.includes("The first archery lesson is free."), read);
  for (const out of [found, read, await run(spec!, { op: "outline" }), await projectOverview("p1", "outsider")]) {
    assert.ok(!out.includes(QUOTE), out);
    assert.ok(!out.includes("Never charge"), out);
    assert.ok(!out.includes("Alperen") && !out.includes("Kaya"), out);
    assert.ok(!out.includes("§"), out);
  }
});

test("a candidate record shows the marker", async () => {
  const [spec] = specLookupTools({ sessionId: "gathering-2", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "outsider" });
  const found = await run(spec!, { op: "find", words: "gift cards" });
  const ref = /- (s\d+) — Proposed, not settled yet: Gift cards/.exec(found)?.[1];
  assert.ok(ref, found);
  assert.ok((await run(spec!, { op: "read", ref })).includes(`${CANDIDATE_MARK} People can buy gift cards.`));
});

test("the main line only: an uncommitted spec edit is never read; a commit is", async () => {
  const before = await mainLineOf("p1", root);
  const file = join(root, ".sova", "spec", "claims", "site", "shop.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("People can buy gift cards.", "People can buy gift cards and DIRTY vouchers."));
  const [spec] = specLookupTools({ sessionId: "gathering-3", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "full" });
  assert.ok(!(await run(spec!, { op: "read", ref: "§site.shop/gift-cards" })).includes("DIRTY"));
  commit("voucher");
  const now = await mainLineOf("p1", root);
  assert.notEqual(now.specKey, before.specKey);
  assert.ok((await run(spec!, { op: "read", ref: "§site.shop/gift-cards" })).includes("DIRTY"));
});

test("the full view keeps the quote and the name; Spec counts every entry", async () => {
  const [spec] = specLookupTools({ sessionId: "po", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "full" });
  const read = await run(spec!, { op: "read", ref: "§requirements.lessons/first-lesson-free" });
  assert.ok(read.includes(QUOTE) && read.includes(NAME));
  assert.ok(((await specEntries("p1")) ?? 0) >= 4);
});

test("code_read reads the committed site", async () => {
  const [, code] = specLookupTools({ sessionId: "gathering-4", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "outsider" });
  assert.ok((await run(code!, { op: "read", path: "index.html" })).includes("Mamluk Arabia"));
  await assert.rejects(run(code!, { op: "list", path: ".sova" }), /can't be read/);
});

test("the main line is master, never the branch checked out: a claim committed on feat/x is not found", async () => {
  const { mainLineCommit } = await import("./spec-lookup");
  g("checkout", "-q", "-b", "feat/x");
  const spec = join(root, ".sova", "spec");
  mkdirSync(join(spec, "claims", "site"), { recursive: true });
  writeFileSync(join(spec, "claims", "site", "unmerged.md"), "# §site/unmerged — Unmerged zebra feature\n\nThe zebra quiver page lists striped arrows.\n");
  addRecords({ "§site/unmerged": { kind: "surface", authority: "accepted" } });
  writeFileSync(join(root, "zebra.html"), "<p>zebra quiver</p>\n");
  commit("feature work");
  try {
    const main = await mainLineCommit(root);
    assert.equal(main?.branch, "master");
    assert.equal(main?.commit, g("rev-parse", "master"));
    const [spec_, code] = specLookupTools({ sessionId: "gathering-featx", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "outsider" });
    const found = await run(spec_!, { op: "find", words: "zebra quiver striped arrows" });
    assert.ok(!found.includes("Unmerged zebra feature") && !/- s\d+ — /.test(found), found);
    const [full] = specLookupTools({ sessionId: "po-featx", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "full" });
    await assert.rejects(run(full!, { op: "read", ref: "§site/unmerged" }), /No §site\/unmerged on the main line/);
    await assert.rejects(run(code!, { op: "read", path: "zebra.html" }), /no such file/);
    assert.ok(!(await run(code!, { op: "search", words: "zebra" })).includes("zebra.html"));
    // Control: once merged into master, the same look-ups find it (the check tells the two states apart).
    g("checkout", "-q", "master");
    g("-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--ff-only", "feat/x");
    const [spec2, code2] = specLookupTools({ sessionId: "gathering-merged", projects: [{ id: "p1", name: "Mamluk Arabia" }], view: "outsider" });
    assert.match(await run(spec2!, { op: "find", words: "zebra quiver striped arrows" }), /- s\d+ — Unmerged zebra feature/);
    assert.ok((await run(code2!, { op: "read", path: "zebra.html" })).includes("zebra quiver"));
  } finally {
    g("checkout", "-q", "master");
  }
});
