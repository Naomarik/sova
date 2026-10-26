// `sova-spec-draft.mjs migrate` (al_6): the one-shot, reversible conversion between format 1 (records in
// manifest.json) and format 2 (records beside each claim file). Its output is compared with tests/spec-fixture.mjs's
// independent writer byte for byte; the round trip is checked record by record and as a fixed point; every refusal
// writes nothing; a corrupted write is caught by the identity check and rolled back; drafts convert on request,
// keep their old form for the reverse, and answer status/diff exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  META, RECORDS, CLAIMS, SPEC, CLAIMS_POINTER, DRAFT, project, core, draft, codes, put, read, git, gitInit, hasGit, hashTree, textTree, notDrafts,
  recordsOnDisk, layoutOnDisk, editRecords, recordFiles, same, env,
} from "./layout/lib.mjs";

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const current = (root) => hashTree(root, SPEC, { skip: notDrafts });
const clean = (layout = 1) => (hasGit ? gitInit(project(layout)) : project(layout));
const meta = (m) => { const { claims: _c, formatVersion: _v, ...rest } = m; return rest; };
const graphOf = (root) => { const g = core(root, ["graph"]).j; return { nodes: g.nodes, edges: g.edges, counts: g.counts }; };
const checkOf = (root) => { const c = core(root, ["check"]).j; return { declarations: c.declarations, counts: c.counts, findings: c.findings, frontier: c.frontier, code: c.code }; };

// ---------------------------------------------------------------- dry run and forward
test("migrate previews without writing: counts and a passed round trip", () => {
  const root = clean();
  const before = current(root);
  const j = draft(root, ["migrate"]).j;
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.equal(j.written, false);
  assert.deepEqual([j.from, j.to, j.records, j.recordFiles], [1, 2, Object.keys(RECORDS).length, Object.keys(recordFiles(META, RECORDS)).length]);
  assert.ok(j.identity && Object.values(j.identity).length >= 4 && Object.values(j.identity).every((v) => v === true), JSON.stringify(j.identity));
  assert.deepEqual(current(root), before, "the preview writes nothing");
});

test("migrate --write: the record files are exactly the independent writer's bytes; the prose is untouched", () => {
  const root = clean();
  const prose = textTree(root, `${SPEC}/claims`);
  const [chk, graph] = [checkOf(root), graphOf(root)];
  const j = draft(root, ["migrate", "--write"]).j;
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.equal(j.written, true);
  assert.equal(layoutOnDisk(root), 2);
  const want = recordFiles(META, RECORDS);
  const got = textTree(root, SPEC, { skip: (r) => notDrafts(r) || r === "manifest.json" || r.endsWith(".md") });
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "one record file per area, nothing else");
  for (const [rel, text] of Object.entries(want)) assert.equal(got[rel], text, `${rel}: sorted ids, 2-space indent, trailing newline`);
  const m = JSON.parse(read(root, `${SPEC}/manifest.json`));
  assert.equal(m.formatVersion, 2);
  assert.equal(m.claims, CLAIMS_POINTER);
  assert.deepEqual(meta(m), meta({ ...META }), "every other key kept");
  assert.ok(read(root, `${SPEC}/manifest.json`).endsWith("}\n"));
  assert.deepEqual(textTree(root, `${SPEC}/claims`, { skip: (r) => r.endsWith(".json") }), prose, "claim files byte-identical");
  same(checkOf(root), chk, "check after migrate");
  same(graphOf(root), graph, "graph after migrate");
});

// ---------------------------------------------------------------- reverse and the fixed point
test("migrate --reverse --write: back to format 1, record for record; forward again gives the same bytes", () => {
  const root = clean();
  const v1 = JSON.parse(read(root, `${SPEC}/manifest.json`));
  assert.equal(draft(root, ["migrate", "--write"]).j.exit, 0);
  if (hasGit) { git(root, "add", "-A"); git(root, "commit", "-qm", "v2"); }
  const v2 = current(root);
  const r = draft(root, ["migrate", "--reverse", "--write"]).j;
  assert.equal(r.exit, 0, JSON.stringify(r));
  assert.deepEqual([r.from, r.to], [2, 1]);
  assert.equal(layoutOnDisk(root), 1);
  const back = JSON.parse(read(root, `${SPEC}/manifest.json`));
  assert.equal(back.formatVersion, 1);
  assert.deepEqual(meta(back), meta(v1));
  assert.deepEqual(Object.keys(back.claims).sort(), Object.keys(v1.claims).sort(), "the same ids");
  for (const id of Object.keys(v1.claims)) assert.equal(JSON.stringify(back.claims[id]), JSON.stringify(v1.claims[id]), `${id}: the same record, key order included`);
  assert.equal(readdirSync(join(root, SPEC, "claims/ot")).some((n) => n.endsWith(".json")), false, "no record file left");
  const v1again = read(root, `${SPEC}/manifest.json`);
  if (hasGit) { git(root, "add", "-A"); git(root, "commit", "-qm", "v1 again"); }
  assert.equal(draft(root, ["migrate", "--write"]).j.exit, 0);
  assert.deepEqual(current(root), v2, "forward again: byte-identical format 2 (a fixed point)");
  if (hasGit) { git(root, "add", "-A"); git(root, "commit", "-qm", "v2 again"); }
  assert.equal(draft(root, ["migrate", "--reverse", "--write"]).j.exit, 0);
  assert.equal(read(root, `${SPEC}/manifest.json`), v1again, "reverse again: byte-identical format 1 (a fixed point)");
  assert.deepEqual(recordsOnDisk(root).records, v1.claims);
});

