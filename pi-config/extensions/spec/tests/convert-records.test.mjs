// al_6 landing 2, check (1): the cutover commit changes the layout of Sova's REAL spec and nothing else.
// Records are dumped from Git objects at the cutover's first parent (format 1: manifest.json's `claims`) and at
// the cutover (format 2: claims/**/*.json), by this file's own reader (tests/convert/lib.mjs), and compared
// canonically AND byte for byte per record; then the tools' own instruments (`records --at`, `foreign`) must agree.
// Until the cutover commit is on HEAD's history every test here fails (requireCutover): that is the point.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CORE, recordFiles, CLAIMS_POINTER, byCodePoint, env } from "./layout/lib.mjs";
import { SPEC, REPO, MERGED_MASTER, isAncestor, hasRev, requireBases, recordsAt, canon, rgit, archiveInto, scratch, noGit, lsTree, showAt } from "./convert/lib.mjs";

const toolAt = (args) => {
  const r = spawnSync(process.execPath, [CORE, ...args, "--root", REPO, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: env(scratch("home")) });
  let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`${args.join(" ")}: ${r.stdout.slice(0, 600)}${r.stderr.slice(0, 600)}`); }
  return { status: r.status, j };
};

describe("the cutover commit converts Sova's spec without changing a record", { skip: noGit }, () => {
  let C, A, B;
  const load = () => {
    if (C) return;
    C = requireBases();
    A = recordsAt(C.base);
    B = recordsAt(C.cutover);
  };

  test("there is a cutover commit: format 1 at its first parent, format 2 at it", (t) => {
    load();
    assert.equal(A.manifest.formatVersion, 1);
    assert.equal(B.manifest.formatVersion, 2);
    const fromPre = rgit("diff", "--name-only", C.pre, C.base, "--", SPEC).trim();
    t.diagnostic(`cutover ${C.cutover.slice(0, 12)} on ${C.base.slice(0, 12)}; pre-landing master ${C.pre.slice(0, 12)}; spec changed since it: ${fromPre ? fromPre.split("\n").length + " file(s)" : "none"}`);
  });

  test("the cutover is the newest conversion: no later commit converts again, and HEAD is format 2", () => {
    load();
    const fmt = (rev) => JSON.parse(showAt(rev, `${SPEC}/manifest.json`) ?? "{}").formatVersion;
    assert.equal(fmt("HEAD"), 2);
    // an oldest-first locator, after a merge back to format 1 and a second conversion, fails here
    const later = rgit("log", "--no-merges", "--format=%H %P", `${C.cutover}..HEAD`, "--", `${SPEC}/manifest.json`).split("\n").filter(Boolean).map((l) => l.split(" "));
    for (const [c, p] of later) assert.ok(!(fmt(c) === 2 && fmt(p) === 1), `${c.slice(0, 12)} converts again after ${C.cutover.slice(0, 12)}`);
  });

  test("the flip's parent contains the master it merged, and every record of that master is in its manifest.json", (t) => {
    load();
    assert.ok(hasRev(MERGED_MASTER), `${MERGED_MASTER.slice(0, 12)} is not in this clone (history rewritten? repin with SOVA_CONVERT_MASTER)`);
    assert.ok(isAncestor(MERGED_MASTER, C.base), `the flip's parent ${C.base.slice(0, 12)} does not contain ${MERGED_MASTER.slice(0, 12)}: an older flip, cut before the merge`);
    const m = recordsAt(MERGED_MASTER);
    assert.equal(m.manifest.formatVersion, 1, "the merged master is format 1");
    assert.deepEqual(Object.keys(m.records).filter((i) => !(i in A.records)), [], "no record of the merged master is missing from the flip's parent");
    assert.ok(Object.values(A.fileOf).every((f) => f === "manifest.json"), "the flip's parent keeps every record in manifest.json (format 1, no record file)");
    t.diagnostic(`flip parent ${C.base.slice(0, 12)} contains ${MERGED_MASTER.slice(0, 12)} (${Object.keys(m.records).length} records there, ${Object.keys(A.records).length} in the parent); pre-landing master found: ${C.pre.slice(0, 12)}`);
  });

  test("every record in the flip's parent's manifest.json is in the flip's per-area files, value for value", () => {
    load();
    const ids = Object.keys(A.manifest.claims);
    assert.ok(ids.length > 1000);
    const bad = ids.filter((i) => !B.fileOf[i] || !B.fileOf[i].startsWith("claims/") || !B.fileOf[i].endsWith(".json") || JSON.stringify(B.records[i]) !== JSON.stringify(A.manifest.claims[i]));
    assert.deepEqual(bad, [], "each in a claims/**/*.json, the same bytes");
  });

  test("no record of the pre-landing master is lost on the way to the cutover", () => {
    load();
    const pre = recordsAt(C.pre).records;
    assert.ok(Object.keys(pre).length > 1000);
    assert.deepEqual(Object.keys(pre).filter((i) => !(i in B.records)), [], `every record of ${C.pre.slice(0, 12)} is in the cutover`);
  });

  test("the same record ids, every record byte-identical (canonical and as written), the count unchanged", (t) => {
    load();
    const ia = Object.keys(A.records).sort(byCodePoint), ib = Object.keys(B.records).sort(byCodePoint);
    assert.ok(ia.length > 1000, `${ia.length} records before`);
    assert.deepEqual(ib.filter((i) => !(i in A.records)), [], "no record appears");
    assert.deepEqual(ia.filter((i) => !(i in B.records)), [], "no record is lost");
    assert.equal(ib.length, ia.length);
    const canonDiff = ia.filter((i) => canon(A.records[i]) !== canon(B.records[i]));
    assert.deepEqual(canonDiff, [], "canonically equal");
    const byteDiff = ia.filter((i) => JSON.stringify(A.records[i]) !== JSON.stringify(B.records[i]));
    assert.deepEqual(byteDiff, [], "key order inside each record kept (the values are byte-for-byte today's)");
    const pre = recordsAt(C.pre);
    t.diagnostic(`${ib.length} records (${Object.keys(pre.records).length} at the pre-landing master ${C.pre.slice(0, 12)}) in ${B.recordFiles.length} record files`);
  });

  test("manifest.json keeps every project setting; only formatVersion and the records pointer change", () => {
    load();
    const { formatVersion: va, ...ma } = A.meta, { formatVersion: vb, ...mb } = B.meta;
    assert.equal(canon(mb), canon(ma), "grammar, boundary, _ and any other key equal");
    assert.deepEqual(Object.keys(mb), Object.keys(ma), "same key order");
    assert.equal(B.claimsKey, CLAIMS_POINTER, "format 2 keeps `claims` as the pointer string (an old merge helper then refuses instead of dropping records)");
    assert.ok(Buffer.byteLength(B.manifestText) < 16 * 1024, `the cut-down manifest.json is ${Buffer.byteLength(B.manifestText)} bytes`);
    void va; void vb;
  });

  test("each area's records sit beside its document, in the canonical bytes an independent writer produces", () => {
    load();
    const want = recordFiles(A.meta, A.records);
    const got = Object.fromEntries(Object.entries(B.raw).map(([p, s]) => [p.slice(SPEC.length + 1), s]));
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "the same set of record files");
    const differ = Object.keys(want).filter((rel) => got[rel] !== want[rel]);
    assert.deepEqual(differ, [], "ids sorted by code point, 2-space indent, trailing newline");
    const noMd = Object.keys(got).filter((rel) => !(`${SPEC}/${rel.replace(/\.json$/, ".md")}` in B.md));
    assert.deepEqual(noMd, [], "every record file has its .md");
    for (const [id, f] of Object.entries(B.fileOf)) assert.notEqual(f, "manifest.json", `${id} left in manifest.json`);
  });

  test("the prose is untouched, and the spec dir changes only in manifest.json, the record files and its docs", () => {
    load();
    assert.deepEqual(B.md, A.md, "every claims/**/*.md blob identical");
    const changed = rgit("diff", "--name-status", "--no-renames", C.base, C.cutover, "--", SPEC).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
    const allowed = ([st, p]) => p === `${SPEC}/manifest.json` || (st === "A" && p.startsWith(`${SPEC}/claims/`) && p.endsWith(".json")) || [`${SPEC}/README.md`, `${SPEC}/USAGE.md`, `${SPEC}/.gitignore`].includes(p);
    assert.deepEqual(changed.filter((x) => !allowed(x)), [], "nothing else in .sova/spec changes");
  });

  test("the cutover commit touches only .sova/spec, .gitattributes and docs", () => {
    load();
    const files = rgit("diff", "--name-only", C.base, C.cutover).trim().split("\n").filter(Boolean);
    const other = files.filter((p) => !(p.startsWith(`${SPEC}/`) || p === ".gitattributes" || p.endsWith(".md")));
    assert.deepEqual(other, [], "code changes belong in another commit (the cutover stays regenerable with one command)");
  });

  test(".gitattributes: the records' merge helper is retired, the claims helper stays, record files get Git's line merge", () => {
    load();
    // against the pre-landing master: a regenerated cutover (after a merge back to format 1) finds the attribute
    // already retired on its own parent
    const before = showAt(C.pre, ".gitattributes") ?? "", after = showAt(C.cutover, ".gitattributes") ?? "";
    assert.match(before, /^\.sova\/spec\/manifest\.json merge=sova-spec-manifest$/m, "the pre-landing master still had the helper (else this check proves nothing)");
    assert.doesNotMatch(after, /sova-spec-manifest/, "no line routes anything to the manifest helper");
    assert.match(after, /^\.sova\/spec\/claims\/\*\*\/\*\.md merge=sova-spec-claims$/m, "the claims helper stays");
    assert.doesNotMatch(after, /\.json\s+merge=/, "no merge driver for the record files (question 3: combine, then the landing report lists it)");
    const rules = (s) => s.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !/sova-spec-manifest/.test(l));
    assert.deepEqual(rules(after), rules(before), "no other attribute line changes (comments may)");
  });

  test("Git tracks every record file: .sova/spec/.gitignore admits claims/**/*.json", () => {
    load();
    // A fresh repo from the cutover's spec: `git add -A` honours the cutover's own .gitignore, so an ignored record
    // file would be missing from ls-files (and check-ignore would name it).
    const root = scratch("ignore");
    archiveInto(C.cutover, root, [SPEC]);
    const g = (...a) => { const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8", env: env(root) }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    g("init", "-q"); g("add", "-A");
    const tracked = g("ls-files", "--", `${SPEC}/claims`).split("\n").filter((p) => p.endsWith(".json"));
    assert.equal(tracked.length, B.recordFiles.length, "every record file is admitted");
    const onDisk = [];
    const walk = (d, rel) => { for (const n of readdirSync(d, { withFileTypes: true })) n.isDirectory() ? walk(join(d, n.name), `${rel}/${n.name}`) : n.name.endsWith(".json") && onDisk.push(`${rel}/${n.name}`); };
    walk(join(root, SPEC, "claims"), `${SPEC}/claims`);
    const ci = spawnSync("git", ["-C", root, "check-ignore", "--no-index", ...onDisk], { encoding: "utf8" });
    assert.equal(ci.stdout.trim(), "", "git check-ignore names no record file");
    assert.equal(ci.status, 1, "check-ignore: nothing ignored");
    // and the rule still keeps stray support files out of claims/
    const probe = spawnSync("git", ["-C", root, "check-ignore", "--no-index", `${SPEC}/claims/app/notes.txt`], { encoding: "utf8" });
    assert.equal(probe.status, 0, "a non-.md/.json file under claims/ is still ignored");
  });

  test("the tools' own instruments agree: records --at both sides, and foreign sees no change", () => {
    load();
    const a = toolAt(["records", "--at", C.base]).j, b = toolAt(["records", "--at", C.cutover]).j;
    assert.equal(a.exit, 0, JSON.stringify(a).slice(0, 400));
    assert.equal(b.exit, 0, JSON.stringify(b).slice(0, 400));
    assert.deepEqual([a.layout, b.layout], [1, 2]);
    assert.equal(canon(b.records), canon(a.records));
    assert.equal(canon(a.records), canon(A.records), "the tool reads what this file's own reader reads");
    const f = toolAt(["foreign", "--base", C.base, "--head", C.cutover]).j;
    assert.ok(f.exit === 0 || f.exit === undefined, JSON.stringify(f).slice(0, 600));
    assert.deepEqual([f.foreign, f.created, f.changes], [[], [], []], `the cutover changes no §: ${JSON.stringify(f).slice(0, 600)}`);
  });

  test("control: this reader sees a one-field record change (it cannot pass by reading nothing)", () => {
    load();
    const id = Object.keys(B.records)[0];
    const planted = { ...B.records[id], evidence: B.records[id].evidence === "verified" ? "reviewed" : "verified" };
    assert.notEqual(canon(planted), canon(A.records[id]));
    assert.ok(Object.keys(lsTree(C.cutover)).length > 150, "the cutover tree was read");
  });
});
