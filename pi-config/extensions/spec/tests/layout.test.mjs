// Cross-layout equivalence (al_6 landing 1): one spec, in format 1 (records in manifest.json) and format 2 (each
// area's records in claims/<path>.json beside its .md), gives the same answer from every core command and every
// draft-tool command. Three copies are compared:
//   A  format 1, with a two-commit history;
//   B  format 2 written by tests/spec-fixture.mjs (an independent placement, not the tools'), same history;
//   C  a copy of A converted by `migrate --write` and committed (history crosses the cutover).
// Allowed to differ: the root path, commit ids where the histories differ, and cursor tokens. Every command must
// work on A (not refused), so two identical refusals cannot pass as equivalence, and a planted record change in B
// must show, so a reader that ignores the record files cannot pass either.
// Also: a copy of Sova's own spec at HEAD, converted in a scratch dir, through the read commands.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  META, RECORDS, CLAIMS, SOURCES, CORE_DIR, REPO, SPEC, CLAIMS_POINTER, project, writeSpec, recordFiles, core, draft, codes, pages, normalizer,
  put, read, tmp, git, same, gitInit, hasGit, copyTree, hashTree, textTree, notDrafts, recordsOnDisk, layoutOnDisk, editRecords, byCodePoint, env, DRAFT,
} from "./layout/lib.mjs";

// ---------------------------------------------------------------- the fixture's own shape (independent of the tools)
test("fixture: format 2 puts each record beside its claim file, ids in code-point order, nothing in manifest.json", () => {
  const root = project(2);
  const files = recordFiles(META, RECORDS);
  assert.deepEqual(Object.keys(files), [
    "claims/ed/seed.json", "claims/ot/base.json", "claims/ot/dangle.json", "claims/ot/second.json", "claims/ot/unrelated.json",
    "claims/ot/uses.json", "claims/ot/why.json", "claims/section/bundle.json", "claims/section/ops/runbook.json",
  ]);
  for (const rel of Object.keys(files)) assert.ok(existsSync(join(root, SPEC, rel.replace(/\.json$/, ".md"))), `${rel} has its .md`);
  assert.deepEqual(Object.keys(JSON.parse(files["claims/ed/seed.json"])), ["§ed.seed/compose", "§ed.seed/save", "§ed/seed"], "code-point order, not declaration order");
  const m = JSON.parse(read(root, `${SPEC}/manifest.json`));
  assert.equal(m.formatVersion, 2);
  assert.equal(m.claims, CLAIMS_POINTER);
  assert.deepEqual(m.boundary, META.boundary);
  assert.deepEqual(recordsOnDisk(root).records, RECORDS, "every record, value for value");
  assert.equal(layoutOnDisk(root), 2);
  assert.equal(layoutOnDisk(project(1)), 1);
});

// ---------------------------------------------------------------- the shared module's interface
test("core/layout.mjs exists and exports the shared reader and writer", async () => {
  const path = join(CORE_DIR, "layout.mjs");
  assert.ok(existsSync(path), "core/layout.mjs");
  const mod = await import(pathToFileURL(path).href);
  for (const name of ["layoutOf", "readSpecFs", "readSpecGit", "recordFileOf", "isRecordFile", "serialize", "split", "canonRecords", "hasSpec"])
    assert.equal(typeof mod[name], "function", name);
  assert.equal(typeof (mod.join ?? mod.join1), "function", "join (or join1, beside path.join)");
  assert.equal(mod.CLAIMS_POINTER, CLAIMS_POINTER, "the pointer string tests/spec-fixture.mjs writes");
  assert.ok(existsSync(join(CORE_DIR, "layout.d.mts")), "types for the server's typecheck");
});

