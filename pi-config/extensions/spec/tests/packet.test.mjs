// Owner black-box regressions: measure transport, reconstruct exact streams, and distinguish DFS from BFS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, lstatSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packetPage } from "../core/packet.mjs";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "spec-packet-")); roots.push(r); return r; };
function write(root, path, text) { const abs = join(root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
function fixture(prose = "Exact \"quoted\" requirements 🙂.\n") {
  const root = tmp();
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§a/top": { kind: "surface", code: ["src/a.txt"] },
    "§a.top/start": { kind: "behavior", requires: ["§b/near", "§c/near"] },
    "§a.top/sibling": { kind: "behavior", requires: [] },
    "§b/near": { kind: "behavior", requires: ["§d/far"] },
    "§c/near": { kind: "behavior", requires: ["§missing/edge"] },
    "§d/far": { kind: "behavior" },
  } }));
  write(root, ".sova/spec/claims/a/top.md", "# §a/top\n\nOrientation.\n\n## §a.top/start\n\n" + prose + "\n## §a.top/sibling\n\nExcluded sibling.\n");
  for (const id of ["b/near", "c/near", "d/far"]) write(root, `.sova/spec/claims/${id}.md`, `# §${id}\n\n${id}.\n`);
  write(root, "src/a.txt", "code locations are not prose\n");
  return root;
}
function run(root, args, budget = 12000, cli = CORE, packet = true) {
  const r = spawnSync(process.execPath, [cli, ...args, "--root", root, ...(packet ? ["--budget", String(budget)] : ["--json"])],
    { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.error, undefined);
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, j.exit, r.stderr);
  if (packet) {
    assert.equal(r.stderr, "", "no stderr side channel");
    assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= budget, "actual stdout+newline+stderr budget");
    assert.equal(r.stdout, JSON.stringify(j) + "\n", "compact single JSON line incl one terminating newline");
  }
  return j;
}
function collect(root, part, budget = 1024, cli = CORE) {
  const records = [], chunks = new Map();
  let cursor, pages = 0;
  do {
    const j = run(root, ["packet", "§a.top/start", "--part", part, ...(cursor ? ["--cursor", cursor] : [])], budget, cli);
    assert.notEqual(j.status, "refused", JSON.stringify(j));
    assert.ok(j.items.length || j.status === "done", "progress or exhausted");
    for (const item of j.items) {
      if (item.value !== undefined) { records[item.index] = item.value; continue; }
      const old = chunks.get(item.index) ?? { text: "", end: 0 };
      assert.equal(item.fragment.start, old.end);
      const text = item.text ?? item.json;
      assert.equal(Buffer.byteLength(text), item.fragment.end - item.fragment.start);
      assert.equal(item.fragment.complete, item.fragment.start === 0 && item.fragment.end === item.fragment.total);
      assert.equal(text.includes("�"), false, "never split a scalar into replacement characters");
      old.text += text; old.end = item.fragment.end; chunks.set(item.index, old);
      if (old.end === item.fragment.total) records[item.index] = part === "prose" ? { id: item.id, text: old.text } : JSON.parse(old.text);
    }
    assert.equal(j.remaining, j.counts[part] - records.filter((r) => r !== undefined).length);
    assert.equal(j.next === null, j.status === "done");
    assert.notEqual(j.next, cursor ?? "", "no empty-success cursor loop");
    cursor = j.next;
    assert.ok(++pages < 300, "finite traversal");
  } while (cursor);
  return records;
}
const scope = (root) => run(root, ["scope", "§a.top/start"], undefined, CORE, false);

test("packet default compact JSON and complete exact streams; BFS beats DFS", () => {
  const root = fixture(), legacy = scope(root), prose = collect(root, "prose");
  assert.deepEqual(prose.map((p) => p.id), ["§a.top/start", "§a/top", "§b/near", "§c/near", "§d/far"]);
  assert.deepEqual(new Map(prose.map((p) => [p.id, p.text])), new Map(legacy.passages.map((p) => [p.id, p.text])));
  assert.ok(legacy.passages.findIndex((p) => p.id === "§d/far") < legacy.passages.findIndex((p) => p.id === "§c/near"), "positive control: old scope really DFS");
  const inventory = collect(root, "inventory");
  for (let n = 0; n < prose.length; n++) {
    const { text, ...metadata } = legacy.passages.find((p) => p.id === prose[n].id);
    assert.deepEqual(inventory[n], { ...metadata, bytes: Buffer.byteLength(text) });
  }
  for (const part of ["frontier", "code", "findings"]) assert.deepEqual(collect(root, part), legacy[part]);
});

test("large seed: controls, escaping, Unicode and long lines recover exact scope without --json", () => {
  const root = fixture(('漢🙂\\\"\t\u0001' + "q".repeat(80)).repeat(110) + "\n");
  const first = run(root, ["packet", "§a.top/start"], 1024);
  assert.equal(first.items[0].fragment.complete, false);
  const all = collect(root, "prose");
  assert.equal(all[0].text, scope(root).passages[0].text);
  assert.equal(all[0].id, "§a.top/start");
});

