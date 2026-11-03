import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth, widest } from "../../core/text";
import { parseVis } from "../../parse";
import { FLOW_FONT, FLOW_LEVELS, HEX_INSET, estimateHeight, fitFlow, layoutFlow, placedEdgeEnds, scrolledHeight, type FlowLayout } from "./layout";
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

test("a decision hexagon holds its text box in its flat part, at every spacing level", () => {
  const labels = ["Ok?", "Reply streamed?", "Project has a login? (its own, else its org's)", "Is the cache warm and the lock free, and has the lease not expired yet while the worker still holds it?"];
  for (const label of labels)
    for (let level = 0; level < FLOW_LEVELS; level++) {
      const l = layoutFlow(flow(`node d "${label}" decision\na -> d`), undefined, level);
      const d = byId(l, "d");
      const tw = widest(d.lines, FLOW_FONT.label);
      const th = d.lines.length * 17;
      assert.ok(tw <= d.w - 2 * HEX_INSET, `${label} @${level}: ${tw} wide in ${d.w} - 2×${HEX_INSET}`);
      assert.ok(th <= d.h - 2 * 7, `${label} @${level}: ${th} tall in ${d.h}`);
      assert.equal(d.lines.join(" "), label, "its whole text, wrapped, nothing cut");
    }
  // About as wide as a box with the same text, and far shorter than a diamond would be.
  const both = layoutFlow(flow('node d "Project has a login? (its own, else its org\'s)" decision\nnode b "Project has a login? (its own, else its org\'s)"\nd -> b'));
  assert.ok(byId(both, "d").w - byId(both, "b").w <= 2 * HEX_INSET + 0.01);
  assert.equal(byId(both, "d").h, byId(both, "b").h);
});

/** The last point of an SVG path (where its arrowhead is) and its first. */
const ends = (d: string) => {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  return { start: { x: n[0]!, y: n[1]! }, end: { x: n[n.length - 2]!, y: n[n.length - 1]! } };
};

test("arrows meet a hexagon's outline: its flat top and bottom downwards, its pointed sides in dir: right", () => {
  const body = 'a "Start here" -> d "Ready here, or free to borrow in the pool?" decision -> b "The project\'s login"';
  for (let level = 0; level < FLOW_LEVELS; level++) {
    const down = layoutFlow(flow(body), undefined, level);
    const d = byId(down, "d");
    const [into, out] = down.edges.map((e) => ends(e.path));
    assert.ok(Math.abs(into!.end.y - (d.y - d.h / 2)) < 0.11, `down @${level}: into the flat top (${into!.end.y} vs ${d.y - d.h / 2})`);
    assert.ok(Math.abs(out!.start.y - (d.y + d.h / 2)) < 0.11, `down @${level}: out of the flat bottom`);
    const right = layoutFlow(flow(`dir: right\n${body}`), undefined, level);
    const r = byId(right, "d");
    const [rin, rout] = right.edges.map((e) => ends(e.path));
    // A single edge each way meets the point itself, at the hexagon's mid-height.
    assert.ok(Math.abs(rin!.end.y - r.y) < 0.11 && Math.abs(rin!.end.x - (r.x - r.w / 2)) < 0.11, `right @${level}: into the left point (${rin!.end.x},${rin!.end.y})`);
    assert.ok(Math.abs(rout!.start.x - (r.x + r.w / 2)) < 0.11, `right @${level}: out of the right point`);
  }
  // Fanned edges off the middle meet the sloping sides, inside the shape's box.
  const fan = layoutFlow(flow('dir: right\nnode d "Which one of these three should run first?" decision\nd -> x\nd -> y\nd -> z'));
  const d = byId(fan, "d");
  assert.ok(fan.edges.some((e) => Math.abs(ends(e.path).start.y - d.y) > 1), "some leave off the point");
  for (const e of fan.edges) {
    const s = ends(e.path).start;
    const dy = Math.abs(s.y - d.y);
    assert.ok(Math.abs(s.x - (d.x + d.w / 2 - HEX_INSET * (dy / (d.h / 2)))) < 0.11, `on the slope at dy=${dy}`);
  }
});

