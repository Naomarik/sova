// Git merges of spec changes: the `merge-claims` driver and landing-order-independent manifest keys.
// Black-box fixture tests for core/sova-spec-draft.mjs. Node stdlib only (plus `git` for the merge test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const cleanEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = () => { const r = mkdtempSync(join(tmpdir(), "sova-claims-merge-")); roots.push(r); return r; };
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const note = { kind: "note", authority: "accepted" };
const CLAIMS = { "§a/top": { kind: "surface", authority: "accepted" }, "§a.top/one": { ...note }, "§a.top/two": { ...note }, "§b/side": { kind: "surface", authority: "accepted" } };
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne says X.\n\n### Detail\n\nPlain H3 prose.\n\n## §a.top/two\n\nTwo says Y.\n";
const SIDE = "# §b/side\n\nThe side surface.\n";
const FILE = ".sova/spec/claims/a/top.md", MAN = ".sova/spec/manifest.json";
const D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;

function project() {
  const root = temp();
  write(root, MAN, manifest(CLAIMS));
  write(root, FILE, TOP);
  write(root, ".sova/spec/claims/b/side.md", SIDE);
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: cleanEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
// A change: new note H2s after §a.top/one (and records appended to the draft manifest, wherever the editor puts them).
const CHANGES = {
  x: { ids: ["§a.top/xnew"], edit: (t) => t.replace("## §a.top/two", "## §a.top/xnew\n\nX adds this.\n\n## §a.top/two") },
  y: { ids: ["§a.top/ynew", "§b.side/ynote"], edit: (t) => t.replace("## §a.top/two", "## §a.top/ynew\n\nY adds this.\n\n## §a.top/two"), side: "\n## §b.side/ynote\n\nY notes the side.\n" },
};
function draft(root, name) {
  const c = CHANGES[name];
  assert.equal(run(root, "new", name, "--write").exit, 0);
  write(root, D(name, "claims/a/top.md"), c.edit(read(root, D(name, "claims/a/top.md"))));
  if (c.side) write(root, D(name, "claims/b/side.md"), read(root, D(name, "claims/b/side.md")) + c.side);
  editManifest(root, D(name, "manifest.json"), (m) => { for (const id of c.ids) m.claims[id] = { ...note }; });
}
function promote(root, name) {
  const ids = CHANGES[name].ids.flatMap((i) => ["--id", i]);
  assert.equal(run(root, "evidence", name, ...ids, "--by", "tester", "--verification", "doc-only notes", "--doc-only", "--write").exit, 0);
  const p = run(root, "promote", name, ...ids);
  assert.equal(p.exit, 0, JSON.stringify(p.refusals));
  const w = run(root, "promote", name, ...ids, "--plan", p.plan, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w.refusals));
}
/** In one tree: both drafts made from the same base, promoted in `order`. */
function inTree(order) {
  const root = project();
  for (const n of order) draft(root, n);
  for (const n of order) promote(root, n);
  return { root, top: read(root, FILE), side: read(root, ".sova/spec/claims/b/side.md"), man: read(root, MAN) };
}

test("promotion order doesn't change the manifest's bytes: new records sit by their area, sorted", () => {
  const xy = inTree(["x", "y"]), yx = inTree(["y", "x"]);
  assert.equal(xy.top, yx.top);
  assert.equal(xy.man, yx.man);
  assert.deepEqual(Object.keys(JSON.parse(xy.man).claims), ["§a/top", "§a.top/one", "§a.top/two", "§a.top/xnew", "§a.top/ynew", "§b/side", "§b.side/ynote"]);
});

function driver(base, ours, theirs, root = project()) {
  const dir = temp();
  for (const [n, t] of Object.entries({ base, ours, theirs })) if (t !== null) writeFileSync(join(dir, n), t);
  const j = run(root, "merge-claims", "--base", join(dir, "base"), "--ours", join(dir, "ours"), "--theirs", join(dir, "theirs"), "--path", FILE, "--write");
  return { j, text: readFileSync(join(dir, "ours"), "utf8") };
}

