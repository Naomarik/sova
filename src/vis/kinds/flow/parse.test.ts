import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { FlowSpec } from "./parse";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as T;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("flow: nodes, chains, labels, dashed and two-way edges, auto nodes", () => {
  const s = ok<FlowSpec>(
    "flow",
    `title: How a prompt travels
dir: right
# a comment line
node web "Browser tab" "Solid app" round accent
node srv "Hono server" store
web -> srv "WS /ws/chat" --> sdk   # trailing comment
sdk <-> disk`,
  );
  assert.equal(s.title, "How a prompt travels");
  assert.equal(s.dir, "right");
  assert.deepEqual(
    s.nodes.map((n) => [n.id, n.label, n.shape, n.tone ?? null, n.note ?? null]),
    [
      ["web", "Browser tab", "round", "accent", "Solid app"],
      ["srv", "Hono server", "store", null, null],
      ["sdk", "sdk", "box", null, null],
      ["disk", "disk", "box", null, null],
    ],
  );
  assert.deepEqual(s.edges, [
    { from: "web", to: "srv", label: "WS /ws/chat", dashed: false, both: false },
    { from: "srv", to: "sdk", dashed: true, both: false },
    { from: "sdk", to: "disk", dashed: false, both: true },
  ]);
});

test("flow: arrows need no spaces around them, and ids may hold hyphens", () => {
  const s = ok<FlowSpec>("flow", "a-b->c-->d");
  assert.deepEqual(s.edges.map((e) => [e.from, e.to, e.dashed]), [["a-b", "c", false], ["c", "d", true]]);
});

test("state: nodes default to round", () => {
  const s = ok<FlowSpec>("state", "node s0 start\ns0 -> idle\nidle -> busy \"prompt\"\nbusy -> idle \"settled\"");
  assert.equal(s.nodes.find((n) => n.id === "idle")!.shape, "round");
  assert.equal(s.nodes.find((n) => n.id === "s0")!.shape, "start");
});

test("flow errors point at the line and say what to write", () => {
  assert.deepEqual([err("flow", 'a -> b\nA["Label"] --> b').line], [2]);
  assert.match(err("flow", 'a["x"] -> b').message, /node <id> "Label"/);
  assert.match(err("flow", 'a "Label" -> b').message, /node a "Label"/);
  assert.match(err("flow", "node a sparkly").message, /unknown word "sparkly"/);
  assert.match(err("flow", "direction: down\na -> b").message, /unknown setting "direction:"/);
  assert.match(err("flow", "dir: up\na -> b").message, /down or right/);
  assert.match(err("flow", "node a\nnode a").message, /declared twice/);
  assert.match(err("flow", 'node a "unclosed').message, /unclosed quote/);
  assert.match(err("flow", "a -> ").message, /target id/);
  assert.match(err("flow", "").message, /nothing to draw/);
});

test("flow: mark a node by id or label", () => {
  const r = parseVis("flow", 'node srv "Sova server"\na -> srv\nmark srv "bottleneck"\nmark "a" muted');
  assert.ok(r.ok);
  assert.deepEqual((r.spec as FlowSpec).emphasis, [{ key: "srv", tone: "accent", note: "bottleneck", n: 1 }, { key: "a", tone: "muted" }]);
  assert.match(err("flow", "a -> b\nmark c").message, /no node c/);
});

test("flow: a tone after an edge's target colours that node", () => {
  const tone = (s: FlowSpec, nid: string) => s.nodes.find((n) => n.id === nid)?.tone;
  const labelled = ok<FlowSpec>("flow", 'a -> b "go" warn');
  assert.equal(tone(labelled, "b"), "warn");
  assert.equal(labelled.edges[0]!.label, "go");
  assert.equal(tone(ok<FlowSpec>("state", "a -> b ok -> c"), "b"), "ok");
  // The fence a live model wrote.
  const s = ok<FlowSpec>("flow", 'toggle -> newhead "<mode> head rewritten" -> miss "cache prefix dead" error -> resend "re-send"');
  assert.equal(tone(s, "miss"), "error");
  assert.equal(tone(s, "newhead"), undefined);
  assert.deepEqual(s.edges.map((e) => e.label), ["<mode> head rewritten", "cache prefix dead", "re-send"]);
  assert.equal(s.nodes.find((n) => n.id === "miss")!.label, "miss");
  // Agrees with the node line: fine, in either order. Disagrees: an error naming both.
  assert.equal(tone(ok<FlowSpec>("flow", 'node b "B" error\na -> b error'), "b"), "error");
  assert.match(err("flow", 'node b "B" ok\na -> b error').message, /node b is toned ok on its node line and error/);
  assert.match(err("flow", 'a -> b error\nnode b "B" ok').message, /node b is toned ok on its node line and error/);
  assert.match(err("flow", "a -> b error\nc -> b ok").message, /node b is toned error and ok/);
  assert.match(err("flow", 'a -> b "x" loud').message, /unexpected loud after b/);
  assert.match(err("flow", "a -> b error extra").message, /unexpected extra after b/);
  const sec = ok<FlowSpec>("flow", "== A ==\na -> b warn\n== B ==\nc -> d");
  assert.equal(sec.sections![0]!.nodes.find((n) => n.id === "b")!.tone, "warn");
});
