// Independent M2 black-box acceptance. No production helpers/imports; disposable dummy projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.SOVA_PACKET_ACCEPTANCE_CLI ?? resolve(here, "../core/sova-spec.mjs");
const projectRoot = resolve(here, "../../../..");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => Buffer.byteLength(s);
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function temporary() { const r = mkdtempSync(join(tmpdir(), "sova-packet-independent-")); roots.push(r); return r; }
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
function manifest(root, fn) { const p = join(root, ".sova/spec/manifest.json"), m = JSON.parse(readFileSync(p)); fn(m); writeFileSync(p, JSON.stringify(m)); }
function fixture({ long = false, unknown = false, metadata = false } = {}) {
  const root = temporary();
  const claims = {
    "§task/input": { kind: "surface" },
    "§task.input/run": { kind: "behavior", requires: ["§near/beta", "§near/alpha", "§task/input"], code: ["lib/dummy.txt"] },
    "§task.input/extra": { kind: "behavior", requires: [] },
    "§near/alpha": { kind: "behavior", requires: ["§far/first"] },
    "§near/beta": { kind: "behavior", requires: ["§far/last"] },
    "§far/first": { kind: "behavior", requires: ["§task.input/run"] },
    "§far/last": { kind: "behavior", requires: [] },
    "§other/unrelated": { kind: "note" },
  };
  if (unknown) { delete claims["§far/last"].requires; claims["§near/beta"].requires.push("§absent/dependency"); }
  if (metadata) claims["§task.input/run"].code.push("missing/" + "m".repeat(6000));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims }));
  const body = long ? ('Useful exact prose: 🐦 漢字 é "quoted" \\ slash\t\u0001\u0000\r\n' + 'line 🐦 \\"\u0002'.repeat(800)) : "Requested promise, not metadata.";
  write(root, ".sova/spec/claims/task/input.md", `# §task/input\n\nParent orientation.\n\n## §task.input/run\n\n${body}\n\n## §task.input/extra\n\nExtra sibling reached through declared parent.\n`);
  for (const [ns, name] of [["near", "alpha"], ["near", "beta"], ["far", "first"], ["far", "last"], ["other", "unrelated"]])
    write(root, `.sova/spec/claims/${ns}/${name}.md`, `# §${ns}/${name}\n\nExact ${ns}/${name} requirement.\n`);
  write(root, "lib/dummy.txt", "Dummy implementation, never executed.\n");
  write(root, "package.json", JSON.stringify({ scripts: { prepare: "this-must-never-be-run" } }));
  return root;
}
function invoke(root, args, { cli = CLI, env = {} } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, "--root", root], {
    cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: join(root, ".fixture-home"), XDG_CONFIG_HOME: join(root, ".fixture-home/config"), GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  assert.ifError(r.error); assert.equal(r.signal, null); return r;
}
function output(r, limit) {
  assert.equal(r.stderr.length, 0, `no stderr spill channel: ${r.stderr.toString("utf8")}`);
  assert.ok(r.stdout.length <= limit, `whole stdout ${r.stdout.length} exceeds ${limit}, including newline`);
  assert.ok(Buffer.from(r.stdout.toString("utf8")).equals(r.stdout), "valid UTF-8 stdout");
  const text = r.stdout.toString("utf8"), j = JSON.parse(text);
  assert.equal(text, JSON.stringify(j) + "\n", "compact JSON with exactly one terminating newline");
  assert.equal(j.command, "packet"); assert.equal(j.exit, r.status);
  return j;
}
function packet(root, id = "§task.input/run", { budget = 12000, part = "prose", cursor, extra = [], env, cli } = {}) {
  const args = ["packet", id, "--budget", String(budget), "--part", part, ...(cursor !== undefined ? ["--cursor", cursor] : []), ...extra];
  const j = output(invoke(root, args, { env, cli }), budget);
  if (j.exit !== 2) {
    assert.equal(j.budget, budget); assert.equal(j.id, id); assert.equal(j.part, part);
    assert.ok(["more", "done"].includes(j.status));
    assert.equal(j.next === null, j.status === "done");
    assert.equal(j.counts.prose, j.counts.inventory);
    for (const value of Object.values(j.counts)) assert.ok(Number.isSafeInteger(value) && value >= 0);
    assert.ok(Number.isSafeInteger(j.remaining) && j.remaining >= 0);
    assert.equal(j.remaining === 0, j.status === "done");
    if (j.status === "more") assert.equal(j.exit, 1, "navigation incomplete is not success");
  } else assert.equal(j.status, "refused");
  return j;
}
function scope(root, id = "§task.input/run", extra = []) {
  const r = invoke(root, ["scope", id, "--json", ...extra]); assert.equal(r.stderr.length, 0);
  const j = JSON.parse(r.stdout); assert.equal(j.exit, r.status); return j;
}
const expectedOrder = ["§task.input/run", "§task/input", "§near/alpha", "§near/beta", "§far/first", "§far/last", "§task.input/extra"];
function fragment(item, text, start) {
  const f = item.fragment;
  assert.ok(f && Number.isSafeInteger(f.start) && Number.isSafeInteger(f.end) && Number.isSafeInteger(f.total));
  assert.equal(f.start, start, "no gap/overlap or duplicate fragment");
  assert.equal(f.end, start + bytes(text)); assert.ok(f.end > f.start && f.end <= f.total);
  assert.equal(f.complete, f.start === 0 && f.end === f.total, "complete means WHOLE item, not final fragment");
  assert.doesNotMatch(text, /[\uD800-\uDFFF]/u, "no split Unicode surrogate");
  return f;
}
function traverse(root, part, { budget = 1024, id = "§task.input/run", extra = [] } = {}) {
  const result = [], allPages = [], tokens = new Set(); let cursor, partial = "", currentId;
  for (let step = 0; step < 500; step++) {
    const j = packet(root, id, { part, budget, cursor, extra });
    assert.notEqual(j.exit, 2, `must make bounded progress: ${JSON.stringify(j)}`); allPages.push(j);
    assert.ok(j.items.length > 0 || j.status === "done", "not empty-success pagination");
    for (const item of j.items) {
      assert.equal(item.index, result.length, "each stream record appears exactly once, contiguously");
      if (part === "prose" || Object.hasOwn(item, "json")) {
        const text = part === "prose" ? item.text : item.json, f = fragment(item, text, bytes(partial));
        if (part === "prose") { currentId ??= item.id; assert.equal(item.id, currentId); }
        partial += text;
        if (f.end === f.total) {
          result.push(part === "prose" ? { id: currentId, text: partial } : JSON.parse(partial)); partial = ""; currentId = undefined;
        }
      } else { assert.equal(partial, ""); assert.ok(Object.hasOwn(item, "value")); result.push(item.value); }
    }
    assert.equal(j.remaining, j.counts[part] - result.length, "remaining includes a partial record");
    if (j.status === "done") { assert.equal(partial, ""); assert.equal(result.length, j.counts[part]); return { result, pages: allPages }; }
    assert.ok(typeof j.next === "string" && j.next.length > 0); assert.ok(!tokens.has(j.next), "cursor must advance"); tokens.add(j.next); cursor = j.next;
  }
  assert.fail("bounded traversal did not terminate");
}
const token = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const decode = (v) => JSON.parse(Buffer.from(v, "base64url"));
function refused(j, code) { assert.equal(j.exit, 2); assert.equal(j.status, "refused"); if (code) assert.equal(j.code ?? j.findings?.[0]?.code, code); }
function snapshot(root) {
  const records = [];
  const walk = (d, rel = "") => { for (const n of readdirSync(d).sort()) { const p = join(d, n), r = rel ? `${rel}/${n}` : n, s = lstatSync(p); records.push([r, s.mode, s.size, s.mtimeMs, s.isFile() ? sha(readFileSync(p)) : null]); if (s.isDirectory()) walk(p, r); } };
  walk(root); return records;
}

