// The replay harness's own checks: a tree against itself shows no difference and holds every guard; a
// candidate that "fixes" a row by dropping what the guard protects is caught; make-tree records its commit.
import "../../../claude-code/tests/hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArm, diffCards, summary } from "./run.mjs";
import { makeTree } from "./make-tree.mjs";
import { baselineText, BASELINE_PATH, DATA, extractPinned } from "./scenario-g.mjs";
import { grade, agentInput, NOT_MEASURED } from "./agent-arm.mjs";
import { specIndex } from "./fullness.mjs";
import { Tools, seedSpec } from "./lib.mjs";

const TREE = fileURLToPath(new URL("../../../", import.meta.url));
/** The ref g's baseline was recorded from (its `tree` field), and the commit it names. */
const PINNED_REF = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).tree.split(" @ ")[0];
const PINNED_REV = DATA.pinned.rev;
const temps = [];
process.on("exit", () => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });
const failed = (card) => card.rows.flatMap((r) => r.guards.filter((g) => !g.ok && !g.na).map((g) => g.name));

test("self-check: this tree against itself differs on no row, and every guard holds in both arms", { timeout: 600_000 }, async () => {
  const a = await runArm(TREE, { label: "baseline" });
  const b = await runArm(TREE, { label: "candidate" });
  assert.equal(a.errors, undefined, JSON.stringify(a.errors));
  assert.equal(b.errors, undefined, JSON.stringify(b.errors));
  const diff = diffCards(a, b);
  assert.deepEqual(diff.rows.filter((r) => r.changed), [], "baseline vs baseline must show zero difference");
  assert.ok(diff.rows.length >= 30, `all scenarios ran (${diff.rows.length} rows)`);
  for (const s of ["a", "b", "c", "d", "e", "f", "g", "h"]) assert.ok(a.rows.some((r) => r.scenario === s), `scenario ${s} has rows`);
  assert.deepEqual(failed(a), []);
  assert.deepEqual(failed(b), []);
  assert.doesNotMatch(JSON.stringify(a.rows), /spec-replay-|\/tmp\//, "no temp path in a value");
  assert.match(summary(a, b, diff), /0 of \d+ rows differ; guards failed: baseline 0, candidate 0/);
});

test("diffCards: a changed value and a changed guard are each a difference; a row only one side has is too", () => {
  const card = (rows) => ({ rows });
  const r = (metric, value, ok = true) => ({ scenario: "x", metric, value, guards: [{ name: `${metric}.g`, ok, detail: "" }] });
  const d = diffCards(card([r("m1", 1), r("m2", { a: 1, b: 2 }), r("m3", "v"), r("m4", 0)]), card([r("m1", 2), r("m2", { b: 2, a: 1 }), r("m3", "v", false), r("m5", 0)]));
  assert.deepEqual(d.rows.map((x) => [x.metric, x.changed]), [["m1", true], ["m2", false], ["m3", true], ["m4", true], ["m5", true]]);
  assert.equal(d.changed, 4);
});

/** A copy of this tree with `files` ({tree path: source}) added and each `[file, from, to]` applied; a patch that finds nothing fails the test.
 *  `{ oneOf: [[[file, from, to], …], …] }` applies the first variant whose targets all exist, for code whose shape differs across milestones. */
function sabotaged(patches, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spec-replay-sabotage-"));
  temps.push(dir);
  for (const sub of ["spec", "mode", "claude-code"]) cpSync(join(TREE, sub), join(dir, sub), { recursive: true });
  for (const [to, from] of Object.entries(files)) cpSync(from, join(dir, to));
  const has = ([file, from]) => readFileSync(join(dir, file), "utf8").includes(from);
  for (const patch of patches.flatMap((p) => p.oneOf ? p.oneOf.find((v) => v.every(has)) ?? p.oneOf[0] : [p])) {
    const [file, from, to] = patch;
    const text = readFileSync(join(dir, file), "utf8");
    assert.ok(text.includes(from), `patch target in ${file}: ${from}`);
    writeFileSync(join(dir, file), text.replace(from, to));
  }
  return dir;
}

test("guards catch the do-nothing fixes: the draft always wins, the census goes quiet, evidence never stales, merges never land, packets trim", { timeout: 600_000 }, async () => {
  const tree = sabotaged([
    ["spec/core/sova-spec-draft.mjs", 'return "conflict";                  // both changed it, differently', 'return "apply";'],
    ["mode/spec-guard.ts", "if (!first && !freshIn.length && !newForeign.length && !unmapped.length) return", "if (true) return"],
    ["spec/core/sova-spec-draft.mjs", "async function evidenceProblems(root, g, e, draftRelDir) {\n  const out = [];", "async function evidenceProblems(root, g, e, draftRelDir) {\n  const out = [];\n  return out;"],
    ["mode/spec-guard.ts", "\tlet absorbing = false;\n\tif ((op.kind", "\tlet absorbing = true;\n\tif ((op.kind"],
    ["spec/core/packet.mjs", 'const text = bytes.subarray(offset, end).toString("utf8");', 'const text = bytes.subarray(offset, end).toString("utf8").trim();'],
    // A frame stream that grows into the whole closure: added on a tree without one, widened on a tree with one (M5).
    { oneOf: [[
      ["spec/core/packet.mjs", "findings, frame: frame ? frame.passages : [],", "findings, frame: passages,"],
      ["spec/core/packet.mjs", "  if (!frame) delete streams.frame;\n", ""],
    ], [
      ["spec/core/packet.mjs", 'export const PACKET_PARTS = ["prose", "inventory", "frontier", "code", "findings"];', 'export const PACKET_PARTS = ["prose", "inventory", "frontier", "code", "findings", "frame"];'],
      ["spec/core/packet.mjs", "frontier: result.frontier, code: result.code, findings,", "frontier: result.frontier, code: result.code, findings, frame: passages,"],
      ["spec/core/packet.mjs", 'isProse = part === "prose";', 'isProse = part === "prose" || part === "frame";'],
    ]] },
    // Impact stops listing uninvestigated behaviors; the manifest driver silently keeps ours on a same-record clash.
    ["spec/core/sova-spec.mjs", 'for (const [id, r] of ctx.claims) if (r.kind === "behavior" && r.requires === undefined && id !== seed) {', "for (const [id, r] of ctx.claims) if (false) {"],
    ["spec/core/sova-spec-draft.mjs", "if (r.conflict) { conflicts.push({ key: k, kind }); continue; }", "if (r.conflict) { out[k] = o[k]; continue; }"],
  ]);
  const card = await runArm(tree, { label: "sabotaged", only: ["a", "b", "c", "d", "e", "f", "g"] });
  const names = failed(card);
  for (const name of [
    "a.diff-h2.no-prose-lost", "a.same-h2.conflict-stops", "a.same-h2.no-prose-lost",
    "a.stacked.master-landing-listed", "b.edit.goes-stale",
    "a.same-spot.same-id-stops", "a.same-spot.no-prose-lost", "a.manifest-merge.same-record-stops", "e.setup",
    "c.pi.drift-flagged", "c.pi.unclaimed-flagged", "c.claude.drift-flagged", "c.claude.unclaimed-flagged",
    "d.packet-text-exact", "f.spans-exact", "f.frame-cap", "f.true-consumer-kept", "g.packet.text-exact", "g.frame-cap",
  ]) assert.ok(names.includes(name), `${name} fails on the sabotaged tree (failed: ${names.join(", ")})`);
  // …while the rows themselves look better, which is why the guards exist.
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  assert.equal(value("a.diff-h2.hand-reapply"), 0);
  assert.equal(value("b.refused-cases"), 0, "no evidence case is refused any more");
});

test("f and g catch the cheap slice: a packet that stops following requires reads less and loses needs", { timeout: 600_000 }, async () => {
  const tree = sabotaged([
    ["spec/core/sova-spec.mjs", "    for (const r of [...(rec.requires ?? [])].sort()) edge(r, { reason: \"requires\", of: id });", ""],
    ["spec/core/packet.mjs", ", ...[...(rec.requires ?? [])].sort()", ""],
  ]);
  const card = await runArm(tree, { label: "sabotaged", only: ["f", "g"] });
  assert.equal(card.errors, undefined, JSON.stringify(card.errors));
  const names = failed(card);
  for (const name of ["f.deps-read-whole", "f.mention-not-absent", "g.packet.no-need-lost", "g.packet.total-never-drops"])
    assert.ok(names.includes(name), `${name} fails on the sabotaged tree (failed: ${names.join(", ")})`);
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  assert.ok(value("f.packet.slice").bytes < 2000, "the sabotaged slice is far smaller…");
  assert.ok(value("g.packet.total").bytesTotal < 1_000_000, "…on the real spec too");
});

/** Route `sova-spec.mjs toc|read` to the harness's stand-in, so the pull checks run before the real commands exist. */
const STUB_FILES = { "spec/core/toc-stub.mjs": fileURLToPath(new URL("./toc-stub.mjs", import.meta.url)), "spec/core/fullness.mjs": fileURLToPath(new URL("./fullness.mjs", import.meta.url)) };
const STUB = ["spec/core/sova-spec.mjs", "if (direct) {\n  try {", "if (direct && ([\"toc\", \"read\", \"where\"].includes(process.argv[2]) || (process.argv[2] === \"impact\" && process.argv.includes(\"--near\")))) await import(\"./toc-stub.mjs\");\nelse if (direct) {\n  try {"];

test("pull checks are n/a on a tree without toc (the pinned revision's), never a pass", { timeout: 600_000, skip: spawnSync("git", ["-C", TREE, "cat-file", "-e", `${PINNED_REV}^{commit}`]).status !== 0 && "the pinned revision is not in this checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-tree-"));
  temps.push(dest);
  const plain = await runArm(makeTree(PINNED_REF, join(dest, "t"), TREE), { label: "plain", only: ["f"] });
  const na = plain.rows.flatMap((r) => r.guards).filter((g) => g.name.startsWith("f.pull."));
  assert.ok(na.length >= 4 && na.every((g) => g.na), "a tree without toc: every pull guard is n/a, never a pass");
});

