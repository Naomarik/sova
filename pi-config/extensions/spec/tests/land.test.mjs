// Black-box tests for `sova-spec-draft.mjs land` (al_4: drafts made official at landing) and `evidence --note`.
// Node stdlib only; Git fixtures use the git CLI. Each case runs on a spec in both record layouts (1: one
// manifest.json; 2: per-area record files), written by spec-fixture.mjs's independent placement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaPathOf, writeSpec } from "./spec-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../core/sova-spec-draft.mjs");
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("SPEC_AGREE"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const put = (root, rel, text) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
function git(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const core = (root, ...a) => JSON.parse(spawnSync(process.execPath, [CORE, ...a, "--root", root, "--json"], { encoding: "utf8", env: fixtureEnv(root) }).stdout);
const codes = (j) => [...(j.findings ?? []).filter((f) => f.severity !== "note").map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];
/** Every file under .sova/spec, path → sha256 (drafts included unless `official`). */
function tree(root, { official = false } = {}) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (official && p.includes("/drafts")) continue; statSync(p).isDirectory() ? walk(p) : (out[p.slice(root.length + 1)] = sha(readFileSync(p))); } };
  if (existsSync(join(root, ".sova/spec"))) walk(join(root, ".sova/spec"));
  return out;
}

const BASE = {
  "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/top.txt"] },
};
const TOP = "# §a/top\n\nThe top does X.\n";
/** A Git project with a spec in `layout`, one code file per name in `code`, all committed. */
function project(layout, code = []) {
  const root = mkdtempSync(join(tmpdir(), "sova-land-test-"));
  roots.push(root);
  writeSpec(root, { layout, records: BASE, claims: { "a/top.md": TOP } });
  put(root, ".sova/spec/.gitignore", "/drafts/\n");
  put(root, "lib/top.txt", "top v1\n");
  for (const f of code) put(root, `lib/${f}.txt`, `${f} v1\n`);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}
const D = (name) => `.sova/spec/drafts/${name}/spec`;
/** Add or replace one record (and its prose) in a draft's spec, in the draft's layout. */
function setRecord(root, name, layout, id, rec, prose) {
  const spec = join(root, D(name));
  const area = areaPathOf(id);
  if (layout === 1) {
    const m = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));
    m.claims[id] = rec;
    writeFileSync(join(spec, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  } else {
    const p = join(spec, "claims", `${area}.json`);
    const recs = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    recs[id] = rec;
    const sorted = Object.fromEntries(Object.keys(recs).sort(byCodePoint).map((k) => [k, recs[k]]));
    put(spec, `claims/${area}.json`, JSON.stringify(sorted, null, 2) + "\n");
  }
  if (prose !== undefined) put(spec, `claims/${area}.md`, prose);
}
const note = (root, name, id, text = "checked by hand") => {
  const j = run(root, "evidence", name, "--id", id, "--by", "chat", "--verification", text, "--note", "--write");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  return j;
};
/** A draft adding §b/<name> mapping lib/<name>.txt, with its note unless `withNote: false`. */
function featureDraft(root, layout, name, { withNote = true, authority = "accepted" } = {}) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  const id = `§b/${name}`;
  setRecord(root, name, layout, id, { kind: "behavior", ...(authority ? { authority } : {}), requires: [], code: [`lib/${name}.txt`] }, `# ${id}\n\nThe ${name} feature does its one thing.\n`);
  if (withNote) note(root, name, id);
  return id;
}
const land = (root, rev, ...more) => run(root, "land", "--commit", rev, "--by", "land-it", "--verification", "Made official at landing: test", ...more);
const draftJson = (root, name) => JSON.parse(read(root, `.sova/spec/drafts/${name}/draft.json`));
const pendingOf = (root, name) => { const d = run(root, "drafts").drafts.find((x) => x.name === name); return [...d.pending, ...d.conflict]; };

