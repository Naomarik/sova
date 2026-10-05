// Agreed, not built: `agreed: {by, at}` records and their --doc-only promotion. Black-box tests for core/sova-spec-draft.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../core/sova-spec-draft.mjs"), CORE = resolve(HERE, "../core/sova-spec.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const FILE = ".sova/spec/claims/a/top.md", D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n";
const AGREED = { by: "the operator", at: "2026-10-05" };

function project() {
  const root = mkdtempSync(join(tmpdir(), "sova-agreed-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", manifest({
    "§a/top": { kind: "surface", authority: "accepted" },
    "§a.top/one": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/one.txt"] },
  }));
  write(root, FILE, TOP);
  write(root, "lib/one.txt", "one v1\n");
  write(root, "lib/new.txt", "new v1\n");
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
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
const ev = (root, name, id, mode, write = true) => run(root, "evidence", name, "--id", id, "--by", "tester", "--verification", "agreed in chat", `--${mode}`, ...(write ? ["--write"] : []));
const promote = (root, name, ...ids) => { const p = run(root, "promote", name, ...ids.flatMap((i) => ["--id", i])); return p.exit ? p : run(root, "promote", name, ...ids.flatMap((i) => ["--id", i]), "--plan", p.plan, "--write"); };
/** The server's formula: built = `code` plus evidence `reviewed` or `verified`. */
const built = (rec) => Array.isArray(rec.code) && rec.code.length > 0 && ["reviewed", "verified"].includes(rec.evidence);
/** A draft that adds §a.top/new (prose + record); `rec` is merged into the record. */
function agreedDraft(root, name, rec) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  write(root, D(name, "claims/a/top.md"), `${TOP}\n## §a.top/new\n\nNew does Z, as agreed.\n`);
  editManifest(root, D(name, "manifest.json"), (m) => { m.claims["§a.top/new"] = { kind: "behavior", authority: "accepted", requires: [], ...rec }; });
}
const current = (root) => JSON.parse(read(root, ".sova/spec/manifest.json")).claims;

test("a requirements chat lands an agreed promise in current on doc-only evidence, and it does not read as built", () => {
  const root = project();
  agreedDraft(root, "talk", { agreed: AGREED });
  assert.equal(ev(root, "talk", "§a.top/new", "doc-only").exit, 0);
  assert.equal(run(root, "status", "talk").exit !== 2, true);
  const w = promote(root, "talk", "§a.top/new");
  assert.equal(w.exit, 0, JSON.stringify(w.refusals));
  const rec = current(root)["§a.top/new"];
  assert.deepEqual(rec.agreed, AGREED);
  assert.equal(rec.code, undefined);
  assert.equal(built(rec), false);
  assert.match(read(root, FILE), /## §a\.top\/new\n\nNew does Z, as agreed\.\n/);
});

test("doc-only evidence is refused for a behavior with no agreed, one that maps code, and one labelled reviewed or verified", () => {
  const root = project();
  agreedDraft(root, "plain", {});
  assert.ok(codes(ev(root, "plain", "§a.top/new", "doc-only")).includes("doc-only-refused"));
  agreedDraft(root, "coded", { agreed: AGREED, code: ["lib/new.txt"] });
  const coded = ev(root, "coded", "§a.top/new", "doc-only");
  assert.ok(codes(coded).includes("doc-only-refused"));
  assert.match(coded.findings[0].message, /maps code/);
  for (const label of ["reviewed", "verified"]) {
    agreedDraft(root, `label-${label}`, { agreed: AGREED, evidence: label });
    assert.ok(codes(ev(root, `label-${label}`, "§a.top/new", "doc-only")).includes("doc-only-refused"), label);
  }
  agreedDraft(root, "unreviewed", { agreed: AGREED, evidence: "unreviewed" });
  assert.equal(ev(root, "unreviewed", "§a.top/new", "doc-only").exit, 0);
});

test("doc-only evidence goes stale when the agreed record gains code, and promotion refuses it", () => {
  const root = project();
  agreedDraft(root, "talk", { agreed: AGREED });
  assert.equal(ev(root, "talk", "§a.top/new", "doc-only").exit, 0);
  editManifest(root, D("talk", "manifest.json"), (m) => { m.claims["§a.top/new"].code = ["lib/new.txt"]; });
  const p = run(root, "promote", "talk", "--id", "§a.top/new");
  assert.ok(codes(p).includes("evidence-stale"));
  const e = p.evidence.find((x) => x.id === "§a.top/new");
  assert.ok(e.reasons.some((r) => /does not cover behavior that maps code/.test(r)), e.reasons.join("; "));
});

test("a malformed agreed is refused at evidence and at promotion", () => {
  const root = project();
  const bad = [{ by: "", at: "2026-10-05" }, { by: "x" }, { by: "x", at: "2026-02-30" }, { by: "x", at: "yesterday" },
    { by: "x", at: "2026-10-05", note: "extra" }, "the operator"];
  bad.forEach((agreed, i) => {
    agreedDraft(root, `bad-${i}`, { agreed });
    assert.ok(codes(ev(root, `bad-${i}`, "§a.top/new", "doc-only")).includes("doc-only-refused"), JSON.stringify(agreed));
    editManifest(root, D(`bad-${i}`, "manifest.json"), (m) => { m.claims["§a.top/new"].code = ["lib/new.txt"]; });
    assert.ok(codes(ev(root, `bad-${i}`, "§a.top/new", "snapshot")).includes("agreed-invalid"), JSON.stringify(agreed));
  });
  // evidence recorded before the agreed went bad: promotion still refuses it
  agreedDraft(root, "late", { code: ["lib/new.txt"] });
  assert.equal(ev(root, "late", "§a.top/new", "snapshot").exit, 0);
  editManifest(root, D("late", "manifest.json"), (m) => { m.claims["§a.top/new"].agreed = { by: "x", at: "soon" }; });
  assert.ok(codes(run(root, "promote", "late", "--id", "§a.top/new")).includes("agreed-invalid"));
  // a note carries no agreed: only behavior and surface records are agreed before they are built
  assert.equal(run(root, "new", "note", "--write").exit, 0);
  write(root, D("note", "claims/n/why.md"), "# §n/why\n\nWhy we did it.\n");
  editManifest(root, D("note", "manifest.json"), (m) => { m.claims["§n/why"] = { kind: "note", authority: "accepted", agreed: AGREED }; });
  assert.ok(codes(ev(root, "note", "§n/why", "doc-only")).includes("agreed-invalid"));
  ["2026-10-05T09:30Z", "2026-10-05T09:30:00.000Z", "2026-10-05T09:30:00+02:00"].forEach((at, i) => {
    agreedDraft(root, `ok-${i}`, { agreed: { by: "x", at } });
    assert.equal(ev(root, `ok-${i}`, "§a.top/new", "doc-only", false).exit, 0, at);
  });
});

test("the build updates the same agreed record, keeps agreed, and only then reads as built", () => {
  const root = project();
  agreedDraft(root, "talk", { agreed: AGREED });
  assert.equal(ev(root, "talk", "§a.top/new", "doc-only").exit, 0);
  assert.equal(promote(root, "talk", "§a.top/new").exit, 0);
  // the build: same §, adds code and a verified label
  assert.equal(run(root, "new", "build", "--write").exit, 0);
  editManifest(root, D("build", "manifest.json"), (m) => { Object.assign(m.claims["§a.top/new"], { code: ["lib/new.txt"], evidence: "verified" }); });
  assert.ok(codes(ev(root, "build", "§a.top/new", "doc-only")).includes("doc-only-refused"));
  assert.equal(ev(root, "build", "§a.top/new", "snapshot").exit, 0);
  const w = promote(root, "build", "§a.top/new");
  assert.equal(w.exit, 0, JSON.stringify(w.refusals));
  const rec = current(root)["§a.top/new"];
  assert.deepEqual(rec.agreed, AGREED);
  assert.equal(built(rec), true);
  assert.deepEqual(Object.keys(current(root)).sort(), ["§a.top/new", "§a.top/one", "§a/top"]);
});

test("agreed is written once: a promotion that changes or removes it is refused", () => {
  const root = project();
  agreedDraft(root, "talk", { agreed: AGREED });
  assert.equal(ev(root, "talk", "§a.top/new", "doc-only").exit, 0);
  assert.equal(promote(root, "talk", "§a.top/new").exit, 0);
  const cases = { changed: (r) => { r.agreed = { by: "someone else", at: "2026-10-06" }; }, removed: (r) => { delete r.agreed; } };
  for (const [name, fn] of Object.entries(cases)) {
    assert.equal(run(root, "new", name, "--write").exit, 0);
    editManifest(root, D(name, "manifest.json"), (m) => { const r = m.claims["§a.top/new"]; fn(r); r.code = ["lib/new.txt"]; });
    assert.equal(ev(root, name, "§a.top/new", "snapshot").exit, 0);
    assert.ok(codes(run(root, "promote", name, "--id", "§a.top/new")).includes("agreed-rewritten"), name);
  }
  // deleting the whole record (the decision was dropped) is an ordinary deletion
  assert.equal(run(root, "new", "drop", "--write").exit, 0);
  write(root, D("drop", "claims/a/top.md"), TOP);
  editManifest(root, D("drop", "manifest.json"), (m) => { delete m.claims["§a.top/new"]; });
  assert.equal(ev(root, "drop", "§a.top/new", "doc-only").exit, 0);
  assert.equal(promote(root, "drop", "§a.top/new").exit, 0);
  assert.equal(current(root)["§a.top/new"], undefined);
});

test("a core that predates agreed still loads a manifest carrying it; a new evidence label value would not", (t) => {
  const BASE = "a95768b7";
  const repo = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  const old = mkdtempSync(join(tmpdir(), "sova-agreed-oldcore-"));
  roots.push(old);
  for (const f of ["sova-spec.mjs", "packet.mjs"]) {
    const r = spawnSync("git", ["-C", repo, "show", `${BASE}:pi-config/extensions/spec/core/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) return t.skip(`commit ${BASE} is not in this clone`);
    write(old, f, r.stdout);
  }
  const root = project();
  agreedDraft(root, "talk", { agreed: AGREED });
  assert.equal(ev(root, "talk", "§a.top/new", "doc-only").exit, 0);
  assert.equal(promote(root, "talk", "§a.top/new").exit, 0);
  const check = (core) => {
    const r = spawnSync(process.execPath, [core, "check", "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
    return { status: r.status, j: JSON.parse(r.stdout) };
  };
  for (const core of [join(old, "sova-spec.mjs"), CORE]) {
    const { status, j } = check(core);
    assert.notEqual(status, 2, `${core}: ${JSON.stringify(j.findings)}`);
    assert.equal(j.counts.records, 3);
    assert.equal(j.findings.filter((f) => f.severity === "error").length, 0);
  }
  // why it is a field: an unknown label value makes the same old core refuse the whole manifest
  editManifest(root, ".sova/spec/manifest.json", (m) => { m.claims["§a.top/new"].evidence = "agreed"; });
  assert.equal(check(join(old, "sova-spec.mjs")).status, 2);
});