test("pull checks run where toc exists: held by a faithful contents view, each failed by a contents view that cheats", { timeout: 600_000 }, async () => {
  const good = await runArm(sabotaged([STUB], STUB_FILES), { label: "stub", only: ["f", "g"] });
  assert.equal(good.errors, undefined, JSON.stringify(good.errors));
  assert.deepEqual(failed(good), []);
  const pullGuards = good.rows.flatMap((r) => r.guards).filter((g) => g.name.startsWith("f.pull."));
  assert.ok(pullGuards.length >= 4 && pullGuards.every((g) => g.ok && !g.na), "with toc, the pull guards are evaluated and hold");
  const shown = (card) => card.rows.find((r) => r.metric === "g.pull.total")?.value?.shown;
  assert.ok(shown(good) > 0, "the pull proxy counts needs shown");
  // A contents view that only shows containment (no out, in or mentions lines) falls under the ratchet.
  const thin = await runArm(sabotaged([STUB, ["spec/core/toc-stub.mjs", "out: () => claims[id].requires ?? [],", "out: () => [],"], ["spec/core/toc-stub.mjs", "in: () => all.filter(", "in: () => [].filter("], ["spec/core/toc-stub.mjs", "mentions: () => all.filter(", "mentions: () => [].filter("]], STUB_FILES), { label: "stub-thin", only: ["g"] });
  assert.ok(failed(thin).includes("g.pull.shown-floor"), `the ratchet trips (shown ${shown(thin)}; failed: ${failed(thin).join(", ")})`);

  const T = "spec/core/toc-stub.mjs";
  // A what cut at the end of its first source line (the 70d6696e toc) reads as a what; the whole-sentence guards catch it.
  const cut = await runArm(sabotaged([STUB, [T, "const body = (units[0] ?? \"\").replace(", "const body = (units[0] ?? \"\").split(\"\\n\")[0].replace("]], STUB_FILES), { label: "stub-cut", only: ["f", "g"] });
  for (const name of ["f.pull.what-whole", "g.pull.what-whole"]) assert.ok(failed(cut).includes(name), `${name} trips on a what cut at the line end (failed: ${failed(cut).join(", ")})`);

  const bad = await runArm(sabotaged([STUB,
    [T, "out: () => claims[id].requires ?? [],", "out: () => [],"],                                  // out-links hidden
    [T, "what: body.split(/(?<=[.:])\\s/)[0] || \"(no text)\",", "what: \"\","],                      // lines say nothing
    [T, "mentions: () => all.filter((x) => x !== id && mentions(index.passages.get(x).text, id)),", "mentions: () => all.filter((x) => x !== id),"], // everything "mentions"
    [T, "up: () => (parentOf(id) ? [parentOf(id)] : []),", ""],                                      // one direction refuses
    [T, "lines: hits.map((x) => ({ id: x }))", "lines: hits.slice(1).map((x) => ({ id: x }))"],              // where drops a claim
    [T, "? \"read\" : \"missing\"", "? \"missing\" : \"missing\""],                                         // where never reads the file
    [T, "family.some((f) => mentions(index.passages.get(x)?.text ?? \"\", f))", "x.endsWith(\"/unrelated\")"], // near keeps the wrong consumer
    [T, "out({ id, near: true,", "out({ id, near: true, ...(id === \"§chat/composer\" ? { status: \"refused\", exit: 2 } : {}),"], // near refuses one seed
    [T, "text: seed.text }], footer: { named: [...(claims[id].requires ?? [])].filter((x) => x !== id) } });", "text: seed.text.trim() }], footer: { named: [] } });"], // read trims, names nothing
    // packet refuses one real seed and the synthetic one
    ["spec/core/packet.mjs", "if (!PACKET_PARTS.includes(part)) return packetError(\"usage\", budget);", "if (!PACKET_PARTS.includes(part) || [\"§app/shell\", \"§f.seed/edit\"].includes(identity.id)) return packetError(\"usage\", budget);"],
  ], STUB_FILES), { label: "stub-hides", only: ["f", "g"] });
  const names = failed(bad);
  for (const name of ["f.ran", "f.pull.items-shown", "f.pull.what-and-why", "f.pull.unrelated-only-in", "f.pull.read-exact", "f.pull.read-names-links", "g.packet.ran", "g.pull.toc-answers", "f.near.true-consumer-kept", "f.near.unrelated-off-frontier", "g.where.all-listed", "g.impact-near.answers", "g.where.file-read", "g.where.ranked-file-read"])
    assert.ok(names.includes(name), `${name} fails on the sabotaged stub (failed: ${names.join(", ")})`);
});