test("acceptance harness rejects newline overflow, pretty JSON, stderr spill and false final completeness", () => {
  const raw = JSON.stringify({ command: "packet", exit: 0 }) + "\n", r = { stdout: Buffer.from(raw), stderr: Buffer.alloc(0), status: 0 };
  assert.equal(output(r, bytes(raw)).exit, 0);
  assert.throws(() => output(r, bytes(raw) - 1), /whole stdout/);
  assert.throws(() => output({ ...r, stderr: Buffer.from("spill") }, 1024), /stderr/);
  assert.throws(() => output({ ...r, stdout: Buffer.from(JSON.stringify(JSON.parse(raw), null, 2) + "\n") }, 1024), /compact/);
  assert.throws(() => fragment({ fragment: { start: 1, end: 2, total: 2, complete: true } }, "x", 1), /WHOLE/);
  assert.throws(() => fragment({ fragment: { start: 2, end: 3, total: 3, complete: false } }, "x", 1), /gap/);
});

test("packet default: useful exact seed before orientation and low-priority inventories without --json", () => {
  const root = fixture({ metadata: true }), full = scope(root), r = invoke(root, ["packet", "§task.input/run"]), j = output(r, 12000);
  assert.equal(j.budget, 12000); assert.equal(j.part, "prose"); assert.ok(j.items.length >= 2);
  for (const [i, id] of ["§task.input/run", "§task/input"].entries()) {
    assert.equal(j.items[i].id, id); assert.equal(j.items[i].text, full.passages.find((p) => p.id === id).text); assert.equal(j.items[i].fragment.complete, true);
  }
  assert.ok(j.counts.code >= 2); assert.ok(!r.stdout.includes(Buffer.from("m".repeat(100))), "large metadata not dumped into prose");
  assert.match(j.notice, /declared|completeness/i); assert.match(j.notice, /read|proof/i);
});

