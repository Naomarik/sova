// The records-file ratchet over pi-config/extensions/** (pi-config stays self-contained; the repo side is
// server/spec-layout-boundary.test.ts). Only core/layout.mjs reads the spec's records; every other line that
// names manifest.json or reads a claims key off a parsed manifest is on tests/layout/allowlist.json, by exact
// text, with a reason, and that list only shrinks. The scanner and the ratchet logic are proved on fixtures
// first, so a scanner that matches nothing cannot pass the real scan by accident.
// SOVA_SPEC_LAYOUT_ALLOW_OUT=<absolute path> writes a draft allowlist from today's hits (reasons kept where known).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./layout/lib.mjs";
import { scanText, isScanned, compare, growth, listSources, scanRepo, committedAllowlist, draftAllowlist, loadAllowlist, LAYOUT_MODULE } from "./layout/guard-scan.mjs";

const ALLOW_REL = "pi-config/extensions/spec/tests/layout/allowlist.json";
const ROOTS = ["pi-config/extensions"];
const rules = (text) => scanText(text).map((h) => h.rule);

// ---------------------------------------------------------------- 1. the rule forms
const FLAGGED = [
  ["a path literal", `const m = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));`, ["names-manifest"]],
  ["a template path", "const p = `${SPEC}/manifest.json`;", ["names-manifest"]],
  ["a git blob path", "git(root, [\"show\", `${rev}:.sova/spec/manifest.json`]);", ["names-manifest"]],
  ["a JSON import", `import manifest from "../.sova/spec/manifest.json";`, ["names-manifest"]],
  ["a MANIFEST constant", "if (!existsSync(join(tree, MANIFEST))) return;", ["names-manifest"]],
  ["m.claims", "for (const id of Object.keys(m.claims)) {}", ["reads-claims"]],
  ["ctx.m.claims", "const has = (ctx, id) => Object.hasOwn(ctx.m.claims, id);", ["reads-claims"]],
  ["manifest?.claims", "const recOf = (t, id) => (t.manifest?.claims ?? {})[id];", ["reads-claims"]],
  ["baseManifest.claims", "const n = Object.keys(baseManifest.claims).length;", ["reads-claims"]],
  ["bracket, double quotes", `const c = parsed["claims"];`, ["reads-claims"]],
  ["bracket, single quotes", "const c = parsed['claims'];", ["reads-claims"]],
  ["bracket, backticks", "const c = parsed[`claims`];", ["reads-claims"]],
  ["destructured off JSON.parse", "const { claims } = JSON.parse(text);", ["reads-claims"]],
  ["straight off JSON.parse", "const c = JSON.parse(readFileSync(p, \"utf8\")).claims;", ["reads-claims"]],
  ["both on one line", `const c = JSON.parse(readFileSync(join(dir, ".sova/spec/manifest.json"), "utf8")).claims;`, ["names-manifest", "reads-claims"]],
];
for (const [name, text, want] of FLAGGED) test(`guard rule form flagged: ${name}`, () => assert.deepEqual(rules(text), want, text));

const CLEAN = [
  ["the graph's Map of claims", "for (const [id, r] of ctx.claims) if (ctx.claims.has(id)) n += ctx.claims.size;"],
  ["a count field", "L.push(`${c.claims} claim(s)`);"],
  ["a code entry's claims", "for (const cl of c.claims) add(c.path, \"code\", cl);"],
  ["another file named manifest", "const p = join(dir, \"package.json\");"],
  ["a line comment", "// reads .sova/spec/manifest.json and m.claims"],
  ["a block comment line", " * the manifest.json and m.claims of a spec"],
  ["claimsRoot", "const croot = m.grammar?.claimsRoot ?? \"claims/\";"],
];
for (const [name, text] of CLEAN) test(`guard rule form not flagged: ${name}`, () => assert.deepEqual(rules(text), [], text));

test("guard scope: tests, fixtures and type files are exempt; layout.mjs is the one module allowed; source is scanned", () => {
  for (const f of ["pi-config/extensions/spec/core/sova-spec.mjs", "pi-config/extensions/mode/spec-guard.ts", "pi-config/extensions/worktrees/spec.ts", "server/spec-lookup.ts", ".sova/playbooks/merge-round/scripts/round.mjs"])
    assert.equal(isScanned(f), true, f);
  for (const f of [LAYOUT_MODULE, "pi-config/extensions/spec/core/layout.d.mts", "pi-config/extensions/spec/tests/draft.test.mjs", "pi-config/extensions/spec/tests/replay/lib.mjs", "server/spec-lookup.test.ts", "server/harness/fixtures/boundary/x.ts", "pi-config/extensions/mode/spec-guard.test.ts"])
    assert.equal(isScanned(f), false, f);
});

