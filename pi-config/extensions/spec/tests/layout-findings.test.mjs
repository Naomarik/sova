// Format 2's own refusals (al_6 landing 1): a record in the wrong file, an id in two files, a record file with no
// claim file, an unreadable record file, and a mixed layout (BRIEF a1: records in manifest.json AND any per-area
// record file). Each is exit 2 with its code; the mixed layout is refused by EVERY command, core and draft tool,
// and the refusal names the one command that fixes it. An old core reading a format 2 root refuses it cleanly
// (manifest-version), never as "no spec".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { RECORDS, SPEC, REPO, project, core, draft, codes, messages, put, read, tmp, hasGit } from "./layout/lib.mjs";

const COMMANDS = [["check"], ["census"], ["records"], ["map"], ["graph"], ["where", "draftId"], ["read", "§ot/uses"], ["toc", "§ot/uses", "--dir", "out"], ["scope", "§ot/uses"], ["impact", "§ot/uses"], ["impact", "§ot/uses", "--near"], ["packet", "§ot/uses"]];
const refusedAs = (j, code, label) => {
  assert.equal(j.exit, 2, `${label}: exit 2 (${JSON.stringify(j).slice(0, 400)})`);
  assert.ok(codes(j).includes(code) || j.cause === code, `${label}: ${code} in findings, or as the refusal's cause: ${JSON.stringify(codes(j))} ${JSON.stringify(j).slice(0, 300)}`);
};

// ---------------------------------------------------------------- the four record-file findings
test("record-misfiled: a record in an area file its id doesn't map to", () => {
  const root = project(2);
  const base = JSON.parse(read(root, `${SPEC}/claims/ot/base.json`));
  base["§ot/uses"] = RECORDS["§ot/uses"];
  put(root, `${SPEC}/claims/ot/base.json`, JSON.stringify(base, null, 2) + "\n");
  rmSync(join(root, SPEC, "claims/ot/uses.json"));
  const j = core(root, ["check"]).j;
  refusedAs(j, "record-misfiled", "check");
  assert.ok(j.findings.some((f) => f.code === "record-misfiled" && (f.id === "§ot/uses" || /§ot\/uses/.test(f.message)) && /ot\/base\.json/.test(`${f.file ?? ""} ${f.message}`)), JSON.stringify(j.findings));
});

test("record-duplicate: one id in two area files", () => {
  const root = project(2);
  const base = JSON.parse(read(root, `${SPEC}/claims/ot/base.json`));
  base["§ot/uses"] = RECORDS["§ot/uses"];
  put(root, `${SPEC}/claims/ot/base.json`, JSON.stringify(base, null, 2) + "\n");
  const j = core(root, ["check"]).j;
  refusedAs(j, "record-duplicate", "check");
  assert.ok(j.findings.some((f) => f.code === "record-duplicate" && /§ot\/uses/.test(`${f.id ?? ""} ${f.message}`)), JSON.stringify(j.findings));
});

test("records-orphaned: a record file with no claim file beside it; its ids are undeclared too", () => {
  const root = project(2);
  put(root, `${SPEC}/claims/zz/ghost.json`, JSON.stringify({ "§zz/ghost": { kind: "note", authority: "accepted" } }, null, 2) + "\n");
  const j = core(root, ["check"]).j;
  refusedAs(j, "records-orphaned", "check");
  assert.ok(j.findings.some((f) => f.code === "records-orphaned" && /zz\/ghost\.json/.test(`${f.file ?? ""} ${f.message}`)), JSON.stringify(j.findings));
  assert.ok(j.findings.some((f) => f.code !== "records-orphaned" && f.severity === "error" && (f.id === "§zz/ghost" || /§zz\/ghost/.test(f.message))), "the ghost id also has no declaration");
});

for (const [name, text] of [["bad JSON", "{ \"§ot/uses\": "], ["an array", "[]\n"], ["a string", "\"x\"\n"], ["null", "null\n"]])
  test(`records-unreadable: a record file holding ${name} is named`, () => {
    const root = project(2);
    put(root, `${SPEC}/claims/ot/uses.json`, text);
    const j = core(root, ["check"]).j;
    refusedAs(j, "records-unreadable", "check");
    assert.ok(j.findings.some((f) => f.code === "records-unreadable" && /ot\/uses\.json/.test(`${f.file ?? ""} ${f.message}`)), JSON.stringify(j.findings));
  });

