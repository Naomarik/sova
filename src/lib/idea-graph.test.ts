// Run: npx tsx --test src/lib/idea-graph.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph, neighbours, type GraphEdge, type GraphNode } from "./idea-graph";

const box = { width: 400, height: 300, pad: 20 };

const nodes: GraphNode[] = [
  { id: "§mesh/retry-backoff", group: "mesh" },
  { id: "§mesh.retry/jitter", group: "mesh" },
  { id: "§mesh/health", group: "mesh" },
  { id: "§sova/ideas-panel", group: "sova" },
  { id: "§sova/graph", group: "sova" },
];
const edges: GraphEdge[] = [
  { from: "§mesh/retry-backoff", to: "§mesh.retry/jitter" },
  { from: "§sova/ideas-panel", to: "§sova/graph" },
  { from: "§sova/graph", to: "§mesh/health" },
];

test("every node lands inside the padded box, with finite coordinates", () => {
  const g = layoutGraph(nodes, edges, box);
  assert.equal(g.nodes.length, nodes.length);
  for (const n of g.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has finite coordinates`);
    assert.ok(n.x >= 20 && n.x <= 380, `${n.id} x=${n.x} inside`);
    assert.ok(n.y >= 20 && n.y <= 280, `${n.id} y=${n.y} inside`);
  }
});

test("the same ideas in another order draw the same picture", () => {
  const a = layoutGraph(nodes, edges, box);
  const b = layoutGraph([...nodes].reverse(), [...edges].reverse(), box);
  const at = (g: typeof a) => Object.fromEntries(g.nodes.map((n) => [n.id, [n.x, n.y]]));
  assert.deepEqual(at(a), at(b));
});

test("no two nodes coincide, even when every one seeds at the same spot", () => {
  const same = Array.from({ length: 6 }, (_, i) => ({ id: `§x/${i}`, group: "x" }));
  const g = layoutGraph(same, [], box);
  const keys = new Set(g.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
  assert.equal(keys.size, same.length);
});

test("linked ideas sit closer together than the average pair", () => {
  const g = layoutGraph(nodes, edges, box);
  const at = new Map(g.nodes.map((n) => [n.id, n]));
  const dist = (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
  const all: number[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) all.push(dist(nodes[i]!.id, nodes[j]!.id));
  const mean = all.reduce((s, d) => s + d, 0) / all.length;
  for (const e of edges) assert.ok(dist(e.from, e.to) < mean, `${e.from} → ${e.to} is ${dist(e.from, e.to)}, mean ${mean}`);
});

test("a link to an idea not on the graph is dangling, never drawn", () => {
  const g = layoutGraph(nodes, [...edges, { from: "§sova/graph", to: "§nowhere/missing" }], box);
  assert.deepEqual(g.dangling, [{ from: "§sova/graph", to: "§nowhere/missing" }]);
  assert.equal(g.edges.length, edges.length);
});

test("a self-link and a reverse duplicate draw nothing extra", () => {
  const g = layoutGraph(nodes, [...edges, { from: "§mesh/health", to: "§mesh/health" }, { from: "§mesh.retry/jitter", to: "§mesh/retry-backoff" }], box);
  assert.equal(g.edges.length, edges.length);
});

test("edges start and end on their nodes", () => {
  const g = layoutGraph(nodes, edges, box);
  const at = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    assert.deepEqual([e.x1, e.y1], [at.get(e.from)!.x, at.get(e.from)!.y]);
    assert.deepEqual([e.x2, e.y2], [at.get(e.to)!.x, at.get(e.to)!.y]);
  }
});

test("empty and single-node graphs are fine", () => {
  assert.deepEqual(layoutGraph([], [], box).nodes, []);
  const one = layoutGraph([{ id: "§a/b", group: "a" }], [], box);
  assert.deepEqual([one.nodes[0]!.x, one.nodes[0]!.y], [200, 150]);
});

test("neighbours: the node, what it links to, and what links to it", () => {
  assert.deepEqual([...neighbours("§sova/graph", edges)].sort(), ["§mesh/health", "§sova/graph", "§sova/ideas-panel"]);
  assert.deepEqual([...neighbours("§lonely/one", edges)], ["§lonely/one"]);
});
