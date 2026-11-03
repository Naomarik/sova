// Run: pnpm test -- src/vis/kinds/flow/focus.browser.test.ts (Solid's reactive build).
// Tap to follow (§chat.markdown/vis-flow-focus), the controller FlowView wires: a tap toggles the
// pick, neighbours stay lit and the rest fades (a tap scrolls nothing), Enter/Space pick the
// shape under the keyboard's cursor, the arrow keys move and reveal it, and Escape clears the pick
// and stops only then. FlowView puts aria-pressed on a shape exactly when nodeState is "sel". The
// real page (one Tab stop for a panelled figure, the scroll, no "…") is scripts/e2e/flow-focus.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createFlowFocus } = await import("./focus");
const { parseVis } = await import("../../parse");
const { layoutFlow, placedEdgeEnds } = await import("./layout");
const { layoutSections, sectionSpec } = await import("./sections");
const { estimateWidth } = await import("../../core/text");
type FocusGraph = import("./focus").FocusGraph;
type FlowSpec = import("./parse").FlowSpec;

const LOGIN = `node start "New chat, worker\\nor overseer turn" round
node pick "Login picked by hand\\nin the composer?" decision
node handpick "That login" box ok
node proj "Project has a login?\\n(its own, else its org's)" decision
node ready "Ready here, or free\\nto borrow in the pool?" decision
node assigned "The project's login" box accent
node limit "Limit choice\\n(question 2)" decision
node order "This computer's order:\\nfirst login with room" box
node stop "Stops or waits,\\nchat says why" box warn
start -> pick
pick -> handpick "yes"
pick -> proj "no"
proj -> order "no"
proj -> ready "yes"
ready -> assigned "yes"
ready -> limit "no"
limit -> order "move on, with a note"
limit -> stop "stop or wait"`;

const spec = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.ok(r.ok);
  return r.spec as FlowSpec;
};
/** The graph FlowView builds: every drawn shape at its center, every placed edge's ends. */
function graphOf(s: FlowSpec): FocusGraph {
  const panels = s.sections ? layoutSections(s, 0, estimateWidth, () => estimateWidth).panels.map((p, i) => ({ layout: p.layout, ends: placedEdgeEnds(sectionSpec(s, i)) })) : [{ layout: layoutFlow(s), ends: placedEdgeEnds(s) }];
  return {
    shapes: panels.flatMap((p, panel) => p.layout.nodes.map((n) => ({ id: n.id, panel, x: n.x, y: n.y, shape: n.shape, down: s.dir !== "right" }))),
    edges: panels.flatMap((p) => p.ends),
  };
}
const key = (k: string) => {
  const e = { key: k, prevented: false, stopped: false, preventDefault: () => void (e.prevented = true), stopPropagation: () => void (e.stopped = true) };
  return e;
};
function mount(s: FlowSpec) {
  const revealed: string[] = [];
  let dispose!: () => void;
  const f = solid.createRoot((d) => {
    dispose = d;
    const g = solid.createMemo(() => graphOf(s));
    return createFlowFocus(g, { reveal: (id) => revealed.push(id) });
  });
  return { f, revealed, dispose };
}
const states = (f: ReturnType<typeof mount>["f"], ids: string[]) => Object.fromEntries(ids.map((id) => [id, f.nodeState(id)]));
const IDS = ["start", "pick", "handpick", "proj", "ready", "assigned", "limit", "order", "stop"];

test("a tap picks a shape: it is selected, its direct neighbours lit, the rest faded; a second tap clears it", () => {
  const { f, revealed, dispose } = mount(spec("flow", LOGIN));
  try {
    assert.equal(f.picked(), null);
    assert.equal(f.nodeState("ready"), undefined, "nothing fades while nothing is picked");
    f.toggle("ready");
    assert.equal(f.picked(), "ready");
    assert.deepEqual(revealed, [], "a tap scrolls nothing into view");
    assert.deepEqual(states(f, IDS), { start: "dim", pick: "dim", handpick: "dim", proj: "near", ready: "sel", assigned: "near", limit: "near", order: "dim", stop: "dim" });
    // aria-pressed is nodeState === "sel": exactly one shape is pressed.
    assert.deepEqual(IDS.filter((id) => f.nodeState(id) === "sel"), ["ready"]);
    assert.equal(f.edgeState({ from: "proj", to: "ready" }), "near");
    assert.equal(f.edgeState({ from: "ready", to: "limit" }), "near");
    assert.equal(f.edgeState({ from: "limit", to: "order" }), "dim", "an arrow between two neighbours isn't the picked shape's");
    f.toggle("ready");
    assert.equal(f.picked(), null, "the same shape again clears it");
    assert.equal(f.nodeState("start"), undefined);
  } finally {
    dispose();
  }
});

