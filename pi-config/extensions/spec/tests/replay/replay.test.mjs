// The replay harness's own checks: a tree against itself shows no difference and holds every guard; a
// candidate that "fixes" a row by dropping what the guard protects is caught; make-tree records its commit.
import "../../../claude-code/tests/hermetic-env.mjs";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArm, diffCards, summary } from "./run.mjs";
import { makeTree } from "./make-tree.mjs";
import { baselineText, BASELINE_PATH, DATA, extractPinned, whatSheet, carriesRule } from "./scenario-g.mjs";
import { grade, agentInput, NOT_MEASURED, accessesOf, compareRuns, graderId, gradeDir, specHash, snapshotSpec } from "./agent-arm.mjs";
import { specIndex, scoreNeed, parentOf } from "./fullness.mjs";
import { RUBRIC, RUBRIC_PROMPT_VERSION, rubricPrompt, blind, leaks, unblind, insideRepo } from "./rubric-arm.mjs";
import { Tools, seedSpec } from "./lib.mjs";

// A landing gate: the merge round runs this file with SOVA_SPEC_REPLAY=1 when a landing touches the
// spec tools or hooks. Anywhere else every test is skipped, visibly, so working never pays for it.
const GATE = process.env.SOVA_SPEC_REPLAY === "1" ? null : "landing gate: the merge round runs it with SOVA_SPEC_REPLAY=1";
const test = (name, opts, fn) => (typeof opts === "function" ? nodeTest(name, GATE ? { skip: GATE } : {}, opts) : nodeTest(name, GATE ? { ...opts, skip: GATE } : opts, fn));

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