// ---------------------------------------------------------------- 2. the ratchet logic
const REASON = "existence probe, reads no record";
test("ratchet: a new direct read fails, naming the file, line and the way in", () => {
  const scans = new Map([["pi-config/extensions/x/new.ts", scanText("const ok = 1;\nconst c = JSON.parse(readFileSync(\".sova/spec/manifest.json\", \"utf8\")).claims;\n")]]);
  const r = compare(scans, { paths: [], lines: {} });
  assert.equal(r.unlisted.length, 2);
  assert.match(r.problems.join("\n"), /new\.ts:2 \(names-manifest\)/);
  assert.match(r.problems.join("\n"), /new\.ts:2 \(reads-claims\)/);
  assert.match(r.problems[0], /layout\.mjs/);
});
test("ratchet: an allowlisted line passes; the same text twice needs two entries; an edited line fails", () => {
  const line = "if (await exists(join(dir, SPEC_REL, \"manifest.json\"))) return dir;";
  const entry = { rule: "names-manifest", text: line, reason: REASON };
  assert.deepEqual(compare(new Map([["f.ts", scanText(line)]]), { lines: { "f.ts": [entry] } }).problems, []);
  assert.equal(compare(new Map([["f.ts", scanText(`${line}\n${line}`)]]), { lines: { "f.ts": [entry] } }).problems.length, 1, "a second copy of the line is a new hit");
  const edited = compare(new Map([["f.ts", scanText(line.replace("return dir", "return parent"))]]), { lines: { "f.ts": [entry] } }).problems;
  assert.equal(edited.length, 2, "the edited line is unlisted and its old entry is stale");
});
test("ratchet: a stale entry fails (the list shrinks), also for a file with no hits left or gone", () => {
  const entry = { rule: "names-manifest", text: "const gone = \"manifest.json\";", reason: REASON };
  assert.match(compare(new Map([["f.ts", scanText("const x = 1;")]]), { lines: { "f.ts": [entry] } }).problems.join(), /delete the entry/);
  assert.match(compare(new Map(), { lines: { "f.ts": [entry] } }).problems.join(), /file not scanned or gone/);
  assert.match(compare(new Map(), { paths: [{ glob: "server/tours/**", reason: "tours have their own manifest" }], lines: {} }).problems.join(), /matches no file with a hit/);
});
test("ratchet: every entry needs a real reason", () => {
  const line = "const p = `${SPEC}/manifest.json`;";
  for (const reason of ["", "probe", "TODO switch later", undefined])
    assert.match(compare(new Map([["f.ts", scanText(line)]]), { lines: { "f.ts": [{ rule: "names-manifest", text: line, reason }] } }).problems.join(), /needs a real reason/, String(reason));
});
test("ratchet: a path allowlist covers a whole file with an unrelated manifest", () => {
  const scans = new Map([["server/tours/bindings.ts", scanText("writePrivate(root, join(stage, \"manifest.json\"), s);")]]);
  assert.deepEqual(compare(scans, { paths: [{ glob: "server/tours/**", reason: "tour snapshots have their own manifest.json" }] }).problems, []);
});
test("ratchet: growth against the committed list catches an added entry or path, not a removed one", () => {
  const a = { rule: "names-manifest", text: "a", reason: REASON }, b = { rule: "names-manifest", text: "b", reason: REASON };
  assert.deepEqual(growth({ lines: { "f.ts": [a, b] } }, { lines: { "f.ts": [a] } }), []);
  assert.equal(growth({ lines: { "f.ts": [a] } }, { lines: { "f.ts": [a, b] } }).length, 1);
  assert.equal(growth({ lines: { "f.ts": [a] } }, { lines: { "f.ts": [a, a] } }).length, 1, "a duplicate is growth");
  assert.equal(growth({ lines: {} }, { lines: { "g.ts": [a] } }).length, 1);
  assert.equal(growth({ paths: [] }, { paths: [{ glob: "x/**", reason: REASON }] }).length, 1);
});

// ---------------------------------------------------------------- 3. the real scan
const files = listSources(REPO, ROOTS);
const scans = scanRepo(REPO, files);
const allow = loadAllowlist(join(REPO, ALLOW_REL));
if (process.env.SOVA_SPEC_LAYOUT_ALLOW_OUT) writeFileSync(process.env.SOVA_SPEC_LAYOUT_ALLOW_OUT, JSON.stringify(draftAllowlist(scans, allow), null, 2) + "\n");

test("the scan sees pi-config's spec readers (it cannot pass by scanning nothing)", () => {
  assert.ok(files.length > 100, `${files.length} files scanned`);
  for (const f of ["pi-config/extensions/mode/spec-guard.ts", "pi-config/extensions/worktrees/spec.ts", "pi-config/extensions/spec/core/sova-spec.mjs", "pi-config/extensions/spec/core/sova-spec-draft.mjs"])
    assert.ok(files.includes(f), `${f} is scanned`);
  assert.ok(scans.get("pi-config/extensions/worktrees/spec.ts").some((h) => h.rule === "names-manifest"), "the worktrees existence probe is found");
  assert.ok(existsSync(join(REPO, ALLOW_REL)), "the allowlist exists");
});

test("only core/layout.mjs reads the spec's records in pi-config/extensions (allowlist exact, reasons given)", () => {
  const r = compare(scans, allow);
  assert.deepEqual(r.problems, [], `\n${r.problems.join("\n")}\n`);
});

test("the pi-config allowlist only shrinks (against the committed list at the merge base with master)", () => {
  const before = committedAllowlist(REPO, ALLOW_REL);
  if (!before) return; // the change that adds the list has nothing to grow past
  assert.deepEqual(growth(before.allow, allow), [], `grew past ${before.at}`);
});