test("packet nearest-first is deterministic, not legacy DFS; orientation later reached expands its obligations", () => {
  const root = fixture(), full = scope(root), a = traverse(root, "prose", { budget: 32768 });
  assert.deepEqual(a.result.map((p) => p.id), expectedOrder);
  assert.notDeepEqual(full.passages.map((p) => p.id), expectedOrder, "fixture discriminates legacy depth-first order");
  assert.deepEqual(new Map(a.result.map((p) => [p.id, p.text])), new Map(full.passages.map((p) => [p.id, p.text])));
  assert.deepEqual(a, traverse(root, "prose", { budget: 32768 }));
});

test("minimum1024 delivers oversized requested prose with exact Unicode/escaping/control/very-long-line fragments", () => {
  const root = fixture({ long: true, metadata: true }), full = scope(root), first = packet(root, undefined, { budget: 1024 });
  assert.equal(first.items[0].id, "§task.input/run"); assert.ok(first.items[0].text.length > 0); assert.equal(first.items[0].fragment.complete, false);
  assert.equal(first.items[0].fragment.start, 0); assert.equal(first.items[0].fragment.total, bytes(full.passages[0].text));
  const { result, pages } = traverse(root, "prose");
  assert.ok(pages.length > 2); assert.deepEqual(result.map((p) => p.id), expectedOrder);
  assert.deepEqual(new Map(result.map((p) => [p.id, p.text])), new Map(full.passages.map((p) => [p.id, p.text])));
  const seedPieces = pages.flatMap((p) => p.items).filter((p) => p.id === "§task.input/run");
  assert.ok(seedPieces.length > 1); assert.equal(seedPieces.at(-1).fragment.complete, false, "last slice is not whole claim");
});

test("all inventories roundtrip exactly with no omissions/duplicates; unknowns are not pagination frontier", () => {
  const root = fixture({ long: true, metadata: true, unknown: true }), full = scope(root);
  const inventory = traverse(root, "inventory"), prose = traverse(root, "prose");
  assert.ok(inventory.pages.some((p) => p.items.some((i) => Object.hasOwn(i, "json"))), "oversized detail fragmentation actually exercised");
  assert.deepEqual(inventory.result.map((p) => p.id), expectedOrder);
  for (let i = 0; i < inventory.result.length; i++) {
    const { text, ...value } = full.passages.find((p) => p.id === inventory.result[i].id);
    assert.deepEqual(inventory.result[i], { ...value, bytes: bytes(text) }); assert.equal(prose.result[i].text, text);
  }
  for (const part of ["frontier", "code", "findings"]) {
    const { result, pages } = traverse(root, part); assert.deepEqual(result, full[part]); assert.equal(pages.at(-1).exit, 1, "unknowns survive selected-stream completion");
  }
  assert.ok(full.frontier.some((f) => f.reason === "dangling")); assert.ok(full.frontier.some((f) => f.reason === "requires-uninvestigated"));
  assert.ok(!full.frontier.some((f) => f.reason === "unread-budget"));
});