test("tapping another shape moves the pick and the cursor there, revealing nothing", () => {
  const { f, revealed, dispose } = mount(spec("flow", LOGIN));
  try {
    f.toggle("ready");
    f.toggle("limit");
    assert.equal(f.picked(), "limit");
    assert.equal(f.active(), "limit");
    assert.deepEqual(revealed, []);
    assert.equal(f.nodeState("ready"), "near", "the shape it came from is now a neighbour");
    assert.equal(f.nodeState("stop"), "near");
    assert.equal(f.nodeState("assigned"), "dim");
  } finally {
    dispose();
  }
});

test("Escape clears the pick and stops there; with nothing picked it passes on untouched", () => {
  const { f, dispose } = mount(spec("flow", LOGIN));
  try {
    const idle = key("Escape");
    assert.equal(f.key(idle), false);
    assert.equal(idle.stopped || idle.prevented, false, "the side pane's Escape still runs");
    f.toggle("proj");
    const esc = key("Escape");
    assert.equal(f.key(esc), true);
    assert.equal(esc.stopped && esc.prevented, true, "nothing else on the screen closes");
    assert.equal(f.picked(), null);
  } finally {
    dispose();
  }
});

test("keyboard: focus puts the cursor on the first shape; arrows move and reveal it; Enter and Space pick and clear", () => {
  const { f, revealed, dispose } = mount(spec("flow", LOGIN));
  try {
    f.focused();
    assert.equal(f.active(), "start", "the first shape in reading order");
    const down = key("ArrowDown");
    assert.equal(f.key(down), true);
    assert.equal(down.prevented, true, "the page doesn't scroll instead");
    assert.equal(f.active(), "pick");
    assert.deepEqual(revealed, ["pick"]);
    const enter = key("Enter");
    f.key(enter);
    assert.equal(f.picked(), "pick");
    assert.equal(enter.prevented, true);
    f.key(key("ArrowDown"));
    const moved = f.active()!;
    assert.ok(moved === "handpick" || moved === "proj", moved);
    assert.equal(f.picked(), "pick", "moving the cursor leaves the pick");
    f.key(key(" "));
    assert.equal(f.picked(), moved, "Space picks the shape under the cursor");
    f.key(key(" "));
    assert.equal(f.picked(), null, "and again clears it");
    f.key(key("End"));
    f.key(key("Home"));
    assert.equal(f.active(), "start");
    assert.equal(f.key(key("a")), false, "other keys are left alone");
    f.toggle("ready");
    f.clear();
    f.focused();
    assert.equal(f.active(), "ready", "refocusing keeps the cursor where it was");
  } finally {
    dispose();
  }
});

test("a wide flow: ArrowRight walks the shapes left to right, revealing each so its box scrolls to it", () => {
  const { f, revealed, dispose } = mount(spec("flow", "dir: right\na -> b -> c -> d -> e -> f -> g -> h"));
  try {
    f.focused();
    for (let i = 0; i < 7; i++) f.key(key("ArrowRight"));
    assert.deepEqual(revealed, ["b", "c", "d", "e", "f", "g", "h"]);
    f.key(key("ArrowRight"));
    assert.equal(f.active(), "h", "the last one stays");
  } finally {
    dispose();
  }
});

test("a figure with panels has one pick: picking in one panel clears the other's; arrows cross panels", () => {
  const s = spec("flow", "== Before ==\na -> b\n== After ==\na -> c -> b");
  const { f, dispose } = mount(s);
  try {
    f.toggle("a");
    assert.equal(f.nodeState("b"), "near");
    assert.equal(f.nodeState("a@2"), "dim", "the other panel's a is another shape");
    f.toggle("c");
    assert.equal(f.picked(), "c");
    assert.equal(f.nodeState("a"), "dim", "the first panel's pick is gone");
    f.focused();
    f.key(key("Home"));
    f.key(key("ArrowDown"));
    f.key(key("ArrowDown"));
    assert.equal(f.active(), "a@2", "past the first panel's last shape, the next panel's first");
  } finally {
    dispose();
  }
});
