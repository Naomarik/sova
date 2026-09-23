// Independent black-box safety controls for core/sova-spec-review.mjs (companion to review.test.mjs). Node stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-review.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "sova-review-safety-")); roots.push(r); return r; };
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }

function project(code = ["lib/a.txt"]) {
  const root = tmp();
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§a/top": { kind: "behavior", requires: [], code } } }));
  write(root, ".sova/spec/claims/a/top.md", "# §a/top\n\nTop.\n");
  write(root, "lib/a.txt", "a v1\n");
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  assert.ok(!codes(j).includes("internal"), `internal crash: ${JSON.stringify(j.findings)}`);
  return j;
}
const codes = (j) => j.findings.map((f) => f.code);
const prep = (root, name = "p1") => run(root, "prepare", "§a/top", "--name", name, "--write");
const rec = (root, c, name = "p1") => run(root, "record", name, "--by", "t", "--conclusion", c, "--note", "n");
const tree = (root) => { const out = {}; const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = `${st.size}:${st.mtimeMs}`; } }; walk(root); return out; };
const pkt = (root, name = "p1") => join(root, ".sova/spec/reviews", name, "packet.json");
const objDir = (root) => join(root, ".sova/spec/reviews/objects");
const allObjects = (root) => existsSync(objDir(root)) ? readdirSync(objDir(root)).map((n) => readFileSync(join(objDir(root), n), "utf8")).join("\n") : "";
function tamper(root, fn, name = "p1") { const p = JSON.parse(readFileSync(pkt(root, name), "utf8")); fn(p); writeFileSync(pkt(root, name), JSON.stringify(p)); }

// ---- malicious packet JSON
test("malicious packet input paths (traversal, absolute, secret) never read or retained", () => {
  const root = project(); const outside = tmp(); write(outside, "s.txt", "OUTSIDE-SECRET\n"); write(root, ".env", "ENV-SECRET\n");
  assert.equal(prep(root).exit, 0);
  tamper(root, (p) => p.inputs.push(
    { path: "../" + outside.split("/").pop() + "/s.txt", roles: [], claims: [], state: "absent" },
    { path: join(outside, "s.txt"), roles: [], claims: [], state: "absent" },
    { path: ".env", roles: [], claims: [], state: "absent" }));
  const before = tree(root);
  const j = run(root, "status", "p1");
  assert.equal(j.exit, 1);
  const s = JSON.stringify(j);
  assert.ok(!s.includes("OUTSIDE-SECRET") && !s.includes("ENV-SECRET") && !s.includes(sha("OUTSIDE-SECRET\n")) && !s.includes(sha("ENV-SECRET\n")));
  assert.deepEqual(tree(root), before, "status writes nothing");
});

test("packet sha256 used as object path must be hex: traversal rejected", () => {
  const root = project(); prep(root);
  tamper(root, (p) => { p.inputs.find((i) => i.state === "present").sha256 = "../../../../etc/passwd"; });
  const j = run(root, "status", "p1");
  assert.equal(j.exit, 2); assert.ok(codes(j).includes("packet-corrupt"));
});

for (const [name, fn] of [
  ["inputs contain null", (p) => p.inputs.push(null)],
  ["inputs entry is a string", (p) => p.inputs.push("lib/a.txt")],
  ["closure.passages missing", (p) => { p.closure = {}; }],
  ["closure.passages holds null", (p) => { p.closure.passages = [null]; }],
  ["blockers missing", (p) => { delete p.blockers; }],
  ["blockers is a string", (p) => { p.blockers = "x"; }],
  ["input roles not array", (p) => { p.inputs[0].roles = "claim"; }],
  ["input roles holds number", (p) => { p.inputs[0].roles = [1]; }],
  ["input claims not array", (p) => { p.inputs[0].claims = "§a/top"; }],
  ["input path not string", (p) => { p.inputs[0].path = 5; }],
  ["input state unknown", (p) => { p.inputs[0].state = "fine"; }],
  ["blockers is empty string", (p) => { p.blockers = ""; }],
  ["blockers is object", (p) => { p.blockers = {}; }],
  ["blockers holds null", (p) => { p.blockers = [null]; }],
  ["inputs not array", (p) => { p.inputs = {}; }],
  ["query.id wrong", (p) => { p.query.id = "../x"; }],
  ["name mismatch", (p) => { p.name = "other"; }],
]) {
  test(`malformed packet: ${name} → packet-corrupt exit 2`, () => {
    const root = project(); prep(root); tamper(root, fn);
    for (const cmd of [["status", "p1"], ["record", "p1", "--by", "t", "--conclusion", "reconciled", "--note", "n"]]) {
      const j = run(root, ...cmd);
      assert.equal(j.exit, 2, `${cmd[0]}: ${JSON.stringify(j.findings)}`);
      assert.ok(codes(j).includes("packet-corrupt"), `${cmd[0]}: ${JSON.stringify(j.findings)}`);
    }
    assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1/record.json")));
  });
}

