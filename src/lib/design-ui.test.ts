import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "../../shared/protocol";
import type { DesignRecord, DesignSetup } from "../../shared/design";
import type { LiveTool } from "./live";
import { designFold, liveDesignCalls, newestDesignRows, normalizeDesignCard } from "./design-rows";
import { batchLine, briefTitle, designGroups, designMeta, moveCoordinator, parentsLine, setupBlocked, setupCount, setupSummary, statusCounts, toggleDirection, toggleGroup, toggleModel } from "./design-ui";

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

test("a group tick covers its models and only them", () => {
  const off = toggleGroup(setup(), "claude", false);
  assert.deepEqual(off.models.map((x) => x.design), [false, false, true]);
  const on = toggleGroup(off, "claude", true);
  assert.deepEqual(on.models.map((x) => x.design), [true, true, true]);
  const g = designGroups(toggleModel(setup(), "claude-code/opus", false).models).find((x) => x.id === "claude")!;
  assert.deepEqual([g.count, g.on], [2, 1], "half ticked");
});

test("a run is models times directions, and says so", () => {
  const c = setupCount(setup());
  assert.deepEqual(c, { models: 2, directions: 2, designs: 4 });
  assert.equal(setupSummary(c), "4 designs · 2 models × 2 directions");
  assert.equal(setupSummary(setupCount(toggleDirection(toggleModel(setup(), "claude-code/sonnet", false), "Heritage", false))), "1 design · 1 model × 1 direction");
});

test("Start Coordinator says why it can't go, one reason at a time", () => {
  assert.equal(setupBlocked(setup(), caps), null);
  assert.match(setupBlocked(setup({ brief: " " }), caps)!, /what to design/);
  assert.match(setupBlocked(toggleGroup(toggleGroup(setup(), "claude", false), "ollama", false), caps)!, /1 model/);
  assert.match(setupBlocked(toggleDirection(toggleDirection(setup(), "Minimalist", false), "Heritage", false), caps)!, /1 direction/);
  const noMark = setup();
  assert.match(setupBlocked({ ...noMark, models: noMark.models.map((x) => ({ ...x, coordinator: false })) }, caps)!, /coordinator/);
  const many = setup({ directions: Array.from({ length: 13 }, (_, i) => ({ name: `d${i}`, on: true })) });
  assert.equal(setupCount(many).designs, 26);
  assert.match(setupBlocked(many, caps)!, /24 designs is the most .* Turn off 2\./);
});

const rec = (label: string, status: DesignRecord["status"], direction = "Minimalist", model = "x/y"): DesignRecord => ({ label, runId: "r", direction, model, modelName: "Opus", parents: [], status, route: "tool", versions: [], vision: true, workerState: "idle", createdAt: "", updatedAt: "" });

test("the card's status line counts what there is, and nothing there isn't", () => {
  assert.equal(statusCounts([rec("A", "ready"), rec("B", "ready"), rec("C", "writing"), rec("D", "failed")]), "2 ready · 1 writing · 1 failed");
  assert.equal(statusCounts([]), "0 designs");
  assert.equal(batchLine([rec("A", "ready", "M", "a"), rec("B", "ready", "H", "b")]), "2 designs · 2 directions · 2 models");
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

const call = (id: string, text = "design"): TranscriptItem => ({ id, kind: "tool-call", text, toolCallId: `c-${id}` }) as TranscriptItem;
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
  const tools = { x: { name: "design", status: "done", details: { designCard: { runId: "a" } } } } as unknown as Record<string, LiveTool>;
  assert.equal(liveDesignCalls(tools).get("a"), "x");
  const running = { x: { name: "design", status: "running", details: { designCard: { runId: "a" } } } } as unknown as Record<string, LiveTool>;
  assert.equal(liveDesignCalls(running).size, 0);
});

test("details that aren't a run are no card", () => {
  assert.equal(normalizeDesignCard({}), undefined);
  assert.equal(normalizeDesignCard({ designCard: {} }), undefined);
  assert.equal(normalizeDesignCard({ designCard: { runId: 3 } }), undefined);
  assert.deepEqual(normalizeDesignCard({ designCard: { runId: "a" } }), { runId: "a" });
});