test("merge-claims: two new H2s at one spot merge to the in-tree promotion's bytes, either side as ours", () => {
  const xy = inTree(["x", "y"]);
  const X = CHANGES.x.edit(TOP), Y = CHANGES.y.edit(TOP);
  for (const [o, t] of [[X, Y], [Y, X]]) {
    const r = driver(TOP, o, t);
    assert.equal(r.j.exit, 0, JSON.stringify(r.j.findings));
    assert.equal(r.text, xy.top);
  }
});

test("merge-claims: the same declaration changed differently conflicts, with both sides' prose and Git's markers", () => {
  const r = driver(TOP, TOP.replace("One says X.", "One says X, ours."), TOP.replace("One says X.", "One says X, theirs."));
  assert.equal(r.j.exit, 1);
  assert.ok(r.j.conflicts.some((c) => c.includes("§a.top/one")), JSON.stringify(r.j));
  // The refusal carries the one recovery for a spec conflict a Git merge leaves.
  assert.match(JSON.stringify(r.j), /git checkout --no-overlay \w+ -- \.sova\/spec\/manifest\.json \.sova\/spec\/claims.*never `--ours`/, JSON.stringify(r.j));
  assert.match(r.text, /^<<<<<<< /m);
  assert.match(r.text, /One says X, ours\./);
  assert.match(r.text, /One says X, theirs\./);
  assert.match(r.text, /^>>>>>>> /m);
});

test("merge-claims: changed on one side, deleted on the other conflicts; a file without declarations gets Git's line merge", () => {
  const del = TOP.replace("## §a.top/two\n\nTwo says Y.\n", "").replace(/\n+$/, "\n");
  const r = driver(TOP, TOP.replace("Two says Y.", "Two says Y, changed."), del);
  assert.equal(r.j.exit, 1);
  assert.match(r.text, /Two says Y, changed\./);
  const plain = driver("line one\nline two\n", "line one\nline two, ours\n", "line one\nline two, theirs\n");
  assert.equal(plain.j.exit, 1);
  assert.match(plain.text, /^<<<<<<< [\s\S]*line two, ours[\s\S]*line two, theirs[\s\S]*^>>>>>>> /m);
  const clean = driver("a\nb\nc\n", "a2\nb\nc\n", "a\nb\nc2\n");
  assert.equal(clean.j.exit, 0);
  assert.equal(clean.text, "a2\nb\nc2\n");
});

test("merge-claims without --write writes nothing", () => {
  const dir = temp(), root = project();
  writeFileSync(join(dir, "b"), TOP); writeFileSync(join(dir, "o"), CHANGES.x.edit(TOP)); writeFileSync(join(dir, "t"), CHANGES.y.edit(TOP));
  const j = run(root, "merge-claims", "--base", join(dir, "b"), "--ours", join(dir, "o"), "--theirs", join(dir, "t"));
  assert.equal(j.exit, 0);
  assert.equal(j.written, false);
  assert.equal(readFileSync(join(dir, "o"), "utf8"), CHANGES.x.edit(TOP));
});

test("merge-manifest inserts theirs' new records by the same rule, so the result doesn't depend on which side is ours", () => {
  const base = manifest(CLAIMS);
  const add = (ids) => { const m = JSON.parse(base); for (const id of ids) m.claims[id] = { ...note }; return JSON.stringify(m, null, 2) + "\n"; };
  const X = add(CHANGES.x.ids), Y = add(CHANGES.y.ids);
  const merge = (o, t) => { const dir = temp(); writeFileSync(join(dir, "b"), base); writeFileSync(join(dir, "o"), o); writeFileSync(join(dir, "t"), t);
    const j = run(project(), "merge-manifest", "--base", join(dir, "b"), "--ours", join(dir, "o"), "--theirs", join(dir, "t"), "--write");
    assert.equal(j.exit, 0); return readFileSync(join(dir, "o"), "utf8"); };
  // Ours already holds its own new record where promotion put it.
  const ox = merge(base, X), oy = merge(base, Y);
  assert.equal(merge(ox, Y), merge(oy, X));
  assert.equal(merge(ox, Y), inTree(["x", "y"]).man);
});