test("all supported boundary budgets bound actual serialized stdout and every continuation", () => {
  const root = fixture({ long: true });
  for (const budget of [1024, 1025, 2048, 12000, 32767, 32768]) {
    const first = packet(root, undefined, { budget }); assert.notEqual(first.exit, 2); assert.equal(first.items[0].id, "§task.input/run");
    if (first.next) assert.notEqual(packet(root, undefined, { budget, cursor: first.next }).exit, 2);
  }
});

test("unchanged reruns byte-identical; budget may change on continuation; future tokens are navigation not prior-read authentication", () => {
  const root = fixture({ long: true }), args = ["packet", "§task.input/run", "--budget", "1024"];
  assert.deepEqual(invoke(root, args).stdout, invoke(root, args).stdout);
  const first = packet(root, undefined, { budget: 1024 }), original = decode(first.next);
  assert.notEqual(packet(root, undefined, { budget: 32768, cursor: first.next }).exit, 2);
  const forgedFuture = [...original]; forgedFuture[3] = 2; forgedFuture[4] = 0;
  const page = packet(root, undefined, { budget: 1024, cursor: token(forgedFuture) });
  assert.notEqual(page.exit, 2, "valid self-created future position is not authenticated reading history"); assert.equal(page.items[0].index, 2);
});

test("malformed, forged-binding, out-of-range and mid-Unicode cursor positions refused within budget", () => {
  const root = fixture({ long: true }), first = packet(root, undefined, { budget: 1024 }), original = decode(first.next);
  const variants = ["", "not-json", "!".repeat(2000), first.next + "=", Buffer.from(" " + JSON.stringify(original)).toString("base64url"), token({ navigation: "fake" }), token([99, ...original.slice(1)])];
  for (const change of [(v) => v[1] = "0".repeat(64), (v) => v[2] = "code", (v) => v[3] = -1, (v) => v[3] = first.counts.prose + 1,
    (v) => v[3] = first.counts.prose, (v) => v[3] = 0.5, (v) => v[4] = -1, (v) => v[4] = 1e9, (v) => v[4] = 0.5, (v) => v.push("extra")]) {
    const v = [...original]; change(v); variants.push(token(v));
  }
  const text = scope(root).passages[0].text, insideBird = bytes(text.slice(0, text.indexOf("🐦"))) + 1;
  variants.push(token([original[0], original[1], "prose", 0, insideBird]), token([original[0], original[1], "prose", 0, bytes(text)]));
  for (const cursor of variants) refused(packet(root, undefined, { budget: 1024, cursor }));
});

