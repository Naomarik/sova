// A branch's place: the line, its clause by the row's own state, what it unfolds to, and the per-project links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchInPlace, clauseText, placeClause, placeFold, placeIsFolder, placeLine, placeOf, queueLinksOf, type BranchPlaceRow } from "./branch-place";

const place = { label: "AmalMoney", root: "/home/u/code/amal", target: "master" };
const row = (x: Partial<BranchPlaceRow> = {}): BranchPlaceRow => ({ path: "/home/u/wt/x", status: "active", place, ...x });

test("a merged row never reads the project's usual target: mergeProject.target isn't even an input", () => {
  // The row as the server sends it: merged into a parent branch, the project's target master.
  const w = { ...row({ status: "merged", merge: { target: "feat/parent" } }), mergeProject: { target: "master" } };
  const text = placeLine(w)!;
  assert.equal(text, "AmalMoney · merged into feat/parent");
  assert.doesNotMatch(text, /merges into master/);
  assert.doesNotMatch(text, /master/);
});

test("the clause follows the row's own state, over every edge", () => {
  const cases: [string, Partial<BranchPlaceRow>, string][] = [
    ["active", {}, " · merges into master"],
    ["recorded merge", { status: "merged", merge: { target: "develop" } }, " · merged into develop"],
    ["git found it merged", { mergedInto: { target: "release" } }, " · merged into release"],
    ["landed", { queue: { state: "landed", target: "trunk" } }, " · merged into trunk"],
    ["merged by the host", { queue: { state: "requested", target: "trunk", request: { facts: { state: "merged" } } } }, " · merged into trunk"],
    ["dropped", { status: "dropped" }, ""],
    ["dropped, a merge on record", { status: "dropped", merge: { target: "develop" } }, ""],
    ["merged, no record of where", { status: "merged" }, ""],
    ["landed, no record of where", { queue: { state: "landed" } }, ""],
    ["readiness alone says merged", { readiness: { state: "merged" } }, ""],
    ["readiness merged while stale", { readiness: { state: "stale", merged: true } }, ""],
    ["folder gone, work merged", { gone: "merged" }, ""],
    ["folder gone, not merged", { gone: "unmerged" }, " · merges into master"],
    ["queued: its entry's own target", { queue: { state: "queued", target: "trunk" } }, " · merges into trunk"],
    ["queued, an older entry with no target", { queue: { state: "queued" } }, " · merges into master"],
    ["cancelled: back to the repository's", { queue: { state: "cancelled", target: "trunk" } }, " · merges into master"],
    ["settled: back to the repository's", { queue: { state: "needs-fix", target: "trunk", settled: { why: "gone" } } }, " · merges into master"],
    ["unknown target", { place: { label: "AmalMoney" } }, ""],
  ];
  for (const [name, x, want] of cases) assert.equal(clauseText(row(x)), want, name);
});

test("no place: nothing to say, whatever the clause would be", () => {
  assert.equal(placeLine(row({ place: undefined })), undefined);
  assert.equal(placeLine(row({ place: { label: "  ", target: "master" } })), undefined);
  assert.equal(placeOf(row({ place: undefined })), undefined);
});

test("a folder place is drawn as a folder, a name is not", () => {
  assert.equal(placeLine(row({ place: { label: "~/code/tools", target: "main" } })), "~/code/tools · merges into main");
  assert.ok(placeIsFolder("~/code/tools") && placeIsFolder("/srv/tools"));
  assert.ok(!placeIsFolder("Notes · work/notes"));
});

test("{branch} in {place}, and the branch alone with no place", () => {
  assert.equal(branchInPlace("feat/x", "AmalMoney"), "feat/x in AmalMoney");
  assert.equal(branchInPlace("feat/x", undefined), "feat/x");
  assert.equal(branchInPlace("feat/x", " "), "feat/x");
});

test("the fold follows the clause, and writes paths from home", () => {
  const home = "/home/u";
  assert.deepEqual(placeFold(row(), home), {
    lines: [
      { label: "Branch folder", value: "~/wt/x" },
      { label: "Merges into", value: "master of ~/code/amal" },
    ],
    copy: "/home/u/wt/x",
  });
  const merged = placeFold(row({ status: "merged", merge: { target: "feat/parent" } }), home);
  assert.deepEqual(merged.lines[1], { label: "Merged into", value: "feat/parent of ~/code/amal" });
  assert.deepEqual(placeFold(row({ status: "dropped" }), home).lines.map((l) => l.label), ["Branch folder"]);
  assert.deepEqual(placeFold(row({ place: { label: "A", target: "main" } }), home).lines[1], { label: "Merges into", value: "main" });
});

test("a remote target's path is never written from our home", () => {
  const home = "/home/u";
  const path = `${home}/.pi/agent/sova/targets/box/home/u/wt`;
  const f = placeFold(row({ path, place: { label: "/home/u/tools", root: `${home}/.pi/agent/sova/targets/box/home/u/tools`, target: "main" } }), home);
  assert.deepEqual(f.lines, [
    { label: "Branch folder", value: "/home/u/wt" },
    { label: "Merges into", value: "main of /home/u/tools" },
  ]);
  assert.equal(f.copy, "/home/u/wt");
});

test("the links: one project reads as ever, several are each named, once each; a repo off the list has none", () => {
  const a = { mergeProject: { id: "prj_a" }, place: { label: "AmalMoney" } };
  const b = { queue: { project: "prj_b" }, place: { label: "Tools" } };
  const off = { place: { label: "~/code/x" } };
  assert.deepEqual(queueLinksOf([off]), []);
  assert.deepEqual(queueLinksOf([off, a, a]).map((l) => l.label), ["View Merge Queue"]);
  assert.deepEqual(queueLinksOf([a, off, b, a]).map((l) => l.label), ["View AmalMoney's Merge Queue", "View Tools's Merge Queue"]);
  assert.match(queueLinksOf([a, b])[1]!.href, /prj_b/);
  // A new page on an older server (no place): a folder's name, or no name, but never the raw id.
  const oldA = { mergeProject: { id: "prj_a", root: "/w/amal" } };
  const oldB = { queue: { project: "prj_b" } };
  assert.deepEqual(queueLinksOf([oldA, oldB]).map((l) => l.label), ["View amal's Merge Queue", "View Merge Queue"]);
});

test("placeClause tells merged from merging for the fold's label", () => {
  assert.deepEqual(placeClause(row()), { merged: false, target: "master" });
  assert.deepEqual(placeClause(row({ mergedInto: { target: "x" } })), { merged: true, target: "x" });
  assert.equal(placeClause(row({ status: "dropped" })), null);
});

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { BranchPlaceLine } = await importSsr(new URL("../components/BranchPlaceLine.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const html = (r: BranchPlaceRow) => renderToString((() => solid.createComponent(BranchPlaceLine, { row: r })) as never).replaceAll(/<!--[^>]*-->/g, "");

test("the line is a real button, closed at first, and draws nothing with no place", () => {
  const h = html(row());
  assert.match(h, /<button[^>]*type="button"[^>]*aria-expanded="false"/);
  assert.match(h.replace(/<[^>]+>/g, ""), /AmalMoney · merges into master/);
  assert.doesNotMatch(h, /Copy Folder/, "the fold is closed");
  assert.equal(html(row({ place: undefined })), "");
});

test("a place that is a folder is in mono, a name isn't", () => {
  assert.match(html(row({ place: { label: "~/code/tools", target: "main" } })), /class="text-mono"[^>]*>~\/code\/tools/);
  assert.doesNotMatch(html(row()), /text-mono/);
});