// ---- retained bytes
test("retained object tampered → status/record exit 2", () => {
  const root = project(); prep(root);
  const o = readdirSync(objDir(root))[0]; writeFileSync(join(objDir(root), o), "evil");
  assert.equal(run(root, "status", "p1").exit, 2);
  assert.equal(rec(root, "reconciled").exit, 2);
});

test("objects entry replaced by symlink → refused, target not read", () => {
  const root = project(); prep(root); const outside = tmp(); write(outside, "x", "a v1\n");
  const o = readdirSync(objDir(root))[0]; rmSync(join(objDir(root), o)); symlinkSync(join(outside, "x"), join(objDir(root), o));
  assert.equal(run(root, "status", "p1").exit, 2);
});

test("hard link to a file outside root is not retained", () => {
  const root = project(["lib/h.txt"]); const outside = tmp(); write(outside, "k", "HARDLINK-SECRET\n");
  try { linkSync(join(outside, "k"), join(root, "lib/h.txt")); } catch { return; }
  const j = prep(root);
  assert.ok(!allObjects(root).includes("HARDLINK-SECRET"));
  assert.equal(j.inputs.find((i) => i.path === "lib/h.txt").state, "refused");
});

test("secret dir name case variant (.GIT) not retained", () => {
  const root = project([".GIT/config"]); write(root, ".GIT/config", "GITCFG\n");
  const j = prep(root);
  assert.ok(!allObjects(root).includes("GITCFG"));
  assert.equal(j.inputs.find((i) => i.path === ".GIT/config").state, "refused");
});

test("secret code mapping: refused, not in objects, blocks reconciled, unresolved is not a met gate", () => {
  const root = project(["lib/a.txt", "config/.env.production", "keys/server.pem"]);
  write(root, "config/.env.production", "ENVP\n"); write(root, "keys/server.pem", "PEM\n");
  const p = prep(root);
  assert.equal(p.exit, 0);
  assert.ok(!allObjects(root).includes("ENVP") && !allObjects(root).includes("PEM"));
  assert.equal(rec(root, "reconciled").exit, 1);
  assert.equal(rec(root, "unresolved").exit, 0);
  const s = run(root, "status", "p1");
  assert.equal(s.exit, 1); assert.equal(s.conclusion.conclusion, "unresolved"); assert.equal(s.gate, "outstanding");
});

// Secret matching is by credential file shape, not by the word: prose and source named for secrets are inputs.
test("secrets-named claim, doc and source are captured; credential data files beside them stay refused", () => {
  const root = tmp();
  const legit = ["docs/secret.md", "lib/secrets.ts", "lib/secrets.test.ts", "lib/secrets-manager.ts", "docs/secret-handling.md"];
  const creds = ["config/secrets", "config/secret", "config/secrets.json", "config/secrets.local.json", "config/secrets-prod.yaml", "config/SECRETS.YML",
    "config/secrets.sops.yaml", "config/secrets.example.json", "config/secrets.env", ".env", ".env.example", "config/.env.production", "credentials.json", "keys/server.pem", "keys/api.key", ".ssh/config"];
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§app/secrets": { kind: "behavior", requires: [], code: [...legit, ...creds] } } }));
  write(root, ".sova/spec/claims/app/secrets.md", "# §app/secrets\n\nSecrets are masked. CLAIM-BYTES\n");
  for (const f of legit) write(root, f, `LEGIT ${f}\n`);
  for (const f of creds) write(root, f, `CRED ${f}\n`);
  const j = run(root, "prepare", "§app/secrets", "--name", "p1", "--write");
  const state = Object.fromEntries(j.inputs.map((i) => [i.path, i.state]));
  assert.equal(state[".sova/spec/claims/app/secrets.md"], "present", JSON.stringify(j.inputs));
  for (const f of legit) assert.equal(state[f], "present", f);
  for (const f of creds) assert.equal(state[f], "refused", f);
  const stored = allObjects(root);
  assert.ok(stored.includes("CLAIM-BYTES") && legit.every((f) => stored.includes(`LEGIT ${f}`)), "control: legitimate bytes retained");
  assert.ok(!stored.includes("CRED "), "no credential bytes retained");
});

// ---- storage symlinks
for (const link of [".sova/spec/reviews", ".sova/spec/reviews/objects"]) {
  test(`${link} symlinked outside → refused, nothing written outside`, () => {
    const root = project(); const outside = tmp();
    mkdirSync(dirname(join(root, link)), { recursive: true });
    symlinkSync(outside, join(root, link));
    const j = prep(root);
    assert.equal(j.exit, 2, JSON.stringify(j.findings));
    assert.deepEqual(readdirSync(outside), []);
  });
}

test("packet dir symlinked to a crafted outside packet → refused", () => {
  const root = project(); prep(root, "real"); const outside = tmp();
  write(outside, "packet.json", readFileSync(pkt(root, "real"), "utf8").replace('"name": "real"', '"name": "p1"'));
  symlinkSync(outside, join(root, ".sova/spec/reviews/p1"));
  assert.equal(run(root, "status", "p1").exit, 2);
  assert.equal(rec(root, "reconciled").exit, 2);
  assert.ok(!existsSync(join(outside, "record.json")));
});

