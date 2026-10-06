// A change to a record's embeds/about/core fields alone lands on --doc-only evidence; bundled with anything else
// on the same record it is refused. Black-box tests for core/sova-spec-draft.mjs. Node stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const FILE = ".sova/spec/claims/a/top.md", D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n";
const AGREED = { by: "the operator", at: "2026-10-05" };

function project(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "sova-draft-fields-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", manifest({
    "§a/top": { kind: "surface", authority: "accepted" },
    "§a.top/one": { kind: "behavior", authority: "accepted", evidence: "verified", requires: [], code: ["lib/one.txt"], ...extra },
    "§p/panel": { kind: "surface", authority: "accepted", evidence: "verified", requires: [], code: ["lib/panel.txt"] },
  }));
  write(root, FILE, TOP);
  write(root, ".sova/spec/claims/p/panel.md", "# §p/panel\n\nThe panel shows Y.\n");
  for (const f of ["one", "panel", "two"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const codes = (j) => [...j.findings.map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];
const editRecord = (root, name, id, fn) => { const rel = D(name, "manifest.json"), m = JSON.parse(read(root, rel)); fn(m.claims[id]); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
const VERIFY = "read §a.top/one and §p/panel, and lib/one.txt, which renders the panel inside one";
const docOnly = (root, name, id = "§a.top/one", verification = VERIFY) => run(root, "evidence", name, "--id", id, "--by", "tester", "--verification", verification, "--doc-only", "--write");
const promote = (root, name, id = "§a.top/one") => { const p = run(root, "promote", name, "--id", id); return p.exit ? p : run(root, "promote", name, "--id", id, "--plan", p.plan, "--write"); };
const current = (root) => JSON.parse(read(root, ".sova/spec/manifest.json")).claims;
/** A draft of `root` whose §a.top/one record gets `fn`; `prose` replaces the file's text if given. */
function draft(root, name, fn, prose) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  editRecord(root, name, "§a.top/one", fn);
  if (prose) write(root, D(name, "claims/a/top.md"), prose);
}
const bundled = (j, what) => {
  assert.equal(j.exit, 1);
  assert.deepEqual(codes(j), ["doc-only-bundled"]);
  assert.match(j.findings[0].message, what);
};

test("(1) an embeds-only change to a built behavior lands on doc-only evidence; prose and code are untouched", () => {
  const root = project();
  draft(root, "emb", (r) => { r.embeds = ["§p/panel"]; });
  assert.equal(docOnly(root, "emb").exit, 0);
  const w = promote(root, "emb");
  assert.equal(w.exit, 0, JSON.stringify(w.refusals));
  assert.deepEqual(current(root)["§a.top/one"].embeds, ["§p/panel"]);
  assert.deepEqual(current(root)["§a.top/one"].code, ["lib/one.txt"]);
  assert.equal(read(root, FILE), TOP);
  // core and about count the same way
  const r2 = project();
  draft(r2, "frame", (r) => { r.core = true; });
  assert.equal(docOnly(r2, "frame").exit, 0);
  assert.equal(promote(r2, "frame").exit, 0);
});

test("(2) a field change bundled with a prose change is refused, naming the prose", () => {
  const root = project();
  draft(root, "fp", (r) => { r.embeds = ["§p/panel"]; }, TOP.replace("One does X.", "One does X, drawn with the panel."));
  bundled(docOnly(root, "fp"), /embeds change is bundled with prose/);
  // the same change takes ordinary evidence
  assert.equal(run(root, "evidence", "fp", "--id", "§a.top/one", "--by", "tester", "--verification", "ran it", "--snapshot", "--write").exit, 0);
  assert.equal(promote(root, "fp").exit, 0);
});

test("(3) a field change bundled with a code-list change is refused", () => {
  const root = project();
  draft(root, "fc", (r) => { r.embeds = ["§p/panel"]; r.code = ["lib/one.txt", "lib/two.txt"]; });
  bundled(docOnly(root, "fc"), /bundled with the code list/);
});

test("(4) a field change bundled with a label change is refused", () => {
  const root = project();
  draft(root, "fl", (r) => { r.core = true; r.evidence = "reviewed"; });
  bundled(docOnly(root, "fl"), /core change is bundled with the evidence label/);
  const r2 = project();
  draft(r2, "fa", (r) => { r.about = ["§p/panel"]; r.authority = "migrated"; });
  bundled(docOnly(r2, "fa"), /bundled with the authority label/);
});

test("(5) removing a field is a field-only change too", () => {
  const root = project({ embeds: ["§p/panel"], core: true });
  draft(root, "rm", (r) => { delete r.embeds; delete r.core; });
  assert.equal(docOnly(root, "rm").exit, 0);
  assert.equal(promote(root, "rm").exit, 0);
  assert.equal(current(root)["§a.top/one"].embeds, undefined);
  assert.equal(current(root)["§a.top/one"].core, undefined);
});

test("(6) the agreed rule is unchanged: an agreed record is judged by it alone, and a plain prose change still needs code evidence", () => {
  // agreed and built (maps code): a field-only change is still refused doc-only, for mapping code
  const root = project({ agreed: AGREED });
  draft(root, "ag", (r) => { r.embeds = ["§p/panel"]; });
  const j = docOnly(root, "ag");
  assert.deepEqual(codes(j), ["doc-only-refused"]);
  assert.match(j.findings[0].message, /maps code/);
  // a behavior with no agreed and no field change: refused as before
  const r2 = project();
  draft(r2, "plain", () => {}, TOP.replace("One does X.", "One does X2."));
  const p = docOnly(r2, "plain");
  assert.deepEqual(codes(p), ["doc-only-refused"]);
  assert.match(p.findings[0].message, /without agreed/);
});

test("the verification text may not be empty, and a later prose edit stales field-only evidence", () => {
  const root = project();
  draft(root, "v", (r) => { r.embeds = ["§p/panel"]; });
  assert.equal(docOnly(root, "v", "§a.top/one", "   ").exit, 2);
  assert.equal(docOnly(root, "v").exit, 0);
  write(root, D("v", "claims/a/top.md"), TOP.replace("One does X.", "One does X, later."));
  const p = run(root, "promote", "v", "--id", "§a.top/one");
  assert.ok(codes(p).includes("evidence-stale"), JSON.stringify(p.refusals));
  assert.match(p.refusals.find((x) => x.code === "evidence-stale").message, /bundled with prose/);
});

test("outside-span bytes changed with an embeds change are prose: doc-only-bundled", () => {
  // a second blank line between the lede and §a.top/one: no span changes, the bytes go to every id in the file
  const root = project();
  draft(root, "gap", (r) => { r.embeds = ["§p/panel"]; }, TOP.replace("The top surface.\n\n", "The top surface.\n\n\n"));
  bundled(docOnly(root, "gap"), /embeds change is bundled with prose/);
  // a paragraph before the H1 counts the same way
  const r2 = project();
  draft(r2, "pre", (r) => { r.embeds = ["§p/panel"]; }, `Intro line.\n\n${TOP}`);
  bundled(docOnly(r2, "pre"), /embeds change is bundled with prose/);
});

test("doc-only is judged by the base kind too: a verified behavior turned into a note with new prose is refused", () => {
  const root = project();
  draft(root, "renote", (r) => { for (const k of Object.keys(r)) delete r[k]; Object.assign(r, { kind: "note", authority: "accepted" }); },
    TOP.replace("One does X.", "One is only a note now."));
  const j = docOnly(root, "renote");
  assert.deepEqual(codes(j), ["doc-only-refused"]);
  assert.match(j.findings[0].message, /kind changed from behavior to note/);
  assert.ok(codes(run(root, "promote", "renote", "--id", "§a.top/one")).includes("evidence-missing"));
  assert.equal(read(root, FILE), TOP);
});
