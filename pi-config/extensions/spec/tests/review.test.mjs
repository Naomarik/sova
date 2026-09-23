// Black-box fixture tests for core/sova-spec-review.mjs. Node stdlib only; no Git, no src/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-review.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2);

// §a/top requires §b/mid requires §c/low; each maps one text file. No Git, no src/.
const CLAIMS = {
  "§a/top": { kind: "behavior", requires: ["§b/mid"], code: ["lib/top.txt"] },
  "§b/mid": { kind: "behavior", requires: ["§c/low"], code: ["lib/mid.txt"] },
  "§c/low": { kind: "behavior", requires: [], code: ["lib/low.txt"] },
  "§d/other": { kind: "behavior", requires: [], code: ["lib/other.txt"] },
};
function project(claims = CLAIMS, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "sova-review-test-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", manifest(claims));
  for (const id of Object.keys(claims)) {
    const [ns, name] = id.slice(1).split("/");
    write(root, `.sova/spec/claims/${ns}/${name}.md`, `# ${id}\n\nClaim ${name}.\n`);
  }
  for (const f of ["top", "mid", "low", "other"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
  write(root, "unrelated.txt", "u1\n");
  for (const [rel, text] of Object.entries(extra)) write(root, rel, text);
  return root;
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const prepare = (root, name, id = "§a/top", write = true) => run(root, "prepare", id, "--name", name, ...(write ? ["--write"] : []));
const record = (root, name, conclusion, ...more) => run(root, "record", name, "--by", "tester", "--conclusion", conclusion, "--note", "checked", ...more);
const codes = (j) => j.findings.map((f) => f.code);
const moved = (j) => Object.fromEntries(j.movement.filter((m) => m.change !== "unchanged" || m.mapping !== "retained").map((m) => [m.path, `${m.change}/${m.mapping}`]));

// Every file under root with its size and mtime: a write anywhere changes this.
function tree(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = `${st.size}:${st.mtimeMs}`; } };
  walk(root);
  return out;
}

test("preview lists paths and byte totals and writes nothing", () => {
  const root = project();
  const before = tree(root);
  const j = prepare(root, "p1", "§a/top", false);
  assert.equal(j.exit, 0);
  assert.equal(j.written, false);
  const paths = j.inputs.map((i) => i.path);
  for (const p of ["lib/top.txt", "lib/mid.txt", "lib/low.txt", ".sova/spec/manifest.json", ".sova/spec/claims/c/low.md"]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.includes("lib/other.txt") && !paths.includes("unrelated.txt"), "only the closure");
  assert.equal(j.inputs.find((i) => i.path === ".sova/spec/README.md").state, "absent", "policy absence explicit");
  assert.equal(j.totals.bytes, j.inputs.reduce((n, i) => n + (i.bytes ?? 0), 0));
  assert.deepEqual(tree(root), before);
  assert.ok(!existsSync(join(root, ".sova/spec/reviews")));
});

test("prepare retains exact dirty working bytes; later edits leave them intact and stale the packet", () => {
  const root = project();
  write(root, "lib/low.txt", "dirty uncommitted bytes\n");
  assert.equal(prepare(root, "p1").exit, 0);
  const obj = join(root, ".sova/spec/reviews/objects", sha("dirty uncommitted bytes\n"));
  assert.equal(readFileSync(obj, "utf8"), "dirty uncommitted bytes\n");
  write(root, "lib/low.txt", "newer\n");
  assert.equal(readFileSync(obj, "utf8"), "dirty uncommitted bytes\n");
  const s = run(root, "status", "p1");
  assert.equal(s.exit, 1);
  assert.equal(s.applicability, "stale");
  assert.deepEqual(moved(s), { "lib/low.txt": "changed/retained" }, "transitive dependency code movement");
});

test("direct code change stales; unrelated file does not; status never writes", () => {
  const root = project();
  prepare(root, "p1");
  write(root, "unrelated.txt", "u2\n");
  write(root, "lib/other.txt", "other v2\n");
  const before = tree(root);
  const s = run(root, "status", "p1");
  assert.equal(s.applicability, "applicable");
  assert.deepEqual(moved(s), {});
  assert.deepEqual(tree(root), before, "status writes nothing");
  write(root, "lib/top.txt", "top v2\n");
  assert.deepEqual(moved(run(root, "status", "p1")), { "lib/top.txt": "changed/retained" });
});

