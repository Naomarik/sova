// Black-box CLI fixture tests for core/sova-spec.mjs. Node stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, statSync, readFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

// Build a project: manifest object + map of relative files.
function project(manifest, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sova-spec-test-"));
  roots.push(root);
  if (manifest !== undefined) write(root, ".sova/spec/manifest.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  return root;
}
const claim = (rel, text) => [".sova/spec/claims/" + rel, text];

function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root });
  let json;
  try { json = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, json.exit, "process status equals JSON exit");
  assert.ok(Array.isArray(json.findings), "findings array");
  return json;
}
const codes = (j) => j.findings.map((f) => f.code);
const hasCode = (j, c) => assert.ok(codes(j).includes(c), `expected finding ${c}, got ${JSON.stringify(j.findings)}`);
const ids = (arr) => arr.map((p) => p.id);
const passage = (j, id) => j.passages.find((p) => p.id === id);

const M = (claims, extra = {}) => ({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, claims, ...extra });

// Base fixture: surface §chat/input with send, draft; send requires §core/net.
function base(extra = {}, overrideClaims = {}) {
  return project(
    M({
      "§chat/input": { kind: "surface" },
      "§chat.input/send": { kind: "behavior", requires: ["§core/net"], code: ["app.txt"] },
      "§chat.input/draft": { kind: "behavior", requires: [] },
      "§core/net": { kind: "surface" },
      ...overrideClaims,
    }, extra),
    Object.fromEntries([
      claim("chat/input.md", "# §chat/input\n\nThe input lede.\n\n## §chat.input/send\n\nSends.\n\n## §chat.input/draft\n\nDrafts.\n"),
      claim("core/net.md", "# §core/net\n\nNetwork.\n"),
      ["app.txt", "app\n"],
    ]),
  );
}

test("scope: surface expands children; body is actual text", () => {
  const j = run(base(), "scope", "§chat/input");
  assert.equal(j.command, "scope");
  assert.deepEqual(ids(j.passages).sort(), ["§chat.input/draft", "§chat.input/send", "§chat/input", "§core/net"].sort());
  assert.equal(j.passages[0].id, "§chat/input");
  const send = passage(j, "§chat.input/send");
  assert.match(send.text, /^## §chat\.input\/send\n/);
  assert.match(send.text, /Sends\./);
  assert.doesNotMatch(send.text, /Drafts/);
  assert.equal(send.file, ".sova/spec/claims/chat/input.md");
  assert.deepEqual(send.lines, [5, 7]);
  assert.ok(send.reasons.some((r) => r.reason === "child" && r.of === "§chat/input"));
  assert.ok(passage(j, "§core/net").reasons.some((r) => r.reason === "requires" && r.of === "§chat.input/send"));
  assert.equal(j.exit, 0);
});

test("scope: child gets parent orientation, siblings excluded", () => {
  const j = run(base(), "scope", "§chat.input/send");
  assert.deepEqual(ids(j.passages).sort(), ["§chat.input/send", "§chat/input", "§core/net"].sort());
  const p = passage(j, "§chat/input");
  assert.ok(p.reasons.some((r) => r.reason === "orientation" && r.of === "§chat.input/send"));
  // Deliberately updated: the requested seed comes first; its parent's orientation follows it.
  assert.equal(j.passages[0].id, "§chat.input/send", "requested seed first");
  assert.equal(j.passages[1].id, "§chat/input", "parent orientation right after the seed");
  assert.ok(!ids(j.passages).includes("§chat.input/draft"));
});

test("scope: section expands members; members are not requires in impact", () => {
  const root = project(
    M({
      "§section/chat": { kind: "section", members: ["§chat/input"] },
      "§chat/input": { kind: "surface" },
      "§chat.input/send": { kind: "behavior", requires: [] },
    }),
    Object.fromEntries([
      claim("section/chat.md", "# §section/chat\n\nSection.\n"),
      claim("chat/input.md", "# §chat/input\n\nLede.\n\n## §chat.input/send\n\nS.\n"),
    ]),
  );
  const j = run(root, "scope", "§section/chat");
  assert.deepEqual(new Set(ids(j.passages)), new Set(["§section/chat", "§chat/input", "§chat.input/send"]));
  assert.ok(passage(j, "§chat/input").reasons.some((r) => r.reason === "member" && r.of === "§section/chat"));
  const imp = run(root, "impact", "§chat/input");
  assert.ok(!(imp.consumers || []).some((c) => c.id === "§section/chat"), "membership is not a consumer");
  assert.ok(imp.containers.some((c) => c.id === "§section/chat" && c.relation === "member"));
});

test("scope: multi-parent shared dependency emitted once with both reasons; cycles terminate", () => {
  const root = project(
    M({
      "§a/x": { kind: "surface" },
      "§a.x/one": { kind: "behavior", requires: ["§a.x/shared", "§a.x/two"] },
      "§a.x/two": { kind: "behavior", requires: ["§a.x/shared", "§a.x/one"] },
      "§a.x/shared": { kind: "behavior", requires: [] },
    }),
    Object.fromEntries([claim("a/x.md", "# §a/x\n\nL.\n\n## §a.x/one\n\n1\n\n## §a.x/two\n\n2\n\n## §a.x/shared\n\ns\n")]),
  );
  const j = run(root, "scope", "§a.x/one");
  const list = ids(j.passages);
  assert.equal(list.length, new Set(list).size, "no duplicates");
  const sh = passage(j, "§a.x/shared");
  const ofs = sh.reasons.filter((r) => r.reason === "requires").map((r) => r.of).sort();
  assert.deepEqual(ofs, ["§a.x/one", "§a.x/two"]);
});

test("impact: reverse requires transitive with depth", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: ["§chat.input/send"] } }), "impact", "§core/net");
  const c = Object.fromEntries(j.consumers.map((x) => [x.id, x.depth]));
  assert.equal(c["§chat.input/send"], 1);
  assert.equal(c["§chat.input/draft"], 2);
  assert.ok(!("§core/net" in c), "seed not a consumer");
  assert.ok(j.code.some((x) => x.path === "app.txt"));
});