test("tokens bind root, normalized spec, requested identity, stream and read policy", () => {
  const root = fixture({ long: true }), first = packet(root, undefined, { budget: 1024 }), other = fixture({ long: true });
  refused(packet(other, undefined, { budget: 1024, cursor: first.next }));
  refused(packet(root, "§near/alpha", { budget: 1024, cursor: first.next }));
  refused(packet(root, undefined, { budget: 1024, part: "inventory", cursor: first.next }));
  refused(packet(root, undefined, { budget: 1024, cursor: first.next, extra: ["--read-policy", "review"] }));
  const draft = ".sova/spec/drafts/copy/spec";
  for (const file of ["manifest.json", ...readdirSync(join(root, ".sova/spec/claims"), { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => `claims/${f}`)])
    write(root, `${draft}/${file}`, readFileSync(join(root, ".sova/spec", file)));
  refused(packet(root, undefined, { budget: 1024, cursor: first.next, extra: ["--spec", draft] }));
});

for (const change of ["manifest-raw", "claim-raw", "unrelated-claim", "code-state", "incumbent-outside-span"]) test(`captured input invalidation: ${change}`, () => {
  const root = fixture({ long: true });
  if (change === "incumbent-outside-span") {
    write(root, "incumbent.txt", "exact cited line\nUncited old bytes\n");
    manifest(root, (m) => m.claims["§task.input/run"].incumbent = [{ file: "incumbent.txt", lines: [1, 1], spanSha256: sha("exact cited line") }]);
  }
  const before = scope(root), first = packet(root, undefined, { budget: 1024 });
  if (change === "manifest-raw") writeFileSync(join(root, ".sova/spec/manifest.json"), readFileSync(join(root, ".sova/spec/manifest.json"), "utf8") + "\n ");
  if (change === "claim-raw") writeFileSync(join(root, ".sova/spec/claims/task/input.md"), readFileSync(join(root, ".sova/spec/claims/task/input.md"), "utf8") + "\n\n");
  if (change === "unrelated-claim") write(root, ".sova/spec/claims/other/unrelated.md", "# §other/unrelated\n\nChanged unrelated source bytes.\n");
  if (change === "code-state") rmSync(join(root, "lib/dummy.txt"));
  if (change === "incumbent-outside-span") write(root, "incumbent.txt", "exact cited line\nUncited NEW bytes\n");
  if (change !== "code-state") assert.deepEqual(scope(root), before, "raw input mutation deliberately invisible in scope results");
  refused(packet(root, undefined, { budget: 1024, cursor: first.next }));
  assert.notEqual(packet(root, undefined, { budget: 1024 }).exit, 2, "fresh traversal remains usable");
});

test("supported-budget errors/help compact and bounded, invalid-budget errors independently bounded", () => {
  const root = fixture();
  for (const args of [["§absent/seed"], ["§task.input/run", "--unknown"], ["§task.input/run", "--spec", "../escape"], ["§task.input/run", "--part", "bogus"], ["§task.input/run", "--read-policy", "bogus"], ["§" + "a".repeat(30000) + "/b"]])
    refused(output(invoke(root, ["packet", ...args, "--budget", "1024"]), 1024));
  output(invoke(root, ["packet", "§task.input/run", "--help", "--budget", "1024"]), 1024);
  for (const budget of ["0", "1023", "32769", "-1", "1.5", "Infinity", "999999999999999999", "x".repeat(30000)])
    refused(output(invoke(root, ["packet", "§task.input/run", "--budget", budget]), 1024));
  refused(output(invoke(root, ["packet", "§task.input/run", "--budget"]), 1024));
  write(root, ".sova/spec/manifest.json", '{"malformed":' + "x".repeat(30000));
  refused(packet(root, undefined, { budget: 1024 }));
});

test("unfittable long identity gives explicit bounded refusal, never empty-success progress", () => {
  const root = temporary(), id = "§task.input/" + "a".repeat(3000);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§task/input": { kind: "surface" }, [id]: { kind: "behavior", requires: [] } } }));
  write(root, ".sova/spec/claims/task/input.md", `# §task/input\n\nOrientation.\n\n## ${id}\n\nUseful exact requirement.\n`);
  assert.equal(scope(root, id).exit, 0, "long identity is a valid graph, not accidentally satisfied by a graph error");
  refused(packet(root, id, { budget: 1024 }), "budget-refused");
  const larger = packet(root, id, { budget: 32768 }); assert.notEqual(larger.exit, 2); assert.equal(larger.items[0].id, id);
});

test("packet does not write project/HOME or execute project code; empty findings done is not global prose/read completeness", () => {
  const root = fixture({ long: true }), before = snapshot(root);
  for (const part of ["prose", "inventory", "frontier", "code", "findings"]) packet(root, undefined, { budget: 1024, part });
  const findings = packet(root, undefined, { part: "findings" }); assert.equal(findings.status, "done"); assert.equal(findings.exit, 0); assert.ok(findings.counts.prose > 0);
  assert.equal(packet(root, undefined, { budget: 1024 }).status, "more", "findings success never records an earlier prose read");
  assert.deepEqual(snapshot(root), before, "no persisted sessions/cursors/snapshots or other project writes");
});

function observer(root) {
  const hooks = temporary(), log = join(hooks, "events.jsonl"), hook = join(hooks, "observe.cjs");
  writeFileSync(hook, `const fs=require('node:fs'), cp=require('node:child_process'), {syncBuiltinESMExports}=require('node:module');
const append=fs.appendFileSync.bind(fs), fds=new Map(); let recording=false; const record=(op,p)=>{if(recording)return;if(typeof p==='number')p=fds.get(p);recording=true;try{append(process.env.PACKET_OBSERVER_LOG,JSON.stringify({op,path:String(p)})+'\\n')}finally{recording=false}};
const open=fs.openSync; fs.openSync=function(p,...a){record('openSync',p);const fd=open.call(this,p,...a);fds.set(fd,p);return fd};
for(const op of ['readFileSync','readdirSync','writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync']){const f=fs[op];fs[op]=function(p,...a){record(op,p);return f.call(this,p,...a)}}
for(const op of ['spawnSync','spawn','execSync','exec','execFileSync','execFile']){const f=cp[op];cp[op]=function(p,...a){record(op,p);return f.call(this,p,...a)}} syncBuiltinESMExports();`);
  return { env: { NODE_OPTIONS: `--require=${hook}`, PACKET_OBSERVER_LOG: log }, events: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [], clear: () => rmSync(log, { force: true }) };
}

test("safe reads: observer positive controls distinguish legitimate reads from refused incumbent/claim inputs and execution", () => {
  const root = fixture(), spy = observer(root), secret = join(root, ".env"); write(root, ".env", "DUMMYSECRET\n");
  manifest(root, (m) => m.claims["§task.input/run"].incumbent = [{ file: ".env", lines: [1, 1], spanSha256: sha("DUMMYSECRET") }]);
  packet(root, undefined, { env: spy.env }); assert.ok(spy.events().some((e) => e.path === secret && e.op === "readFileSync"), "default policy legitimate read positive control");
  const calibrated = spawnSync(process.execPath, ["-e", "require('node:child_process').spawnSync(process.execPath,['-e','']);require('node:fs').writeFileSync(process.env.PROBE_MARKER,'calibration')"], { env: { ...process.env, ...spy.env, PROBE_MARKER: join(root, "probe-marker") } });
  assert.equal(calibrated.status, 0); assert.ok(spy.events().some((e) => e.op === "spawnSync")); assert.ok(spy.events().some((e) => e.op === "writeFileSync")); rmSync(join(root, "probe-marker")); spy.clear();
  packet(root, undefined, { budget: 1024, env: spy.env, extra: ["--read-policy", "review"] });
  assert.ok(spy.events().some((e) => e.path.includes("claims/task/input.md") && e.op === "readFileSync"));
  assert.ok(!spy.events().some((e) => e.path === secret), "refused incumbent not opened, read or hashed");
  assert.ok(!spy.events().some((e) => /^(?:spawn|exec|write|append|mkdir|rename|unlink)/.test(e.op)), "packet never writes or launches code");
  spy.clear(); const outside = temporary(); write(outside, "private.md", "# §other/unrelated\n\nOUTSIDEMARKER\n");
  rmSync(join(root, ".sova/spec/claims/other/unrelated.md")); symlinkSync(join(outside, "private.md"), join(root, ".sova/spec/claims/other/unrelated.md"));
  refused(packet(root, undefined, { budget: 1024, env: spy.env })); assert.ok(!spy.events().some((e) => e.path.startsWith(outside)), "symlink refused before read/hash");
});

for (const kind of ["hardlink", "oversize"]) test(`review read policy refuses ${kind} incumbent before reading/hashing`, () => {
  const root = fixture(), spy = observer(root), rel = "incumbent.txt", text = kind === "oversize" ? "x".repeat(2 * 1024 * 1024 + 1) : "DUMMY\n";
  write(root, rel, text); if (kind === "hardlink") linkSync(join(root, rel), join(temporary(), "alias"));
  manifest(root, (m) => m.claims["§task.input/run"].incumbent = [{ file: rel, lines: [1, 1], spanSha256: sha("DUMMY") }]);
  packet(root, undefined, { env: spy.env, extra: ["--read-policy", "review"] });
  assert.ok(!spy.events().some((e) => e.op === "readFileSync" && e.path === join(root, rel)), "refused bytes never read for fingerprint");
});

test("draft/no-Git support and isolated shipped core + sibling helper, without project runtime imports", () => {
  const root = fixture(), standalone = temporary(), draft = ".sova/spec/drafts/copy/spec";
  for (const name of ["sova-spec.mjs", "packet.mjs", "toc.mjs", "read.mjs", "fields.mjs"]) if (existsSync(join(dirname(CLI), name))) write(standalone, name, readFileSync(join(dirname(CLI), name)));
  for (const file of ["manifest.json", ...readdirSync(join(root, ".sova/spec/claims"), { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => `claims/${f}`)])
    write(root, `${draft}/${file}`, readFileSync(join(root, ".sova/spec", file)));
  assert.equal(existsSync(join(root, ".git")), false);
  const j = packet(root, undefined, { cli: join(standalone, "sova-spec.mjs"), extra: ["--spec", draft] }); assert.notEqual(j.exit, 2); assert.equal(j.items[0].id, "§task.input/run");
  assert.equal(j.items[0].text, scope(root, undefined, ["--spec", draft]).passages[0].text);
});

test("no-spec bootstrap distinguishes missing manifest from malformed graph; orphaned claims never destructively bootstrap", () => {
  const root = temporary(), before = snapshot(root), missing = packet(root, undefined, { budget: 1024 });
  refused(missing); assert.equal(missing.cause, "manifest-not-found", "guide can identify bootstrap without treating all graph errors as no spec");
  const draft = (args) => {
    const r = invoke(root, args, { cli: resolve(here, "../core/sova-spec-draft.mjs") });
    assert.equal(r.stderr.length, 0); const j = JSON.parse(r.stdout); assert.equal(j.exit, r.status); return j;
  };
  const preview = draft(["new", "bootstrap", "--json"]); assert.equal(preview.exit, 0); assert.equal(preview.specExisted, false);
  assert.deepEqual(snapshot(root), before, "bootstrap preview writes nothing");
  write(root, ".sova/spec/claims/orphan/rule.md", "# §orphan/rule\n\nExisting prose must be preserved.\n");
  const orphaned = snapshot(root); assert.equal(packet(root, undefined, { budget: 1024 }).cause, "manifest-not-found");
  for (const flags of [[], ["--write"]]) {
    const j = draft(["new", "bootstrap", "--json", ...flags]); assert.equal(j.exit, 2); assert.ok(j.findings.some((f) => f.code === "orphaned-spec"));
    assert.deepEqual(snapshot(root), orphaned, "orphan refusal preserves all existing files");
  }
  write(root, ".sova/spec/manifest.json", "{broken");
  const malformed = packet(root, undefined, { budget: 1024 }); refused(malformed); assert.notEqual(malformed.cause, "manifest-not-found", "malformed existing graph must not invite bootstrap");
});

const legacyFixture = JSON.parse(readFileSync(join(here, "fixtures/legacy-scope-envelope.json"), "utf8"));
function legacyProject() {
  const root = temporary();
  for (const [rel, text] of Object.entries(legacyFixture.files)) write(root, rel, text);
  return root;
}
function normalizedLegacyStdout(r, root) {
  assert.equal(r.stderr.length, 0, "legacy has no stderr spill");
  const raw = r.stdout.toString("utf8");
  assert.ok(Buffer.from(raw).equals(r.stdout), "valid legacy UTF-8 stdout");
  assert.equal(JSON.parse(raw).root, root, "only the generated project root may vary");
  const field = `  "root": ${JSON.stringify(root)},\n`;
  assert.equal(raw.split(field).length, 2, "exactly one top-level root field");
  // Do not parse/reserialize: spacing, field order, newline and every other byte remain contractual.
  return raw.replace(field, '  "root": "<fixture-root>",\n');
}

test("legacy scope preserves frozen pre-packet envelope bytes and prose-only budgets at different roots", () => {
  assert.equal(sha(JSON.stringify(legacyFixture.files)), legacyFixture.provenance.inputsSha256, "frozen inputs match oracle provenance");
  assert.deepEqual(legacyFixture.cases.map((c) => c.budget), [null, 12000, 0, legacyFixture.seedBytes - 1, legacyFixture.seedBytes]);
  const projects = [legacyProject(), legacyProject()];
  assert.notEqual(projects[0], projects[1]);
  for (const root of projects) {
    assert.equal(existsSync(join(root, ".git")), false);
    const check = () => {
      for (const c of legacyFixture.cases) {
        const r = invoke(root, ["scope", legacyFixture.id, "--json", ...(c.budget === null ? [] : ["--budget", String(c.budget)])]);
        assert.equal(r.status, c.exit);
        assert.equal(normalizedLegacyStdout(r, root), c.stdout, "legacy complete envelope unchanged from independently frozen pre-M2 CLI");
      }
    };
    check();
    write(root, ".sova/spec/claims/growth/unrelated.md", "# §growth/unrelated\n\nUnrelated corpus growth must not change the fixed closure.\n");
    manifest(root, (m) => m.claims["§growth/unrelated"] = { kind: "note" });
    check();
  }
  const envelopes = legacyFixture.cases.map((c) => JSON.parse(c.stdout));
  assert.deepEqual(envelopes[1].passages, envelopes[0].passages, "12k fits all fixed prose");
  for (const i of [2, 3]) assert.deepEqual(envelopes[i].passages, [], "a whole oversized seed is unread, never fragmented");
  assert.equal(envelopes[4].passages.length, 1, "exact UTF-8 seed boundary keeps one whole passage");
  assert.equal(bytes(envelopes[4].passages[0].text), legacyFixture.seedBytes);
  for (const e of envelopes.slice(1)) {
    assert.deepEqual(e.code, envelopes[0].code, "prose budget never truncates complete code inventory");
    assert.deepEqual(e.frontier.filter((f) => f.reason !== "unread-budget"), envelopes[0].frontier, "dependency unknowns survive prose cuts");
    assert.equal(e.budget.used, e.passages.reduce((n, p) => n + bytes(p.text), 0));
  }
  assert.ok(bytes(legacyFixture.cases[4].stdout) > legacyFixture.seedBytes, "legacy budget is NOT a whole-envelope cap");
});

test("real a-pane packet12k smoke delivers exact useful seed/orientation fragments independent of corpus size", {
  skip: !existsSync(join(projectRoot, ".sova/spec/manifest.json")),
}, () => {
  // Dynamic scope parity is a corpus smoke check, not the independent legacy compatibility oracle above.
  const ids = ["§workspace.groups/a-pane", "§workspace/groups"], full = scope(projectRoot, ids[0]);
  const requested = ids.map((id) => full.passages.find((p) => p.id === id));
  for (const p of requested) assert.ok(p, "current corpus contains the requested seed and orientation");
  const accumulated = new Map(ids.map((id) => [id, ""]));
  let cursor;
  for (let page = 0; page < 500; page++) {
    const j = packet(projectRoot, ids[0], { cursor });
    assert.notEqual(j.exit, 2); assert.equal(j.counts.prose, full.passages.length); assert.equal(j.counts.code, full.code.length);
    if (page === 0) { assert.equal(j.items[0].id, ids[0]); assert.ok(bytes(j.items[0].text) > 0, "bounded response starts with useful requested prose"); }
    for (const item of j.items) {
      if (!accumulated.has(item.id)) continue;
      const text = requested.find((p) => p.id === item.id).text, prior = accumulated.get(item.id);
      const f = fragment(item, item.text, bytes(prior));
      assert.equal(f.total, bytes(text));
      assert.deepEqual(Buffer.from(item.text), Buffer.from(text).subarray(f.start, f.end), "exact UTF-8 range, not a summary");
      accumulated.set(item.id, prior + item.text);
    }
    if (requested.every((p) => accumulated.get(p.id) === p.text)) return;
    assert.ok(j.next, "continue until requested seed and orientation finish, even when oversized");
    cursor = j.next;
  }
  assert.fail("requested seed/orientation traversal did not terminate");
});