test("reconciled record over applicable evidence meets the gate; unrelated churn keeps it", () => {
  const root = project();
  prepare(root, "p1");
  const r = record(root, "p1", "reconciled", "--self");
  assert.equal(r.exit, 0);
  assert.equal(r.record.selfReview, true);
  write(root, "unrelated.txt", "u3\n");
  const s = run(root, "status", "p1");
  assert.equal(s.exit, 0);
  assert.equal(s.conclusion.conclusion, "reconciled");
  write(root, "lib/mid.txt", "mid v2\n");
  const s2 = run(root, "status", "p1");
  assert.equal(s2.exit, 1, "movement after the record reopens the gate");
  assert.equal(s2.conclusion.conclusion, "reconciled", "conclusion reported separately from applicability");
  assert.equal(s2.applicability, "stale");
});

test("mapping addition stales and names the added input", () => {
  const root = project();
  prepare(root, "p1");
  write(root, "lib/extra.txt", "e\n");
  write(root, ".sova/spec/manifest.json", manifest({ ...CLAIMS, "§b/mid": { ...CLAIMS["§b/mid"], code: ["lib/mid.txt", "lib/extra.txt"] } }));
  const m = moved(run(root, "status", "p1"));
  assert.equal(m["lib/extra.txt"], "new/added");
  assert.equal(m[".sova/spec/manifest.json"], "changed/retained", "whole manifest is an input");
});

test("dependency removal stales; the removed dependency's retained input is still compared", () => {
  const root = project();
  prepare(root, "p1");
  write(root, ".sova/spec/manifest.json", manifest({ ...CLAIMS, "§b/mid": { ...CLAIMS["§b/mid"], requires: [] } }));
  write(root, "lib/low.txt", "low v2\n");
  const s = run(root, "status", "p1");
  assert.deepEqual(s.closure.removed, ["§c/low"]);
  const m = moved(s);
  assert.equal(m["lib/low.txt"], "changed/removed");
  assert.equal(m[".sova/spec/claims/c/low.md"], "unchanged/removed");
});