/** read's embed line (M5); the test below runs once this tree's read delivers embeds. */
const EMBED_LINE = "for (const k of [t, ...childrenInOrder(ctx, t)])";
test("an embed delivered as its lede only is not whole: the target says so and read-names-links trips", { timeout: 600_000, skip: !readFileSync(join(TREE, "spec/core/read.mjs"), "utf8").includes(EMBED_LINE) && "this tree's read does not deliver embeds (M5)" }, async () => {
  const value = (card) => card.rows.find((r) => r.metric === "f.pull.target.unasked")?.value ?? "";
  const whole = await runArm(sabotaged([]), { label: "whole", only: ["f"] });
  assert.match(value(whole), /§f\/panel:delivered whole/);
  const lede = await runArm(sabotaged([["spec/core/read.mjs", EMBED_LINE, "for (const k of [t])"]]), { label: "lede", only: ["f"] });
  assert.match(value(lede), /§f\/panel:delivered, not whole/);
  assert.ok(failed(lede).includes("f.pull.read-names-links"), `failed: ${failed(lede).join(", ")}`);
});

test("h's guards trip when doc-only evidence covers any behavior, code and all", { timeout: 600_000 }, async () => {
  const tree = sabotaged([["spec/core/sova-spec-draft.mjs", 'const DOC_ONLY_KINDS = new Set(["note", "section"]);', 'const DOC_ONLY_KINDS = new Set(["note", "section", "behavior"]);']]);
  const card = await runArm(tree, { label: "sabotaged", only: ["h"] });
  assert.equal(card.errors, undefined, JSON.stringify(card.errors));
  for (const name of ["h.unbuilt-not-built", "h.doc-only-refuses-code"]) assert.ok(failed(card).includes(name), `${name} (failed: ${failed(card).join(", ")})`);
});