test("prose fragments expose declared kind and labels without inventing authority or verification", () => {
  const root = fixture("🙂".repeat(800) + "\n");
  const manifest = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  Object.assign(manifest.claims["§a.top/start"], { kind: "note", authority: "candidate", evidence: "unreviewed" });
  Object.assign(manifest.claims["§b/near"], { authority: "migrated", evidence: "unreviewed" });
  Object.assign(manifest.claims["§c/near"], { authority: "accepted", evidence: "reviewed" });
  write(root, ".sova/spec/manifest.json", JSON.stringify(manifest));
  const expected = new Map(scope(root).passages.map((p) => [p.id, p]));
  const seen = new Set();
  let cursor, pages = 0, candidatePieces = 0, candidateEnd = false;
  do {
    const page = run(root, ["packet", "§a.top/start", ...(cursor ? ["--cursor", cursor] : [])], 1024);
    assert.notEqual(page.status, "refused");
    assert.ok(page.items.length, "metadata coverage cannot pass on empty prose");
    for (const item of page.items) {
      const original = expected.get(item.id);
      assert.ok(original);
      assert.equal(item.kind, original.kind);
      assert.deepEqual(item.labels, original.labels);
      assert.equal(Object.hasOwn(item, "labels"), Object.hasOwn(original, "labels"), "undeclared labels stay absent");
      seen.add(item.id);
      if (item.id === "§a.top/start") {
        candidatePieces++;
        assert.equal(item.kind, "note");
        assert.deepEqual(item.labels, { authority: "candidate", evidence: "unreviewed" });
        if (item.fragment.start > 0 && item.fragment.end === item.fragment.total) {
          candidateEnd = true;
          assert.equal(item.fragment.complete, false, "the ending piece is not a whole passage");
        }
      }
    }
    cursor = page.next;
    assert.ok(++pages < 100);
  } while (cursor);
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort());
  assert.ok(candidatePieces > 1 && candidateEnd, "both intermediate and final partial pieces were checked");
});

test("oversized detail records page JSON slices and exactly recover code/frontier/findings", () => {
  const root = fixture(), manifest = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  manifest.claims["§a.top/start"].code = ["outside/" + "x".repeat(1800)];
  manifest.claims["§a.top/start"].incumbentNote = "多🙂".repeat(1200);
  manifest.claims["§a.top/start"].incumbent = [];
  write(root, ".sova/spec/manifest.json", JSON.stringify(manifest));
  const legacy = scope(root);
  for (const part of ["code", "frontier", "findings"]) assert.deepEqual(collect(root, part), legacy[part]);
  const meta = collect(root, "inventory")[0], { text, ...original } = legacy.passages[0];
  assert.deepEqual(meta, { ...original, bytes: Buffer.byteLength(text) });
});

test("all usage/help/graph responses fit min budget without input echoes", () => {
  const root = fixture();
  for (const args of [[], ["--part", "bad"], ["--unknown-" + "x".repeat(8000)], ["§unknown/no"], ["--spec", "../" + "x".repeat(8000)], ["--cursor", "x".repeat(8000)]]) {
    const j = run(root, ["packet", ...(args[0]?.startsWith("§") ? args : ["§a.top/start", ...args])], 1024);
    if (args.length) { assert.equal(j.exit, 2); assert.equal(j.status, "refused"); }
    assert.ok(JSON.stringify(j).length < 1200);
  }
  const help = run(root, ["packet", "--help"], 1024);
  assert.equal(help.exit, 0); assert.match(help.help, /--part.*--cursor/);
  for (const budget of ["0", "1023", "32769", "abc", "1.5", "9".repeat(4000)]) {
    const r = spawnSync(process.execPath, [CORE, "packet", "§a.top/start", "--root", root, "--budget", budget], { encoding: "utf8" });
    assert.equal(r.status, 2); assert.equal(r.stderr, ""); assert.ok(Buffer.byteLength(r.stdout) <= 1024); assert.equal(JSON.parse(r.stdout).status, "refused");
  }
});

test("stateless cursor permits new budgets but rejects malformed, range, identity and raw-source changes", () => {
  const root = fixture("🙂".repeat(700) + "\n"), first = run(root, ["packet", "§a.top/start"], 1024);
  assert.ok(first.next);
  const token = JSON.parse(Buffer.from(first.next, "base64url")), encode = (t) => Buffer.from(JSON.stringify(t)).toString("base64url");
  assert.notEqual(run(root, ["packet", "§a.top/start", "--cursor", first.next], 2048).status, "refused");
  for (const bad of ["!", first.next + "=", encode([2, ...token.slice(1)]), encode([...token.slice(0, 3), -1, 0]), encode([...token.slice(0, 3), 10000, 0]), encode([...token.slice(0, 4), -1])]) {
    assert.equal(run(root, ["packet", "§a.top/start", "--cursor", bad], 1024).status, "refused");
  }
  assert.equal(run(root, ["packet", "§b/near", "--cursor", first.next], 1024).code, "token-mismatch-or-stale");
  assert.equal(run(root, ["packet", "§a.top/start", "--part", "code", "--cursor", first.next], 1024).code, "token-mismatch-or-stale");
  write(root, ".sova/spec/claims/a/top.md", readFileSync(join(root, ".sova/spec/claims/a/top.md"), "utf8") + "\n");
  assert.equal(run(root, ["packet", "§a.top/start", "--cursor", first.next], 1024).code, "token-mismatch-or-stale", "out-of-span raw byte change invalidates");
});