test("migrate --reverse groups records by area, so a later promotion's diff stays inside its area", () => {
  const root = clean(2);
  assert.equal(draft(root, ["migrate", "--reverse", "--write"]).j.exit, 0);
  const ids = Object.keys(JSON.parse(read(root, `${SPEC}/manifest.json`)).claims);
  const area = (id) => id.slice(0, id.indexOf("/"));
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    if (i && area(ids[i]) === area(ids[i - 1])) continue;
    assert.ok(!seen.has(area(ids[i])), `area ${area(ids[i])} is contiguous: ${ids.join(", ")}`);
    seen.add(area(ids[i]));
  }
});

// ---------------------------------------------------------------- refusals write nothing
const REFUSALS = [
  ["already format 2", (r) => { assert.equal(draft(r, ["migrate", "--write"]).j.exit, 0); if (hasGit) { git(r, "add", "-A"); git(r, "commit", "-qm", "v2"); } }, [], ["already-v2"]],
  ["--reverse on format 1", () => {}, ["--reverse"], ["already-v1"]],
  ["a pending promotion transaction", (r) => put(r, `${SPEC}/drafts/.txn/journal.json`, JSON.stringify({ format: "sova-spec-draft/1", draft: "x", startedAt: "x", pid: 1, targets: [] })), [], ["txn-pending", "pending-transaction"]],
  ["a held drafts lock", (r) => put(r, `${SPEC}/drafts/.lock`, `${process.pid} other-host tok 2026`), [], ["locked", "lock-occupied"]],
];
if (hasGit) REFUSALS.push(["a dirty .sova/spec", (r) => put(r, `${SPEC}/claims/ot/base.md`, "# §ot/base — Base\n\nEdited, not committed.\n"), [], ["migrate-dirty"]],
  ["an untracked file in .sova/spec", (r) => put(r, `${SPEC}/claims/ot/new.md`, "# §ot/new — New\n\nUntracked.\n"), [], ["migrate-dirty"]]);
for (const [name, arrange, extra, want] of REFUSALS) test(`migrate refuses ${name} and writes nothing`, () => {
  const root = clean();
  arrange(root);
  const before = hashTree(root, SPEC);
  const j = draft(root, ["migrate", ...extra, "--write"]).j;
  assert.notEqual(j.exit, 0, JSON.stringify(j));
  assert.ok(codes(j).some((c) => want.includes(c)), `${want.join("|")} in ${JSON.stringify(codes(j))}`);
  assert.deepEqual(hashTree(root, SPEC), before, "nothing written");
});