test("records: the same records and meta in both layouts, in id order", () => {
  const a = core(project(1), ["records"]).j, b = core(project(2), ["records"]).j;
  assert.equal(a.exit, 0, JSON.stringify(a));
  assert.equal(b.exit, 0, JSON.stringify(b));
  assert.equal(a.layout, 1);
  assert.equal(b.layout, 2);
  assert.deepEqual(b.records, a.records);
  assert.deepEqual(Object.keys(a.records), Object.keys(RECORDS).sort(byCodePoint));
  for (const [id, r] of Object.entries(RECORDS)) assert.equal(JSON.stringify(b.records[id]), JSON.stringify(r), `${id}: record key order kept`);
  const { formatVersion: _a, ...ma } = a.meta, { formatVersion: _b, ...mb } = b.meta;
  assert.deepEqual(mb, ma);
  const one = core(project(2), ["records", "--id", "§ot/uses", "--id", "§section.ops/runbook"]).j;
  assert.deepEqual(Object.keys(one.records), ["§ot/uses", "§section.ops/runbook"]);
});

// ---------------------------------------------------------------- the command matrix
const IDS = ["§ed/seed", "§ed.seed/compose", "§ot/base", "§ot/uses", "§ot/why", "§section/bundle", "§section.ops/runbook", "§zz/fresh"];
// [args, mayRefuse]: a refusal is allowed only where the command itself refuses the input (an H1 has no parent).
function matrix(r) {
  const m = [
    [["check"]], [["census"]], [["records"]],
    [["map"]], [["map", "ot"]], [["map", "§ed/seed"]], [["graph"]],
    [["where", "draftId"]], [["where", "src/editor.ts"]], [["where", "composer", "send", "draft"]], [["where", "Composer.send()", "--token"]],
    [["read", "--frame"]],
    [["census", "--changed", "--base", r.c0, "--related"]],
    [["foreign", "--base", r.c0, "--head", r.head]],
  ];
  for (const id of IDS) {
    m.push([["read", id]], [["read", id, "--whole"]], [["read", id, "--no-frame"]], [["scope", id]], [["impact", id]], [["impact", id, "--near"]]);
    for (const dir of ["out", "in", "down", "mentions"]) m.push([["toc", id, "--dir", dir]]);
    m.push([["toc", id, "--dir", "up"], true]);
    for (const part of ["prose", "inventory", "frontier", "code", "findings", "frame"]) m.push([["packet", id, "--part", part]]);
  }
  return m;
}
const PAGED = (r) => [["map"], ["graph"], ["where", "composer", "send", "draft"], ["toc", "§ed/seed", "--dir", "in"], ["read", "§ed/seed", "--whole"], ["impact", "§ot/base", "--near"], ["packet", "§ot/uses"], ["packet", "§ot/uses", "--part", "inventory"]];

const C1_RECORDS = { ...RECORDS, "§ot/uses": { ...RECORDS["§ot/uses"], requires: ["§ed.seed/compose", "§ot/base"] }, "§zz/fresh": { kind: "behavior", authority: "accepted", requires: ["§ot/base"], code: ["src/editor.ts"] } };
const C1_CLAIMS = { ...CLAIMS, "ot/uses.md": CLAIMS["ot/uses.md"].replace("Then it reads", "Then, on the base, it reads"), "zz/fresh.md": "# §zz/fresh — Fresh\n\nA fresh claim on the editor (§ot/base).\n" };

/** A two-commit history of the fixture in one layout: c0 the fixture, c1 a code, record, prose and new-claim change. */
function history(layout) {
  const root = project(layout);
  gitInit(root);
  const c0 = git(root, "rev-parse", "HEAD");
  writeSpec(root, { layout, meta: META, records: C1_RECORDS, claims: C1_CLAIMS });
  put(root, "src/editor.ts", SOURCES["src/editor.ts"].replace("send()", "send(draft)"));
  git(root, "add", "-A"); git(root, "commit", "-qm", "c1");
  const c1 = git(root, "rev-parse", "HEAD");
  return { root, c0, c1, head: c1, revs: { [c0]: "<c0>", [c1]: "<c1>" } };
}