test("missing requires key → requires-uninvestigated frontier, exit 1", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior" } }), "scope", "§chat.input/draft");
  assert.ok(j.frontier.some((f) => f.id === "§chat.input/draft" && f.reason === "requires-uninvestigated"));
  assert.equal(j.exit, 1);
});

test("unresolved edge → dangling frontier, exit 1", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: ["§nope/gone"] } }), "scope", "§chat.input/draft");
  assert.ok(j.frontier.some((f) => f.id === "§nope/gone" && f.reason === "dangling" && f.of === "§chat.input/draft"));
  hasCode(j, "dangling-edge");
  assert.equal(j.exit, 1);
});

test("missing code → code-missing warning, exit 1", () => {
  const root = base();
  rmSync(join(root, "app.txt"));
  const j = run(root, "scope", "§chat.input/send");
  assert.equal(j.code.find((c) => c.path === "app.txt").state, "missing");
  hasCode(j, "code-missing");
  assert.equal(j.exit, 1);
});

test("code path traversal refused", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: [], code: ["../../etc/passwd"] } }), "scope", "§chat.input/draft");
  const c = j.code.find((x) => x.path.includes("passwd"));
  assert.equal(c.state, "refused");
  assert.ok(j.exit >= 1);
});

test("symlinked claims file refused, exit 2", () => {
  const root = base();
  const outside = project(undefined, { "x.md": "# §core/net\n\nNetwork.\n" });
  rmSync(join(root, ".sova/spec/claims/core/net.md"));
  symlinkSync(join(outside, "x.md"), join(root, ".sova/spec/claims/core/net.md"));
  const j = run(root, "check");
  hasCode(j, "symlink-refused");
  assert.equal(j.exit, 2);
});

test("budget: whole passages, remainder listed unread not truncated", () => {
  const full = run(base(), "scope", "§chat/input");
  const first = Buffer.byteLength(full.passages[0].text);
  const j = run(base(), "--budget", String(first), "scope", "§chat/input");
  assert.equal(j.passages.length, 1);
  assert.equal(j.passages[0].text, full.passages[0].text);
  const unread = j.frontier.filter((f) => f.reason === "unread-budget").map((f) => f.id);
  assert.deepEqual(unread, ids(full.passages).slice(1));
  assert.equal(j.exit, 1);
});

test("check clean fixture exits 0", () => {
  assert.equal(run(base(), "check").exit, 0);
});

test("deterministic output and no file writes", () => {
  const root = base();
  const snap = () => { const out = []; const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const s = statSync(p); out.push([p, s.mtimeMs, s.size]); if (s.isDirectory()) walk(p); } }; walk(root); return JSON.stringify(out); };
  const before = snap();
  for (const cmd of [["check"], ["census"], ["scope", "§chat/input"], ["impact", "§core/net"]]) {
    assert.deepEqual(run(root, ...cmd), run(root, ...cmd));
  }
  assert.equal(snap(), before);
});