test("record.json pre-planted as symlink → not followed, not overwritten", () => {
  const root = project(); prep(root); const outside = tmp(); write(outside, "r", "KEEP");
  symlinkSync(join(outside, "r"), join(root, ".sova/spec/reviews/p1/record.json"));
  assert.notEqual(rec(root, "reconciled").exit, 0);
  assert.equal(readFileSync(join(outside, "r"), "utf8"), "KEEP");
  assert.notEqual(run(root, "status", "p1").exit, 0);
});

test("--root that is a symlink, or .sova ancestor symlink → refused, nothing written", () => {
  const real = project(); const outer = tmp(); symlinkSync(real, join(outer, "lnk"));
  const before = tree(real);
  assert.equal(prep(join(outer, "lnk")).exit, 2);
  const r2 = tmp(); symlinkSync(join(real, ".sova"), join(r2, ".sova"));
  assert.equal(prep(r2).exit, 2);
  assert.deepEqual(tree(real), before);
});

// ---- lock and records
test("held lock → exit 1 lock-occupied, lock kept, no record", () => {
  const root = project(); prep(root);
  write(root, ".sova/spec/reviews/.lock", "999 other");
  const j = rec(root, "reconciled");
  assert.equal(j.exit, 1); assert.ok(codes(j).includes("lock-occupied"));
  assert.equal(readFileSync(join(root, ".sova/spec/reviews/.lock"), "utf8"), "999 other");
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/p1/record.json")));
  assert.equal(prep(root, "p2").exit, 1);
});

test("parallel records: exactly one wins, the other refused", async () => {
  const root = project(); prep(root);
  const { spawn } = await import("node:child_process");
  const go = (c) => new Promise((ok) => { const ch = spawn(process.execPath, [CLI, "record", "p1", "--by", "t", "--conclusion", c, "--note", "n", "--root", root, "--json"]); let s = ""; ch.stdout.on("data", (d) => (s += d)); ch.on("close", (st) => ok({ st, j: JSON.parse(s) })); });
  const rs = await Promise.all([go("reconciled"), go("unresolved"), go("unaffected")]);
  assert.equal(rs.filter((r) => r.st === 0).length, 1, JSON.stringify(rs.map((r) => r.j.findings)));
  assert.ok(!existsSync(join(root, ".sova/spec/reviews/.lock")), "lock released");
});

test("record is immutable: second record refused, bytes unchanged", () => {
  const root = project(); prep(root); rec(root, "unresolved");
  const f = join(root, ".sova/spec/reviews/p1/record.json"), b = readFileSync(f, "utf8");
  assert.equal(rec(root, "reconciled").exit, 1);
  assert.equal(readFileSync(f, "utf8"), b);
});

for (const [name, body] of [
  ["corrupt JSON", "{"], ["null", "null"], ["array", "[]"],
  ["wrong packetSha256", (root) => JSON.stringify({ packetSha256: "0".repeat(64), conclusion: "reconciled" })],
  ["bogus conclusion", (root) => JSON.stringify({ packetSha256: sha(readFileSync(pkt(root))), conclusion: "approved" })],
]) {
  test(`record.json ${name} → status never met`, () => {
    const root = project(); prep(root);
    writeFileSync(join(root, ".sova/spec/reviews/p1/record.json"), typeof body === "function" ? body(root) : body);
    const j = run(root, "status", "p1");
    assert.equal(j.exit, 1); assert.equal(j.gate, "outstanding"); assert.equal(j.conclusion.conclusion, null);
  });
}

test("hand-forged valid record for applicable packet: gate met only for reconciled/unaffected", () => {
  const root = project(); prep(root);
  writeFileSync(join(root, ".sova/spec/reviews/p1/record.json"), JSON.stringify({ packetSha256: sha(readFileSync(pkt(root))), conclusion: "unresolved" }));
  assert.equal(run(root, "status", "p1").exit, 1);
});

// ---- no execution of project code
test("project code is never executed", () => {
  const root = project(["lib/a.txt", "run.mjs"]);
  const marker = join(root, "EXECUTED");
  const payload = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`;
  write(root, "run.mjs", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  write(root, "package.json", JSON.stringify({ type: "module", scripts: { preinstall: payload } }));
  write(root, "core/sova-spec.mjs", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  write(root, "sova-spec.mjs", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  prep(root); rec(root, "unaffected"); run(root, "status", "p1");
  assert.ok(!existsSync(marker));
});

test("unsafe --by/--note bytes stay data; names with traversal refused", () => {
  const root = project(); prep(root);
  for (const n of ["../x", "objects", ".lock", "A", "a/b", "a".repeat(65)]) assert.equal(run(root, "status", n).exit, 2, n);
  assert.equal(run(root, "record", "p1", "--by", "t\u0001x", "--conclusion", "reconciled", "--note", "n").exit, 2);
});