function compareMatrix(A, X, label) {
  const na = normalizer({ root: A.root, revs: A.revs }), nx = normalizer({ root: X.root, revs: X.revs });
  let worked = 0;
  for (const [args, mayRefuse] of matrix(A)) {
    const argsX = args.map((a) => (a === A.c0 ? X.c0 : a === A.head ? X.head : a));
    const a = core(A.root, args).j, x = core(X.root, argsX).j;
    const refused = a.exit === 2 || a.status === "refused";
    if (!mayRefuse) assert.ok(!refused, `${label}: format 1 must answer ${args.join(" ")} (got ${JSON.stringify(a).slice(0, 400)})`);
    if (!refused) worked++;
    if (args[0] === "records") { assert.deepEqual(x.records, a.records, `${label}: records`); continue; }
    if (args[0] === "census" && args[1] === "--changed") {
      // A file count, so it differs by layout: each side must count exactly the files its own Git history changed.
      for (const [r, j, base] of [[A.root, a, A.c0], [X.root, x, argsX[3]]])
        assert.equal(j.census.changed, git(r, "diff", "--name-only", base).split("\n").filter(Boolean).length, `${label}: census.changed counts the changed files`);
      a.census.changed = x.census.changed = "<files>";
    }
    same(nx(x), na(a), `${label}: ${args.join(" ")}`);
  }
  let paged = 0;
  for (const args of PAGED(A)) {
    const pa = pages(A.root, args, { budget: 1100 }), px = pages(X.root, args, { budget: 1100 });
    if (pa.length > 1) paged++;
    same(px.map(nx), pa.map(na), `${label}: every page of ${args.join(" ")}`);
  }
  assert.ok(paged >= 3, `${label}: ${paged} commands paged at the small budget (cursors followed across layouts)`);
  assert.ok(worked > 100, `${label}: ${worked} commands answered`);
}

describe("every core command answers the same in both layouts", { skip: !hasGit }, () => {
  const A = history(1);

  test("A (format 1) against B (format 2 written independently, own history)", () => {
    const B = history(2);
    assert.equal(layoutOnDisk(B.root), 2);
    compareMatrix(A, B, "B");
  });

  test("A against C (A converted by migrate --write and committed: history crosses the cutover)", () => {
    const root = tmp();
    copyTree(A.root, root);
    const m = draft(root, ["migrate", "--write"]).j;
    assert.equal(m.exit, 0, JSON.stringify(m));
    assert.equal(layoutOnDisk(root), 2);
    git(root, "add", "-A"); git(root, "commit", "-qm", "cutover");
    const C = { root, c0: A.c0, c1: A.c1, head: git(root, "rev-parse", "HEAD"), revs: { ...A.revs } };
    C.revs[C.head] = "<c1>"; // the cutover commit stands where A's c1 does
    compareMatrix(A, C, "C");
    const f = core(root, ["foreign", "--base", A.c1, "--head", C.head]).j;
    assert.deepEqual([f.foreign, f.created, f.changes], [[], [], []], `the cutover changes nothing: ${JSON.stringify(f).slice(0, 600)}`);
  });

  test("the comparison sees the record files: one changed record in format 2 changes the answers", () => {
    const B = history(2);
    editRecords(B.root, SPEC, (r) => { r["§ot/uses"].requires = ["§ot/base"]; });
    const n = (X) => normalizer({ root: X.root, revs: X.revs });
    for (const args of [["check"], ["toc", "§ot/uses", "--dir", "out"], ["impact", "§ed.seed/compose"]])
      assert.notDeepEqual(n(B)(core(B.root, args).j), n(A)(core(A.root, args).j), args.join(" "));
  });
});