const invalid = [
  ["malformed manifest JSON", () => project("{ nope", {}), "manifest-unreadable"],
  ["wrong formatVersion", () => project({ ...M({}), formatVersion: 2 }), "manifest-version"],
  ["invalid id", () => base({}, { "chat input": { kind: "behavior", requires: [] } }), "id-invalid"],
  ["record without heading", () => base({}, { "§chat.input/ghost": { kind: "behavior", requires: [] } }), "undeclared-record"],
  ["heading without record", () => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n## §core.net/extra\n\nx\n")])), "unrecorded-declaration"],
  ["duplicate heading", () => project(M({ "§core/net": { kind: "surface" }, "§core.net/a": { kind: "behavior", requires: [] } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n## §core.net/a\n\nx\n\n## §core.net/a\n\ny\n")])), "duplicate-declaration"],
  ["misfiled heading", () => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/other.md", "# §core/net\n\nN.\n")])), "misfiled-declaration"],
  // Deliberately updated: plain H3+ is prose now; only a §-declaring H3+ is invalid.
  ["§ declared at H3", () => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n### §core.net/deep\n\nx\n")])), "heading-level"],
  ["§ declared at H5", () => project(M({ "§core/net": { kind: "surface" }, "§core.net/a": { kind: "behavior", requires: [] } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n## §core.net/a\n\n##### §core.net/a\n")])), "heading-level"],
  ["plain H2", () => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n## Background\n\nx\n")])), "heading-invalid"],
  ["plain H3 before the lede", () => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "### Preface\n\n# §core/net\n\nN.\n")])), "heading-order"],
];
for (const [name, mk, code] of invalid) {
  test(`invalid: ${name} → ${code}, exit 2`, () => {
    const j = run(mk(), "check");
    hasCode(j, code);
    assert.equal(j.exit, 2);
  });
}

test("fenced headings ignored", () => {
  const root = project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n```\n## §core.net/fake\n```\n\n~~~\n# §x/y\n~~~\n")]));
  const j = run(root, "check");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
});

test("usage errors → exit 2 usage", () => {
  const root = base();
  hasCode(run(root, "check", "--bogus"), "usage");
  hasCode(run(root, "scope"), "usage");
  hasCode(run(root, "check", "§core/net"), "usage");
  hasCode(run(root, "frobnicate"), "usage");
  hasCode(run(root, "scope", "§chat/input", "--budget", "-1"), "usage");
  hasCode(run(root, "scope", "not-an-id"), "usage");
  assert.equal(run(root, "scope", "§none/here").exit, 2);
});

test("manifest not found → exit 2", () => {
  hasCode(run(project(undefined, { "x": "" }), "check"), "manifest-not-found");
});

test("incumbent hash: equal, moved, changed", () => {
  const src = "a\nb\nKEY1\nKEY2\nz\n";
  const hash = createHash("sha256").update("KEY1\nKEY2").digest("hex");
  const mk = () => base({}, { "§chat.input/draft": { kind: "behavior", requires: [], incumbent: [{ file: "old.md", lines: [3, 4], hash }] } });
  let root = mk(); write(root, "old.md", src);
  let p = passage(run(root, "scope", "§chat.input/draft"), "§chat.input/draft");
  assert.equal(p.provenance.state, "cited");
  assert.equal(p.provenance.entries[0].state, "current-equal");
  root = mk(); write(root, "old.md", "new\n" + src);
  let j = run(root, "scope", "§chat.input/draft");
  p = passage(j, "§chat.input/draft");
  assert.equal(p.provenance.entries[0].state, "span-moved");
  assert.deepEqual(p.provenance.entries[0].currentLines, [4, 5]);
  root = mk(); write(root, "old.md", "a\nb\nKEY1\nCHANGED\nz\n");
  j = run(root, "scope", "§chat.input/draft");
  assert.equal(passage(j, "§chat.input/draft").provenance.entries[0].state, "changed");
  hasCode(j, "provenance-stale");
  assert.equal(j.exit, 1);
});

test("census: no boundary → boundary-missing exit 1", () => {
  const j = run(base(), "census");
  hasCode(j, "boundary-missing");
  assert.equal(j.exit, 1);
});

test("census: boundary include/exclude with reasons, unclaimed, outside", () => {
  const root = base({ boundary: { include: ["lib"], exclude: [{ path: "lib/vendor", reason: "third party" }] } });
  write(root, "lib/a.js", "");
  write(root, "lib/b.js", "");
  write(root, "lib/vendor/v.js", "");
  const j = run(root, "census");
  assert.deepEqual(j.census.boundary.exclude, [{ path: "lib/vendor", reason: "third party" }]);
  assert.deepEqual([...j.census.unclaimed].sort(), ["lib/a.js", "lib/b.js"]);
  assert.ok(j.census.outside.includes("app.txt"));
  assert.ok(!JSON.stringify(j.census.unclaimed).includes("vendor"));
});

test("human output without --json works", () => {
  const r = spawnSync(process.execPath, [CLI, "check", "--root", base()], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 0);
});

// --- Negative controls (review-tests) ---

test("code: absolute path refused", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: [], code: ["/etc/passwd"] } }), "scope", "§chat.input/draft");
  assert.equal(j.code.find((x) => x.path === "/etc/passwd").state, "refused");
  assert.ok(j.exit >= 1);
});

test("code: symlink escaping root refused, target never read", () => {
  const root = base({}, { "§chat.input/draft": { kind: "behavior", requires: [], code: ["esc.txt"] } });
  const outside = project(undefined, { "secret.txt": "SECRET-OUTSIDE\n" });
  symlinkSync(join(outside, "secret.txt"), join(root, "esc.txt"));
  const j = run(root, "scope", "§chat.input/draft");
  assert.equal(j.code.find((x) => x.path === "esc.txt").state, "refused");
  assert.ok(!JSON.stringify(j).includes("SECRET-OUTSIDE"));
  assert.ok(j.exit >= 1);
});

test("incumbent: path outside root refused, not hashed", () => {
  const outside = project(undefined, { "o.md": "X\n" });
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: [], incumbent: [{ file: join(outside, "o.md"), lines: [1, 1], hash: "0".repeat(64) }] } }), "scope", "§chat.input/draft");
  const e = passage(j, "§chat.input/draft").provenance.entries[0];
  assert.equal(e.state, "refused");
  assert.ok(j.exit >= 1);
});

test("--root elsewhere: claim file symlinked directory refused", () => {
  const root = base();
  const outside = project(undefined, { "net.md": "# §core/net\n\nNetwork.\n" });
  rmSync(join(root, ".sova/spec/claims/core"), { recursive: true });
  symlinkSync(outside, join(root, ".sova/spec/claims/core"));
  const j = run(root, "check");
  hasCode(j, "symlink-refused");
  assert.equal(j.exit, 2);
});

test("no writes even on invalid project and failing commands", () => {
  const root = base({}, { "§chat.input/draft": { kind: "behavior", requires: ["§nope/gone"], code: ["../x"] } });
  const snap = () => { const out = []; const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const s = statSync(p); out.push([p, s.mtimeMs, s.size]); if (s.isDirectory()) walk(p); } }; walk(root); return JSON.stringify(out); };
  const before = snap();
  for (const cmd of [["check"], ["census"], ["scope", "§chat.input/draft"], ["impact", "§core/net"], ["frobnicate"]]) run(root, ...cmd);
  assert.equal(snap(), before);
});

test("cycle: reported with cycle reason, not silently dropped", () => {
  const root = project(
    M({ "§a/x": { kind: "surface" }, "§a.x/one": { kind: "behavior", requires: ["§a.x/two"] }, "§a.x/two": { kind: "behavior", requires: ["§a.x/one"] } }),
    Object.fromEntries([claim("a/x.md", "# §a/x\n\nL.\n\n## §a.x/one\n\n1\n\n## §a.x/two\n\n2\n")]),
  );
  const j = run(root, "scope", "§a.x/one");
  assert.deepEqual(new Set(ids(j.passages)), new Set(["§a/x", "§a.x/one", "§a.x/two"]));
  // seed reached back via two → one: the back-edge must be recorded as a reason on the seed
  assert.ok(passage(j, "§a.x/one").reasons.some((r) => r.reason === "requires" && r.of === "§a.x/two"), "back-edge recorded");
  const imp = run(root, "impact", "§a.x/one");
  assert.ok(!imp.consumers.some((c) => c.id === "§a.x/one"), "seed never its own consumer");
  assert.equal(imp.consumers.find((c) => c.id === "§a.x/two").depth, 1);
});

test("self-require terminates", () => {
  const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: ["§chat.input/draft"] } }), "scope", "§chat.input/draft");
  const list = ids(j.passages);
  assert.equal(list.length, new Set(list).size);
});

