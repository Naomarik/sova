// al_6 landing 2: a project with no spec starts in format 2. `new` on such a project writes a format 2 draft root
// (formatVersion 2, `claims` the pointer string, no records in it); a claim authored beside its record file,
// evidenced and promoted, lands as manifest.json (settings only) + claims/<area>.md + claims/<area>.json, and
// checks clean. Control: the pre-cutover draft tool (landing 1's, at ca8ab14) still starts format 1, so the
// assertions tell the two STARTERs apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DRAFT, CLAIMS_POINTER, tmp, put, read, draft, core, editRecords, recordsOnDisk, layoutOnDisk, env } from "./layout/lib.mjs";
import { PRE_CUTOVER, TOOLS, SPEC, archiveInto, scratch, noGit } from "./convert/lib.mjs";

const MD = "# §zz/first — First claim\n\nThe first thing this project documents. It lives in `src/a.ts`.\n";
const REC = { kind: "behavior", authority: "accepted", code: ["src/a.ts"], requires: [] };

test("new on a project with no spec starts a format 2 draft; the first promotion writes format 2", () => {
  const root = tmp("spec-convert-starter-");
  put(root, "src/a.ts", "export const a = 1;\n");
  const n = draft(root, ["new", "first", "--write"]).j;
  assert.equal(n.exit, 0, JSON.stringify(n).slice(0, 600));
  assert.equal(n.specExisted, false);
  const D = `${SPEC}/drafts/first/spec`;
  const m = JSON.parse(read(root, `${D}/manifest.json`));
  assert.equal(m.formatVersion, 2);
  assert.equal(m.claims, CLAIMS_POINTER, "the pointer string, never a records object");
  assert.equal(layoutOnDisk(root, D), 2);
  put(root, `${D}/claims/zz/first.md`, MD);
  editRecords(root, D, (r) => { r["§zz/first"] = REC; });
  assert.ok(existsSync(join(root, D, "claims/zz/first.json")), "the record sits beside its claim file");
  assert.equal(draft(root, ["check", "first"]).j.exit <= 1, true);
  const e = draft(root, ["evidence", "first", "--id", "§zz/first", "--by", "t", "--verification", "read src/a.ts", "--snapshot", "--write"]).j;
  assert.equal(e.exit, 0, JSON.stringify(e).slice(0, 600));
  const p = draft(root, ["promote", "first", "--id", "§zz/first", "--write"]).j;
  assert.equal(p.exit, 0, JSON.stringify(p).slice(0, 800));
  const cur = JSON.parse(read(root, `${SPEC}/manifest.json`));
  assert.equal(cur.formatVersion, 2, "current is format 2");
  assert.equal(cur.claims, CLAIMS_POINTER);
  assert.equal(read(root, `${SPEC}/claims/zz/first.md`), MD);
  assert.deepEqual(JSON.parse(read(root, `${SPEC}/claims/zz/first.json`)), { "§zz/first": REC });
  assert.deepEqual(recordsOnDisk(root).records, { "§zz/first": REC });
  const c = core(root, ["check"]).j;
  assert.equal(c.exit, 0, JSON.stringify(c).slice(0, 800));
  assert.equal(c.counts.records, 1);
  assert.equal(core(root, ["records"]).j.layout, 2);
});

test("control: the pre-cutover draft tool starts format 1 (the check above tells the STARTERs apart)", { skip: noGit }, () => {
  const old = scratch("starter-old");
  archiveInto(PRE_CUTOVER, old, [TOOLS]);
  const root = tmp("spec-convert-starter-");
  const r = spawnSync(process.execPath, [join(old, TOOLS, "sova-spec-draft.mjs"), "new", "first", "--write", "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(read(root, `${SPEC}/drafts/first/spec/manifest.json`)).formatVersion, 1);
  void DRAFT;
});