// ---------------------------------------------------------------- Sova's own spec, written both ways in scratch dirs
// The real spec at HEAD (whatever its layout), read by the fixture's own reader and written once in each layout.
describe("Sova's own spec at HEAD reads the same in both layouts", { skip: !hasGit }, () => {
  const S = tmp("spec-layout-sova-");
  const ar = spawnSync("sh", ["-c", `git -C "$1" archive HEAD .sova/spec | tar -x -C "$2"`, "sh", REPO, S], { encoding: "utf8" });
  assert.equal(ar.status, 0, ar.stderr);
  const { manifest, records } = recordsOnDisk(S);
  const claims = {};
  const croot = join(S, SPEC, "claims");
  const walk = (d, rel = "") => { for (const n of readdirSync(d)) { const p = join(d, n); if (n.endsWith(".md")) claims[rel + n] = readFileSync(p, "utf8"); else if (!n.includes(".")) walk(p, `${rel}${n}/`); } };
  walk(croot);
  const { claims: _c, formatVersion: _v, ...meta } = manifest;
  const A = writeSpec(tmp("spec-layout-sova-"), { layout: 1, meta, records, claims });
  const B = writeSpec(tmp("spec-layout-sova-"), { layout: 2, meta, records, claims });
  for (const f of [".sova/spec/README.md", ".sova/spec/USAGE.md"]) if (existsSync(join(S, f))) { put(A, f, read(S, f)); put(B, f, read(S, f)); }

  test("A is the real spec in format 1 (> 1000 records) and B holds every record in area files", () => {
    assert.equal(layoutOnDisk(A), 1);
    assert.equal(layoutOnDisk(B), 2);
    assert.ok(Object.keys(records).length > 1000);
    assert.deepEqual(recordsOnDisk(A).records, records);
    assert.deepEqual(recordsOnDisk(B).records, records);
    assert.ok(Object.keys(recordFiles(meta, records)).length > 50, "many area files");
  });

  const ids = Object.keys(records).sort(byCodePoint);
  const pick = [
    ids.find((i) => records[i].kind === "surface" && records[i].notOwned), ids.find((i) => records[i].agreed && records[i].code),
    ids.find((i) => records[i].kind === "note" && records[i].about), ids.find((i) => records[i].core === true),
    ids.find((i) => records[i].requires?.length > 2), ids.find((i) => i.includes(".") && records[i].kind === "behavior"),
  ].filter(Boolean);

  test("read commands on the real spec", () => {
    assert.ok(pick.length >= 5, JSON.stringify(pick));
    const na = normalizer({ root: A }), nb = normalizer({ root: B });
    const run = [["check"], ["map"], ["map", "app"], ["where", "server/spec-lookup.ts"], ["where", "spec", "lookup", "draft"], ["read", "--frame"], ["census"]];
    for (const id of pick) run.push(["read", id], ["toc", id, "--dir", "out"], ["toc", id, "--dir", "in"], ["impact", id], ["impact", id, "--near"], ["scope", id], ["packet", id]);
    for (const args of run) {
      const a = core(A, args).j, b = core(B, args).j;
      assert.ok(a.exit !== 2 && a.status !== "refused", `format 1 answers ${args.join(" ")}: ${JSON.stringify(a).slice(0, 300)}`);
      same(nb(b), na(a), args.join(" "));
    }
    const ga = pages(A, ["graph"]), gb = pages(B, ["graph"]);
    assert.deepEqual(gb.map(nb), ga.map(na), "graph, every page");
  });
});

// ---------------------------------------------------------------- the draft tool
// Draft answers may also differ in the plan hash (it binds the target files), timestamps of the run, and `new`'s
// file count, byte total and tree hash (the copied tree's own files).
const DRAFT_OPAQUE = ["next", "cursor", "plan", "createdAt", "recordedAt", "startedAt", "treeSha256", "fileCount", "bytes"];
const D = (rel = "") => `${SPEC}/drafts/f1/spec${rel ? `/${rel}` : ""}`;
const NEW_MD = "# §zz/new — New\n\nA new note about the base.\n";

/** The same proposal made in a draft, in the draft's own layout. */
function propose(root) {
  put(root, D("claims/ot/base.md"), "# §ot/base — Base\n\nThe base everything stands on, firmly.\n");
  put(root, D("claims/zz/new.md"), NEW_MD);
  put(root, D("claims/ot/uses.md"), CLAIMS["ot/uses.md"].replace("Then it reads", "Then it saves and reads"));
  editRecords(root, D(), (r) => {
    r["§ot/base"].requires = ["§ot/unrelated"];
    r["§zz/new"] = { kind: "note", authority: "accepted", requires: [] };
    r["§ot/uses"] = { ...r["§ot/uses"], evidence: "verified" };
  });
}
const STEPS = [
  ["status", "f1"], ["diff", "f1"], ["diff", "f1", "--against", "current"], ["check", "f1"], ["check", "f1", "--all"],
  ["evidence", "f1", "--id", "§ot/base", "--id", "§zz/new", "--by", "t", "--verification", "read it", "--doc-only", "--write"],
  ["evidence", "f1", "--id", "§ot/uses", "--by", "t", "--verification", "ran it", "--snapshot", "--write"],
  ["agree", "f1", "--id", "§zz/new", "--by", "omar (t)", "--verification", "agreed in chat", "--at", "2026-10-26T00:00Z", "--source", "chat:t", "--write"],
  ["status", "f1"], ["diff", "f1"],
];