test("closure: requires-uninvestigated propagates to frontier for transitive dep", () => {
  const j = run(base({}, { "§core/net": { kind: "behavior" } }), "scope", "§chat.input/send");
  assert.ok(j.frontier.some((f) => f.id === "§core/net" && f.reason === "requires-uninvestigated"));
  assert.equal(j.exit, 1);
});

const badFields = [
  ["requires is string", { requires: "§core/net" }],
  ["requires has non-string", { requires: [42] }],
  ["requires is null", { requires: null }],
  ["code is string", { requires: [], code: "app.txt" }],
  ["code has object", { requires: [], code: [{ path: "app.txt" }] }],
  ["kind unknown", { kind: "wizard", requires: [] }],
  ["incumbent malformed lines", { requires: [], incumbent: [{ file: "app.txt", lines: "1-2", hash: "x" }] }],
];
for (const [name, rec] of badFields) {
  test(`field type: ${name} → exit 2, no crash`, () => {
    const j = run(base({}, { "§chat.input/draft": { kind: "behavior", ...rec } }), "check");
    assert.equal(j.exit, 2, JSON.stringify(j.findings));
    assert.ok(j.findings.length > 0);
  });
}

test("record not an object → exit 2", () => {
  assert.equal(run(base({}, { "§chat.input/draft": "behavior" }), "check").exit, 2);
});

test("claims not an object → exit 2", () => {
  assert.equal(run(project({ formatVersion: 1, grammar: { claimsRoot: "claims/" }, claims: [] }), "check").exit, 2);
});

test("claimsRoot escaping .sova/spec refused", () => {
  const j = run(project({ formatVersion: 1, grammar: { claimsRoot: "../../" }, claims: {} }), "check");
  assert.equal(j.exit, 2);
});

// --- claimsRoot containment and grammar robustness ---

const netClaim = "# §core/net\n\nNetwork.\n";
test("custom multi-level claimsRoot works", () => {
  const root = project({ formatVersion: 1, grammar: { claimsRoot: "alias/claims/" }, claims: { "§core/net": { kind: "surface" } } }, { ".sova/spec/alias/claims/core/net.md": netClaim });
  assert.equal(run(root, "check").exit, 0);
});

test("claimsRoot: intermediate symlink escaping root refused, outside never read", () => {
  const outside = project(undefined, { "claims/core/net.md": "# §core/net\n\nOUTSIDE-SECRET\n" });
  const root = project({ formatVersion: 1, grammar: { claimsRoot: "alias/claims" }, claims: { "§core/net": { kind: "surface" } } });
  symlinkSync(outside, join(root, ".sova/spec/alias"));
  const j = run(root, "check");
  hasCode(j, "symlink-refused");
  assert.equal(j.exit, 2);
  assert.ok(!JSON.stringify(run(root, "scope", "§core/net")).includes("OUTSIDE-SECRET"));
});

test("claimsRoot: symlinked .sova/spec ancestor refused", () => {
  const outside = project({ formatVersion: 1, grammar: { claimsRoot: "claims/" }, claims: { "§core/net": { kind: "surface" } } }, { ".sova/spec/claims/core/net.md": netClaim });
  const root = mkdtempSync(join(tmpdir(), "sova-spec-test-")); roots.push(root);
  symlinkSync(join(outside, ".sova"), join(root, ".sova"));
  const r = spawnSync(process.execPath, [CLI, "check", "--root", root, "--json"], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "linked spec dir must not validate clean");
});

for (const cr of ["..\\..\\", "claims\\..\\..\\x", "/abs", "C:\\claims", "a/../..", "./", "", 7, null, ["claims"]]) {
  test(`claimsRoot ${JSON.stringify(cr)} → exit 2 JSON, no crash`, () => {
    const j = run(project({ formatVersion: 1, grammar: { claimsRoot: cr }, claims: {} }), "check");
    assert.equal(j.exit, 2, JSON.stringify(j.findings));
  });
}

test("claimsRoot backslash separators normalize like slashes", () => {
  const root = project({ formatVersion: 1, grammar: { claimsRoot: "alias\\claims\\" }, claims: { "§core/net": { kind: "surface" } } }, { ".sova/spec/alias/claims/core/net.md": netClaim });
  const j = run(root, "check");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
});

for (const g of ["claims/", 5, [], true, { directoryKinds: "section" }, { directoryKinds: [1] }, { id: 3 }]) {
  test(`malformed grammar ${JSON.stringify(g)} → JSON result, no crash`, () => {
    const j = run(project({ formatVersion: 1, grammar: g, claims: {} }), "check");
    assert.ok(j.exit === 2 || (j.exit === 0 && typeof g !== "object"), JSON.stringify(j));
  });
}

// --- check on malformed records, fs read errors, budget typing ---

const checkBad = [
  { requires: 5 }, { requires: [], code: 7 }, { requires: [], code: [7] }, { requires: [], incumbent: "old.md" },
  { requires: [], incumbent: [null] }, { requires: [], incumbent: [{ file: 3, lines: [1, 1], hash: "x" }] },
  { requires: [], incumbent: [{ file: "app.txt", lines: [2, 1], hash: "x" }] }, { requires: [], members: "§core/net" },
];
for (const rec of checkBad) {
  for (const cmd of [["check"], ["census"], ["scope", "§chat.input/draft"], ["impact", "§chat.input/draft"]]) {
    test(`malformed ${JSON.stringify(rec)} ${cmd[0]} → JSON exit 2, no crash`, () => {
      const j = run(base({}, { "§chat.input/draft": { kind: "behavior", ...rec } }), ...cmd);
      assert.equal(j.exit, 2, JSON.stringify(j.findings));
    });
  }
}

