import assert from "node:assert/strict";
import { test } from "node:test";
import { widest } from "../../core/text";
import { FLOW_FONT, layoutFlow, type FlowLayout } from "./layout";
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

test("compact is narrower and still overlap-free and in bounds", () => {
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
  const tight = layoutFlow(spec, undefined, true);
  assert.ok(tight.width < roomy.width, `${tight.width} < ${roomy.width}`);
  const boxes = [...tight.nodes, ...tight.edges.flatMap((e) => (e.label ? [e.label] : []))];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!));
  for (const b of boxes) assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= tight.width);
});