test("f catches a packet that carries notes beyond its closure: every note, or every note about the seed's H1 area (rejected rule B)", { timeout: 600_000 }, async () => {
  const kinds = {
    every: { oneOf: [
      [["spec/core/sova-spec.mjs", "aboutNotes(ctx, [opt.id, ", "aboutNotes(ctx, [...ctx.claims.keys(), opt.id, "]],
      [["spec/core/sova-spec.mjs", "aboutDelivered(ctx, new Set(passages.map((p) => p.id)))", "aboutDelivered(ctx, new Set(ctx.claims.keys()))"]],
    ] },
    area: { oneOf: [
      [["spec/core/sova-spec.mjs", "aboutNotes(ctx, [opt.id, ", "aboutNotes(ctx, [...(ctx.children.get(parent) ?? []), opt.id, "]],
      [["spec/core/sova-spec.mjs", "aboutDelivered(ctx, new Set(passages.map((p) => p.id)))", "aboutDelivered(ctx, new Set([...passages.map((p) => p.id), ...(ctx.children.get(parentOf(opt.id, ctx.dirKinds)) ?? [])]))"]],
    ] },
  };
  for (const [kind, patch] of Object.entries(kinds)) {
    const card = await runArm(sabotaged([patch]), { label: `sabotaged-${kind}`, only: ["f"] });
    assert.equal(card.errors, undefined, JSON.stringify(card.errors));
    assert.deepEqual(failed(card), ["f.about-outside-closure"], kind);
    if (kind === "area") assert.match(card.rows.flatMap((r) => r.guards).find((g) => g.name === "f.about-outside-closure").detail, /§design\.copy\/limits \(the unlinked sibling\) is read/);
    if (kind === "every") assert.equal(card.rows.find((r) => r.metric === "f.target.about-closure").value, "read", "…while the target row looks met");
  }
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
  // A sentence ended at a colon inside parentheses (the b1843900 toc): "(one row per heading:" is cut.
  const paren = await runArm(sabotaged([STUB, [T, "else if (depth === 0 && \".:!?\".includes(c)", "else if (\".:!?\".includes(c)"]], STUB_FILES), { label: "stub-paren", only: ["f", "g"] });
  for (const name of ["f.pull.what-whole", "g.pull.what-whole"]) assert.ok(failed(paren).includes(name), `${name} trips on a what ended inside an open bracket (failed: ${failed(paren).join(", ")})`);
  // Every what blanked, as prose and as "none" (no prose sentence) alike: never a whole sentence.
  const WHAT = "what: firstOf(body) || \"(no text)\",";
  for (const [label, patches] of [["blank", [[T, WHAT, "what: \"\","]]], ["blank-none", [[T, WHAT, "what: \"\","], [T, "whatSource: body ? \"prose\" : \"none\"", "whatSource: \"none\""]]]]) {
    const blank = await runArm(sabotaged([STUB, ...patches], STUB_FILES), { label: `stub-${label}`, only: ["f", "g"] });
    for (const name of ["f.pull.what-whole", "g.pull.what-whole"]) assert.ok(failed(blank).includes(name), `${name} trips when every what is blank (${label}; failed: ${failed(blank).join(", ")})`);
  }

  const bad = await runArm(sabotaged([STUB,
    [T, "out: () => claims[id].requires ?? [],", "out: () => [],"],                                  // out-links hidden
    [T, WHAT, "what: \"\","],                      // lines say nothing
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
  for (const name of ["h.unbuilt-not-built", "h.doc-only-refuses-code", "h.field-bundle-refused"]) assert.ok(failed(card).includes(name), `${name} (failed: ${failed(card).join(", ")})`);
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

test("agent arm routes: where and map arguments are lookups, not file reads; a real read beside them still counts", () => {
  const kinds = (command) => accessesOf({ tool: "bash" }, command, "/work").map((a) => a.kind);
  assert.deepEqual(kinds(`core="$PWD/tools"; node "$core/sova-spec.mjs" where 'PATCH /api/projects' --root . --json`), [], "M2 C02's lookup");
  assert.deepEqual(kinds("node tools/sova-spec.mjs map /srv/app/x.ts --root ."), []);
  assert.deepEqual(kinds("node tools/sova-spec.mjs where /etc/x --root . && cat /etc/hosts"), ["outside"], "the cat after && is a read");
  assert.deepEqual(kinds("cat /etc/passwd"), ["outside"]);
  assert.deepEqual(kinds("node tools/sova-spec.mjs where x --root .\ncat /etc/passwd"), ["outside"], "a newline ends the lookup's arguments");
  assert.deepEqual(kinds("node tools/sova-spec.mjs where x --root /home/u/real --json"), ["outside"], "--root names a directory the tool reads");
  assert.deepEqual(kinds("node tools/sova-spec.mjs map src/a.ts --root . --spec /home/u/real/.sova/spec"), ["outside"], "so does --spec");
  assert.deepEqual(kinds("node tools/sova-spec.mjs where x --root . --json > /tmp/w.json"), ["scratch"], "a redirect ends the lookup's arguments");
});

test("agent arm: a map line is no sighting; a pull run whose only call is map loses every H1-located packet answer, listed apart; compare refuses another grader", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-agent-"));
  temps.push(root);
  extractPinned(root);
  const index = specIndex(root);
  const h1s = [...index.passages.values()].filter((p) => !parentOf(p.id)).map((p) => p.id);
  const recorded = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons;
  const map = JSON.stringify({ command: "map", lines: h1s.map((id) => ({ id, what: "x" })) });
  const events = [
    { type: "tool_execution_start", toolCallId: "m", toolName: "bash", args: { command: "node tools/sova-spec.mjs map --root . --json" } },
    { type: "tool_execution_end", toolCallId: "m", toolName: "bash", isError: false, result: { content: [{ type: "text", text: map }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const rows = DATA.comparisons.map((c) => ({ id: c.id, ...grade(index, c, events, root) }));
  const h1Answers = DATA.comparisons.flatMap((c) => recorded[c.id].values.map((v, i) => (v > 0 && h1s.includes(recorded[c.id].passageOf[i]) ? `${c.id}:${i}` : null)).filter(Boolean));
  assert.ok(h1Answers.length > 0);
  for (const r of rows) assert.deepEqual(r.shown, [], `${r.id}: nothing seen`);
  const dir = (name, card) => { const d = join(root, name); mkdirSync(d); writeFileSync(join(d, "agent-scorecard.json"), JSON.stringify(card)); return d; };
  const card = (rs) => ({ model: "m", prompt: "p", instructions: null, grader: graderId(), rows: rs });
  const base = dir("base", card(DATA.comparisons.map((c) => ({ id: c.id, values: recorded[c.id].values, answered: 0 }))));
  const cmp = compareRuns(base, dir("cand", card(rows)));
  const lost = new Set(cmp.lost.map((l) => l.split(" ")[0]));
  for (const id of h1Answers) assert.ok(lost.has(id), `${id} is lost: a map line doesn't excuse it`);
  assert.deepEqual(cmp.lostSeenOnlyInMap, h1Answers.filter((id) => cmp.lost.some((l) => l.startsWith(`${id} `))), "and listed apart as seen only in map");
  assert.equal(cmp.total.lostSeenOnlyInMap, h1Answers.length);
  // Two scorecards graded by different grading code don't compare.
  const g = graderId();
  assert.match(g.sha256, /^[0-9a-f]{16}$/);
  assert.throws(() => compareRuns(dir("base-g", { ...card([]), grader: g }), dir("cand-g", { ...card([]), grader: { ...g, sha256: "0".repeat(16) } })), /different grading code/);
  const bare = (rs) => { const { grader, ...rest } = card(rs); return rest; };
  assert.throws(() => compareRuns(dir("base-u", bare([])), dir("cand-u", { ...card([]), grader: g })), /different grading code \(unrecorded/);
  assert.throws(() => compareRuns(dir("base-n", bare([])), dir("cand-n", bare([]))), /different grading code \(unrecorded vs unrecorded/, "neither card records a grader: refused too");
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

test("agent arm grading: this tree's own toc and read in text are seen exactly as their JSON says", { skip: (spawnSync("git", ["-C", TREE, "cat-file", "-e", `${PINNED_REV}^{commit}`]).status !== 0 && "the pinned revision is not in this checkout") || (!existsSync(join(TREE, "spec/core/read.mjs")) && "this tree has no read") }, () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-agent-"));
  temps.push(root);
  extractPinned(root);
  const index = specIndex(root);
  const tools = new Tools(TREE);
  // The first comparison whose seed's read names links it doesn't deliver, so the footer is exercised.
  const c = DATA.comparisons.find((x) => (tools.spec(root, root, ["read", x.seed]).json?.footer?.named ?? []).length > 0);
  assert.ok(c, "some seed's read names a link");
  const events = [], lines = new Set(), named = new Set();
  let n = 0;
  const call = (args) => {
    const json = tools.spec(root, root, args).json, text = tools.run(root, root, args, { json: false }).stdout;
    events.push({ type: "tool_execution_start", toolCallId: `c${++n}`, toolName: "bash", args: { command: `node tools/sova-spec.mjs ${args.map((a) => `'${a}'`).join(" ")} --root .` } });
    events.push({ type: "tool_execution_end", toolCallId: `c${n}`, toolName: "bash", isError: false, result: { content: [{ type: "text", text }] } });
    return json;
  };
  for (const dir of ["out", "in", "down", "up", "mentions"]) for (const l of call(["toc", c.seed, "--dir", dir])?.lines ?? []) lines.add(l.id);
  const g = grade(index, c, events.map((e) => JSON.stringify(e)).join("\n"), root);
  assert.equal(g.contentsLines, lines.size, "every toc line in text is a contents line seen, and nothing else is");
  for (const id of lines) assert.ok(g.shown.includes(id), `${id} (a toc line) is seen from the text form`);
  // read alone, so only its footer can make an id seen.
  events.length = 0;
  const r = call(["read", c.seed]);
  for (const id of [...(r.footer?.named ?? []), ...(r.footer?.about ?? [])]) named.add(id);
  const gr = grade(index, c, events.map((e) => JSON.stringify(e)).join("\n"), root);
  for (const id of named) assert.ok(gr.shown.includes(id), `${id}, named in read's footer, is seen from the text form (seen: ${gr.shown.join(", ") || "none"})`);
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

/** The integration revision whose spec data/g-baseline-<rev>.json was recorded on, and its file. */
const INT_BASELINE = join(fileURLToPath(new URL(".", import.meta.url)), "data/g-baseline-b1de66b1.json");
const INT_REV = JSON.parse(readFileSync(INT_BASELINE, "utf8")).tree.split(" @ ")[1];
const hasRev = (rev) => spawnSync("git", ["-C", TREE, "cat-file", "-e", `${rev}^{commit}`]).status === 0;

test("g's integration-spec baseline is what that revision's tools record on its spec, byte for byte", { timeout: 600_000, skip: !hasRev(INT_REV) && "the integration revision is not in this checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-int-"));
  temps.push(dest);
  const tree = makeTree(INT_REV, join(dest, "t"), TREE);
  mkdirSync(join(dest, "s"));
  const spec = extractPinned(join(dest, "s"), INT_REV, [".sova/spec"]);
  const text = await baselineText(tree, { pinned: spec, specLabel: JSON.parse(readFileSync(INT_BASELINE, "utf8")).pinned.spec });
  assert.equal(text.replace(/"tree": "[^"]*"/, ""), readFileSync(INT_BASELINE, "utf8").replace(/"tree": "[^"]*"/, ""), "regenerate with `node scenario-g.mjs --record <tree> --pinned <spec> --spec <label> --out <file>` only on purpose");
});

test("a base is never recorded with a verdict it can't place; a verdict anchored in both specs scores in both", { timeout: 600_000, skip: !hasRev(INT_REV) && "the integration revision is not in this checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-anchor-"));
  temps.push(dest);
  mkdirSync(join(dest, "base"));
  mkdirSync(join(dest, "draft"));
  const base = extractPinned(join(dest, "base"), INT_REV, [".sova/spec"]), draft = extractPinned(join(dest, "draft"), INT_REV, [".sova/spec"]);
  const old = DATA.comparisons.find((c) => c.id === "C21").needs[3].verdict.anchor;
  const reworded = { passage: old.passage, snippet: old.snippet.replace("is shared", "is common") };
  const rel = specIndex(draft).passages.get(old.passage).rel, file = join(draft, ".sova/spec/claims", rel);
  writeFileSync(file, readFileSync(file, "utf8").replace(old.snippet, reworded.snippet));
  // --record on the reworded spec refuses, naming the verdict, instead of recording that need as 0.
  await assert.rejects(baselineText(TREE, { pinned: draft, specLabel: "reworded" }), /refusing to record: .*C21:3/);
  // A re-verdict lists both lines: it holds on the base spec and on the draft.
  // Only the anchors place it: no `at`, and a probe that matches nothing.
  const need = { ...DATA.comparisons.find((c) => c.id === "C21").needs[3], probe: { source: "never-matches-anything-\\d{9}", flags: "" } };
  need.verdict = { status: need.verdict.status, anchors: [old, reworded] };
  for (const root of [base, draft]) {
    const index = specIndex(root);
    const s = scoreNeed(index, need, new Set([old.passage]), new Set());
    assert.equal(s.status, need.verdict.status, `${root === base ? "base" : "draft"}: ${JSON.stringify(s)}`);
  }
});

test("g on a draft spec against the spec it drafts from: anchors follow moved lines, a lost one is flagged, a moved answer is listed, the frame answers, what verdicts count", { timeout: 600_000, skip: (!hasRev(INT_REV) && "the integration revision is not in this checkout") || (!existsSync(join(TREE, "spec/core/fields.mjs")) && "this tree has no frame (M5)") }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-draft-"));
  temps.push(dest);
  mkdirSync(join(dest, "draft"));
  const draft = extractPinned(join(dest, "draft"), INT_REV, [".sova/spec"]);
  const base = JSON.parse(readFileSync(INT_BASELINE, "utf8"));
  const index = specIndex(draft);
  const file = (rel) => join(draft, ".sova/spec/claims", rel);
  const edit = (rel, fn) => writeFileSync(file(rel), fn(readFileSync(file(rel), "utf8")));
  const verdict = (id, i) => DATA.comparisons.find((c) => c.id === id).needs[i].verdict.anchor;
  // 1. The shell is a core record: the frame carries its lede (C01:0, "the frame around the tab").
  const manifest = JSON.parse(readFileSync(join(draft, ".sova/spec/manifest.json"), "utf8"));
  manifest.claims["§app/shell"].core = true;
  // 1a. So is the ground-rules breadcrumb lede: every frame carries it, and it carries no rule.
  manifest.claims["§design/ground-rules"].core = true;
  // 1b. A copy-deck note says which surface it serves (C06's seed): the copy-deck rows count it.
  manifest.claims["§design.copy-deck/model-menu"].about = ["§chat/model-menu"];
  // 1c. One note with a 20 KB body about the seeds of the 11 smallest and the 2 largest recorded packets: the median
  // per-comparison increase (+20 KB) trips the about byte guard, while the increase of the median stays far smaller,
  // because the padded small packets overtake the unpadded middle ones. A uniform pad can't tell the two apart.
  const bySize = DATA.comparisons.map((c) => c.id).sort((x, y) => base.comparisons[x].bytes - base.comparisons[y].bytes);
  const small = new Set([...bySize.slice(0, 11), ...bySize.slice(-2)]);
  const pad = index.passages.get("§mesh/peers").rel;
  edit(pad, (t) => `${t.trimEnd()}\n\n## §mesh.peers/padding — Padding\n\n${"Zzqx filler words for the byte guard.\n".repeat(540)}`);
  manifest.claims["§mesh.peers/padding"] = { kind: "note", authority: "accepted", evidence: "verified", about: [...new Set(DATA.comparisons.filter((c) => small.has(c.id)).map((c) => c.seed))] };
  writeFileSync(join(draft, ".sova/spec/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // 2. C21:3's quoted line is reworded: its hand verdict no longer applies.
  const c21 = verdict("C21", 3);
  edit(index.passages.get(c21.passage).rel, (t) => t.replace(c21.snippet, c21.snippet.replace("is shared", "is common")));
  // 3. Two lines go in above C09's verdicts: they move, and their anchors follow.
  const fork = index.passages.get(verdict("C09", 1).passage);
  edit(fork.rel, (t) => { const L = t.split("\n"); L.splice(fork.lines[0], 0, "", "A draft note, inserted above the verdicts."); return L.join("\n"); });
  // 4. A probe-answered need loses its matching lines: its answer moves to another passage, or to none.
  const anchored = new Set(DATA.comparisons.flatMap((c) => c.needs.map((n) => n.verdict?.anchor?.passage)).filter(Boolean));
  // Its body lines that match go; the heading stays, so pick one whose passage then matches nowhere, even across two lines.
  const strip = (p, re) => p.text.split("\n").map((l, k) => (k > 0 && re.test(l) ? "(removed in the draft)" : l));
  const pick = DATA.comparisons.flatMap((c) => c.needs.map((n, i) => ({ c, n, i, p: base.comparisons[c.id].passageOf[i], v: base.comparisons[c.id].values[i] })))
    .find((x) => {
      if (["C01", "C09", "C21"].includes(x.c.id) || x.p === "§app/shell" || x.n.verdict || x.v !== 1 || !x.p || anchored.has(x.p) || index.passages.get(x.p).rel === fork.rel) return false;
      const re = new RegExp(x.n.probe.source, x.n.probe.flags);
      const kept = strip(index.passages.get(x.p), re);
      return kept.every((l, k) => !re.test(`${l} ${(kept[k + 1] ?? "").trim()}`));
    });
  const re = new RegExp(pick.n.probe.source, pick.n.probe.flags), pp = index.passages.get(pick.p);
  edit(pp.rel, (t) => { const L = t.split("\n"); L.splice(pp.lines[0] - 1, pp.lines[1] - pp.lines[0] + 1, ...strip(pp, re)); return L.join("\n"); });
  // 5. Verdicts on the composer family: one right, one wrong, one judged on a what no longer shown.
  const sheet = await whatSheet(TREE, { pinned: draft, families: ["§chat/composer"] });
  const lines = sheet.families["§chat/composer"];
  const verdicts = join(dest, "what-verdicts.json");
  writeFileSync(verdicts, JSON.stringify({ verdicts: { [lines[0].id]: { what: lines[0].what, right: true }, [lines[1].id]: { what: lines[1].what, right: false }, [lines[2].id]: { what: "an older what", right: true } } }));

  const card = await runArm(TREE, { label: "draft", only: ["g"], pinned: draft, gBaseline: INT_BASELINE, whatVerdicts: verdicts });
  assert.equal(card.errors, undefined, JSON.stringify(card.errors));
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  const guardOf = (name) => card.rows.flatMap((r) => r.guards).find((g) => g.name === name);
  assert.match(guardOf("g.packet.total-never-drops").detail, new RegExp(`recorded at ${INT_REV.slice(0, 8)}`), "the guards compare against the given baseline");
  assert.ok(!guardOf("g.packet.anchored").ok && /C21:3/.test(guardOf("g.packet.anchored").detail), guardOf("g.packet.anchored").detail);
  assert.equal(value("g.packet.C09").needs, base.comparisons.C09.needs.join(" "), "C09's verdicts moved two lines and still score as recorded");
  assert.match(value("g.packet.passage-changed"), new RegExp(`${pick.c.id}:${pick.i} ${pick.p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} → `));
  // The breadcrumb reaches every packet (in the frame) and counts for nothing; a rule-carrying H2 would.
  assert.equal(value("g.read.frame-bytes").passages, 2, JSON.stringify(value("g.read.frame-bytes")));
  assert.equal(value("g.packet.total").groundRules, "0/24", "a breadcrumb-only frame reaches no ground rule");
  assert.equal(value("g.packet.C23").answered, 0.5, "nor does it answer C23:0 (product-wide principles): C23 stays 0.5/6");
  assert.doesNotMatch(value("g.pull.frame-answered").which, /C23:0/);
  const principles = DATA.comparisons.find((c) => c.id === "C23").needs[0];
  assert.equal(scoreNeed(index, principles, new Set(["§design/ground-rules"]), new Set()).value, 0, "the breadcrumb heading answers nothing");
  assert.deepEqual(["value", "passage"].map((k) => scoreNeed(index, principles, new Set(["§design.ground-rules/color-budget"]), new Set())[k]), [1, "§design.ground-rules/color-budget"], "a rule-carrying ground-rules passage answers it");
  assert.ok(!carriesRule(index.passages.get("§design/ground-rules").text) && carriesRule(index.passages.get("§design.ground-rules/color-budget").text));
  // C09's answers stayed in a passage whose text changed (step 3): listed, anchored, for a hand check.
  assert.ok(value("g.packet.answer-text-changed").includes(`C09:1 ${fork.id} (anchored)`), value("g.packet.answer-text-changed"));
  assert.ok(!guardOf("g.packet.about-bytes").ok && /median increase .* against b1de66b1/.test(guardOf("g.packet.about-bytes").detail), guardOf("g.packet.about-bytes").detail);
  const med = (xs) => { const q = [...xs].sort((a, b) => a - b), m = q.length >> 1; return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2; };
  const now = DATA.comparisons.map((c) => value(`g.packet.${c.id}`).bytes - value(`g.packet.${c.id}`).frameBytes), was = DATA.comparisons.map((c) => base.comparisons[c.id].bytes);
  const paired = med(now.map((b, k) => b - was[k]));
  assert.equal(value("g.packet.about-bytes-delta").median, paired, "the guard's statistic is the median of per-comparison increases");
  console.log("about-bytes: median of increases", paired, "| increase of the median", med(now) - med(was));
  assert.ok(med(now) - med(was) <= 12000, "…while the increase of the median (the old form) would have passed");
  assert.ok(paired > 12000 && value("g.packet.about-bytes-delta").overSlack >= 12, JSON.stringify(value("g.packet.about-bytes-delta")));
  assert.match(value("g.pull.frame-answered").which, /C01:0 /);
  assert.ok(value("g.read.frame-bytes").bytes > 0 && guardOf("g.read.frame-cap").ok, JSON.stringify(value("g.read.frame-bytes")));
  assert.ok(value("g.pull.C01").frameBytes > 0 && value("g.pull.total").bytesWithFrameTotal > value("g.pull.total").bytesTotal, "the frame's bytes count beside the toc bytes");
  // A need still answered, but in another passage, is counted apart and fails until an anchored verdict there confirms it.
  assert.equal(value("g.packet.total").viaChangedPassage, 1);
  assert.match(guardOf("g.packet.total-never-drops").detail, /of which 1 via a changed passage/);
  assert.ok(!guardOf("g.packet.moved-confirmed").ok && guardOf("g.packet.moved-confirmed").detail.includes(`${pick.c.id}:${pick.i}`), guardOf("g.packet.moved-confirmed").detail);
  // pct over all lines: grading fewer lines never raises it.
  assert.deepEqual(value("g.target.what-right.chat-composer"), { lines: lines.length, graded: 2, right: 1, stale: 1, ungraded: lines.length - 3, pct: Math.round(1000 / lines.length) / 10 });
  assert.equal(value("g.target.what-right.chat-sandbox").graded, 0);
  assert.equal(value("g.packet.total").copyDeck, "1/17", "packet delivers the copy-deck note that is about the seed");
  assert.match(value("g.pull.copy-deck").which, /C06:§design\.copy-deck\/model-menu/, "toc shows it as a line");
  console.log(JSON.stringify(Object.fromEntries(["g.packet.passage-changed", "g.pull.frame-answered", "g.read.frame-bytes", "g.target.what-right.chat-composer", "g.pull.total", "g.pull.copy-deck"].map((m) => [m, value(m)]))));
  console.log(guardOf("g.packet.anchored").detail, "|", guardOf("g.packet.no-need-lost").detail, "|", guardOf("g.pull.shown-floor").detail, "|", guardOf("g.packet.about-bytes").detail);
});

test("g on a draft: the about-growth guard catches one small packet swamped by a note the median never sees; a rule-carrying core passage answers C23:0 through the frame, with no moved answer", { timeout: 600_000, skip: !hasRev(INT_REV) && "the integration revision is not in this checkout" }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "spec-replay-growth-"));
  temps.push(dest);
  mkdirSync(join(dest, "draft"));
  const draft = extractPinned(join(dest, "draft"), INT_REV, [".sova/spec"]);
  const index = specIndex(draft), base = JSON.parse(readFileSync(INT_BASELINE, "utf8"));
  // A 10 KB note about C21's seed alone (its recorded packet is about 6 KB): one comparison of 24 moves.
  const c21 = DATA.comparisons.find((c) => c.id === "C21");
  const rel = index.passages.get("§mesh/peers").rel, file = join(draft, ".sova/spec/claims", rel);
  writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\n\n## §mesh.peers/swamp — Swamp\n\n${"Zzqx filler words for the growth guard.\n".repeat(256)}`);
  const mf = join(draft, ".sova/spec/manifest.json"), manifest = JSON.parse(readFileSync(mf, "utf8"));
  manifest.claims["§mesh.peers/swamp"] = { kind: "note", authority: "accepted", evidence: "verified", about: [c21.seed] };
  // A ground-rules H2 that carries a rule joins the frame: C23:0 is answered there, not in /theme where it is recorded.
  manifest.claims["§design.ground-rules/color-budget"].core = true;
  // The composer copy deck says which surface it serves: copy-deck need C07:3 is answered by packet and shown by pull.
  manifest.claims["§design.copy-deck/composer"].about = ["§chat/composer"];
  writeFileSync(mf, JSON.stringify(manifest, null, 2) + "\n");
  const card = await runArm(TREE, { label: "swamp", only: ["g"], pinned: draft, gBaseline: INT_BASELINE });
  assert.equal(card.errors, undefined, JSON.stringify(card.errors));
  const guardOf = (name) => card.rows.flatMap((r) => r.guards).find((g) => g.name === name);
  assert.ok(guardOf("g.packet.about-bytes").ok, `the median holds: ${guardOf("g.packet.about-bytes").detail}`);
  assert.ok(!guardOf("g.packet.about-growth").ok && /C21 \+\d+ B/.test(guardOf("g.packet.about-growth").detail), guardOf("g.packet.about-growth").detail);
  assert.ok(base.comparisons.C21.bytes < 10000, "C21's recorded packet is small");
  assert.deepEqual(failed(card), ["g.packet.about-growth"], "nothing else trips: g.packet.moved-confirmed holds, since another rule-carrying ground-rules passage is no moved answer");
  const value = (m) => card.rows.find((r) => r.metric === m)?.value;
  assert.match(value("g.pull.frame-answered").which, /C23:0 /, "the pull proxy counts C23:0 shown through the frame's rule-carrying passage");
  assert.equal(value("g.pull.total").shown, base.pull.shown + 2, "two more needs shown than recorded: C23:0 (the frame) and C07:3 (the composer copy deck)");
  assert.doesNotMatch(value("g.packet.passage-changed"), /C23:0/, "not listed as a moved answer");
  assert.equal(value("g.packet.C23").answered, 1.5);
  // Per-direction lines and bytes add up to the pull totals (so footer-count bytes and new lines can be told apart).
  const dirs = value("g.pull.dirs"), total = value("g.pull.total");
  assert.deepEqual(Object.keys(dirs), ["out", "in", "down", "up", "mentions"]);
  assert.equal(Object.values(dirs).reduce((t, d) => t + d.bytes, 0), total.bytesTotal);
  assert.equal(Object.values(dirs).reduce((t, d) => t + d.lines, 0), total.lines);
  const sweep = value("g.pull.down-sweep");
  assert.ok(sweep.h1s > 70 && sweep.lines > 0 && sweep.bytes > 0 && Number.isInteger(sweep.notesAboutH2s), JSON.stringify(sweep));
  // D49: the copy-deck target counts needs, per arm.
  const deck = value("g.target.copy-deck-needs");
  assert.equal(deck.needs, "C07:3 C10:2 C21:2 C23:4 C24:3");
  assert.deepEqual([deck.packet, deck.pull, deck.both, deck.packetLost], ["1/5", "3/5", "1/5", "none"], JSON.stringify(deck));
  assert.match(deck.which, /C07:3 packet 1, pull shown.*C21:2 packet 0, pull shown/, "pull already showed two at b1de66b1 (its 2/17 copy-deck lines)");
});

test("agent arm: each run is graded against the spec it read (its snapshot, hash-checked); compare lists moved answers between arms", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-perarm-"));
  temps.push(root);
  mkdirSync(join(root, "a"));
  const A = extractPinned(join(root, "a"));
  // Spec B: two lines go in above C09's anchored verdicts, so their lines (and the passage text) move.
  const B = join(root, "b");
  snapshotSpec(A, B);
  const ia = specIndex(A), anchor = DATA.comparisons.find((c) => c.id === "C09").needs[1].verdict.anchor, fork = ia.passages.get(anchor.passage);
  const file = join(B, ".sova/spec/claims", fork.rel), L = readFileSync(file, "utf8").split("\n");
  L.splice(fork.lines[0], 0, "", "A draft note, inserted above the verdicts.");
  writeFileSync(file, L.join("\n"));
  const ib = specIndex(B), recorded = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons.C09;
  // A run on spec B that read every passage C09's needs live in, as B words them.
  const out = join(root, "run");
  mkdirSync(join(out, "C09"), { recursive: true });
  snapshotSpec(B, join(out, "spec"));
  writeFileSync(join(out, "run.json"), JSON.stringify({ runId: "r", arm: "pull", model: "m", prompt: "p", comparisons: ["C09"], spec: { label: "spec B", sha256: specHash(B), snapshot: "spec" } }));
  const ids = [...new Set(recorded.passageOf.filter(Boolean))];
  const items = ids.map((id) => ({ id, text: ib.passages.get(id).text }));
  writeFileSync(join(out, "C09", "events.jsonl"), [
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "node tools/sova-spec.mjs read x --json" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: JSON.stringify({ command: "read", items }) }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const own = gradeDir(out);
  assert.equal(own.spec.label, "spec B");
  assert.equal(own.rows[0].answered, recorded.values.reduce((s, v) => s + v, 0), "graded on its own spec: every recorded answer holds, the anchors follow the moved lines");
  assert.ok(own.rows[0].passageOf.includes(anchor.passage) && own.rows[0].textOf.every((t, i) => !own.rows[0].passageOf[i] || typeof t === "string"));
  const wrong = gradeDir(out, specIndex(A));
  assert.ok(wrong.rows[0].answered < own.rows[0].answered, "graded on the other spec, B's text matches nothing there: why the run's own spec matters");
  // A snapshot that no longer matches the recorded hash is refused.
  const snap = join(out, "spec/.sova/spec/claims", fork.rel);
  writeFileSync(snap, readFileSync(snap, "utf8") + "\nedited after the run\n");
  assert.throws(() => gradeDir(out), /no longer matches the hash/);
  // compare: a need answered in both arms but in another passage is a moved answer, unconfirmed without an anchor there.
  const dir = (name, rows) => { const d = join(root, name); mkdirSync(d); writeFileSync(join(d, "agent-scorecard.json"), JSON.stringify({ model: "m", prompt: "p", instructions: null, grader: graderId(), spec: { label: name }, rows })); return d; };
  const c = DATA.comparisons.find((x) => x.id === "C01"), i = c.needs.findIndex((n) => !n.verdict);
  const row = (p, t) => ({ id: "C01", answered: 1, values: c.needs.map((_, k) => (k === i ? 1 : 0)), passageOf: c.needs.map((_, k) => (k === i ? p : null)), textOf: c.needs.map((_, k) => (k === i ? t : null)), shown: [] });
  const cmp = compareRuns(dir("base", [row("§x/one", "aaa")]), dir("cand", [row("§x/two", "aaa")]));
  assert.deepEqual([cmp.specs.baseline.label, cmp.specs.candidate.label], ["base", "cand"]);
  assert.deepEqual(cmp.movedUnconfirmed, [`C01:${i} §x/one → §x/two`]);
  const same = compareRuns(dir("base2", [row("§x/one", "aaa")]), dir("cand2", [row("§x/one", "bbb")]));
  assert.deepEqual(same.answerTextChanged, [`C01:${i} §x/one (probe only)`]);
});

test("agent arm on a spec where an answering passage was renamed: lost-unless-seen follows the new id, an unanchored verdict is left out of both arms", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-rename-"));
  temps.push(root);
  mkdirSync(join(root, "a"));
  const A = extractPinned(join(root, "a")), B = join(root, "b");
  snapshotSpec(A, B);
  // Spec B renames the passage every C09 answer lives in.
  const was = "§chat.session-fork/from-reply", now = "§chat.session-fork/from-a-reply";
  const ia = specIndex(A), rel = ia.passages.get(was).rel, file = join(B, ".sova/spec/claims", rel);
  writeFileSync(file, readFileSync(file, "utf8").replace(`## ${was} `, `## ${now} `));
  const mf = join(B, ".sova/spec/manifest.json"), m = JSON.parse(readFileSync(mf, "utf8"));
  m.claims[now] = m.claims[was];
  delete m.claims[was];
  writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
  assert.ok(specIndex(B).passages.has(now) && !specIndex(B).passages.has(was));
  // Two runs on spec B that read nothing: one saw the new id as a toc line, the other only the old one.
  const run = (name, seen) => {
    const out = join(root, name);
    mkdirSync(join(out, "C09"), { recursive: true });
    snapshotSpec(B, join(out, "spec"));
    writeFileSync(join(out, "run.json"), JSON.stringify({ runId: name, arm: "pull", model: "m", prompt: "p", comparisons: ["C09"], spec: { label: "renamed", sha256: specHash(B), snapshot: "spec" } }));
    writeFileSync(join(out, "C09", "events.jsonl"), [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "node tools/sova-spec.mjs toc x --dir out --root . --json" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: JSON.stringify({ command: "toc", lines: [{ id: seen, what: "x" }] }) }] } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { out, card: gradeDir(out) };
  };
  const newSeen = run("new", now), oldSeen = run("old", was);
  const lostIds = (card) => card.rows[0].lostVsPacket.map((l) => Number(l.split(" ")[0]));
  // C09:1 and C09:4 are anchored in the renamed passage: unanchored on B, listed apart, never lost.
  assert.deepEqual(newSeen.card.rows[0].unanchored, [1, 4]);
  assert.equal(newSeen.card.total.unanchored, 2);
  // C09:2, C09:3 (probe only) and C09:5 live in the renamed passage: seen through the new id, not lost; seeing only the
  // old id (which B lacks) does not excuse them.
  assert.deepEqual(lostIds(newSeen.card), [], JSON.stringify(newSeen.card.rows[0].lostVsPacket));
  assert.deepEqual(lostIds(oldSeen.card), [2, 3, 5], JSON.stringify(oldSeen.card.rows[0].lostVsPacket));
  assert.ok(newSeen.card.rows[0].whereOf.slice(2).every((p) => p === now));
  // compare, against a baseline arm that answered every recorded need on a95768b7: the same both ways, and the two
  // unanchored needs are out of both arms' totals.
  const rec = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).comparisons.C09;
  const baseDir = join(root, "base");
  mkdirSync(baseDir);
  writeFileSync(join(baseDir, "agent-scorecard.json"), JSON.stringify({ model: "m", prompt: "p", instructions: null, grader: graderId(), spec: { label: "a95768b7" }, rows: [{ id: "C09", answered: rec.values.reduce((t, v) => t + v, 0), values: rec.values, passageOf: rec.passageOf, unanchored: [], shown: [] }] }));
  for (const r of [newSeen, oldSeen]) writeFileSync(join(r.out, "agent-scorecard.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(r.out, "agent-scorecard.json"), "utf8")), grader: graderId() }));
  const cNew = compareRuns(baseDir, newSeen.out), cOld = compareRuns(baseDir, oldSeen.out);
  assert.deepEqual(cNew.lost, []);
  assert.deepEqual(cOld.lost.map((l) => l.split(" ")[0]), ["C09:2", "C09:3", "C09:5"]);
  assert.deepEqual(cNew.unanchored.candidate.map((l) => l.split(" ")[0]), ["C09:1", "C09:4"]);
  assert.equal(cNew.rows[0].agentPacket, rec.values.reduce((t, v) => t + v, 0) - rec.values[1] - rec.values[4], "the unanchored needs leave the baseline arm's total too");
});

test("rubric arm: both arms get the same task words; blind grading input holds no listed leak and no differential tell; routes, redactions and a random seed are kept in the key", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-replay-rubric-"));
  temps.push(root);
  // The prompt depends only on the task: no arm, no command beyond the generic tool line both arms get.
  for (const t of RUBRIC.tasks) {
    const p = rubricPrompt(t);
    assert.ok(p.includes(t.task) && t.seeds.every((s) => p.includes(s)), `${t.n}: the rubric's own wording and seeds`);
    assert.doesNotMatch(p, /\b(baseline|candidate|arm|packet|toc|pull|scope|impact|frontier|census)\b|sova-spec\.mjs (?!<command>)/i, `${t.n}: names no arm and no reading command`);
  }
  // Two fake runs whose briefs hold each arm's commands, tool words, a revision id and fenced shell, around the same facts.
  const tools = { baseline: { cmd: "packet '§x' --part frontier", words: "packet frontier" }, candidate: { cmd: "toc '§chat/composer' --dir out", words: "toc" } };
  const brief = (arm, n, extra = "") => [
    `Read via \`node tools/sova-spec.mjs ${tools[arm].cmd} --root .\` at a7c3e9f.`,
    "```sh", `core="$PWD/tools"; node "$core/sova-spec.mjs" ${tools[arm].cmd} --root .`, "```",
    `- The ${tools[arm].words} showed it.`,
    `- FACT-${n}: Send stays refused while the draft is empty (§chat.composer/disabled-states); model id 20251001 stays.`,
    extra,
  ].join("\n");
  const fakeRun = (name, arm, { extra = () => "", tasks = RUBRIC.tasks, prompt = (t) => rubricPrompt(t) } = {}) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: `rubric-${arm}-zai_glm-5.3_medium-${name}`, arm, model: "zai/glm-5.3:medium", prompt: RUBRIC_PROMPT_VERSION, spec: { label: `spec-of-${name}` }, tasks: tasks.map((t) => t.n) }));
    for (const t of tasks) {
      mkdirSync(join(dir, `T${t.n}`));
      writeFileSync(join(dir, `T${t.n}`, "prompt.txt"), prompt(t) + "\n");
      writeFileSync(join(dir, `T${t.n}`, "exit.json"), JSON.stringify({ code: 0, work: "/work" }));
      const ev = [
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "node tools/sova-spec.mjs toc x --root ." } },
        { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: arm === "baseline" ? "x".repeat(100) : "y".repeat(40) }] } },
        ...(arm === "candidate" && t.n === "01" ? [
          { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "cat /etc/passwd" } },
          { type: "tool_execution_end", toolCallId: "c2", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "" }] } },
        ] : []),
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: brief(arm, t.n, extra(t)) }] } },
      ];
      writeFileSync(join(dir, `T${t.n}`, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    return dir;
  };
  const A = fakeRun("a", "baseline"), B = fakeRun("b", "candidate");
  const { grader, key, tells } = blind(A, B, join(root, "blind"), { seed: 7 });
  assert.deepEqual([tells.A, tells.B], [[], []], "the same facts, the arms' tool words scrubbed: no differential tell");
  assert.deepEqual([...leaks(grader, key)], [], "no listed leak and no differential tell reaches the grader");
  assert.ok(!readdirSync(grader).some((f) => /key|tells/i.test(f)) && existsSync(join(root, "blind", "key.json")) && existsSync(join(root, "blind", "tells.json")), "the key and the tells stay outside the grader folder");
  const t01 = readFileSync(join(grader, "tasks", "01.md"), "utf8");
  assert.match(t01, /FACT-01: Send stays refused while the draft is empty \(§chat\.composer\/disabled-states\); model id 20251001 stays\./, "facts survive, a date is no revision id");
  assert.doesNotMatch(t01, /a7c3e9f|toc|packet|frontier|\b100\b|\b40\b|bytes|calls/, "no revision id, tool word or number that tells the arms apart");
  // Routes and redactions per arm stay in the key.
  assert.deepEqual([key.tasks["01"].routes.B.outside, key.tasks["01"].routes.A.outside], [1, 0], "the candidate's cat of /etc/passwd is an outside route");
  assert.ok(key.tasks["01"].redactions.A > 0 && key.tasks["01"].redactions.B > 0);
  // The draw: both orders occur; the same seed repeats it; no seed means a random one, kept only in key.json.
  const xs = Object.values(key.tasks).map((k) => k.X);
  assert.ok(xs.includes("A") && xs.includes("B"), xs.join(""));
  assert.deepEqual(Object.values(blind(A, B, join(root, "blind2"), { seed: 7 }).key.tasks).map((k) => k.X), xs);
  const random = blind(A, B, join(root, "blind3")).key;
  assert.ok(Number.isInteger(random.seed) && random.seed !== 1);
  assert.ok(!readdirSync(join(root, "blind3", "grader", "tasks")).some((f) => readFileSync(join(root, "blind3", "grader", "tasks", f), "utf8").includes(String(random.seed))));
  // A tell no list can hold: a random token in every candidate brief. Blind refuses and names it; in both arms it is content.
  const nonce = `zq${randomUUID().replace(/[^a-z]/g, "")}`;
  const Bn = fakeRun("bn", "candidate", { extra: () => `- Also ${nonce} applies.` });
  assert.throws(() => blind(A, Bn, join(root, "blind-n")), /differential tell/);
  const t = JSON.parse(readFileSync(join(root, "blind-n", "tells.json"), "utf8"));
  assert.ok(t.B.tells.some((x) => x.token === nonce) && t.B.arm === "candidate", JSON.stringify(t.B.tells.slice(0, 3)));
  assert.ok(!existsSync(join(root, "blind-n", "grader")), "nothing is handed out");
  const An = fakeRun("an", "baseline", { extra: () => `- Also ${nonce} applies.` });
  assert.deepEqual([...leaks(blind(An, Bn, join(root, "blind-nn"), { seed: 3 }).grader, JSON.parse(readFileSync(join(root, "blind-nn", "key.json"), "utf8")))], [], "the token in both arms is content, not a tell");
  // Accepted tells are recorded; a tell planted in the grader folder afterwards, or a listed word, is caught.
  const acc = blind(A, Bn, join(root, "blind-acc"), { seed: 5, acceptTells: true });
  assert.ok(acc.key.acceptedTells.includes(nonce));
  assert.deepEqual([...leaks(acc.grader, acc.key)], [], "accepted tells pass the check");
  assert.ok(leaks(acc.grader, { ...acc.key, acceptedTells: [] }).some((f) => f.includes(nonce)), "the check finds the tell in the handed-out briefs when nobody accepted it");
  writeFileSync(join(grader, "tasks", "99.md"), "Brief X: the packet arm read it with toc.");
  assert.ok(leaks(grader, key).length >= 2, "a planted arm phrase and tool word are caught");
  // Different task sets or prompt bytes are refused.
  assert.throws(() => blind(A, fakeRun("b2", "candidate", { tasks: RUBRIC.tasks.slice(0, 2) }), join(root, "blind4")), /different tasks/);
  assert.throws(() => blind(A, fakeRun("b3", "candidate", { prompt: (x) => `${rubricPrompt(x)}\nRead with toc first.` }), join(root, "blind5")), /not given the same prompt/);
  // A work directory inside a repository is caught (the run command refuses it).
  assert.equal(insideRepo(TREE), true);
  // Unblinding maps X/Y back to the arms, with (e) bytes, (g) calls, routes and redactions beside a-d.
  const scores = { tasks: Object.fromEntries(Object.entries(key.tasks).map(([n, k]) => [n, { [k.X === "A" ? "X" : "Y"]: { a: 2, b: 2, c: 1, d: 1 }, [k.X === "A" ? "Y" : "X"]: { a: 1, b: 1, c: 1, d: 0 } }])) };
  const card = unblind(join(root, "blind"), scores);
  assert.deepEqual([card.arms.A.arm, card.arms.A.spec.label, card.arms.A.total.sum, card.arms.A.total.of, card.arms.A.total.bytes, card.arms.A.total.calls], ["baseline", "spec-of-a", 6 * 15, 120, 100 * 15, 15]);
  assert.deepEqual([card.arms.B.arm, card.arms.B.total.sum, card.arms.B.total.bytes, card.arms.B.total.outside], ["candidate", 3 * 15, 40 * 15, 1]);
  assert.equal(card.reference.total, 63);
  assert.throws(() => unblind(join(root, "blind"), { tasks: { ...scores.tasks, "01": { X: { a: 3, b: 0, c: 0, d: 0 }, Y: { a: 0, b: 0, c: 0, d: 0 } } } }), /is not 0, 1 or 2/);
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
