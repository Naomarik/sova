import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth, widest } from "../../core/text";
import { FLOW_FONT, estimateHeight, fitFlow, layoutFlow, scrolledHeight, type FlowLayout } from "./layout";
import { parseFlow, parseState, type FlowSpec } from "./parse";

const flow = (body: string): FlowSpec => parseFlow(body);
const byId = (l: FlowLayout, id: string) => l.nodes.find((n) => n.id === id)!;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

test("a chain goes down in declaration order; right swaps the axes", () => {
  const down = layoutFlow(flow("a -> b -> c"));
  assert.ok(byId(down, "a").y < byId(down, "b").y && byId(down, "b").y < byId(down, "c").y);
  assert.equal(Math.round(byId(down, "a").x), Math.round(byId(down, "c").x), "a straight chain stays straight");
  const right = layoutFlow(flow("dir: right\na -> b -> c"));
  assert.ok(byId(right, "a").x < byId(right, "b").x && byId(right, "b").x < byId(right, "c").x);
});

test("nothing overlaps: boxes with boxes, labels with boxes and labels", () => {
  const l = layoutFlow(
    flow(`a -> b "first label"
a -> c "second label"
a -> d "third, a longer label here"
b -> e
c -> e "joins"
d -> e
e -> a "loops back"
e -> e "self"`),
  );
  const boxes = [...l.nodes, ...l.edges.flatMap((e) => (e.label ? [e.label] : []))];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!), `overlap ${JSON.stringify(boxes[i])} ${JSON.stringify(boxes[j])}`);
  for (const b of boxes) {
    assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= l.width, "inside the width");
    assert.ok(b.y - b.h / 2 >= 0 && b.y + b.h / 2 <= l.height, "inside the height");
  }
  assert.equal(l.edges.length, 8);
});

test("a cycle still ranks: the back edge's target stays above", () => {
  const l = layoutFlow(flow("idle -> busy -> idle"));
  assert.ok(byId(l, "idle").y < byId(l, "busy").y);
});

test("a crossing that ordering can remove is removed", () => {
  // Declared crossed: a→y, b→x with x declared before y.
  const l = layoutFlow(flow("node x\nnode y\na -> y\nb -> x"));
  const [a, b, x, y] = ["a", "b", "x", "y"].map((id) => byId(l, id));
  assert.equal(Math.sign(a!.x - b!.x), Math.sign(y!.x - x!.x));
});

test("deterministic", () => {
  const body = "a -> b\na -> c\nb -> d\nc -> d\nd -> a";
  assert.deepEqual(layoutFlow(flow(body)), layoutFlow(flow(body)));
});

test("a decision diamond holds its text box: tw/w + th/h <= 1", () => {
  for (const label of ["Ok?", "Reply streamed?", "Is the cache warm and the lock free?"]) {
    const l = layoutFlow(flow(`node d "${label}" decision\na -> d`));
    const d = byId(l, "d");
    const tw = widest(d.lines, FLOW_FONT.label);
    const th = d.lines.length * 17;
    assert.ok(tw / d.w + th / d.h <= 1, `${label}: ${tw}x${th} in ${d.w}x${d.h}`);
    assert.ok(d.w < 2 * tw + 16 || tw < 40, "narrower than the old 2x rule");
  }
});

test("an end state sinks to the last rank; a start stays on top", () => {
  const l = layoutFlow(parseState("node s0 start\nnode done end\ns0 -> a -> b -> c -> d\na -> done"));
  const ys = l.nodes.map((n) => n.y);
  assert.equal(byId(l, "done").y, Math.max(...ys));
  assert.equal(byId(l, "s0").y, Math.min(...ys));
});

test("each compact level is narrower and still overlap-free and in bounds", () => {
  const spec = flow(`node gw "API gateway"
gw -> auth "verify"
gw -> users
gw -> orders
gw -> search "query"
gw -> billing
auth -> db
orders -> queue
billing -> queue`);
  const roomy = layoutFlow(spec);
  const compact = layoutFlow(spec, undefined, 1);
  const tight = layoutFlow(spec, undefined, 2);
  assert.ok(compact.width < roomy.width && tight.width < compact.width, `${tight.width} < ${compact.width} < ${roomy.width}`);
  const boxes = [...tight.nodes, ...tight.edges.flatMap((e) => (e.label ? [e.label] : []))];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!));
  for (const b of boxes) assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= tight.width);
});

test("edge labels wrap, never truncate, and a long edge's label leaves the busiest rank", () => {
  const spec = parseState(`node s0 start
s0 -> queued "enqueue"
queued -> running "claimed (lease)"
running -> done "ok"
running -> retry "retryable error / lease expired"
retry -> queued "run_at reached"
running -> dead "fatal error / attempts exhausted"
queued -> cancelled "cancel"
retry -> cancelled "cancel"
running -> cancelled "cancel acknowledged"`);
  for (const level of [0, 1, 2]) {
    const l = layoutFlow(spec, undefined, level);
    for (const e of l.edges) if (e.label) assert.ok(!e.label.lines.join(" ").includes("…"), `level ${level}: ${e.label.lines.join(" / ")}`);
    const words = l.edges.flatMap((e) => e.label?.lines ?? []).join(" ");
    assert.match(words, /acknowledged/, "a word is never split");
  }
  // queued -> cancelled spans three ranks; its label sits apart from running's four.
  const l = layoutFlow(spec);
  const ys = (text: string) => l.edges.find((e) => e.label?.lines.join(" ") === text)!.label!.y;
  const cancelYs = l.edges.filter((e) => e.label?.lines.join(" ") === "cancel").map((e) => e.label!.y);
  assert.ok(cancelYs.every((y) => y !== ys("ok")), "neither cancel label crowds running's rank");
});

test("scrolledHeight: natural size, then shrinking with the pane to 80%, then scrolling at that size", () => {
  const l = { width: 500, height: 200 };
  assert.equal(scrolledHeight(l, 0), 200, "unmeasured: natural");
  assert.equal(scrolledHeight(l, 800), 200, "a wider pane never enlarges it");
  assert.equal(scrolledHeight(l, 450), 180);
  assert.equal(scrolledHeight(l, 400), 160, "80%");
  assert.equal(scrolledHeight(l, 300), 160, "past 80% it scrolls, keeping that height");
});

test("estimateHeight is the chosen layout's height at SvgScroll's size, sane over phone to desktop widths", () => {
  const specs = [
    flow(`node gw "API gateway"\ngw -> auth "verify"\ngw -> users\ngw -> orders\ngw -> search "query"\ngw -> billing\nauth -> db\norders -> queue`),
    flow(`dir: right\nnode ok "Green?" decision\nsrc -> lint -> test -> ok\nsrc -> build -> ok\nok -> ship "yes"\nok --> src "no"`),
    parseState("node s0 start\nnode done end\ns0 -> idle\nidle -> busy \"prompt\"\nbusy -> idle \"settled\"\nbusy -> done"),
  ];
  for (const spec of specs) {
    const natural = layoutFlow(spec);
    for (let w = 296; w <= 900; w += 26) {
      const h = estimateHeight(spec, w);
      // Node has no canvas: canvasMeasure falls back to estimateWidth, the measure used here.
      assert.equal(h, scrolledHeight(fitFlow(spec, estimateWidth, w), w), `w=${w}`);
      assert.equal(h, estimateHeight(spec, w), "deterministic");
      assert.ok(Number.isFinite(h) && h > 0 && h < 4 * natural.height, `w=${w}: ${h}`);
      if (w >= natural.width) assert.equal(h, natural.height, "a pane that holds it gets the natural drawing");
    }
  }
});
