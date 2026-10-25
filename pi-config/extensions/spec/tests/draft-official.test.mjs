// The one rule for "is this draft official" (core/official.mjs) as the draft tool's `drafts` and `prune --official`
// read it: black-box, through sova-spec-draft.mjs. Node stdlib only; each fixture in its own temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const env = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const CLAIMS = { "§b/other": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/other.txt"] }, "§b.other/two": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/other.txt"] } };
const OTHER = (one, two = "Two does W.") => `# §b/other\n\n${one}\n\n## §b.other/two\n\n${two}\n`;
const FILE = ".sova/spec/claims/b/other.md";
function project() {
  const root = mkdtempSync(join(tmpdir(), "sova-draft-official-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: CLAIMS }, null, 2) + "\n");
  write(root, FILE, OTHER("Other does Z."));
  write(root, "lib/other.txt", "other v1\n");
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: env(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
/** A draft saying `one` for §b/other, made from the current spec and promoted with snapshot evidence. */
function promoted(root, name, one) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  write(root, `.sova/spec/drafts/${name}/spec/claims/b/other.md`, OTHER(one));
  assert.equal(run(root, "evidence", name, "--id", "§b/other", "--by", "t", "--verification", "read", "--snapshot", "--write").exit, 0);
  const pv = run(root, "promote", name, "--id", "§b/other");
  assert.equal(run(root, "promote", name, "--id", "§b/other", "--plan", pv.plan, "--write").exit, 0, JSON.stringify(pv.refusals));
}
const entry = (root, name) => run(root, "drafts").drafts.find((d) => d.name === name);
const names = (root) => (existsSync(join(root, ".sova/spec/drafts")) ? readdirSync(join(root, ".sova/spec/drafts")).filter((n) => !n.startsWith(".")).sort() : []);

test("a promotion records each claim it wrote, as the draft said it and as written", () => {
  const root = project();
  promoted(root, "a", "Other does Z, said by A.");
  const p = JSON.parse(readFileSync(join(root, ".sova/spec/drafts/a/draft.json"), "utf8")).promotions[0];
  const said = p.claims["t:§b/other"];
  assert.ok(Array.isArray(said) && said.length === 2 && said[0] === said[1], JSON.stringify(p.claims));
  assert.equal(p.claims["t:§b.other/two"], undefined, "a claim it didn't change isn't one it wrote");
});

test("(a) draft A promoted, then draft B rewords the same § and is promoted: A is official, and prune --official clears it", () => {
  const root = project();
  promoted(root, "a", "Other does Z, said by A.");
  promoted(root, "b", "Other does Z, as B rewords it.");
  const a = entry(root, "a");
  assert.deepEqual([a.state, a.conflict, a.promotedConflict], ["promoted", [], []], JSON.stringify(a));
  const pr = run(root, "prune", "--official", "--write");
  assert.deepEqual(pr.deleted.map((d) => d.name), ["a", "b"]);
  assert.deepEqual(names(root), []);
});

test("(b) draft A promoted, then a catch-up merge takes master's bytes: not official, and kept; master changing only another § is no change", () => {
  const root = project();
  promoted(root, "a", "Other does Z, said by A.");
  write(root, FILE, OTHER("Other does Z, said by A.", "Two does W, as master moved it."));
  assert.deepEqual(entry(root, "a").promotedConflict, [], "another claim of the same file moved: A's own still reads as A says");
  write(root, FILE, OTHER("Other does Z, as master says it."));
  const a = entry(root, "a");
  assert.deepEqual(a.promotedConflict, ["§b/other"], JSON.stringify(a));
  assert.deepEqual(run(root, "prune", "--official", "--write").deleted, []);
  assert.deepEqual(names(root), ["a"]);
});

test("one verdict: a draft changing only a top-level manifest key, current holding a third value, reads not official in drafts too", async () => {
  const { draftOfficial } = await import("../core/official.mjs");
  const root = project();
  const manifest = (x) => JSON.stringify({ formatVersion: 1, x, claims: CLAIMS }, null, 2) + "\n";
  write(root, ".sova/spec/manifest.json", manifest("base"));
  assert.equal(run(root, "new", "k", "--write").exit, 0);
  write(root, ".sova/spec/drafts/k/spec/manifest.json", manifest("draft"));
  write(root, ".sova/spec/manifest.json", manifest("master"));
  const off = draftOfficial(join(root, ".sova/spec"), join(root, ".sova/spec/drafts/k"), join(root, ".sova/spec/drafts"));
  assert.deepEqual([off.official, off.changed, off.notOfficial], [false, 1, []]);
  const k = entry(root, "k");
  assert.equal(k.official, off.official, `drafts row and the rule disagree: ${JSON.stringify(k)}`);
  assert.notEqual(k.state, "promoted");
  assert.deepEqual(run(root, "prune", "--official", "--write").deleted, []);
});