test("cursor binds actual ordered streams even when captured inputs and legacy scope stay identical", () => {
  const passages = [{ id: "§a/first", text: "a".repeat(3000) }, { id: "§b/second", text: "b".repeat(3000) }];
  const args = { identity: { root: "/fixture", spec: ".sova/spec", id: "§a/first", readPolicy: "default" },
    inputs: { files: [["manifest.json", "same captured hash"]], tree: [] },
    result: { passages, frontier: [], code: [] }, findings: [], passages, part: "prose", budget: 1024 };
  const first = packetPage(args);
  assert.equal(first.status, "more"); assert.ok(first.next);
  assert.notEqual(packetPage({ ...args, cursor: first.next }).status, "refused", "positive control: unchanged streams continue");
  const reordered = packetPage({ ...args, passages: [...passages].reverse(), cursor: first.next });
  assert.equal(reordered.status, "refused");
  assert.equal(reordered.code, "token-mismatch-or-stale", "same inputs and legacy result cannot authorize a changed delivery order");
  const rerendered = packetPage({ ...args, passages: passages.map((p) => ({ ...p, text: p.text.toUpperCase() })), cursor: first.next });
  assert.equal(rerendered.code, "token-mismatch-or-stale", "actual rendered passage text is bound too");
});

test("missing manifest cause preserves safe no-Git bootstrap and orphan refusal", () => {
  const empty = tmp(), before = tree(empty);
  const missing = run(empty, ["packet", "§a/top"], 1024);
  assert.equal(missing.code, "graph-untrusted"); assert.equal(missing.cause, "manifest-not-found");
  assert.deepEqual(tree(empty), before, "missing packet writes nothing");
  const draft = join(dirname(CORE), "sova-spec-draft.mjs");
  const preview = spawnSync(process.execPath, [draft, "new", "bootstrap", "--root", empty, "--json"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(tree(empty), before, "draft preview writes nothing");
  const orphan = tmp(); write(orphan, ".sova/spec/claims/a/top.md", "# §a/top\n\nKeep this orphan source.\n");
  const orphanBefore = tree(orphan);
  assert.equal(run(orphan, ["packet", "§a/top"], 1024).cause, "manifest-not-found");
  const refusal = spawnSync(process.execPath, [draft, "new", "bootstrap", "--root", orphan, "--json"], { encoding: "utf8" });
  assert.equal(refusal.status, 2);
  assert.ok(JSON.parse(refusal.stdout).findings.some((f) => f.code === "orphaned-spec"));
  assert.deepEqual(tree(orphan), orphanBefore, "orphan sources never overwritten");
});

function tree(root) {
  const result = []; const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const abs = join(dir, name), st = lstatSync(abs); result.push([abs, st.size, st.mtimeMs]); if (st.isDirectory()) walk(abs); } }; walk(root); return result;
}
test("standalone sibling shipment, draft/no-Git and refusal path preserve read-only filesystem", () => {
  const root = fixture(), tools = tmp();
  for (const name of ["sova-spec.mjs", "packet.mjs", "toc.mjs", "read.mjs", "fields.mjs", "graph.mjs", "map.mjs", "where.mjs", "sova-spec-draft.mjs", "sova-spec-review.mjs"]) cpSync(join(dirname(CORE), name), join(tools, name));
  const before = tree(root);
  assert.deepEqual(collect(root, "prose", 1024, join(tools, "sova-spec.mjs")), collect(root, "prose"));
  assert.deepEqual(tree(root), before, "packet writes nothing");
  write(root, ".sova/spec/drafts/example/spec/manifest.json", readFileSync(join(root, ".sova/spec/manifest.json")));
  cpSync(join(root, ".sova/spec/claims"), join(root, ".sova/spec/drafts/example/spec/claims"), { recursive: true });
  assert.notEqual(run(root, ["packet", "§a.top/start", "--spec", ".sova/spec/drafts/example/spec"], 1024).status, "refused");
  const outside = tmp(); write(outside, "a/top.md", "# §a/top\n\nMUST NOT BE READ\n");
  rmSync(join(root, ".sova/spec/claims"), { recursive: true }); symlinkSync(outside, join(root, ".sova/spec/claims"));
  assert.equal(run(root, ["packet", "§a.top/start"], 1024).code, "graph-untrusted");
});