for (const layout of [1, 2]) {
  const L = `layout ${layout}:`;

  test(`${L} evidence --note records the chat's note with no binding to code, and is not evidence for a manual promote`, () => {
    const { root } = project(layout, ["feat"]);
    const id = featureDraft(root, layout, "feat", { withNote: false });
    const before = tree(root, { official: true });
    const j = note(root, "feat", id, "ran it by hand");
    assert.equal(j.written, true);
    const e = draftJson(root, "feat").evidence.at(-1);
    assert.equal(e.mode, "note");
    assert.equal(e.verification, "ran it by hand");
    assert.equal(e.commit, undefined, "no commit");
    assert.deepEqual(e.inputs ?? [], [], "no inputs");
    for (const bad of [["--commit", "HEAD"], ["--snapshot"], ["--doc-only"], ["--path", "lib/feat.txt"]])
      assert.equal(run(root, "evidence", "feat", "--id", id, "--by", "c", "--verification", "v", "--note", ...bad).exit, 2, `--note with ${bad[0]} is a usage error`);
    assert.ok(codes(run(root, "promote", "feat", "--id", id)).includes("evidence-missing"), "a note alone never lets a manual promote through");
    assert.deepEqual(tree(root, { official: true }), before, "the official spec untouched");
  });

  test(`${L} land previews without writing, then promotes every pending id of every draft at REV in one go, the kind picked per id`, () => {
    const { root } = project(layout, ["one", "two"]);
    const one = featureDraft(root, layout, "one");
    const two = featureDraft(root, layout, "two");
    // A note-kind record maps no code: doc-only, not commit evidence.
    setRecord(root, "two", layout, "§b/two-note", { kind: "note", authority: "accepted" }, undefined);
    put(join(root, D("two")), `claims/${areaPathOf("§b/two-note")}.md`, "# §b/two-note\n\nA note on two.\n");
    note(root, "two", "§b/two-note");
    git(root, "add", "-A");
    git(root, "commit", "-q", "--allow-empty", "-m", "code");
    const REV = git(root, "rev-parse", "HEAD");
    const before = tree(root);

    const pv = land(root, REV);
    assert.equal(pv.exit, 0, JSON.stringify(pv.findings));
    assert.equal(pv.written, false);
    assert.deepEqual(tree(root), before, "the preview writes nothing, drafts included");
    assert.deepEqual(pv.counts, { drafts: 2, added: 3, changed: 0, removed: 0 });

    const w = land(root, REV, "--write");
    assert.equal(w.exit, 0, JSON.stringify(w.findings));
    assert.equal(w.written, true);
    assert.equal(w.nothingToLand, false);
    for (const [name, id] of [["one", one], ["two", two], ["two", "§b/two-note"]]) {
      assert.deepEqual(pendingOf(root, name), [], `${name} landed`);
      const e = [...draftJson(root, name).evidence].reverse().find((x) => x.ids.some((y) => y.id === id) && x.mode !== "note");
      assert.ok(e, `${id}: evidence recorded by land`);
      assert.equal(e.landing, true, `${id}: marked as the landing's`);
      assert.ok(e.verification.startsWith("Made official at landing: test | the chat's note (chat, "), `the landing's text, then the chat's own note: ${e.verification}`);
      assert.ok(e.verification.endsWith("checked by hand"), e.verification);
      if (id === "§b/two-note") assert.equal(e.mode, "doc-only", "a note kind lands on doc-only evidence");
      else {
        assert.equal(e.mode, "commit", `${id}: bound at REV`);
        assert.equal(e.commit, REV);
      }
      assert.match(e.verification, /Made official at landing: test/);
    }
    assert.ok(core(root, "records").records?.["§b/two"], "the landed record reads back");
    assert.ok(core(root, "check").exit <= 1, "the landed spec checks");
    for (const name of ["one", "two"]) assert.deepEqual(draftJson(root, name).promotions.at(-1).landing, { commit: REV, by: "land-it" }, `${name}: the receipt names the landing`);

    // paths: exactly the official spec files that changed, repo-relative; never a draft file.
    const changed = [...git(root, "diff", "--name-only", "HEAD", "--", ".sova/spec").split("\n"), ...git(root, "ls-files", "--others", "--exclude-standard", "--", ".sova/spec").split("\n")].filter(Boolean);
    assert.deepEqual([...w.paths].sort(byCodePoint), changed.sort(byCodePoint), "paths lists every spec file it wrote");
    assert.ok(w.paths.every((p) => p.startsWith(".sova/spec/") && !p.includes("/drafts/")));
    if (layout === 1) assert.ok(w.paths.includes(".sova/spec/manifest.json"));
    else assert.ok(!w.paths.includes(".sova/spec/manifest.json") && w.paths.includes(`.sova/spec/claims/${areaPathOf(one)}.json`), "layout 2: record files, never the manifest");
    // The commit message: a subject, and a body naming the drafts, the records and REV.
    assert.equal(typeof w.commitMessage?.subject, "string");
    assert.ok(w.commitMessage.subject.length > 0 && !w.commitMessage.subject.includes("\n"));
    for (const s of ["one", "two", one, two, REV.slice(0, 7)]) assert.ok(w.commitMessage.body.includes(s), `the body names ${s}:\n${w.commitMessage.body}`);

    // Again: nothing to land, nothing written.
    const after = tree(root);
    const again = land(root, REV, "--write");
    assert.equal(again.exit, 0);
    assert.equal(again.nothingToLand, true);
    assert.deepEqual(again.paths ?? [], []);
    assert.deepEqual(tree(root), after, "a re-run is a no-op");
  });

  test(`${L} a draft of proposals only (authority candidate) is left; a candidate sharing a claim file with a landing record is a finding`, () => {
    const { root } = project(layout, ["feat"]);
    const id = featureDraft(root, layout, "feat");
    assert.equal(run(root, "new", "idea", "--write").exit, 0);
    setRecord(root, "idea", layout, "§c/idea", { kind: "behavior", authority: "candidate", requires: [] }, "# §c/idea\n\nMaybe one day.\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", "code");
    const w = land(root, "HEAD", "--write");
    assert.equal(w.exit, 0, JSON.stringify(w.findings));
    assert.deepEqual(w.left, [{ draft: "idea", why: "proposals", ids: ["§c/idea"] }]);
    assert.deepEqual(pendingOf(root, "feat"), []);
    assert.deepEqual(pendingOf(root, "idea"), ["§c/idea"]);
    assert.ok(!w.paths.some((p) => p.includes("claims/c/")), "nothing of the proposal is written");
    assert.ok(w.paths.some((p) => p.endsWith(`claims/${areaPathOf(id)}.md`)), "the feature's claim is");

    // A candidate in the same claim file as a landing record (§b.mix/maybe lives in b/mix.md beside §b/mix): files
    // move whole, so it can't land half.
    const p2 = project(layout, ["mix"]);
    featureDraft(p2.root, layout, "mix", { withNote: false });
    setRecord(p2.root, "mix", layout, "§b.mix/maybe", { kind: "behavior", authority: "candidate", requires: [] }, "# §b/mix\n\nThe mix feature does its one thing.\n\n## §b.mix/maybe\n\nMaybe.\n");
    assert.equal(areaPathOf("§b.mix/maybe"), areaPathOf("§b/mix"), "the fixture puts both in one claim file");
    note(p2.root, "mix", "§b/mix");
    git(p2.root, "add", "-A"); git(p2.root, "commit", "-q", "--allow-empty", "-m", "code");
    const before = tree(p2.root);
    const r = land(p2.root, "HEAD", "--write");
    assert.equal(r.exit, 1);
    assert.ok(r.findings.some((f) => f.id === "§b.mix/maybe" && ["selection-incomplete", "candidate-label"].includes(f.code)), `the candidate in the landing record's file is a finding: ${JSON.stringify(r.findings)}`);
    assert.deepEqual(tree(p2.root), before, "nothing written");
  });

  test(`${L} verification-missing and verification-stale: a record needs the chat's note on its record and prose as they are now`, () => {
    const { root } = project(layout, ["feat"]);
    const id = featureDraft(root, layout, "feat", { withNote: false });
    git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", "code");
    const before = tree(root);
    const miss = land(root, "HEAD", "--write");
    assert.equal(miss.exit, 1);
    const f = miss.findings.find((x) => x.code === "verification-missing");
    assert.ok(f, JSON.stringify(miss.findings));
    assert.deepEqual([f.draft, f.id], ["feat", id]);
    assert.equal(typeof f.fix, "string");
    assert.deepEqual(tree(root), before, "nothing written");

    note(root, "feat", id);
    // The prose changes after the note: the note is stale.
    put(join(root, D("feat")), `claims/${areaPathOf(id)}.md`, `# ${id}\n\nThe feat feature now does two things.\n`);
    const stale = land(root, "HEAD");
    assert.equal(stale.exit, 1);
    assert.ok(stale.findings.some((x) => x.code === "verification-stale" && x.id === id), JSON.stringify(stale.findings));
    note(root, "feat", id, "re-checked after the rewrite");
    assert.equal(land(root, "HEAD").exit, 0, "a fresh note covers it");
  });

  test(`${L} a clash with current (master moved the same claim) is refused naming the declaration, writing nothing`, () => {
    const { root } = project(layout);
    assert.equal(run(root, "new", "edit", "--write").exit, 0);
    put(join(root, D("edit")), "claims/a/top.md", "# §a/top\n\nThe top does X, and Y on the branch.\n");
    note(root, "edit", "§a/top");
    // Another landing changed §a/top in current.
    put(root, ".sova/spec/claims/a/top.md", "# §a/top\n\nThe top does X, and Z on master.\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "master's docs");
    const before = tree(root);
    const r = land(root, "HEAD", "--write");
    assert.equal(r.exit, 1);
    const f = r.findings.find((x) => x.draft === "edit" && (x.id === "§a/top" || String(x.message).includes("§a/top")));
    assert.ok(f, `a finding names the draft and §a/top: ${JSON.stringify(r.findings)}`);
    assert.deepEqual(tree(root), before, "official spec and the draft byte-identical");
    for (const left of [".sova/spec/.txn", ".sova/spec/drafts/.land"]) assert.ok(!existsSync(join(root, left)), `no ${left}`);
  });

  test(`${L} all or nothing across drafts: the second refused leaves the first unpromoted, spec and draft.json bytes identical`, () => {
    const { root } = project(layout, ["good"]);
    featureDraft(root, layout, "good");
    featureDraft(root, layout, "bad", { withNote: false }); // maps lib/bad.txt, absent: refused too
    git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", "code");
    const before = tree(root);
    const r = land(root, "HEAD", "--write");
    assert.equal(r.exit, 1);
    assert.ok(r.findings.every((x) => x.draft === "bad"), JSON.stringify(r.findings));
    assert.deepEqual(tree(root), before, "nothing changed anywhere under .sova/spec, the good draft's draft.json included");
    assert.ok(pendingOf(root, "good").length === 1, "the good draft still pending");
  });

  test(`${L} a write that fails mid-way puts back everything it wrote, leaves no .land or .txn, and recover has nothing to do`, () => {
    const { root } = project(layout, ["feat"]);
    featureDraft(root, layout, "feat");
    assert.equal(run(root, "new", "edit", "--write").exit, 0);
    put(join(root, D("edit")), "claims/a/top.md", "# §a/top\n\nThe top does X, and Y.\n");
    note(root, "edit", "§a/top");
    git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", "code");
    const before = tree(root);
    // claims/a can't be written: whichever file land writes first, one of its writes fails.
    const locked = join(root, ".sova/spec/claims/a");
    chmodSync(locked, 0o555);
    let r;
    try { r = land(root, "HEAD", "--write"); } finally { chmodSync(locked, 0o755); }
    assert.notEqual(r.exit, 0, JSON.stringify(r));
    assert.equal(r.written, false);
    assert.ok(r.findings.some((f) => /everything it wrote was put back$/.test(f.message)), JSON.stringify(r.findings));
    assert.deepEqual(tree(root), before, "official spec and both drafts' draft.json as they were");
    for (const left of [".sova/spec/.txn", ".sova/spec/drafts/.land"]) assert.ok(!existsSync(join(root, left)), `no ${left}`);
    assert.equal(land(root, "HEAD", "--write").exit, 0, "once writable, it lands");
  });

  test(`${L} draftsHash: sha256 over the sorted '<draft>/<path under spec/> <sha256>' lines; draft.json is not in it; null with no draft`, () => {
    const { root } = project(layout, ["feat"]);
    git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", "code");
    assert.equal(land(root, "HEAD").draftsHash ?? null, null, "no drafts: null");
    featureDraft(root, layout, "feat");
    featureDraft(root, layout, "more");
    const lines = [];
    for (const name of ["feat", "more"]) {
      const base = join(root, D(name));
      const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; e.isDirectory() ? walk(join(d, e.name), r) : lines.push(`${name}/${r} ${sha(readFileSync(join(d, e.name)))}`); } };
      walk(base, "");
    }
    const want = sha(lines.sort(byCodePoint).join("\n"));
    assert.equal(land(root, "HEAD").draftsHash, want);
    note(root, "feat", "§b/feat", "another note");
    assert.equal(land(root, "HEAD").draftsHash, want, "draft.json changes don't move it");
  });
}