test("the insertion rule is landing-order independent on unsorted manifests (random)", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = () => { const a = ["a", "b", "c", "d"][rnd(4)], s = ["", ".p", ".q"][rnd(3)]; return `§${a}${s}/${"kmnrt"[rnd(5)]}${rnd(9)}`; };
  const root = project(), dir = temp();
  const merge = (b, o, t) => { writeFileSync(join(dir, "b"), b); writeFileSync(join(dir, "o"), o); writeFileSync(join(dir, "t"), t);
    const j = run(root, "merge-manifest", "--base", join(dir, "b"), "--ours", join(dir, "o"), "--theirs", join(dir, "t"), "--write");
    assert.equal(j.exit, 0); return readFileSync(join(dir, "o"), "utf8"); };
  for (let round = 0; round < 12; round++) {
    const old = {}; while (Object.keys(old).length < 6) old[ids()] = { ...note };
    const fresh = () => { const out = {}; while (Object.keys(out).length < 2) { const k = ids(); if (!(k in old)) out[k] = { ...note }; } return out; };
    const A = fresh(), B = fresh(); for (const k of Object.keys(B)) if (k in A) delete B[k];
    const L = manifest(old), LA = manifest({ ...old, ...A }), LB = manifest({ ...old, ...B });
    const viaA = merge(L, merge(L, L, LA), LB), viaB = merge(L, merge(L, L, LB), LA);
    assert.equal(viaA, viaB, `round ${round}: ${Object.keys(old)} + ${Object.keys(A)} / ${Object.keys(B)}`);
  }
});

test("a Git merge with the drivers configured: no conflict, the in-tree bytes; the same H2 edited differently still conflicts", () => {
  const ref = inTree(["x", "y"]);
  const solo = (n) => { const r = inTree([n]); return { top: r.top, side: r.side, man: r.man }; };
  const sx = solo("x"), sy = solo("y");
  const repo = project();
  const git = (...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8", env: cleanEnv(repo) }); return r; };
  assert.equal(git("init", "-q", "-b", "main").status, 0);
  write(repo, ".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n.sova/spec/claims/**/*.md merge=sova-spec-claims\n");
  git("config", "merge.sova-spec-manifest.driver", `"${process.execPath}" "${CLI}" merge-manifest --root . --base %O --ours %A --theirs %B --write`);
  git("config", "merge.sova-spec-claims.driver", `"${process.execPath}" "${CLI}" merge-claims --root . --base %O --ours %A --theirs %B --path %P --write`);
  write(repo, "notes.md", "# notes\n\nline\n");
  git("add", "-A"); assert.equal(git("commit", "-qm", "base").status, 0);
  const branch = (name, s, extra = () => {}) => {
    git("checkout", "-qb", name, "main");
    write(repo, FILE, s.top); write(repo, ".sova/spec/claims/b/side.md", s.side); write(repo, MAN, s.man); extra();
    git("add", "-A"); assert.equal(git("commit", "-qm", name).status, 0);
  };
  branch("bx", sx, () => write(repo, "notes.md", "# notes\n\nline x\n"));
  branch("by", sy, () => write(repo, "notes.md", "# notes\n\nline y\n"));
  git("checkout", "-q", "bx");
  const m = git("merge", "-q", "--no-edit", "by");
  const conflicted = git("diff", "--name-only", "--diff-filter=U").stdout.trim().split("\n").filter(Boolean);
  assert.deepEqual(conflicted, ["notes.md"], m.stdout + m.stderr);  // a plain .md keeps Git's own merge
  assert.equal(read(repo, FILE), ref.top);
  assert.equal(read(repo, ".sova/spec/claims/b/side.md"), ref.side);
  assert.equal(read(repo, MAN), ref.man);
  git("merge", "--abort");
  // Guard: the same H2 changed differently on both branches still conflicts, keeping both sides' prose.
  branch("cx", { ...sx, top: TOP.replace("One says X.", "One says X, cx.") });
  branch("cy", { ...sx, top: TOP.replace("One says X.", "One says X, cy.") });
  git("checkout", "-q", "cx");
  git("merge", "-q", "--no-edit", "cy");
  assert.deepEqual(git("diff", "--name-only", "--diff-filter=U").stdout.trim().split("\n"), [FILE]);
  assert.match(read(repo, FILE), /One says X, cx\.[\s\S]*One says X, cy\./);
});