test("a format 2 manifest.json without the claims pointer, or with claims of another type, is refused", () => {
  const control = core(project(2), ["check"]).j; // the same spec with the pointer loads, so the refusals below are about the pointer
  assert.ok(control.exit <= 1, JSON.stringify(codes(control)));
  for (const claims of [undefined, 7, null, ["x"]]) {
    const root = project(2);
    const m = JSON.parse(read(root, `${SPEC}/manifest.json`));
    if (claims === undefined) delete m.claims; else m.claims = claims;
    put(root, `${SPEC}/manifest.json`, JSON.stringify(m, null, 2) + "\n");
    assert.equal(core(root, ["check"]).j.exit, 2, `claims ${JSON.stringify(claims)}`);
  }
});

// ---------------------------------------------------------------- the mixed layout (BRIEF a1)
const toMixedV2 = (root) => { // a format 2 root that also holds records, as an agent following old text might write
  const m = JSON.parse(read(root, `${SPEC}/manifest.json`));
  m.claims = { "§ot/extra": { kind: "note", authority: "accepted" } };
  put(root, `${SPEC}/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  put(root, `${SPEC}/claims/ot/extra.md`, "# §ot/extra — Extra\n\nAn extra note.\n");
  return root;
};
const toMixedV1 = (root) => { // a format 1 root with a per-area record file beside it (a half-finished conversion or merge)
  put(root, `${SPEC}/claims/ot/extra.json`, JSON.stringify({ "§ot/extra": { kind: "note", authority: "accepted" } }, null, 2) + "\n");
  put(root, `${SPEC}/claims/ot/extra.md`, "# §ot/extra — Extra\n\nAn extra note.\n");
  return root;
};
const mixedV2 = () => toMixedV2(project(2));
const mixedV1 = () => toMixedV1(project(1));
const namesFix = (j, label, { draftName } = {}) => {
  const msg = messages(j) + JSON.stringify(j.findings ?? []);
  assert.match(msg, /migrate/, `${label}: names migrate`);
  assert.match(msg, /--write/, `${label}: names --write`);
  if (draftName) assert.match(msg, new RegExp(`--draft ${draftName}`), `${label}: names the draft`);
};

for (const [form, make] of [["a format 2 root with records in manifest.json", mixedV2], ["a format 1 root with a per-area record file", mixedV1]]) {
  test(`layout-mixed (${form}): every core command refuses with the one-command fix`, () => {
    const root = make();
    for (const args of COMMANDS) {
      const j = core(root, args).j;
      refusedAs(j, "layout-mixed", args.join(" "));
      namesFix(j, args.join(" "));
    }
  });
  test(`layout-mixed (${form}): the draft tool refuses to copy it or promote into it, and writes nothing`, () => {
    const root = make();
    const n = draft(root, ["new", "f1", "--write"]).j;
    assert.equal(n.exit, 2, JSON.stringify(n).slice(0, 400));
    assert.ok(codes(n).includes("layout-mixed"), JSON.stringify(codes(n)));
    namesFix(n, "new");
    assert.equal(existsSync(join(root, SPEC, "drafts/f1")), false, "no draft was made from a mixed spec");
    // a draft made before the spec went mixed: promoting into the mixed current is refused
    const layout = make === mixedV2 ? 2 : 1;
    const r2 = project(layout);
    assert.equal(draft(r2, ["new", "f2", "--write"]).j.exit, 0);
    put(r2, `${SPEC}/drafts/f2/spec/claims/ot/base.md`, "# §ot/base — Base\n\nThe base, restated.\n");
    assert.equal(draft(r2, ["evidence", "f2", "--id", "§ot/base", "--by", "t", "--verification", "read", "--doc-only", "--write"]).j.exit, 0);
    (layout === 2 ? toMixedV2 : toMixedV1)(r2);
    const before = read(r2, `${SPEC}/manifest.json`) + read(r2, `${SPEC}/claims/ot/base.md`);
    const p = draft(r2, ["promote", "f2", "--id", "§ot/base", "--write"]).j;
    assert.equal(p.exit, 2, JSON.stringify(p).slice(0, 400));
    assert.ok(codes(p).includes("layout-mixed"), JSON.stringify(codes(p)));
    namesFix(p, "promote");
    assert.equal(read(r2, `${SPEC}/manifest.json`) + read(r2, `${SPEC}/claims/ot/base.md`), before, "nothing promoted");
  });
}

test("layout-mixed in a draft: the draft tool names `--draft NAME` in its fix", () => {
  const root = project(2);
  assert.equal(draft(root, ["new", "f1", "--write"]).j.exit, 0);
  const rel = `${SPEC}/drafts/f1/spec/manifest.json`;
  const m = JSON.parse(read(root, rel));
  m.claims = { "§ot/extra": { kind: "note", authority: "accepted" } }; // old mode text: "add the record to manifest.json"
  put(root, rel, JSON.stringify(m, null, 2) + "\n");
  put(root, `${SPEC}/drafts/f1/spec/claims/ot/extra.md`, "# §ot/extra — Extra\n\nAn extra note.\n");
  for (const args of [["check", "f1"], ["status", "f1"], ["evidence", "f1", "--id", "§ot/extra", "--by", "t", "--verification", "v", "--doc-only", "--write"], ["promote", "f1", "--id", "§ot/extra"]]) {
    const j = draft(root, args).j;
    assert.equal(j.exit, 2, `${args.join(" ")}: ${JSON.stringify(j).slice(0, 400)}`);
    assert.ok(codes(j).includes("layout-mixed"), `${args.join(" ")}: ${JSON.stringify(codes(j))}`);
    namesFix(j, args.join(" "), { draftName: "f1" });
  }
  const sc = core(root, ["check", "--spec", ".sova/spec/drafts/f1/spec"]).j;
  refusedAs(sc, "layout-mixed", "core check --spec <draft>");
});

test("layout-mixed: the named fix works (migrate finishes the move, then check passes)", () => {
  for (const make of [mixedV2, mixedV1]) {
    const root = make();
    const j = draft(root, ["migrate", "--write"]).j;
    assert.equal(j.exit, 0, JSON.stringify(j).slice(0, 600));
    const c = core(root, ["check"]).j;
    assert.ok(c.exit <= 1, JSON.stringify(codes(c)));
    assert.equal(core(root, ["records"]).j.records["§ot/extra"]?.kind, "note", "the stray record is kept");
    assert.equal(core(root, ["records"]).j.layout, 2);
  }
});

test("layout-mixed: a differing duplicate (root and area file disagree) is refused by migrate, nothing written", () => {
  const root = project(2);
  const m = JSON.parse(read(root, `${SPEC}/manifest.json`));
  m.claims = { "§ot/uses": { ...RECORDS["§ot/uses"], authority: "migrated" } };
  put(root, `${SPEC}/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  const before = read(root, `${SPEC}/manifest.json`) + read(root, `${SPEC}/claims/ot/uses.json`);
  const j = draft(root, ["migrate", "--write"]).j;
  assert.equal(j.exit, 2, JSON.stringify(j).slice(0, 400));
  assert.ok(codes(j).includes("record-duplicate"), JSON.stringify(codes(j)));
  assert.equal(read(root, `${SPEC}/manifest.json`) + read(root, `${SPEC}/claims/ot/uses.json`), before);
});