const isRoot = process.getuid?.() === 0;
test("unreadable claims file → JSON exit 2, no crash", { skip: isRoot }, () => {
  const root = base(); const f = join(root, ".sova/spec/claims/core/net.md");
  chmodSync(f, 0o000);
  try { assert.equal(run(root, "check").exit, 2); } finally { chmodSync(f, 0o644); }
});
test("unreadable claims directory → JSON exit 2, no crash", { skip: isRoot }, () => {
  const root = base(); const d = join(root, ".sova/spec/claims/core");
  chmodSync(d, 0o000);
  try { assert.equal(run(root, "check").exit, 2); } finally { chmodSync(d, 0o755); }
});
test("unreadable code file → JSON result, no crash", { skip: isRoot }, () => {
  const root = base({}, { "§chat.input/draft": { kind: "behavior", requires: [], incumbent: [{ file: "app.txt", lines: [1, 1], hash: "0".repeat(64) }] } });
  chmodSync(join(root, "app.txt"), 0o000);
  try { assert.ok(run(root, "scope", "§chat.input/draft").exit >= 1); } finally { chmodSync(join(root, "app.txt"), 0o644); }
});
test("unreadable boundary dir in census → JSON, no crash", { skip: isRoot }, () => {
  const root = base({ boundary: { include: ["lib"], exclude: [] } }); write(root, "lib/x/a.js", "");
  chmodSync(join(root, "lib/x"), 0o000);
  try { assert.ok(run(root, "census").exit >= 1); } finally { chmodSync(join(root, "lib/x"), 0o755); }
});

for (const b of ["Infinity", "1e400", "9007199254740993", "1.5", "NaN", "0x10", "1e3", "", "abc"]) {
  test(`--budget ${JSON.stringify(b)} → usage exit 2`, () => {
    const j = run(base(), "scope", "§chat/input", "--budget", b);
    hasCode(j, "usage");
    assert.equal(j.exit, 2);
  });
}

for (const inc of ["/", "../", "lib/../.."]) {
  test(`boundary include ${inc} refused, never walked`, () => {
    const j = run(base({ boundary: { include: [inc], exclude: [] } }), "census");
    hasCode(j, "boundary-refused");
    assert.ok(j.exit >= 1);
    assert.equal(j.census.files, 0);
  });
}

for (const bd of [{ include: "lib" }, { include: [5] }, { exclude: ["lib"] }, { exclude: [{ path: 3 }] }, "lib"]) {
  test(`malformed boundary ${JSON.stringify(bd)} → exit 2 before walking`, () => {
    assert.equal(run(base({ boundary: bd }), "census").exit, 2);
  });
}

// --- nested prose, note kind, labels, --spec ---

const nested = "# §core/net\n\nLede.\n\n### Lede detail\n\nLD.\n\n## §core.net/a\n\nA.\n\n### Rationale\n\nWhy A.\n\n#### Table\n\n| x |\n|---|\n\n###### See §core.net/b for more\n\nstill A.\n\n## §core.net/b\n\nB.\n";
const nestedRoot = (extra = {}) => project(M({ "§core/net": { kind: "surface" }, "§core.net/a": { kind: "behavior", requires: [] }, "§core.net/b": { kind: "behavior", requires: [] }, ...extra }), Object.fromEntries([claim("core/net.md", nested)]));

test("plain H3–H6 is prose inside the enclosing H1/H2 span", () => {
  const root = nestedRoot();
  assert.equal(run(root, "check").exit, 0, JSON.stringify(run(root, "check").findings));
  const j = run(root, "scope", "§core.net/a");
  const a = passage(j, "§core.net/a"), lede = passage(j, "§core/net");
  assert.match(a.text, /### Rationale\n\nWhy A\.\n\n#### Table/);
  assert.match(a.text, /still A\.\n$/);
  assert.doesNotMatch(a.text, /B\./);
  assert.match(lede.text, /### Lede detail\n\nLD\.\n$/);
  assert.doesNotMatch(lede.text, /A\./);
  assert.ok(!ids(j.passages).includes("§core.net/b"), "a § mentioned mid-heading cites, never declares");
});

test("§ inside a fence at H3 depth never declares", () => {
  const root = project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", "# §core/net\n\nN.\n\n```md\n### §core.net/fake\n```\n")]));
  assert.equal(run(root, "check").exit, 0);
});

test("prose before the lede warns (exit 1); control without it is clean", () => {
  const mk = (pre) => project(M({ "§core/net": { kind: "surface" } }), Object.fromEntries([claim("core/net.md", `${pre}# §core/net\n\nN.\n`)]));
  assert.equal(run(mk("\n\n"), "check").exit, 0);
  const j = run(mk("Orphan paragraph.\n\n"), "check");
  hasCode(j, "prose-outside-declaration");
  assert.equal(j.findings.find((f) => f.code === "prose-outside-declaration").line, 1);
  assert.equal(j.exit, 1);
});

test("note kind: H1 and H2, requires optional and never uninvestigated", () => {
  const root = project(
    M({ "§core/net": { kind: "surface" }, "§core.net/why": { kind: "note" }, "§ref/glossary": { kind: "note" }, "§ref.glossary/term": { kind: "note", requires: ["§core/net"] } }),
    Object.fromEntries([
      claim("core/net.md", "# §core/net\n\nN.\n\n## §core.net/why\n\nDecision.\n"),
      claim("ref/glossary.md", "# §ref/glossary\n\nG.\n\n### Plain\n\np\n\n## §ref.glossary/term\n\nT.\n"),
    ]),
  );
  const c = run(root, "check");
  assert.equal(c.exit, 0, JSON.stringify(c.findings));
  assert.equal(c.counts.kinds.note, 3);
  const j = run(root, "scope", "§ref/glossary");
  assert.deepEqual(new Set(ids(j.passages)), new Set(["§ref/glossary", "§ref.glossary/term", "§core/net", "§core.net/why"]));
  assert.equal(passage(j, "§ref/glossary").kind, "note");
  assert.ok(!j.frontier.some((f) => f.reason === "requires-uninvestigated"));
  assert.equal(j.exit, 0);
  const imp = run(root, "impact", "§core/net");
  assert.ok(!imp.frontier.some((f) => f.reason === "requires-uninvestigated"), "notes are not possible hidden consumers");
});

test("note kind: members refused; behavior control still requires-uninvestigated", () => {
  const bad = project(M({ "§ref/glossary": { kind: "note", members: [] } }), Object.fromEntries([claim("ref/glossary.md", "# §ref/glossary\n\nG.\n")]));
  assert.equal(run(bad, "check").exit, 2);
  const beh = project(M({ "§ref/glossary": { kind: "behavior" } }), Object.fromEntries([claim("ref/glossary.md", "# §ref/glossary\n\nG.\n")]));
  hasCode(run(beh, "check"), "requires-uninvestigated");
});

test("labels: reported verbatim, counted, absent when undeclared, never change exit", () => {
  const root = base({}, {
    "§chat/input": { kind: "surface", authority: "migrated", evidence: "unreviewed" },
    "§chat.input/send": { kind: "behavior", requires: ["§core/net"], code: ["app.txt"], evidence: "verified" },
  });
  const j = run(root, "scope", "§chat/input");
  assert.deepEqual(passage(j, "§chat/input").labels, { authority: "migrated", evidence: "unreviewed" });
  assert.deepEqual(passage(j, "§chat.input/send").labels, { evidence: "verified" });
  assert.ok(!("labels" in passage(j, "§core/net")));
  assert.equal(j.exit, 0);
  const c = run(root, "check");
  assert.deepEqual(c.counts.labels, { authority: { migrated: 1 }, evidence: { unreviewed: 1, verified: 1 }, unlabeled: 2 });
  const imp = run(root, "impact", "§core/net");
  assert.deepEqual(imp.consumers.find((x) => x.id === "§chat.input/send").labels, { evidence: "verified" });
  // "verified" is no proof: a dangling edge still makes the closure unknown.
  const d = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: ["§nope/gone"], authority: "accepted", evidence: "verified" } }), "scope", "§chat.input/draft");
  assert.equal(d.exit, 1);
});