describe("every draft-tool command answers the same in both layouts", () => {
  const A = project(1), B = project(2);
  const na = normalizer({ root: A, opaque: DRAFT_OPAQUE }), nb = normalizer({ root: B, opaque: DRAFT_OPAQUE });
  const step = (args) => { const a = draft(A, args).j, b = draft(B, args).j; same(nb(b), na(a), args.join(" ")); return [a, b]; };

  test("new copies the spec in its own layout", () => {
    const [a, b] = step(["new", "f1", "--write"]);
    assert.equal(a.exit, 0, JSON.stringify(a));
    assert.equal(layoutOnDisk(A, D()), 1);
    assert.equal(layoutOnDisk(B, D()), 2, "a format 2 project's draft is format 2");
    assert.deepEqual(textTree(B, D()), textTree(B, SPEC, { skip: notDrafts }), "a byte-exact copy of current");
    void b;
  });

  test("status, diff, check, evidence and agree on the same proposal", () => {
    propose(A); propose(B);
    for (const args of STEPS) {
      const [a] = step(args);
      assert.ok(a.exit !== 2, `${args.join(" ")}: ${JSON.stringify(a).slice(0, 500)}`);
    }
    const ea = draft(A, ["status", "f1"]).j;
    assert.ok(ea.ids.every((i) => i.evidence.state === "valid"), JSON.stringify(ea.ids.map((i) => [i.id, i.evidence])));
    assert.deepEqual(recordsOnDisk(B, D()).records, recordsOnDisk(A, D()).records, "agree wrote the same record in both");
    assert.equal(layoutOnDisk(B, D()), 2, "agree kept the draft in format 2");
  });

  test("promote: same plan answer; format 2 writes only the changed areas' files", () => {
    const sel = ["--id", "§ot/base", "--id", "§zz/new", "--id", "§ot/uses"];
    // The write targets are files, so they differ by layout: the prose targets must match, and the record targets
    // must be manifest.json in format 1 and exactly the three changed areas' files in format 2.
    const pa = draft(A, ["promote", "f1", ...sel]).j, pb = draft(B, ["promote", "f1", ...sel]).j;
    assert.equal(pa.exit, 0, JSON.stringify(pa).slice(0, 800));
    const md = (t) => t.filter((x) => x.path.endsWith(".md")), rec = (t) => t.filter((x) => !x.path.endsWith(".md")).map((x) => [x.path, x.action]);
    same(md(pb.targets), md(pa.targets), "prose targets");
    assert.deepEqual(rec(pa.targets), [["manifest.json", "replace"]]);
    assert.deepEqual(rec(pb.targets).filter(([p]) => p !== "manifest.json").sort(), [["claims/ot/base.json", "replace"], ["claims/ot/uses.json", "replace"], ["claims/zz/new.json", "create"]]);
    assert.ok(pb.targets.every((t) => t.path !== "manifest.json" || t.before === t.after), "format 2 never rewrites manifest.json for a record change");
    same(nb({ ...pb, targets: "<files>" }), na({ ...pa, targets: "<files>" }), "promote preview");
    const before = { a: hashTree(A, SPEC, { skip: notDrafts }), b: hashTree(B, SPEC, { skip: notDrafts }) };
    const mBefore = read(B, `${SPEC}/manifest.json`);
    const wa = draft(A, ["promote", "f1", ...sel, "--plan", pa.plan, "--write"]).j, wb = draft(B, ["promote", "f1", ...sel, "--plan", pb.plan, "--write"]).j;
    assert.equal(wa.exit, 0, JSON.stringify(wa).slice(0, 800));
    same(nb({ ...wb, targets: "<files>" }), na({ ...wa, targets: "<files>" }), "promote --write");
    const changed = (x, b4) => { const now = hashTree(x, SPEC, { skip: notDrafts }); return [...new Set([...Object.keys(now), ...Object.keys(b4)])].filter((k) => now[k] !== b4[k]).sort(); };
    assert.deepEqual(changed(A, before.a), ["claims/ot/base.md", "claims/ot/uses.md", "claims/zz/new.md", "manifest.json"]);
    assert.deepEqual(changed(B, before.b), ["claims/ot/base.json", "claims/ot/base.md", "claims/ot/uses.json", "claims/ot/uses.md", "claims/zz/new.json", "claims/zz/new.md"], "only the touched areas; manifest.json untouched");
    assert.equal(read(B, `${SPEC}/manifest.json`), mBefore);
    const ra = recordsOnDisk(A).records, rb = recordsOnDisk(B).records;
    assert.deepEqual(rb, ra, "the same records landed");
    const want = recordFiles(META, rb);
    for (const [rel, text] of Object.entries(want)) assert.equal(read(B, `${SPEC}/${rel}`), text, `${rel}: canonical bytes`);
    assert.deepEqual(textTree(B, `${SPEC}/claims`, { skip: (r) => r.endsWith(".json") }), textTree(A, `${SPEC}/claims`), "the same prose");
    const ca = core(A, ["check"]).j, cb = core(B, ["check"]).j;
    assert.deepEqual(normalizer({ root: B })(cb), normalizer({ root: A })(ca), "check after promotion");
  });

  test("recover with nothing pending", () => { step(["recover"]); });
});

