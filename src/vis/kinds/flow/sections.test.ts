import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth } from "../../core/text";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight, fitFlow, layoutFlow, scrolledHeight } from "./layout";
import type { FlowSpec } from "./parse";
import { layoutSections, SECTION_CSS, sectionsHeight } from "./sections";

const ok = (body: string, kind = "flow"): FlowSpec => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as FlowSpec;
};
const err = (body: string, kind = "flow") => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

const LINK = `title: Today vs with a claim→test link
== Today ==
node a1 "Agent edits code"
node g1 "Green build"
node c1 "Claim prose" "nothing checks it" muted
a1 -> g1 "npm test"
== With the link ==
node a2 "Agent edits :191"
node g2 "Test :191 fails"
node c2 "Claim flagged" warn
a2 -> g2 "npm test" -> c2
mark c2 "the edit points at the claim"
mark "Green build" ok`;

test("flow sections: panels hold their own nodes and edges; marks reach any panel", () => {
  const s = ok(LINK);
  assert.deepEqual(s.sections!.map((p) => [p.label, p.nodes.map((n) => n.id), p.edges.map((e) => `${e.from}>${e.to}`)]), [
    ["Today", ["a1", "g1", "c1"], ["a1>g1"]],
    ["With the link", ["a2", "g2", "c2"], ["a2>g2", "g2>c2"]],
  ]);
  // The fence-wide lists still hold everything.
  assert.equal(s.nodes.length, 6);
  assert.equal(s.edges.length, 3);
  assert.deepEqual(s.emphasis!.map((e) => [e.key, e.tone]), [["c2", "accent"], ["g1", "ok"]]);
  // Undeclared ids belong to the section that first uses them.
  const auto = ok("== A ==\nx -> y\n== B ==\np -> q");
  assert.deepEqual(auto.sections!.map((p) => p.nodes.map((n) => n.id)), [["x", "y"], ["p", "q"]]);
  // state takes sections too.
  const st = ok("== Before ==\nnode s0 start\ns0 -> idle\n== After ==\nnode s1 start\ns1 -> ready", "state");
  assert.equal(st.sections!.length, 2);
  assert.equal(st.sections![1]!.nodes[1]!.shape, "round");
});

test("flow sections: ids are local to their panel; the same id in two panels is two nodes", () => {
  // What a model wrote for a before/after: `toggle` in both panels, an edge to it in the second.
  const s = ok('== Before ==\ntoggle -> mode\n== After ==\nnode toggle "Toggle" accent\ntoggle -> note\nmark toggle "here"');
  assert.deepEqual(s.sections!.map((p) => [p.nodes.map((n) => [n.id, n.label, n.tone ?? null]), p.edges.map((e) => `${e.from}>${e.to}`)]), [
    [[["toggle", "toggle", null], ["mode", "mode", null]], ["toggle>mode"]],
    [[["toggle@2", "Toggle", "accent"], ["note", "note", null]], ["toggle@2>note"]],
  ]);
  // A mark resolves in the first panel that has the id.
  assert.deepEqual(s.emphasis, [{ key: "toggle", tone: "accent", note: "here", n: 1 }]);
  // An id seen in a panel keeps its key there, used or declared in any order.
  const again = ok('== A ==\na -> b\n== B ==\nb -> a\nnode a "Again"\n== C ==\na -> c');
  assert.deepEqual(again.sections!.map((p) => p.nodes.map((n) => `${n.id}=${n.label}`)), [["a=a", "b=b"], ["a@2=Again", "b@2=b"], ["a@3=a", "c=c"]]);
  assert.deepEqual(again.sections![1]!.edges.map((e) => `${e.from}>${e.to}`), ["b@2>a@2"]);
  // A flow without sections is one scope, as before.
  assert.match(err("node a\nnode a round").message, /declared twice/);
  assert.match(err("== A ==\nnode a\nnode a warn").message, /declared twice/);
});

test("flow sections: misuse is an error", () => {
  assert.match(err("node x\n== A ==\na -> b").message, /under a == section == line/);
  assert.match(err("== A ==\na -> b\n== B ==").message, /section "B" is empty/);
  assert.match(err("== A ==\na -> b\n== A ==\nc -> d").message, /section "A" appears twice/);
  assert.match(err("== ==\na -> b").message, /needs a label/);
  assert.match(err(Array.from({ length: 5 }, (_, i) => `== S${i} ==\nnode n${i}`).join("\n")).message, /5 sections; at most 4/);
  const dropped = parseVis("flow", "== A ==\na -> b\nmark zz");
  assert.ok(dropped.ok && /no node zz, dropped/.test(dropped.warnings[0]!.message), "a mark naming nothing is dropped, not an error");
  // What two live models wrote: a tone after an edge's target now colours that node (see parse.test.ts).
  assert.equal(ok('a -> miss "cache prefix dead" error -> resend').nodes.find((n) => n.id === "miss")!.tone, "error");
});

test("flow without sections parses exactly as before", () => {
  const s = ok('dir: right\nnode web "Browser" round\nweb -> srv "ws" --> sdk\nmark srv');
  assert.equal(s.sections, undefined);
  assert.deepEqual(Object.keys(s).sort(), ["dir", "edges", "emphasis", "kind", "nodes"]);
  // The same drawing and height as a spec that never had the field.
  assert.deepEqual(layoutFlow(s, estimateWidth), layoutFlow({ ...s }, estimateWidth));
});

test("flow sections: side by side when they fit, stacked when they don't; heights add up", () => {
  const s = ok(LINK);
  const head = unweighted((t, px) => t.length * px * 0.6);
  const natural = s.sections!.map((p) => layoutFlow({ kind: "flow", dir: s.dir, nodes: p.nodes, edges: p.edges }, estimateWidth));
  const wide = natural.reduce((a, l) => a + l.width, 0) + SECTION_CSS.gapRow;
  const row = layoutSections(s, wide + 50, estimateWidth, head);
  assert.equal(row.row, true);
  assert.deepEqual(row.panels.map((p) => p.layout), natural);
  // Side by side: the tallest panel, plus a one-line head.
  assert.equal(sectionsHeight(s, wide + 50, estimateWidth, head), Math.max(...natural.map((l) => l.height)) + SECTION_CSS.line + SECTION_CSS.below);
  // A phone: stacked, each panel fitted to the full width as a lone flow would be.
  const col = layoutSections(s, 358, estimateWidth, head);
  assert.equal(col.row, false);
  col.panels.forEach((p, i) => {
    const one: FlowSpec = { kind: "flow", dir: s.dir, nodes: s.sections![i]!.nodes, edges: s.sections![i]!.edges };
    assert.deepEqual(p.layout, fitFlow(one, estimateWidth, 358));
  });
  const stacked = col.panels.reduce((a, p) => a + scrolledHeight(p.layout, 358) + SECTION_CSS.line + SECTION_CSS.below, 0) + SECTION_CSS.gapColumn;
  assert.equal(sectionsHeight(s, 358, estimateWidth, head), stacked);
  // The kind's estimate goes through the sections.
  assert.ok(estimateHeight(s, 358) > estimateHeight(s, 1200));
});