for (const [key, val] of [["authority", "current"], ["authority", "Migrated"], ["evidence", "proven"], ["evidence", true], ["authority", null]]) {
  test(`label ${key}=${JSON.stringify(val)} → label-invalid exit 2`, () => {
    const j = run(base({}, { "§chat.input/draft": { kind: "behavior", requires: [], [key]: val } }), "check");
    hasCode(j, "label-invalid");
    assert.equal(j.exit, 2);
  });
}

test("pilot schema/version manifest with derived resolution still reads (note only)", () => {
  const root = project({ schema: "sova-spec/pilot-manifest", version: 1, status: "candidate-unreviewed", resolution: { "§core/net": { file: "x", lines: [9, 9] } }, claims: { "§core/net": { kind: "surface" } } }, Object.fromEntries([claim("core/net.md", netClaim)]));
  const j = run(root, "check");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  hasCode(j, "resolution-ignored");
  assert.equal(passage(run(root, "scope", "§core/net"), "§core/net").lines[0], 1, "spans recomputed, not read from resolution");
});

// A draft graph beside a current one: same ids, different prose; code stays project-root-relative.
function withDraft(dir = ".sova/spec/drafts/feat/spec") {
  const root = base();
  write(root, `${dir}/manifest.json`, JSON.stringify(M({ "§core/net": { kind: "surface", authority: "candidate" }, "§core.net/new": { kind: "behavior", requires: [], code: ["app.txt"] } }), null, 2));
  write(root, `${dir}/claims/core/net.md`, "# §core/net\n\nDRAFT network.\n\n## §core.net/new\n\nNew.\n");
  return root;
}

test("--spec reads the alternate graph; current is untouched; code resolves from the project root", () => {
  const root = withDraft();
  const j = run(root, "--spec", ".sova/spec/drafts/feat/spec", "scope", "§core/net");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  assert.equal(j.spec, ".sova/spec/drafts/feat/spec");
  assert.match(passage(j, "§core/net").text, /DRAFT network/);
  assert.equal(passage(j, "§core/net").file, ".sova/spec/drafts/feat/spec/claims/core/net.md");
  assert.deepEqual(j.code, [{ path: "app.txt", state: "present", claims: ["§core.net/new"] }]);
  const cur = run(root, "scope", "§core/net");
  assert.equal(cur.spec, ".sova/spec");
  assert.doesNotMatch(passage(cur, "§core/net").text, /DRAFT/);
  assert.equal(run(root, "--spec", ".sova/spec/drafts/feat/spec/", "check").spec, ".sova/spec/drafts/feat/spec", "normalized");
});

test("--spec without --root discovers the chosen graph upward from cwd", () => {
  const root = withDraft();
  mkdirSync(join(root, "sub/dir"), { recursive: true });
  const r = spawnSync(process.execPath, [CLI, "check", "--spec", ".sova/spec/drafts/feat/spec", "--json"], { encoding: "utf8", cwd: join(root, "sub/dir") });
  const j = JSON.parse(r.stdout);
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  assert.equal(j.counts.records, 2);
});

test("--spec missing manifest → manifest-not-found exit 2", () => {
  hasCode(run(base(), "--spec", ".sova/spec/drafts/none", "check"), "manifest-not-found");
});

for (const bad of ["/abs", "../x", ".sova/../../x", ".sova/spec/../..", "a/..", ".", "./", "", "C:\\x", "\\\\host\\share"]) {
  test(`--spec ${JSON.stringify(bad)} → usage exit 2`, () => {
    const j = run(base(), "--spec", bad, "check");
    hasCode(j, "usage");
    assert.equal(j.exit, 2);
  });
}

for (const linkAt of [".sova/spec/drafts", ".sova/spec/drafts/feat", ".sova/spec/drafts/feat/spec", ".sova/spec/drafts/feat/spec/manifest.json"]) {
  test(`--spec: symlink at ancestor ${linkAt} refused, outside never read`, () => {
    const root = withDraft();
    assert.equal(run(root, "--spec", ".sova/spec/drafts/feat/spec", "check").exit, 0, "control");
    const outside = project(undefined);
    const src = join(root, linkAt), moved = join(outside, "moved");
    spawnSync("mv", [src, moved]);
    write(outside, "SECRET.md", "OUTSIDE-SECRET\n");
    symlinkSync(moved, src);
    const j = run(root, "--spec", ".sova/spec/drafts/feat/spec", "scope", "§core/net");
    hasCode(j, "symlink-refused");
    assert.equal(j.exit, 2);
    assert.ok(!JSON.stringify(j).includes("DRAFT network"), "content behind the link never read");
  });
}