// ---------------------------------------------------------------- the identity check reads back from disk
// Two corruptions: one the core's check sees (a label: its counts change), one it cannot (who agreed: no count or
// edge holds it). "Every record identical before and after" must catch both, so it reads the records back from disk.
for (const [name, file, from, to] of [
  ["a label (visible to check)", "ot", '"accepted"', '"migrated"'],
  ["who agreed (invisible to check)", "ed", '"omar (t)"', '"mallory"'],
]) test(`a record file corrupted on its way to disk, ${name}: migrate never reports it done`, { skip: process.platform === "win32" }, () => {
  const root = clean();
  const before = hashTree(root, SPEC);
  // The same conversion, uncorrupted, passes: so the refusal below can only come from the corruption.
  const ok = draft(root, ["migrate"]).j;
  assert.equal(ok.exit, 0, `the clean conversion must pass first: ${JSON.stringify(ok)}`);
  const preload = join(root, ".home/corrupt.mjs");
  const re = `/claims[\\\\/]${file}[\\\\/]/`;
  put(root, ".home/corrupt.mjs", `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const hit = (p, t) => ${re}.test(String(p)) && t.includes(${JSON.stringify(from)});
const bad = (p, d) => typeof d === "string" ? (hit(p, d) ? d.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}) : d) : Buffer.isBuffer(d) && hit(p, d.toString()) ? Buffer.from(d.toString().replace(${JSON.stringify(from)}, ${JSON.stringify(to)})) : d;
const w = fs.promises.writeFile; fs.promises.writeFile = (p, d, ...r) => w(p, bad(p, d), ...r);
const ws = fs.writeFileSync; fs.writeFileSync = (p, d, ...r) => ws(p, bad(p, d), ...r);
syncBuiltinESMExports();\n`);
  const r = spawnSync(process.execPath, ["--import", preload, DRAFT, "migrate", "--write", "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  const j = JSON.parse(r.stdout);
  assert.notEqual(r.status, 0, `the corrupted conversion must not finish: ${r.stdout}`);
  assert.notEqual(j.written, true);
  if (to === '"migrated"') { // seen by check: caught before anything is written, and nothing is
    assert.ok(codes(j).includes("identity-failed"), JSON.stringify(codes(j)));
    assert.ok(Object.values(j.identity ?? {}).includes(false), JSON.stringify(j.identity));
    assert.deepEqual(hashTree(root, SPEC), before, "rolled back to format 1, byte for byte");
    assert.equal(existsSync(join(root, SPEC, "drafts/.txn")), false, "no transaction left pending");
  } else { // unseen by check: the write's own read-back catches it; it never reports success
    assert.ok(codes(j).some((c) => ["identity-failed", "race", "rollback-failed", "write-failed"].includes(c)), JSON.stringify(codes(j)));
  }
});

// ---------------------------------------------------------------- drafts
const NOTE = "# §zz/new — New\n\nA new note.\n";
function withDraft(root, name, layoutOfEdit) {
  assert.equal(draft(root, ["new", name, "--write"]).j.exit, 0);
  const D = `${SPEC}/drafts/${name}/spec`;
  put(root, `${D}/claims/zz/new.md`, NOTE);
  put(root, `${D}/claims/ot/base.md`, "# §ot/base — Base\n\nThe base, restated.\n");
  editRecords(root, D, (r) => { r["§zz/new"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/base"].requires = ["§ot/unrelated"]; });
  assert.equal(draft(root, ["evidence", name, "--id", "§zz/new", "--id", "§ot/base", "--by", "t", "--verification", "read", "--doc-only", "--write"]).j.exit, 0);
  void layoutOfEdit;
  return D;
}
const answers = (root, name) => ({ status: draft(root, ["status", name]).j, diff: draft(root, ["diff", name]).j, check: draft(root, ["check", name]).j });

test("migrate --drafts --write converts every draft, keeps its old manifests, and status/diff/check answer exactly as before", () => {
  const root = clean();
  const D1 = withDraft(root, "f1"), D2 = withDraft(root, "f2");
  const before = { f1: answers(root, "f1"), f2: answers(root, "f2") };
  const old = { f1: read(root, `${D1}/manifest.json`), f1base: read(root, `${SPEC}/drafts/f1/base/manifest.json`) };
  const j = draft(root, ["migrate", "--drafts", "--write"]).j;
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.deepEqual(j.drafts.flatMap((d) => d.parts.map((p) => [d.name, p.side, p.from, p.to])).sort(), [["f1", "base", 1, 2], ["f1", "spec", 1, 2], ["f2", "base", 1, 2], ["f2", "spec", 1, 2]]);
  assert.equal(j.identity?.drafts, true, "the drafts' round trip is part of the identity check");
  for (const n of ["f1", "f2"]) {
    assert.equal(layoutOnDisk(root, `${SPEC}/drafts/${n}/spec`), 2, `${n} spec`);
    assert.equal(layoutOnDisk(root, `${SPEC}/drafts/${n}/base`), 2, `${n} base`);
    same(answers(root, n), before[n], `${n}: status/diff/check unchanged, evidence included`);
  }
  // the plan names drafts/<n>/.v1/; the tool keeps them under drafts/<n>/.layout-backup/v1/: either is the old form, kept
  const kept = (side) => [`${SPEC}/drafts/f1/.v1/${side}/manifest.json`, `${SPEC}/drafts/f1/.layout-backup/v1/${side}/manifest.json`].find((p) => existsSync(join(root, p)));
  assert.ok(kept("spec") && kept("base"), "the old draft and base manifests are kept");
  assert.equal(read(root, kept("spec")), old.f1, "the old draft manifest, byte for byte");
  assert.equal(read(root, kept("base")), old.f1base, "the old base manifest, byte for byte");
  assert.ok(draft(root, ["status", "f1"]).j.ids.every((i) => i.evidence.state === "valid"), "evidence still valid");
  // and the converted draft promotes into the converted current
  const p = draft(root, ["promote", "f1", "--id", "§zz/new", "--id", "§ot/base", "--write"]).j;
  assert.equal(p.exit, 0, JSON.stringify(p).slice(0, 600));
  assert.equal(layoutOnDisk(root), 2);
  assert.equal(read(root, `${SPEC}/claims/zz/new.json`), recordFiles(META, { "§zz/new": { kind: "note", authority: "accepted", requires: [] } })["claims/zz/new.json"]);
});

test("migrate --draft NAME converts that draft only, and leaves current alone", () => {
  const root = clean();
  withDraft(root, "f1"); withDraft(root, "f2");
  const cur = current(root);
  const j = draft(root, ["migrate", "--draft", "f1", "--write"]).j;
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.equal(layoutOnDisk(root, `${SPEC}/drafts/f1/spec`), 2);
  assert.equal(layoutOnDisk(root, `${SPEC}/drafts/f2/spec`), 1, "f2 untouched");
  assert.deepEqual(current(root), cur, "current untouched");
});

test("migrate --reverse --drafts restores each draft's old bytes when they still match, and re-joins an edited one", () => {
  const root = clean();
  const D1 = withDraft(root, "f1"), D2 = withDraft(root, "f2");
  const old = { f1: read(root, `${D1}/manifest.json`), f2: read(root, `${D2}/manifest.json`) };
  assert.equal(draft(root, ["migrate", "--drafts", "--write"]).j.exit, 0);
  if (hasGit) { git(root, "add", "-A"); git(root, "commit", "-qm", "v2"); }
  editRecords(root, D2, (r) => { r["§zz/new"].requires = ["§ot/base"]; }); // f2 edited after the conversion
  const edited = recordsOnDisk(root, D2).records;
  const j = draft(root, ["migrate", "--reverse", "--drafts", "--write"]).j;
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.equal(read(root, `${D1}/manifest.json`), old.f1, "f1 restored byte for byte");
  assert.equal(layoutOnDisk(root, D2), 1);
  assert.notEqual(read(root, `${D2}/manifest.json`), old.f2, "f2's edit is not thrown away");
  assert.deepEqual(recordsOnDisk(root, D2).records, edited, "f2 re-joined with its edit");
  assert.equal(layoutOnDisk(root), 1, "current reversed too");
});

test("open work at the cutover: a format 1 draft promotes into a converted current, its evidence valid, writing format 2", () => {
  const root = clean();
  withDraft(root, "f1");
  assert.equal(draft(root, ["migrate", "--write"]).j.exit, 0, "current only, the draft is left in format 1");
  assert.equal(layoutOnDisk(root, `${SPEC}/drafts/f1/spec`), 1);
  const s = draft(root, ["status", "f1"]).j;
  assert.ok(s.ids.every((i) => i.evidence.state === "valid"), JSON.stringify(s.ids.map((i) => i.evidence)));
  const m0 = read(root, `${SPEC}/manifest.json`);
  const p = draft(root, ["promote", "f1", "--id", "§zz/new", "--id", "§ot/base", "--write"]).j;
  assert.equal(p.exit, 0, JSON.stringify(p).slice(0, 600));
  assert.equal(layoutOnDisk(root), 2, "promotion writes current's layout");
  assert.equal(read(root, `${SPEC}/manifest.json`), m0, "manifest.json untouched");
  assert.deepEqual(recordsOnDisk(root).records["§ot/base"].requires, ["§ot/unrelated"]);
  const c = core(root, ["check"]).j;
  assert.ok(c.exit <= 1, JSON.stringify(codes(c)));
});

test("a format 2 project's new draft promotes back into format 2 without touching manifest.json or other areas", () => {
  const root = clean(2);
  const before = current(root);
  withDraft(root, "f1");
  assert.equal(draft(root, ["promote", "f1", "--id", "§zz/new", "--id", "§ot/base", "--write"]).j.exit, 0);
  const now = current(root);
  const changed = Object.keys({ ...now, ...before }).filter((k) => now[k] !== before[k]).sort();
  assert.deepEqual(changed, ["claims/ot/base.json", "claims/ot/base.md", "claims/zz/new.json", "claims/zz/new.md"]);
  void CLAIMS;
});