test("symlink, traversal and secret inputs are refused, never stored; they block reconciled but not unresolved", () => {
  const outside = mkdtempSync(join(tmpdir(), "sova-review-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "target.txt"), "OUTSIDE-BYTES\n");
  const claims = { ...CLAIMS, "§c/low": { kind: "behavior", requires: [], code: ["lib/low.txt", "link.txt", "linkdir/target.txt", "../escape.txt", ".env", "keys/server.pem"] } };
  const root = project(claims, { ".env": "SECRET=ENV-BYTES\n", "keys/server.pem": "PEM-BYTES\n" });
  symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  const j = prepare(root, "p1");
  assert.equal(j.exit, 0, "packet written with findings");
  const st = Object.fromEntries(j.inputs.map((i) => [i.path, i.state]));
  assert.equal(st["link.txt"], "refused");
  assert.equal(st["linkdir/target.txt"], "refused", "symlinked directory component");
  assert.equal(st["../escape.txt"], "refused");
  assert.equal(st[".env"], "refused");
  assert.equal(st["keys/server.pem"], "refused");
  const objs = join(root, ".sova/spec/reviews/objects");
  for (const f of readdirSync(objs)) assert.doesNotMatch(readFileSync(join(objs, f), "utf8"), /OUTSIDE-BYTES|ENV-BYTES|PEM-BYTES/);
  const r = record(root, "p1", "reconciled");
  assert.equal(r.exit, 1);
  assert.ok(codes(r).includes("evidence-incomplete"));
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1/record.json")));
  assert.equal(record(root, "p1", "unresolved").exit, 0);
});

test("unsafe review names are usage errors and write nothing", () => {
  const root = project();
  const before = tree(root);
  for (const n of ["../x", "a/b", ".hidden", "objects", "UP", ""]) {
    const j = prepare(root, n);
    assert.equal(j.exit, 2, n);
    assert.ok(codes(j).includes("usage"));
  }
  assert.equal(run(root, "status", "../../etc").exit, 2);
  assert.deepEqual(tree(root), before);
});

test("concurrent candidate change between prepare and record refuses the record", () => {
  const root = project();
  prepare(root, "p1");
  write(root, ".sova/spec/claims/b/mid.md", "# §b/mid\n\nClaim mid, edited.\n");
  const r = record(root, "p1", "reconciled");
  assert.equal(r.exit, 1);
  assert.ok(codes(r).includes("stale"));
  assert.ok(r.closure.respanned.includes("§b/mid"));
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1/record.json")));
});

test("core exit 1 (uninvestigated requires): packet allowed, reconciled refused, unresolved is not completion", () => {
  const root = project({ ...CLAIMS, "§c/low": { kind: "behavior", code: ["lib/low.txt"] } });
  const j = prepare(root, "p1");
  assert.equal(j.exit, 0);
  assert.equal(j.coreExit, 1);
  assert.ok(j.blockers.some((b) => b.code === "requires-uninvestigated"));
  assert.equal(record(root, "p1", "unaffected").exit, 1);
  const u = record(root, "p1", "unresolved");
  assert.equal(u.exit, 0, "recording unresolved succeeds operationally");
  const s = run(root, "status", "p1");
  assert.equal(s.exit, 1);
  assert.equal(s.conclusion.conclusion, "unresolved");
  assert.equal(s.gate, "outstanding");
});

test("moved incumbent provenance is informational and does not block a conclusion", () => {
  const cite = "keep this line";
  const claims = { ...CLAIMS, "§c/low": { ...CLAIMS["§c/low"], incumbent: [{ file: "docs/old.md", lines: [1, 1], spanSha256: sha(cite) }] } };
  const root = project(claims, { "docs/old.md": `inserted\n${cite}\n` });
  const j = prepare(root, "p1");
  assert.ok(j.informational.some((b) => b.code === "provenance-moved"));
  assert.deepEqual(j.blockers, []);
  assert.ok(j.inputs.some((i) => i.path === "docs/old.md" && i.roles.includes("incumbent") && i.state === "present"));
  assert.equal(record(root, "p1", "reconciled").exit, 0);
});

test("repeat names never overwrite packets or records", () => {
  const root = project();
  prepare(root, "p1");
  const packet = readFileSync(join(root, ".sova/spec/reviews/p1/packet.json"), "utf8");
  write(root, "lib/top.txt", "top v2\n");
  const again = prepare(root, "p1");
  assert.equal(again.exit, 1);
  assert.ok(codes(again).includes("name-taken"));
  assert.equal(prepare(root, "p1", "§a/top", false).exit, 1, "preview reports the taken name too");
  assert.equal(readFileSync(join(root, ".sova/spec/reviews/p1/packet.json"), "utf8"), packet);
  prepare(root, "p2");
  assert.equal(record(root, "p2", "unresolved").exit, 0);
  const rec = readFileSync(join(root, ".sova/spec/reviews/p2/record.json"), "utf8");
  const r2 = record(root, "p2", "reconciled");
  assert.equal(r2.exit, 1);
  assert.ok(codes(r2).includes("record-exists"));
  assert.equal(readFileSync(join(root, ".sova/spec/reviews/p2/record.json"), "utf8"), rec);
});

test("an occupied lock refuses writes and is left in place", () => {
  const root = project();
  write(root, ".sova/spec/reviews/.lock", "someone else\n");
  const j = prepare(root, "p1");
  assert.equal(j.exit, 1);
  assert.ok(codes(j).includes("lock-occupied"));
  assert.equal(readFileSync(join(root, ".sova/spec/reviews/.lock"), "utf8"), "someone else\n");
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1")));
});

test("oversize inputs are refused, not truncated", () => {
  const root = project(undefined, { "lib/low.txt": "x".repeat(2 * 1024 * 1024 + 1) });
  const j = prepare(root, "p1", "§a/top", false);
  const low = j.inputs.find((i) => i.path === "lib/low.txt");
  assert.equal(low.state, "refused");
  assert.match(low.why, /oversize/);
  assert.ok(j.blockers.some((b) => b.path === "lib/low.txt"));
});

test("lost retained bytes make status unable to check", () => {
  const root = project();
  prepare(root, "p1");
  rmSync(join(root, ".sova/spec/reviews/objects", sha("low v1\n")));
  const s = run(root, "status", "p1");
  assert.equal(s.exit, 2);
  assert.ok(codes(s).includes("object-missing"));
});

test("an untrustworthy graph (core exit 2) yields no packet", () => {
  const root = project({ ...CLAIMS, "§a/top": { kind: "nonsense" } });
  const j = prepare(root, "p1");
  assert.equal(j.exit, 2);
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1")));
});

test("human output works", () => {
  const root = project();
  const r = spawnSync(process.execPath, [CLI, "prepare", "§a/top", "--name", "p1", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /preview; nothing written/);
  assert.match(r.stdout, /lib\/low\.txt/);
});
