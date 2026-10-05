// The replay harness's own checks: a tree against itself shows no difference and holds every guard; a
// candidate that "fixes" a row by dropping what the guard protects is caught; make-tree records its commit.
import "../../../claude-code/tests/hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArm, diffCards, summary } from "./run.mjs";
import { makeTree } from "./make-tree.mjs";

const TREE = fileURLToPath(new URL("../../../", import.meta.url));
const temps = [];
process.on("exit", () => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });
const failed = (card) => card.rows.flatMap((r) => r.guards.filter((g) => !g.ok && !g.na).map((g) => g.name));

test("self-check: this tree against itself differs on no row, and every guard holds in both arms", { timeout: 600_000 }, async () => {
  const a = await runArm(TREE, { label: "baseline" });
  const b = await runArm(TREE, { label: "candidate" });
  assert.equal(a.errors, undefined, JSON.stringify(a.errors));
  assert.equal(b.errors, undefined, JSON.stringify(b.errors));
  const diff = diffCards(a, b);
  assert.deepEqual(diff.rows.filter((r) => r.changed), [], "baseline vs baseline must show zero difference");
  assert.ok(diff.rows.length >= 30, `all scenarios ran (${diff.rows.length} rows)`);
  for (const s of ["a", "b", "c", "d", "e", "f", "g"]) assert.ok(a.rows.some((r) => r.scenario === s), `scenario ${s} has rows`);
  assert.deepEqual(failed(a), []);
  assert.deepEqual(failed(b), []);
  assert.doesNotMatch(JSON.stringify(a.rows), /spec-replay-|\/tmp\//, "no temp path in a value");
  assert.match(summary(a, b, diff), /0 of \d+ rows differ; guards failed: baseline 0, candidate 0/);
});

test("diffCards: a changed value and a changed guard are each a difference; a row only one side has is too", () => {
  const card = (rows) => ({ rows });
  const r = (metric, value, ok = true) => ({ scenario: "x", metric, value, guards: [{ name: `${metric}.g`, ok, detail: "" }] });
  const d = diffCards(card([r("m1", 1), r("m2", { a: 1, b: 2 }), r("m3", "v"), r("m4", 0)]), card([r("m1", 2), r("m2", { b: 2, a: 1 }), r("m3", "v", false), r("m5", 0)]));
  assert.deepEqual(d.rows.map((x) => [x.metric, x.changed]), [["m1", true], ["m2", false], ["m3", true], ["m4", true], ["m5", true]]);
  assert.equal(d.changed, 4);
});

/** A copy of this tree with `files` ({tree path: source}) added and each `[file, from, to]` applied; a patch that finds nothing fails the test. */
function sabotaged(patches, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spec-replay-sabotage-"));
  temps.push(dir);
  for (const sub of ["spec", "mode", "claude-code"]) cpSync(join(TREE, sub), join(dir, sub), { recursive: true });
  for (const [to, from] of Object.entries(files)) cpSync(from, join(dir, to));
  for (const [file, from, to] of patches) {
    const text = readFileSync(join(dir, file), "utf8");
    assert.ok(text.includes(from), `patch target in ${file}: ${from}`);
    writeFileSync(join(dir, file), text.replace(from, to));
  }
  return dir;
}

test("guards catch the do-nothing fixes: the draft always wins, the census goes quiet, evidence never stales, merges never land, packets trim", { timeout: 600_000 }, async () => {
  const tree = sabotaged([
    ["spec/core/sova-spec-draft.mjs", 'return "conflict";                  // both changed it, differently', 'return "apply";'],
    ["mode/spec-guard.ts", "if (!first && !freshIn.length && !newForeign.length && !unmapped.length) return", "if (true) return"],
    ["spec/core/sova-spec-draft.mjs", "async function evidenceProblems(root, g, e, draftRelDir) {\n  const out = [];", "async function evidenceProblems(root, g, e, draftRelDir) {\n  const out = [];\n  return out;"],
    ["mode/spec-guard.ts", "\tlet absorbing = false;\n\tif ((op.kind", "\tlet absorbing = true;\n\tif ((op.kind"],
    ["spec/core/packet.mjs", 'const text = bytes.subarray(offset, end).toString("utf8");', 'const text = bytes.subarray(offset, end).toString("utf8").trim();'],
  ]);
  const card = await runArm(tree, { label: "sabotaged", only: ["a", "b", "c", "d", "f"] });
  const names = failed(card);
  for (const name of [
    "a.diff-h2.no-prose-lost", "a.same-h2.conflict-stops", "a.same-h2.no-prose-lost",
    "a.stacked.master-landing-listed", "b.edit.goes-stale",
    "c.pi.drift-flagged", "c.pi.unclaimed-flagged", "c.claude.drift-flagged", "c.claude.unclaimed-flagged",
    "d.packet-text-exact", "f.spans-exact",
  ]) assert.ok(names.includes(name), `${name} fails on the sabotaged tree (failed: ${names.join(", ")})`);
  // …while the rows themselves look better, which is why the guards exist.
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  assert.equal(value("a.diff-h2.hand-reapply"), 0);
  assert.equal(value("b.refused-cases"), 0, "no evidence case is refused any more");
});

test("f and g catch the cheap slice: a packet that stops following requires reads less and loses needs", { timeout: 600_000 }, async () => {
  const tree = sabotaged([
    ["spec/core/sova-spec.mjs", "    for (const r of [...(rec.requires ?? [])].sort()) edge(r, { reason: \"requires\", of: id });", ""],
    ["spec/core/packet.mjs", "for (const to of [...[...nearby].sort(), ...[...(rec.requires ?? [])].sort()]) {", "for (const to of [...nearby].sort()) {"],
  ]);
  const card = await runArm(tree, { label: "sabotaged", only: ["f", "g"] });
  assert.equal(card.errors, undefined, JSON.stringify(card.errors));
  const names = failed(card);
  for (const name of ["f.deps-read-whole", "f.mention-not-absent", "g.packet.no-need-lost", "g.packet.total-never-drops"])
    assert.ok(names.includes(name), `${name} fails on the sabotaged tree (failed: ${names.join(", ")})`);
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  assert.ok(value("f.packet.slice").bytes < 2000, "the sabotaged slice is far smaller…");
  assert.ok(value("g.packet.total").bytesTotal < 1_000_000, "…on the real spec too");
});

/** Route `sova-spec.mjs toc|read` to the harness's stand-in, so the pull checks run before the real commands exist. */
const STUB_FILES = { "spec/core/toc-stub.mjs": fileURLToPath(new URL("./toc-stub.mjs", import.meta.url)), "spec/core/fullness.mjs": fileURLToPath(new URL("./fullness.mjs", import.meta.url)) };
const STUB = ["spec/core/sova-spec.mjs", "if (direct) {\n  try {", "if (direct && [\"toc\", \"read\"].includes(process.argv[2])) await import(\"./toc-stub.mjs\");\nelse if (direct) {\n  try {"];

test("pull checks run only where toc exists: n/a without it, held by a faithful contents view, failed by one that hides out-links", { timeout: 600_000 }, async () => {
  const plain = await runArm(TREE, { label: "plain", only: ["f"] });
  const na = plain.rows.flatMap((r) => r.guards).filter((g) => g.name.startsWith("f.pull."));
  assert.ok(na.length >= 4 && na.every((g) => g.na), "a tree without toc: every pull guard is n/a, never a pass");

  const good = await runArm(sabotaged([STUB], STUB_FILES), { label: "stub", only: ["f", "g"] });
  assert.equal(good.errors, undefined, JSON.stringify(good.errors));
  assert.deepEqual(failed(good), []);
  const pullGuards = good.rows.flatMap((r) => r.guards).filter((g) => g.name.startsWith("f.pull."));
  assert.ok(pullGuards.length >= 4 && pullGuards.every((g) => g.ok && !g.na), "with toc, the pull guards are evaluated and hold");
  const shown = (card) => card.rows.find((r) => r.metric === "g.pull.total")?.value?.shown;
  assert.ok(shown(good) > 0, "the pull proxy counts needs shown");

  const bad = await runArm(sabotaged([STUB, ["spec/core/toc-stub.mjs", "out: () => claims[id].requires ?? [],", "out: () => [],"], ["spec/core/toc-stub.mjs", "out({ id, dir, lines, footer: { named } });", "out({ id, dir, lines, footer: { named: [] } });"]], STUB_FILES), { label: "stub-hides", only: ["f", "g"] });
  const names = failed(bad);
  assert.ok(names.includes("f.pull.items-shown"), `f.pull.items-shown fails when out-links are hidden (failed: ${names.join(", ")})`);
  assert.ok(shown(bad) < shown(good), "fewer needs shown when out-links are hidden");
});

test("make-tree: a ref's pi-config/extensions, with its commit recorded for the scorecard", { skip: spawnSync("git", ["-C", TREE, "rev-parse", "HEAD"]).status !== 0 && "not in a Git checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-tree-"));
  temps.push(dest);
  const tree = makeTree("HEAD", join(dest, "t"), TREE);
  for (const need of ["spec/core/sova-spec.mjs", "mode/spec-guard.ts", "claude-code/spec-hooks.ts"]) assert.ok(existsSync(join(tree, need)), need);
  const source = JSON.parse(readFileSync(join(dest, "t/replay-source.json"), "utf8"));
  assert.equal(source.ref, "HEAD");
  assert.equal(source.commit, spawnSync("git", ["-C", TREE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
  assert.throws(() => makeTree("HEAD", join(dest, "t"), TREE), /not empty/);
});