test("the manifest-merge guard trips when the driver refuses every merge", { timeout: 600_000 }, async () => {
  const tree = sabotaged([["spec/core/sova-spec-draft.mjs", "const m = mergeManifests(...texts);", "const m = { conflicts: [{ key: \"any\", kind: \"claim\" }], taken: [], text: \"\" };"]]);
  const card = await runArm(tree, { label: "sabotaged", only: ["a"] });
  assert.ok(failed(card).includes("a.manifest-merge.two-records-merge"), `failed: ${failed(card).join(", ")}`);
});

test("g's recorded baseline is what the pinned revision's tools produce, byte for byte", { timeout: 600_000, skip: spawnSync("git", ["-C", TREE, "cat-file", "-e", `${PINNED_REV}^{commit}`]).status !== 0 && "the pinned revision is not in this checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-tree-"));
  temps.push(dest);
  const tree = makeTree(PINNED_REF, join(dest, "t"), TREE);
  assert.equal(await baselineText(tree), readFileSync(BASELINE_PATH, "utf8"), "regenerate with `node scenario-g.mjs --record <tree>` only on purpose");
});

test("agent arm grading: what came back in tool results is what was read; leaving the work directory is flagged", { timeout: 120_000, skip: spawnSync("git", ["-C", TREE, "cat-file", "-e", `${PINNED_REV}^{commit}`]).status !== 0 && "the pinned revision is not in this checkout" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-agent-"));
  temps.push(root);
  extractPinned(root);
  const index = specIndex(root);
  const tools = new Tools(join(TREE, "."));
  const c = DATA.comparisons.find((x) => x.id === "C18");
  // Every packet page of the seed, as an agent following `next` would get them.
  const events = [];
  let args = ["packet", c.seed], n = 0;
  for (;;) {
    const r = tools.spec(root, root, args);
    const id = `call-${++n}`;
    events.push({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `node tools/sova-spec.mjs ${args.join(" ")} --root . --json` } });
    events.push({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: { content: [{ type: "text", text: r.stdout }] } });
    if (!r.json?.next) break;
    args = ["packet", c.seed, "--cursor", r.json.next];
  }
  events.push({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: { command: "cat ../../src/server.ts" } });
  events.push({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "No such file" }] } });
  const g = grade(index, c, events.map((e) => JSON.stringify(e)).join("\n"), root);
  const recorded = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons.C18.values.reduce((s, v) => s + v, 0);
  assert.equal(g.answered, recorded, "the packet pages answer what the recorded packet arm answered");
  assert.equal(g.calls, n + 1);
  assert.deepEqual(g.outside, ["cat ../../src/server.ts"]);
  assert.deepEqual(g.lostVsPacket, []);
  // Nothing read: every need the packet answered is lost, and none was shown.
  const empty = grade(index, c, "", root);
  assert.equal(empty.answered, 0);
  assert.equal(empty.lostVsPacket.length, JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons.C18.values.filter((v) => v > 0).length);
});