test("census excludes all of .sova/spec and the chosen --spec, never only the draft", () => {
  const root = withDraft();
  write(root, ".sova/spec/reviews/r.json", "{}");
  write(root, ".sova/other.txt", "");
  write(root, "lib/a.js", "");
  const bd = { include: ["."], exclude: [] };
  const patch = (dir) => { const f = join(root, dir, "manifest.json"); const m = JSON.parse(readFileSync(f, "utf8")); m.boundary = bd; writeFileSync(f, JSON.stringify(m)); };
  patch(".sova/spec"); patch(".sova/spec/drafts/feat/spec");
  for (const args of [[], ["--spec", ".sova/spec/drafts/feat/spec"]]) {
    const j = run(root, ...args, "census");
    const all = [...j.census.claimed, ...j.census.unclaimed];
    assert.ok(all.includes("lib/a.js") && all.includes(".sova/other.txt"), "control: population still walked");
    assert.ok(!all.some((f) => f.startsWith(".sova/spec")), JSON.stringify(all));
  }
  // A graph outside .sova/spec is also excluded from its own census.
  const alt = withDraft("docs/spec");
  const f = join(alt, "docs/spec/manifest.json"); const m = JSON.parse(readFileSync(f, "utf8")); m.boundary = bd; writeFileSync(f, JSON.stringify(m));
  const j = run(alt, "--spec", "docs/spec", "census");
  assert.ok(!j.census.unclaimed.some((p) => p.startsWith("docs/spec") || p.startsWith(".sova/spec")), JSON.stringify(j.census.unclaimed));
});

test("--spec: no writes across every command", () => {
  const root = withDraft();
  const snap = () => { const out = []; const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const s = statSync(p); out.push([p, s.mtimeMs, s.size]); if (s.isDirectory()) walk(p); } }; walk(root); return JSON.stringify(out); };
  const before = snap();
  for (const cmd of [["check"], ["census"], ["scope", "§core/net"], ["impact", "§core/net"]]) run(root, "--spec", ".sova/spec/drafts/feat/spec", ...cmd);
  assert.equal(snap(), before);
});

test("check lists declarations with scope-text hashes; still emitted when the graph is broken", () => {
  const root = nestedRoot();
  const c = run(root, "check");
  assert.deepEqual(c.declarations.map((d) => d.id), ["§core.net/a", "§core.net/b", "§core/net"]);
  const sc = run(root, "scope", "§core.net/a");
  const a = c.declarations.find((d) => d.id === "§core.net/a");
  assert.equal(a.file, ".sova/spec/claims/core/net.md");
  assert.deepEqual(a.lines, passage(sc, "§core.net/a").lines);
  assert.equal(a.level, 2);
  assert.equal(a.textSha256, createHash("sha256").update(passage(sc, "§core.net/a").text).digest("hex"));
  const broken = run(nestedRoot({ "§core.net/ghost": { kind: "behavior", requires: [] } }), "check");
  assert.equal(broken.exit, 2);
  assert.equal(broken.declarations.length, 3);
});

// --- budget never spends the requested seed on orientation ---

// Parent lede P bytes, requested child C bytes, a required behavior after both.
function sized(parentBytes, childBytes) {
  const pad = (head, n) => { const t = `${head}\n\n`; return t + "x".repeat(n - Buffer.byteLength(t) - 1) + "\n"; };
  const lede = pad("# §big/area", parentBytes), child = pad("## §big.area/child", childBytes);
  const root = project(
    M({ "§big/area": { kind: "surface" }, "§big.area/child": { kind: "behavior", requires: ["§big/dep"] }, "§big/dep": { kind: "behavior", requires: [] } }),
    Object.fromEntries([claim("big/area.md", `${lede}\n${child}`), claim("big/dep.md", "# §big/dep\n\nDep.\n")]),
  );
  return root;
}

test("budget: requested child fits, parent+child does not → child delivered, parent named unread", () => {
  const root = sized(1406, 4615);
  const full = run(root, "scope", "§big.area/child");
  assert.equal(Buffer.byteLength(passage(full, "§big.area/child").text), 4615, "fixture sizes");
  assert.equal(Buffer.byteLength(passage(full, "§big/area").text), 1406, "fixture sizes");
  assert.deepEqual(ids(full.passages), ["§big.area/child", "§big/area", "§big/dep"]);
  const j = run(root, "--budget", "4700", "scope", "§big.area/child");
  assert.deepEqual(ids(j.passages), ["§big.area/child"]);
  assert.equal(j.budget.used, 4615);
  const unread = j.frontier.filter((f) => f.reason === "unread-budget");
  assert.deepEqual(unread.map((f) => f.id), ["§big/area", "§big/dep"]);
  assert.deepEqual(unread[0], { id: "§big/area", reason: "unread-budget", file: ".sova/spec/claims/big/area.md", lines: passage(full, "§big/area").lines, bytes: 1406 });
  hasCode(j, "budget-unread");
  assert.equal(j.exit, 1);
  // Control: enough budget for both returns both with no unread.
  const both = run(root, "--budget", String(1406 + 4615 + 100), "scope", "§big.area/child");
  assert.ok(!both.frontier.some((f) => f.reason === "unread-budget"));
  assert.equal(both.exit, 0);
});

test("budget: seed alone over budget → nothing returned, seed named unread, exit 1, never exceeded", () => {
  const root = sized(1406, 4615);
  const j = run(root, "--budget", "4614", "scope", "§big.area/child");
  assert.deepEqual(j.passages, []);
  assert.equal(j.budget.used, 0);
  assert.equal(j.frontier.find((f) => f.reason === "unread-budget").id, "§big.area/child", "the seed is the first unread");
  assert.equal(j.exit, 1);
  const z = run(root, "--budget", "0", "scope", "§big.area/child");
  assert.deepEqual(z.passages, []);
  assert.equal(z.exit, 1);
});