// ---------------------------------------------------------------- an interrupted format 2 promotion rolls back
for (const layout of [1, 2]) test(`an interrupted promotion (format ${layout}) is rolled back by recover, then promotes`, { skip: process.platform === "win32" }, () => {
  const root = project(layout);
  assert.equal(draft(root, ["new", "f1", "--write"]).j.exit, 0);
  propose(root);
  assert.equal(draft(root, ["evidence", "f1", "--id", "§ot/base", "--id", "§zz/new", "--by", "t", "--verification", "read", "--doc-only", "--write"]).j.exit, 0);
  assert.equal(draft(root, ["evidence", "f1", "--id", "§ot/uses", "--by", "t", "--verification", "ran", "--snapshot", "--write"]).j.exit, 0);
  const before = hashTree(root, SPEC, { skip: notDrafts });
  // Test-only preload: the process dies right after the first file lands in the current spec.
  const preload = join(root, "die-after-first-write.mjs");
  put(root, "die-after-first-write.mjs", `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const real = fs.promises.rename;
fs.promises.rename = async (a, b, ...r) => { const out = await real(a, b, ...r); if (!String(b).includes("/drafts/")) process.exit(9); return out; };
syncBuiltinESMExports();\n`);
  const sel = ["--id", "§ot/base", "--id", "§zz/new", "--id", "§ot/uses"];
  const r = spawnSync(process.execPath, ["--import", preload, DRAFT, "promote", "f1", ...sel, "--write", "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  assert.equal(r.status, 9, `the promotion died mid-way: ${r.stdout}${r.stderr}`);
  assert.notDeepEqual(hashTree(root, SPEC, { skip: notDrafts }), before, "one file was applied before it died");
  assert.ok(existsSync(join(root, SPEC, "drafts/.txn/journal.json")), "the journal is left");
  const pv = draft(root, ["recover"]).j;
  assert.equal(pv.pending, true, JSON.stringify(pv));
  if (layout === 2) assert.ok(pv.targets.every((t) => t.path !== "manifest.json" || t.before === t.after), `format 2 journals the area files: ${JSON.stringify(pv.targets)}`);
  const w = draft(root, ["recover", "--write"]).j;
  assert.equal(w.exit, 0, JSON.stringify(w));
  assert.deepEqual(hashTree(root, SPEC, { skip: notDrafts }), before, "rolled back to the bytes before the promotion");
  assert.equal(draft(root, ["promote", "f1", ...sel, "--write"]).j.exit, 0);
  assert.equal(layoutOnDisk(root), layout);
});