test("agent arm input: two trees' agents are told the same task; only the tree's own mode text differs", () => {
  const a = sabotaged([]), b = sabotaged([["mode/spec-mode.md", "Every behavior change is spec'd.", "Every behavior change is spec'd. Start with toc."]]);
  for (const c of DATA.comparisons) {
    const [x, y] = [agentInput(c, a), agentInput(c, b)];
    assert.equal(x.prompt, y.prompt, `${c.id}: the task prompt never depends on the tree or arm`);
    assert.doesNotMatch(x.prompt, /\b(toc|read|packet|scope|impact|map|where)\b '|--dir|--part|Start with/, `${c.id}: the prompt names no command or reading strategy`);
  }
  const strip = (t) => t.replace(/^core=.*$/m, "");
  const raw = (tree) => strip(readFileSync(join(tree, "mode/spec-mode.md"), "utf8"));
  assert.equal(strip(agentInput(DATA.comparisons[0], a).instructions), raw(a));
  assert.equal(strip(agentInput(DATA.comparisons[0], b).instructions), raw(b));
  assert.notEqual(agentInput(DATA.comparisons[0], a).instructions, agentInput(DATA.comparisons[0], b).instructions);
  // The guard the arm can't measure: outside any repository, as the agent works, census --changed lists nothing to read.
  const work = mkdtempSync(join(tmpdir(), "spec-replay-armwork-"));
  temps.push(work);
  seedSpec({ write: (rel, text) => { mkdirSync(dirname(join(work, rel)), { recursive: true }); writeFileSync(join(work, rel), text); } }, {
    claims: { "§w/one": { kind: "surface", authority: "accepted" } }, files: { ".sova/spec/claims/w/one.md": "# §w/one — One\n\nA surface.\n" },
  });
  const r = new Tools(TREE).spec(work, work, ["census", "--changed"]);
  assert.ok(r.json?.exit === 2 && r.json.census === null, `census --changed in a work directory: ${r.stdout.slice(0, 400)}`);
  assert.ok(NOT_MEASURED.some((s) => s.startsWith("every census --changed claim read")));
});

test("agent arm grading: a passage the frame carries is read, JSON or text; toc lines and footer names in text are seen", { skip: spawnSync("git", ["-C", TREE, "cat-file", "-e", `${PINNED_REV}^{commit}`]).status !== 0 && "the pinned revision is not in this checkout" }, () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-agent-"));
  temps.push(root);
  extractPinned(root);
  const index = specIndex(root);
  // The first comparison with a packet-answered need whose passage is not the seed's own.
  const recorded = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons;
  const other = (cc) => recorded[cc.id].values.findIndex((v, k) => v > 0 && recorded[cc.id].passageOf[k] && recorded[cc.id].passageOf[k] !== cc.seed);
  const c = DATA.comparisons.find((cc) => other(cc) >= 0);
  const base = recorded[c.id], i = other(c);
  const p = index.passages.get(base.passageOf[i]);
  const call = (n, command, text) => [
    { type: "tool_execution_start", toolCallId: `c${n}`, toolName: "bash", args: { command } },
    { type: "tool_execution_end", toolCallId: `c${n}`, toolName: "bash", isError: false, result: { content: [{ type: "text", text }] } },
  ];
  const run = (...calls) => grade(index, c, calls.flat().map((e) => JSON.stringify(e)).join("\n"), root);
  // The need's passage arrives only as a frame item on read's first page.
  const json = run(call(1, `node tools/sova-spec.mjs read '${c.seed}' --json`, JSON.stringify({ command: "read", items: [], footer: { named: [] }, frame: { passages: 1, items: [{ id: p.id, text: p.text }] } })));
  assert.equal(json.values[i], base.values[i], `${p.id} carried by the frame (JSON) answers need ${i}`);
  const text = run(call(1, `node tools/sova-spec.mjs read '${c.seed}'`, `── frame: always applies\n── ${p.id} — x [behavior] ${p.file}:${p.lines[0]}-${p.lines[1]} (1 KB) · frame\n${p.text.replace(/\n$/, "")}\nexit 0`));
  assert.equal(text.values[i], base.values[i], `${p.id} carried by the frame (text) answers need ${i}`);
  // Text toc: every packet-answered passage shown as a contents line or named in read's footer; nothing read.
  const shownIds = [...new Set(base.passageOf.filter((x, k) => x && base.values[k] > 0))];
  const [half, rest] = [shownIds.slice(0, Math.ceil(shownIds.length / 2)), shownIds.slice(Math.ceil(shownIds.length / 2))];
  const seen = run(
    call(1, `node tools/sova-spec.mjs toc '${c.seed}' --dir out`, [`${c.seed} — Seed  behavior · 1 KB`, "  what: x", "OUT: requires (1)", ...half.flatMap((id) => [`  ${id} — T  behavior · 1 KB`, "    what: y"]), "exit 0"].join("\n")),
    call(2, `node tools/sova-spec.mjs read '${c.seed}'`, `── ${c.seed} — Seed [behavior]\nbody\nnamed here, not delivered by this call: ${rest.join(", ") || "none"}\nexit 0`),
  );
  assert.equal(seen.answered, 0);
  assert.deepEqual(seen.lostVsPacket, [], "a need whose passage was seen is not lost");
  assert.ok(shownIds.every((id) => seen.shown.includes(id)), `seen: ${seen.shown.join(", ")}`);
  assert.equal(seen.contentsLines, half.length);
});

test("make-tree: a ref's pi-config/extensions, with its commit recorded for the scorecard", { skip: spawnSync("git", ["-C", TREE, "rev-parse", "HEAD"]).status !== 0 && "not in a Git checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-tree-"));
  temps.push(dest);
  const tree = makeTree("HEAD", join(dest, "t"), TREE);
  for (const need of ["spec/core/sova-spec.mjs", "mode/spec-guard.ts", "claude-code/spec-hooks.ts"]) assert.ok(existsSync(join(tree, need)), need);
  const source = JSON.parse(readFileSync(join(dest, "t/replay-source.json"), "utf8"));
  assert.equal(source.ref, "HEAD");
  assert.equal(source.commit, spawnSync("git", ["-C", TREE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
  assert.throws(() => makeTree("HEAD", join(dest, "t"), TREE), /not empty/);
});