// ---------------------------------------------------------------- an old core meets a format 2 root
test("the pre-landing core refuses a format 2 root as an unsupported version, never as no spec", { skip: !hasGit }, () => {
  const OLD = "9b7297f8b8051"; // feat/spec-store's base on master: the tools before al_6
  if (spawnSync("git", ["-C", REPO, "cat-file", "-e", `${OLD}^{commit}`]).status !== 0) return;
  const old = tmp("spec-layout-old-");
  const ar = spawnSync("sh", ["-c", `git -C "$1" archive ${OLD} pi-config/extensions/spec/core | tar -x -C "$2"`, "sh", REPO, old], { encoding: "utf8" });
  assert.equal(ar.status, 0, ar.stderr);
  const root = project(2);
  const r = spawnSync(process.execPath, [join(old, "pi-config/extensions/spec/core/sova-spec.mjs"), "check", "--root", root, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 2);
  assert.ok(codes(j).includes("manifest-version"), JSON.stringify(codes(j)));
  assert.ok(!codes(j).includes("manifest-not-found"));
  const d = spawnSync(process.execPath, [join(old, "pi-config/extensions/spec/core/sova-spec-draft.mjs"), "new", "f1", "--write", "--root", root, "--json"], { encoding: "utf8" });
  assert.notEqual(d.status, 0, `the old draft tool does not copy a format 2 spec: ${d.stdout}`);
  assert.equal(existsSync(join(root, SPEC, "drafts/f1")), false);
});