test("budget: code union and provenance cover the full pre-budget closure", () => {
  const root = sized(1406, 4615);
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§big/dep"].code = ["dep.txt"];
  writeFileSync(join(root, ".sova/spec/manifest.json"), JSON.stringify(m));
  write(root, "dep.txt", "d\n");
  const j = run(root, "--budget", "4700", "scope", "§big.area/child");
  assert.ok(!ids(j.passages).includes("§big/dep"));
  assert.deepEqual(j.code.map((c) => c.path), ["dep.txt"], "unread passage's code still listed");
});

for (const [name, mk] of [["directory", (r) => mkdirSync(join(r, "app.txt"))]]) {
  test(`code path that is a ${name} → code-not-file warning, exit 1`, () => {
    const root = base(); rmSync(join(root, "app.txt")); mk(root);
    const j = run(root, "scope", "§chat.input/send");
    assert.equal(j.code.find((c) => c.path === "app.txt").state, "not-file");
    hasCode(j, "code-not-file");
    assert.equal(j.exit, 1);
  });
}

// --- census --changed: a temporary Git repository ---

function g(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
// base() plus a boundary over lib/, with lib/claimed.js claimed by §chat.input/draft, committed.
function repo() {
  const root = base({ boundary: { include: ["lib"], exclude: [{ path: "lib/vendor", reason: "third party" }] } },
    { "§chat.input/draft": { kind: "behavior", requires: [], code: ["lib/claimed.js"] } });
  for (const f of ["lib/claimed.js", "lib/other.js", "lib/gone.js", "lib/vendor/v.js", "top.txt"]) write(root, f, "1\n");
  write(root, ".gitignore", "*.log\n");
  g(root, "init", "-q"); g(root, "add", "-A"); g(root, "commit", "-qm", "base");
  return root;
}

test("census --changed: nothing changed → exit 0, empty lists", () => {
  const j = run(repo(), "census", "--changed");
  assert.equal(j.census.mode, "changed");
  assert.equal(j.census.base.rev, "HEAD");
  assert.match(j.census.base.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual([j.census.claimed, j.census.unclaimed, j.census.outside], [[], [], []]);
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
});

test("census --changed: claimed change passes with its §IDs; outside and spec edits are never failures", () => {
  const root = repo();
  write(root, "lib/claimed.js", "2\n");
  write(root, "top.txt", "2\n");
  write(root, "lib/vendor/v.js", "2\n");
  write(root, ".sova/spec/claims/core/net.md", "# §core/net\n\nNetwork, edited.\n");
  const j = run(root, "census", "--changed");
  assert.deepEqual(j.census.claimed, [{ path: "lib/claimed.js", claims: ["§chat.input/draft"] }]);
  assert.deepEqual(j.census.unclaimed, []);
  assert.deepEqual(j.census.outside, ["lib/vendor/v.js", "top.txt"]);
  assert.ok(!JSON.stringify(j.census).includes(".sova/spec"));
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
});

test("census --changed: unclaimed tracked and untracked changes → changed-unclaimed per file, exit 1; deletions and ignored files dropped", () => {
  const root = repo();
  write(root, "lib/other.js", "2\n");
  write(root, "lib/new.js", "new\n");
  write(root, "lib/debug.log", "ignored\n");
  rmSync(join(root, "lib/gone.js"));
  const j = run(root, "census", "--changed");
  assert.deepEqual(j.census.unclaimed, ["lib/new.js", "lib/other.js"]);
  assert.deepEqual(j.findings.filter((f) => f.code === "changed-unclaimed").map((f) => f.file), ["lib/new.js", "lib/other.js"]);
  assert.ok(!JSON.stringify(j.census).includes("gone.js") && !JSON.stringify(j.census).includes("debug.log"));
  assert.equal(j.exit, 1);
  const h = spawnSync(process.execPath, [CLI, "census", "--changed", "--root", root], { encoding: "utf8" });
  assert.equal(h.status, 1);
  assert.match(h.stdout, /unclaimed lib\/new\.js/);
});

test("census --changed --base: committed work since the base counts; a bad rev → bad-rev exit 2", () => {
  const root = repo();
  const first = g(root, "rev-parse", "HEAD");
  write(root, "lib/other.js", "2\n");
  g(root, "commit", "-qam", "task");
  assert.equal(run(root, "census", "--changed").exit, 0, "HEAD sees nothing");
  const j = run(root, "census", "--changed", "--base", first);
  assert.deepEqual(j.census.unclaimed, ["lib/other.js"]);
  assert.equal(j.census.base.commit, first);
  assert.equal(j.exit, 1);
  for (const bad of ["no-such-rev", "--output=x"]) {
    const b = run(root, "census", "--changed", "--base", bad);
    hasCode(b, "bad-rev");
    assert.equal(b.exit, 2);
  }
  assert.ok(!readdirSync(root).includes("x"));
});

test("census --changed: not a Git repository → not-git exit 2; no boundary → boundary-missing exit 1", () => {
  const j = run(base({ boundary: { include: ["."], exclude: [] } }), "census", "--changed");
  hasCode(j, "not-git");
  assert.equal(j.exit, 2);
  const root = base();
  g(root, "init", "-q"); g(root, "add", "-A"); g(root, "commit", "-qm", "base");
  write(root, "app.txt", "2\n");
  const m = run(root, "census", "--changed");
  hasCode(m, "boundary-missing");
  assert.deepEqual(m.census.claimed, [{ path: "app.txt", claims: ["§chat.input/send"] }]);
  assert.equal(m.census.unclaimed, null);
  assert.equal(m.exit, 1);
});

test("census --changed: flag misuse is a usage error", () => {
  const root = base();
  hasCode(run(root, "check", "--changed"), "usage");
  hasCode(run(root, "census", "--base", "HEAD"), "usage");
  hasCode(run(root, "census", "--changed", "--base"), "usage");
});
