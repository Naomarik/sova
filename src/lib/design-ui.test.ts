import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "../../shared/protocol";
import type { DesignRecord, DesignSetup } from "../../shared/design";
import type { LiveTool } from "./live";
import { designFold, liveDesignCalls, newestDesignRows, normalizeDesignCard } from "./design-rows";
import { batchLine, briefTitle, lookbookTitle, canShuffle, designSections, pairsLine, setCombine, shufflePairs, tickedLine, toggleLayout, searchModels, sectionSummary, designFixLine, designCanOpen, designHoldEnds, designIsBusy, designMeta, designOpenFollowsLive, designNoteLine, designUnchangedLine, designStatusWord, moveCoordinator, parentsLine, setupBlocked, setupCount, setupSummary, statusCounts, toggleDirection, toggleGroup, toggleModel } from "./design-ui";

const caps = { batchDefault: 6, askAbove: 12, batchMax: 24, concurrent: 6 };
const m = (ref: string, design = true, coordinator = false) => ({ ref, name: ref, design, coordinator, vision: true, route: "tool" as const });
const setup = (over: Partial<DesignSetup> = {}): DesignSetup => ({
  brief: "Landing page",
  models: [m("claude-code/opus", false, true), m("claude-code/sonnet"), m("ollama-cloud/glm")],
  directions: [
    { name: "Minimalist", on: true },
    { name: "Heritage", on: true },
    { name: "Immersive", on: false },
  ],
  ...over,
});

test("exactly one model holds the coordinator mark, wherever it moves", () => {
  const moved = moveCoordinator(setup(), "ollama-cloud/glm");
  assert.deepEqual(moved.models.filter((x) => x.coordinator).map((x) => x.ref), ["ollama-cloud/glm"]);
  const again = moveCoordinator(moved, "ollama-cloud/glm");
  assert.deepEqual(again.models.filter((x) => x.coordinator).map((x) => x.ref), ["ollama-cloud/glm"], "pressing the holder keeps it");
});

test("the coordinator mark and designing are separate", () => {
  const s = setup();
  assert.equal(s.models[0]!.design, false);
  assert.equal(s.models[0]!.coordinator, true);
  assert.equal(setupCount(s).models, 2, "a coordinator that doesn't design isn't counted");
  assert.equal(moveCoordinator(s, "claude-code/sonnet").models[1]!.design, true, "moving the mark leaves designing alone");
});

test("a section's All covers its models and only them", () => {
  const off = toggleGroup(setup(), "claude", false);
  assert.deepEqual(off.models.map((x) => x.design), [false, false, true]);
  const on = toggleGroup(off, "claude", true);
  assert.deepEqual(on.models.map((x) => x.design), [true, true, true]);
  const g = designSections(toggleModel(setup(), "claude-code/opus", false).models).find((x) => x.id === "claude")!;
  assert.deepEqual([g.count, g.on], [2, 1], "half ticked");
});

