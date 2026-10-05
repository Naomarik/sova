// Per-declaration (span) promotion: black-box fixture tests for core/sova-spec-draft.mjs. Node stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const sha = (s) => createHash("sha256").update(s).digest("hex");

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const CLAIMS = {
  "§a/top": { kind: "surface", authority: "accepted" },
  "§a.top/one": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/one.txt"] },
  "§a.top/two": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/two.txt"] },
};
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n\n### Detail\n\nPlain H3 prose.\n\n## §a.top/two\n\nTwo does Y.\n";
const FILE = ".sova/spec/claims/a/top.md";
function project(top = TOP) {
  const root = mkdtempSync(join(tmpdir(), "sova-draft-span-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", manifest(CLAIMS));
  write(root, FILE, top);
  for (const f of ["one", "two", "new"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
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
const D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const newDraft = (root, name = "f1") => assert.equal(run(root, "new", name, "--write").exit, 0);
const snap = (root, name, ...ids) => run(root, "evidence", name, ...ids.flatMap((i) => ["--id", i]), "--by", "tester", "--verification", "ran the suite: pass", "--snapshot", "--write");
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
const addRecord = (root, rel, id) => editManifest(root, rel, (m) => { m.claims[id] = { kind: "behavior", authority: "accepted", requires: [], code: ["lib/new.txt"] }; });
function tree(root, sub) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = sha(readFileSync(p)); } };
  if (existsSync(join(root, sub))) walk(join(root, sub));
  return out;
}
/** Draft edits `draftTop` (with optional new records); meanwhile current becomes `curTop`. → promote --write result */
function race(top, draftTop, curTop, { draftIds = [], curIds = [], curGone = [], select } = {}) {
  const root = project(top);
  newDraft(root);
  write(root, D("f1", "claims/a/top.md"), draftTop);
  for (const id of draftIds) addRecord(root, D("f1", "manifest.json"), id);
  write(root, FILE, curTop);
  for (const id of curIds) addRecord(root, ".sova/spec/manifest.json", id);
  for (const id of curGone) editManifest(root, ".sova/spec/manifest.json", (m) => { delete m.claims[id]; });
  write(root, "lib/one.txt", "one v2\n");
  snap(root, "f1", ...select);
  const before = { cur: tree(root, ".sova/spec/claims"), drafts: tree(root, ".sova/spec/drafts") };
  const preview = run(root, "promote", "f1", ...select.flatMap((i) => ["--id", i]));
  const w = run(root, "promote", "f1", ...select.flatMap((i) => ["--id", i]), ...(preview.plan ? ["--plan", preview.plan] : []), "--write");
  return { root, preview, w, before, text: read(root, FILE) };
}
const insertAfterOne = (top, id, prose) => top.replace("## §a.top/two", `## ${id}\n\n${prose}\n\n## §a.top/two`);

test("different declarations of one file merge: the draft's span lands, current's stays, H3 prose kept", () => {
  const r = race(TOP, TOP.replace("One does X.", "One does X, said by the draft."), TOP.replace("Two does Y.", "Two does Y, said by current."), { select: ["§a.top/one"] });
  assert.equal(r.w.exit, 0, JSON.stringify(r.w.refusals));
  assert.deepEqual(r.w.files, [{ path: "claims/a/top.md", merge: "merge", ids: ["§a.top/one"] }]);
  assert.equal(r.text, TOP.replace("One does X.", "One does X, said by the draft.").replace("Two does Y.", "Two does Y, said by current."));
  // publication and its receipt land together; afterwards the draft reads as already current
  const d = JSON.parse(read(r.root, ".sova/spec/drafts/f1/draft.json"));
  assert.equal(d.promotions.length, 1);
  assert.equal(d.promotions[0].plan, r.preview.plan);
  assert.ok(!existsSync(join(r.root, ".sova/spec/drafts/.txn")));
  assert.equal(run(r.root, "status", "f1").ids[0].current, "already-current");
});

test("the same declaration changed on both sides still stops, naming it; nothing is written", () => {
  const r = race(TOP, TOP.replace("One does X.", "One does X, said by the draft."), TOP.replace("One does X.", "One does X, said by current."), { select: ["§a.top/one"] });
  assert.equal(r.w.exit, 1);
  assert.ok(codes(r.w).includes("conflict"));
  assert.match(r.w.refusals.find((x) => x.code === "conflict").message, /claims\/a\/top\.md: §a\.top\/one/);
  assert.deepEqual(tree(r.root, ".sova/spec/claims"), r.before.cur);
  assert.deepEqual(tree(r.root, ".sova/spec/drafts"), r.before.drafts);
  assert.match(read(r.root, D("f1", "claims/a/top.md")), /said by the draft/);
  assert.equal(run(r.root, "status", "f1").ids[0].current, "conflict");
});

test("deleted on one side and changed on the other is a conflict, both ways", () => {
  const gone = TOP.replace("## §a.top/two\n\nTwo does Y.\n", "").replace(/\n\n$/, "\n");
  const a = race(TOP, gone, TOP.replace("Two does Y.", "Two does Y, kept by current.").replace("The top surface.", "The top surface, edited."), { select: ["§a.top/two"] });
  assert.ok(codes(a.w).includes("conflict"), JSON.stringify(a.w.refusals));
  assert.match(a.text, /kept by current/);
  const b = race(TOP, TOP.replace("Two does Y.", "Two does Y, said by the draft.").replace("The top surface.", "The top surface, drafted."), gone, { select: ["§a.top/two", "§a/top"] });
  assert.ok(codes(b.w).includes("conflict"), JSON.stringify(b.w.refusals));
});

test("both sides add an H2 at the same spot: both kept, ordered by id, the same bytes whichever landed first", () => {
  const withA = insertAfterOne(TOP, "§a.top/alpha", "Alpha, added by one side.");
  const withZ = insertAfterOne(TOP, "§a.top/zeta", "Zeta, added by the other side.");
  const r1 = race(TOP, withA, withZ, { draftIds: ["§a.top/alpha"], curIds: ["§a.top/zeta"], select: ["§a.top/alpha"] });
  const r2 = race(TOP, withZ, withA, { draftIds: ["§a.top/zeta"], curIds: ["§a.top/alpha"], select: ["§a.top/zeta"] });
  assert.equal(r1.w.exit, 0, JSON.stringify(r1.w.refusals));
  assert.equal(r2.w.exit, 0, JSON.stringify(r2.w.refusals));
  assert.equal(r1.text, r2.text);
  assert.equal(r1.text, insertAfterOne(withA, "§a.top/zeta", "Zeta, added by the other side."));
  // a run of several new H2s stays together
  const run2 = insertAfterOne(insertAfterOne(TOP, "§a.top/beta", "Beta."), "§a.top/yak", "Yak.");
  const r3 = race(TOP, run2, insertAfterOne(TOP, "§a.top/gamma", "Gamma."), { draftIds: ["§a.top/beta", "§a.top/yak"], curIds: ["§a.top/gamma"], select: ["§a.top/beta", "§a.top/yak"] });
  assert.equal(r3.w.exit, 0, JSON.stringify(r3.w.refusals));
  const at = (id) => r3.text.indexOf(`## ${id}`);
  assert.ok(at("§a.top/beta") < at("§a.top/yak") && at("§a.top/yak") < at("§a.top/gamma"), r3.text);
});

test("both sides append at the end of the file: a blank line separates them, the same bytes either way", () => {
  const add = (id, prose) => `${TOP}\n## ${id}\n\n${prose}\n`;
  const r1 = race(TOP, add("§a.top/alpha", "Alpha."), add("§a.top/zeta", "Zeta."), { draftIds: ["§a.top/alpha"], curIds: ["§a.top/zeta"], select: ["§a.top/alpha"] });
  const r2 = race(TOP, add("§a.top/zeta", "Zeta."), add("§a.top/alpha", "Alpha."), { draftIds: ["§a.top/zeta"], curIds: ["§a.top/alpha"], select: ["§a.top/zeta"] });
  assert.equal(r1.w.exit, 0, JSON.stringify(r1.w.refusals));
  assert.equal(r1.text, `${TOP}\n## §a.top/alpha\n\nAlpha.\n\n## §a.top/zeta\n\nZeta.\n`);
  assert.equal(r2.text, r1.text);
});

test("the same new H2 added identically on both sides is taken once; differently, it conflicts", () => {
  const withA = insertAfterOne(TOP, "§a.top/alpha", "Alpha.");
  const same = race(TOP, withA.replace("One does X.", "One does X2."), withA, { draftIds: ["§a.top/alpha"], curIds: ["§a.top/alpha"], select: ["§a.top/one", "§a.top/alpha"] });
  assert.equal(same.w.exit, 0, JSON.stringify(same.w.refusals));
  assert.equal(same.text, withA.replace("One does X.", "One does X2."));
  const diff = race(TOP, withA, insertAfterOne(TOP, "§a.top/alpha", "Alpha, differently."), { draftIds: ["§a.top/alpha"], curIds: ["§a.top/alpha"], select: ["§a.top/alpha"] });
  assert.ok(codes(diff.w).includes("conflict"));
});

test("an H2 added after one the other side deleted is a conflict", () => {
  const gone = TOP.replace("## §a.top/one\n\nOne does X.\n\n### Detail\n\nPlain H3 prose.\n\n", "");
  const r = race(TOP, insertAfterOne(TOP, "§a.top/alpha", "Alpha."), gone.replace("Two does Y.", "Two does Y2."), { draftIds: ["§a.top/alpha"], curGone: ["§a.top/one"], select: ["§a.top/alpha"] });
  assert.ok(codes(r.w).includes("conflict"), JSON.stringify(r.w.refusals));
  assert.match(r.w.refusals.find((x) => x.code === "conflict").message, /§a\.top\/alpha \(added after §a\.top\/one/);
});

test("bytes outside spans merge as their gap: one side's change is kept, both changing one gap conflicts", () => {
  // the draft adds blank lines after §a.top/one; current edits §a.top/two: both land
  const gap = TOP.replace("Plain H3 prose.\n\n", "Plain H3 prose.\n\n\n\n");
  const r = race(TOP, gap.replace("One does X.", "One does X2."), TOP.replace("Two does Y.", "Two does Y2."), { select: ["§a.top/one"] });
  assert.equal(r.w.exit, 0, JSON.stringify(r.w.refusals));
  assert.equal(r.text, gap.replace("One does X.", "One does X2.").replace("Two does Y.", "Two does Y2."));
  // both sides change the bytes before the lede, differently
  const pre = race(TOP, `<!-- draft -->\n${TOP.replace("One does X.", "One does X2.")}`, `<!-- current -->\n${TOP}`, { select: ["§a.top/one"] });
  assert.ok(codes(pre.w).includes("conflict"));
  assert.match(pre.w.refusals.find((x) => x.code === "conflict").message, /before the lede/);
});

test("a reorder, or a carriage return, is still compared as a whole file", () => {
  const swapped = "# §a/top\n\nThe top surface.\n\n## §a.top/two\n\nTwo does Y.\n\n## §a.top/one\n\nOne does X.\n\n### Detail\n\nPlain H3 prose.\n";
  const r = race(TOP, swapped.replace("One does X.", "One does X2."), TOP.replace("Two does Y.", "Two does Y2."), { select: ["§a.top/one"] });
  assert.ok(codes(r.w).includes("conflict"));
  assert.match(r.w.refusals.find((x) => x.code === "conflict").message, /claims\/a\/top\.md changed in current/);
  const crlf = race(TOP, TOP.replace("One does X.", "One does X2."), TOP.replace("Two does Y.\n", "Two does Y.\r\n"), { select: ["§a.top/one"] });
  assert.ok(codes(crlf.w).includes("conflict"));
});

test("a per-declaration merge is deterministic: preview and write agree on the plan, and a re-preview repeats it", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/a/top.md"), TOP.replace("One does X.", "One does X2."));
  write(root, FILE, TOP.replace("Two does Y.", "Two does Y2."));
  write(root, "lib/one.txt", "one v2\n");
  snap(root, "f1", "§a.top/one");
  const p1 = run(root, "promote", "f1", "--id", "§a.top/one"), p2 = run(root, "promote", "f1", "--id", "§a.top/one");
  assert.equal(p1.exit, 0, JSON.stringify(p1.refusals));
  assert.equal(p1.plan, p2.plan);
  // current moves after the preview: the old plan is refused, nothing written
  write(root, FILE, TOP.replace("Two does Y.", "Two does Y3."));
  const w = run(root, "promote", "f1", "--id", "§a.top/one", "--plan", p1.plan, "--write");
  assert.ok(codes(w).includes("plan-changed"));
  assert.equal(read(root, FILE), TOP.replace("Two does Y.", "Two does Y3."));
});