const LOGIN = `title: Which login new work in a project starts on
node start "New chat, worker\\nor overseer turn" round
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
limit -> stop "stop or wait"
mark assigned "new: chosen on the project or organization Settings tab"
mark limit "your call in question 2"`;

/** Every text a placed flow draws, as lines. */
const drawn = (l: FlowLayout) => [...l.nodes.flatMap((n) => [...n.lines, ...n.noteLines]), ...l.edges.flatMap((e) => e.label?.lines ?? []), ...(l.groups ?? []).flatMap((g) => g.titleLines)];

test("nothing on a flow is cut: no line ends in '…' at any spacing level or phone width, and every word is drawn", () => {
  const long = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ").slice(0, 200);
  const bodies = [
    LOGIN,
    `node d "${long(40, "why")}" decision\nnode b "${long(40, "step")}" "${long(40, "note")}"\nd -> b "${long(40, "edge")}"\nb -> b "${long(30, "loop")}"\nd -> c "${"x".repeat(200)}"`,
    `dir: right\nnode d "${long(40, "why")}" decision\na -> d -> b "${long(40, "edge")}"\nb -> c\ngroup "${long(30, "frame")}" b`,
  ];
  for (const body of bodies) {
    const r = parseVis("flow", body);
    assert.ok(r.ok, body);
    const spec = r.spec as FlowSpec;
    const layouts = [...Array.from({ length: FLOW_LEVELS }, (_, level) => layoutFlow(spec, estimateWidth, level)), ...[300, 340, 390, 700].map((w) => fitFlow(spec, estimateWidth, w))];
    for (const l of layouts) {
      for (const line of drawn(l)) assert.ok(!line.endsWith("…"), `cut: "${line}"`);
      const all = drawn(l).join(" ").replace(/\s+/g, "");
      for (const n of spec.nodes) {
        if (n.shape === "start" || n.shape === "end") continue;
        assert.ok(all.includes(n.label.replace(/\s+/g, "")), `${n.id}'s whole label is drawn`);
        if (n.note) assert.ok(all.includes(n.note.replace(/\s+/g, "")), `${n.id}'s whole note is drawn`);
      }
      for (const e of spec.edges) if (e.label) assert.ok(all.includes(e.label.replace(/\s+/g, "")), `edge label "${e.label}" drawn whole`);
      for (const g of spec.groups ?? []) assert.ok(all.includes(g.label.replace(/\s+/g, "")), `frame title drawn whole`);
      // Tall hexagons and boxes still never overlap one another or a label.
      const boxes = [...l.nodes, ...l.edges.flatMap((e) => (e.label ? [e.label] : []))];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!), `overlap ${JSON.stringify(boxes[i])} ${JSON.stringify(boxes[j])}`);
    }
  }
  // The case that was cut on a desktop: the question is whole at natural size.
  const login = parseVis("flow", LOGIN);
  assert.ok(login.ok);
  const proj = byId(layoutFlow(login.spec as FlowSpec), "proj");
  assert.deepEqual(proj.lines, ["Project has a login?", "(its own, else its org's)"]);
});

test("placedEdgeEnds names each placed edge's ends, in the layout's order (self-loops last)", () => {
  const spec = flow('a -> b "x"\nb -> b "again"\nb -> c\nc -> a');
  const l = layoutFlow(spec);
  const e = placedEdgeEnds(spec);
  assert.equal(e.length, l.edges.length);
  assert.deepEqual(e.map((x) => `${x.from}>${x.to}`), ["a>b", "b>c", "c>a", "b>b"]);
  assert.deepEqual(l.edges.map((x) => x.label?.lines.join(" ")), ["x", undefined, undefined, "again"]);
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