test("local Ollama and Ollama Cloud are two sections: All on one never ticks the other", () => {
  const s = setup({ models: [m("ollama-cloud/glm-5.3", false), m("ollama/gemma3:270m", false), m("ollama/qwen2.5:0.5b", false)] });
  const ticked = toggleGroup(s, "ollama-cloud", true);
  assert.deepEqual(ticked.models.filter((x) => x.design).map((x) => x.ref), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(designSections(ticked.models).map((x) => [x.name, x.on, x.count]), [["Ollama Cloud", 1, 1], ["Ollama on this computer", 0, 2]]);
});

test("a closed section names its designing models on one line, or none", () => {
  assert.equal(sectionSummary([]), "None designing");
  assert.equal(sectionSummary(["glm-5.3", "glm-5.2"]), "glm-5.3, glm-5.2");
  assert.equal(sectionSummary(["a", "b", "c", "d", "e", "f", "g"]), "a, b, c, +4");
});

test("the picker's order stays put while models are ticked", () => {
  const models = [m("zai/glm-4.7", false), m("zai/glm-5.3", false), m("claude-code-cli/claude-haiku-4-5", false), m("zai/glm-5.2", false)];
  const order = (ms: readonly DesignSetup["models"][number][]) => designSections(ms).flatMap((x) => x.refs);
  const before = order(models);
  let s = setup({ models });
  for (const ref of ["zai/glm-4.7", "claude-code-cli/claude-haiku-4-5", "zai/glm-5.2"]) {
    s = toggleModel(s, ref, true);
    assert.deepEqual(order(s.models), before, `ticking ${ref} moves no row`);
  }
  s = moveCoordinator(toggleGroup(s, "zai", false), "zai/glm-4.7");
  assert.deepEqual(order(s.models), before, "All and the coordinator move no row either");
});

test("search finds every word in a model's name or provider, in the picker's order", () => {
  const models = [m("zai/glm-5.2"), m("ollama-cloud/glm-5.3"), m("zai/glm-5.3"), m("openai-codex/gpt-6-luna")];
  assert.deepEqual(searchModels(models, "glm 5.3").map((x) => x.ref), ["zai/glm-5.3", "ollama-cloud/glm-5.3"]);
  assert.deepEqual(searchModels(models, "cloud").map((x) => x.ref), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(searchModels(models, "  "), [], "an empty search shows the sections, not a result");
});

test("a run is models times directions, and says so", () => {
  const c = setupCount(setup());
  assert.deepEqual([c.models, c.styles, c.layouts, c.designs], [2, 2, 0, 4]);
  assert.equal(setupSummary(c), "4 designs · 2 styles · 2 models");
  assert.equal(setupSummary(setupCount(toggleDirection(toggleModel(setup(), "claude-code/sonnet", false), "Heritage", false))), "1 design · 1 style · 1 model");
});

test("Start Creative Director says why it can't go, one reason at a time", () => {
  assert.equal(setupBlocked(setup(), caps), null);
  assert.match(setupBlocked(setup({ brief: " " }), caps)!, /what to design/);
  assert.match(setupBlocked(toggleGroup(toggleGroup(setup(), "claude", false), "ollama-cloud", false), caps)!, /1 model/);
  assert.match(setupBlocked(toggleDirection(toggleDirection(setup(), "Minimalist", false), "Heritage", false), caps)!, /1 style/);
  const noMark = setup();
  assert.match(setupBlocked({ ...noMark, models: noMark.models.map((x) => ({ ...x, coordinator: false })) }, caps)!, /Creative Director/);
  const many = setup({ directions: Array.from({ length: 13 }, (_, i) => ({ name: `d${i}`, on: true })) });
  assert.equal(setupCount(many).designs, 26);
  assert.match(setupBlocked(many, caps)!, /^26 designs is more than 1 run can make \(24\)\. Choose fewer models, styles or layouts\.$/);
});

const rec = (label: string, status: DesignRecord["status"], direction = "Minimalist", model = "x/y"): DesignRecord => ({ label, runId: "r", direction, model, modelName: "Opus", parents: [], status, route: "tool", versions: [], vision: true, workerState: "idle", createdAt: "", updatedAt: "" });

test("the card's status line counts what there is, and nothing there isn't", () => {
  assert.equal(statusCounts([rec("A", "ready"), rec("B", "ready"), rec("C", "writing"), rec("D", "failed")]), "2 ready · 1 writing · 1 failed");
  assert.equal(statusCounts([]), "0 designs");
  assert.equal(batchLine([rec("A", "ready", "M", "a"), rec("B", "ready", "H", "b")]), "2 designs · 2 styles · 2 models");
});

test("a design's chip says what its session is doing", () => {
  const word = (over: Partial<DesignRecord>) => designStatusWord({ ...rec("A", "ready"), ...over });
  assert.equal(word({}), "Ready");
  assert.equal(word({ status: "writing" }), "Writing");
  assert.equal(word({ status: "writing", thinking: true }), "Thinking");
  assert.equal(word({ status: "writing", readingSkill: true, thinking: true }), "Reading");
  assert.equal(word({ status: "writing", readingSkill: true, live: { version: 1, chars: 10 } }), "Writing");
  assert.equal(word({ workerState: "working" }), "Working", "a refine with no page yet");
  assert.equal(word({ status: "failed" }), "Failed");
  assert.equal(word({ workerState: "working", delivery: { state: "queued", key: "k", at: "" } }), "Queued", "a queued message says so first");
  assert.equal(designIsBusy({ ...rec("A", "ready"), workerState: "working" }), true);
  assert.equal(designIsBusy(rec("A", "ready")), false);
  assert.equal(designIsBusy(rec("A", "queued")), false);
});

test("a design being fixed says why and how many tries, and counts as work going on", () => {
  const d: DesignRecord = { ...rec("A", "fixing"), fix: { reason: "The page was cut off.", attempt: 1, of: 2 } };
  assert.equal(designStatusWord(d), "Fixing");
  assert.equal(designFixLine(d), "The page was cut off. Fixing it, try 1 of 2.");
  assert.equal(designIsBusy(d), true);
  assert.equal(designFixLine(rec("A", "writing")), "", "only while fixing");
  assert.equal(designFixLine(rec("A", "fixing")), "Fixing it.", "a server with no reason yet");
  assert.equal(statusCounts([d, rec("B", "ready")]), "1 ready · 1 fixing");
});

test("a design's line names its model, its tokens as far as known, and its cost", () => {
  const d = rec("A", "writing");
  assert.equal(designMeta(d), "Opus");
  assert.equal(designMeta(d, 36_000), "Opus · 10.0k tokens");
  assert.equal(designMeta({ ...d, usage: { input: 1, output: 11_800, cost: 0.19 } }), "Opus · 11.8k tokens · $0.19");
});

test("parents read as words", () => {
  assert.equal(parentsLine([]), "");
  assert.equal(parentsLine(["A"]), "from A");
  assert.equal(parentsLine(["A", "C"]), "from A and C");
  assert.equal(parentsLine(["A", "B", "C"]), "from A, B and C");
});

test("a card's title is the brief's first line, and short", () => {
  assert.equal(briefTitle("Landing page\nmore"), "Landing page");
  assert.equal(briefTitle(""), "New design");
  assert.ok(briefTitle("x".repeat(200)).length <= 64);
});

// ---- the card's place in the transcript

const call = (id: string, text = "lookbook"): TranscriptItem => ({ id, kind: "tool-call", text, toolCallId: `c-${id}` }) as TranscriptItem;
const result = (id: string, details: unknown, isError = false): TranscriptItem => ({ id: `r-${id}`, kind: "tool-result", toolCallId: `c-${id}`, tool: { details, output: "" }, facts: { tool: { isError } } }) as unknown as TranscriptItem;

test("one card per run: only each run's newest successful call draws it", () => {
  const items = [call("1"), result("1", { designCard: { runId: "a" } }), call("2"), result("2", { designCard: { runId: "b" } }), call("3"), result("3", { designCard: { runId: "a" } })];
  assert.deepEqual([...newestDesignRows(items)].sort(), ["2", "3"]);
  assert.equal(designFold(items).rows.size, 3);
});

test("a design call that names no run, fails, or belongs to another tool never takes the card", () => {
  const items = [call("1"), result("1", { designCard: { runId: "a" } }), call("2"), result("2", {}), call("3"), result("3", { designCard: { runId: "a" } }, true), call("4", "other"), result("4", { designCard: { runId: "a" } })];
  assert.deepEqual([...newestDesignRows(items)], ["1"]);
});

test("a streaming turn's own call takes the card from the settled row", () => {
  const items = [call("1"), result("1", { designCard: { runId: "a" } })];
  assert.deepEqual([...newestDesignRows(items, new Set(["a"]))], []);
  const tools = { x: { name: "lookbook", status: "done", details: { designCard: { runId: "a" } } } } as unknown as Record<string, LiveTool>;
  assert.equal(liveDesignCalls(tools).get("a"), "x");
  const running = { x: { name: "lookbook", status: "running", details: { designCard: { runId: "a" } } } } as unknown as Record<string, LiveTool>;
  assert.equal(liveDesignCalls(running).size, 0);
});

test("details that aren't a run are no card", () => {
  assert.equal(normalizeDesignCard({}), undefined);
  assert.equal(normalizeDesignCard({ designCard: {} }), undefined);
  assert.equal(normalizeDesignCard({ designCard: { runId: 3 } }), undefined);
  assert.deepEqual(normalizeDesignCard({ designCard: { runId: "a" } }), { runId: "a" });
});

test("a request that ended with no new version says so, and why, only while the design is ready", () => {
  const d = { ...rec("A", "ready"), unchanged: { reason: "It finished without changing the page.", at: "" } };
  assert.equal(designUnchangedLine(d), "That didn't change the page: It finished without changing the page.");
  assert.equal(designUnchangedLine({ ...d, unchanged: { reason: "script 1, line 2: Unexpected token ';'", at: "" } }), "That didn't change the page: script 1, line 2: Unexpected token ';'.");
  assert.equal(designUnchangedLine(rec("A", "ready")), "", "nothing set, nothing said");
  assert.equal(designUnchangedLine({ ...d, status: "writing" }), "", "a new request in hand");
  assert.equal(designNoteLine({ ...d, status: "fixing", fix: { reason: "The page was cut off.", attempt: 1, of: 2 } }), "The page was cut off. Fixing it, try 1 of 2.");
});

test("a page being written shows its cost as an estimate, and a model with no price shows none", () => {
  const d = { ...rec("A", "writing"), modelName: "Opus" };
  assert.equal(designMeta({ ...d, live: { version: 1, chars: 3600, estimateUsd: 0.023 } }), "Opus · about $0.02");
  assert.equal(designMeta({ ...d, live: { version: 1, chars: 3600, estimateUsd: 0.001 } }), "Opus · under $0.01");
  assert.equal(designMeta({ ...d, live: { version: 1, chars: 3600 } }), "Opus");
  assert.equal(designMeta({ ...d, status: "ready", usage: { input: 1, output: 1000, cost: 0 } }), "Opus · 1.0k tokens");
});

test("a design opens once it has a page or one is being written, never while it only waits", () => {
  const v1 = { n: 1, at: "", chars: 1 } as DesignRecord["versions"][number];
  assert.equal(designCanOpen(rec("A", "queued")), false);
  assert.equal(designCanOpen(rec("A", "failed")), false);
  assert.equal(designCanOpen(rec("A", "writing")), true, "its first page, watched full size");
  assert.equal(designCanOpen(rec("A", "fixing")), true);
  assert.equal(designCanOpen({ ...rec("A", "ready"), versions: [v1] }), true);
});

test("the open view follows the page being written unless a version was picked by hand", () => {
  const writing = { ...rec("A", "writing"), live: { version: 2, chars: 10 } };
  assert.equal(designOpenFollowsLive(writing, null), true);
  assert.equal(designOpenFollowsLive(writing, 1), false, "an older version picked stays on show");
  assert.equal(designOpenFollowsLive(rec("A", "ready"), null), false);
});

test("a held page being written gives way at once when no new version came of it, else only once the new one draws", () => {
  const v = (n: number) => ({ n, at: "", chars: 1 }) as DesignRecord["versions"][number];
  assert.equal(designHoldEnds({ ...rec("A", "ready"), versions: [v(1)] }, 1), true, "a Refine that changed nothing");
  assert.equal(designHoldEnds({ ...rec("A", "ready"), versions: [v(1), v(2)] }, 1), false, "v2 came: wait for it to draw");
  assert.equal(designHoldEnds({ ...rec("A", "writing"), versions: [v(1)] }, 1), false, "still writing");
  assert.equal(designHoldEnds(rec("A", "failed"), 0), true, "a first page that failed");
});

// ---- Style and Layout ------------------------------------------------------------------------------

const lay = (names: string[], on: string[] = []) => names.map((name) => ({ name, on: on.includes(name) }));
const STYLES3 = ["Minimalist", "Bold & Vibrant", "Balanced"];
const LAYOUTS3 = ["Compact", "Bento", "Split Screen"];
const withLayouts = (on: string[], over: Partial<DesignSetup> = {}): DesignSetup =>
  setup({ directions: lay([...STYLES3, "Heritage"], STYLES3), layouts: lay([...LAYOUTS3, "Dashboard"], on), ...over });

test("the count line says how the plan combines, read from the same plan as the count", () => {
  assert.equal(setupSummary(setupCount(withLayouts([]))), "6 designs · 3 styles · 2 models");
  assert.equal(setupSummary(setupCount(withLayouts(LAYOUTS3))), "6 designs · 3 pairs · 2 models");
  assert.equal(setupSummary(setupCount(withLayouts(LAYOUTS3, { combine: "every" }))), "18 designs · 3 styles × 3 layouts · 2 models");
  // The longer list sets the pairs: 3 styles and 4 layouts are 4 pairs per model.
  assert.equal(setupSummary(setupCount(withLayouts([...LAYOUTS3, "Dashboard"]))), "8 designs · 4 pairs · 2 models");
});

test("Every Mix past the hard stop says what to choose fewer of", () => {
  const big = withLayouts([...LAYOUTS3, "Dashboard"], { combine: "every" });
  assert.equal(setupCount(big).designs, 24);
  assert.equal(setupBlocked(big, caps), null, "24 is the most, and allowed");
  const over = { ...big, directions: big.directions.map((d) => ({ ...d, on: true })) };
  assert.equal(setupCount(over).designs, 32);
  assert.match(setupBlocked(over, caps)!, /Choose fewer models, styles or layouts/);
  assert.equal(setupBlocked({ ...over, combine: "pair" }, caps), null, "the same ticks paired up stay small");
});

test("the combine line names the pairs that launch, and says so when no layout is ticked", () => {
  assert.equal(pairsLine(withLayouts([])).text, "No layout ticked: each designer arranges its own page.");
  const one = withLayouts(LAYOUTS3, { models: [m("claude-code/opus", false, true), m("claude-code/sonnet")] });
  assert.equal(pairsLine(one).text, "Minimalist + Compact · Bold & Vibrant + Bento · Balanced + Split Screen");
  // 2 models: the second model's pairs shift, and the line lists every distinct pair, first model first.
  const two = withLayouts(LAYOUTS3);
  assert.equal(pairsLine(two).text.split(" · ").length, 6);
  assert.ok(pairsLine(two).text.startsWith("Minimalist + Compact · Bold & Vibrant + Bento · Balanced + Split Screen · "));
  assert.match(pairsLine(withLayouts(LAYOUTS3, { combine: "every" })).text, /^Every style in every layout: 9 designs for each model\.$/);
});

test("Shuffle deals different pairs and keeps the count; with nothing to deal it stays put", () => {
  const s = withLayouts(LAYOUTS3);
  assert.equal(canShuffle(s), true);
  const dealt = shufflePairs(s, () => 0.37);
  assert.notEqual(pairsLine(dealt).full, pairsLine(s).full);
  assert.equal(setupCount(dealt).designs, setupCount(s).designs);
  const lone = withLayouts(["Bento"]);
  assert.equal(canShuffle(lone), false);
  assert.equal(canShuffle(withLayouts(LAYOUTS3, { combine: "every" })), false);
});

test("a layout ticks on its own row, and a run from before layouts reads as none ticked", () => {
  const s = toggleLayout(withLayouts([]), "Bento", true);
  assert.deepEqual(s.layouts!.filter((d) => d.on).map((d) => d.name), ["Bento"]);
  assert.equal(tickedLine(s.layouts!, "Designer's Choice"), "Bento");
  assert.equal(tickedLine(withLayouts([]).layouts!, "Designer's Choice"), "Designer's Choice");
  assert.equal(setCombine(s, "every").combine, "every");
  const old = setup();
  assert.equal(old.layouts, undefined);
  assert.equal(setupSummary(setupCount(old)), "4 designs · 2 styles · 2 models");
});

test("a launched run's size line reads like Setup's", () => {
  const r = (label: string, style: string, layout: string | undefined, model: string, parents: string[] = []): DesignRecord => ({ ...rec(label, "ready", style, model), ...(layout ? { layout } : {}), parents });
  const paired = [r("A", "Minimalist", "Compact", "a"), r("B", "Minimalist", "Bento", "b"), r("C", "Balanced", "Bento", "a"), r("D", "Balanced", "Compact", "b")];
  assert.equal(batchLine(paired, "pair"), "4 designs · 2 pairs · 2 models");
  assert.equal(batchLine(paired, "every"), "4 designs · 2 styles × 2 layouts · 2 models");
  assert.equal(batchLine([...paired, r("E", "Mixed", undefined, "a", ["A", "C"])], "pair"), "5 designs · 2 pairs · 2 models", "a design made from others counts as a design, not a style");
});

test("a run's card title names its state: the brief until a design exists, then the count", () => {
  assert.equal(lookbookTitle(0), "Lookbook · Brief");
  assert.equal(lookbookTitle(1), "Lookbook · 1 design");
  assert.equal(lookbookTitle(6), "Lookbook · 6 designs");
});
