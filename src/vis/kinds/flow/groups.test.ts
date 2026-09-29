// `group "Label" a b c` in vis flow / vis state: frames around some nodes of one connected graph.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { estimateWidth } from "../../core/text";
import { FLOW_LEVELS, fitFlow, layoutFlow, type FlowLayout } from "./layout";
import type { FlowSpec } from "./parse";
import { layoutSections } from "./sections";

const ok = (kind: string, body: string): FlowSpec => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  assert.deepEqual(r.warnings, [], `no warnings for:\n${body}`);
  return r.spec as FlowSpec;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("group: a label then ids (commas allowed), before or after the chains; frame/subgraph/cluster read the same", () => {
  const s = ok("flow", 'group "Server" srv, sdk\nweb "Browser" -> srv "Hono" -> sdk "pi"\nsdk -> disk "JSONL" store\ncluster "Disk" disk');
  assert.deepEqual(s.groups, [{ label: "Server", nodes: ["srv", "sdk"] }, { label: "Disk", nodes: ["disk"] }]);
  for (const word of ["frame", "subgraph", "cluster"]) assert.deepEqual(ok("flow", `a -> b\n${word} "G" a`).groups, [{ label: "G", nodes: ["a"] }]);
  // Group lines don't make a fence inline-style: here a string after a target is still the edge's label.
  const plain = ok("flow", 'idle -> busy "prompt"\ngroup "Work" busy');
  assert.equal(plain.edges[0]!.label, "prompt");
  assert.equal(plain.nodes.find((n) => n.id === "busy")!.label, "busy");
  assert.deepEqual(ok("state", 'node s0 start\ns0 -> idle\nidle -> busy\ngroup "Running" busy').groups, [{ label: "Running", nodes: ["busy"] }]);
});

test("group: a node called group or frame in a chain is still a chain", () => {
  const s = ok("flow", 'frame -> group\ngroup -> x "go"');
  assert.equal(s.groups, undefined);
  assert.deepEqual(s.nodes.map((n) => n.id), ["frame", "group", "x"]);
});

test("group errors: unknown id, a node in two groups, no ids, junk after the label, more than 6, before the first section", () => {
  assert.match(err("flow", 'a -> b\ngroup "G" a zz').message, /group "G": no node zz/);
  assert.match(err("flow", 'a -> b\ngroup "G" a\ngroup "H" a b').message, /node a is in group "G" and "H"/);
  assert.match(err("flow", 'a -> b\ngroup "G"').message, /names no nodes/);
  assert.match(err("flow", 'a -> b\ngroup "G" a "b"').message, /only node ids/);
  const seven = Array.from({ length: 7 }, (_, i) => `group "G${i}" n${i}`).join("\n");
  const e = err("flow", `${Array.from({ length: 7 }, (_, i) => `n${i} -> m${i}`).join("\n")}\n${seven}`);
  assert.match(e.message, /7 groups; at most 6/);
  assert.equal(e.line, 14);
  assert.match(err("flow", '== A ==\na -> b\n== B ==\na -> c\ngroup "G" c b').message, /no node b in this section/);
});

test("group in panels: each panel's groups name its own ids, and its drawing carries its frames", () => {
  const s = ok("flow", '== Before ==\na -> b -> c\ngroup "One" a b\n== After ==\na -> c\ngroup "Two" a');
  assert.deepEqual(s.sections!.map((p) => p.groups), [[{ label: "One", nodes: ["a", "b"] }], [{ label: "Two", nodes: ["a@2"] }]]);
  const l = layoutSections(s, 0, estimateWidth, () => estimateWidth);
  assert.deepEqual(l.panels.map((p) => p.layout.groups?.map((g) => g.label)), [["One"], ["Two"]]);
});

type Box = { x: number; y: number; w: number; h: number };
const meets = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
const nodeBox = (n: { x: number; y: number; w: number; h: number }): Box => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h });
/** No non-member box meets a frame; every member is inside its frame; frames are disjoint; all inside the drawing. */
function invariants(spec: FlowSpec, l: FlowLayout, what: string) {
  const groups = spec.groups ?? [];
  assert.equal(l.groups?.length ?? 0, groups.length, `${what}: one frame per group`);
  groups.forEach((g, gi) => {
    const f = l.groups![gi]!;
    const members = new Set(g.nodes);
    for (const n of l.nodes) {
      const b = nodeBox(n);
      if (members.has(n.id)) assert.ok(b.x >= f.x - 0.01 && b.y >= f.y - 0.01 && b.x + b.w <= f.x + f.w + 0.01 && b.y + b.h <= f.y + f.h + 0.01, `${what}: member ${n.id} outside "${g.label}"`);
      else assert.ok(!meets(b, f), `${what}: ${n.id} meets frame "${g.label}"`);
    }
    l.groups!.forEach((h, hi) => hi > gi && assert.ok(!meets(f, h), `${what}: frames "${f.label}" and "${h.label}" overlap`));
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= l.width + 0.01 && f.y + f.h <= l.height + 0.01, `${what}: frame "${g.label}" inside the drawing`);
  });
}
const everyLayout = (spec: FlowSpec, name: string) => {
  for (let level = 0; level < FLOW_LEVELS; level++) invariants(spec, layoutFlow(spec, estimateWidth, level), `${name} level ${level}`);
  if (spec.dir === "right") for (let level = 0; level < FLOW_LEVELS; level++) invariants({ ...spec, dir: "down" }, layoutFlow({ ...spec, dir: "down" }, estimateWidth, level), `${name} turned down, level ${level}`);
  for (const w of [340, 390, 700]) invariants(spec, fitFlow(spec, estimateWidth, w), `${name} at ${w}`);
};

const CASES: [string, "flow" | "state", string][] = [
  ["process", "flow", 'web "Browser tab" -> srv "Hono server" "WS /ws/chat" -> sdk "pi session"\nsdk -> llm "Model API" "HTTPS"\nsdk -> disk "Session JSONL" store\nsrv --> web "events"\ngroup "Sova process" srv sdk\ngroup "This machine" disk'],
  ["scope", "flow", 'root "Root claim" -> a "Claim A" -> b "Claim B" -> c "Claim C" -> leaf "Leaf"\nroot -> x "Claim X" -> leaf\na -> x\ngroup "Scope of the task" a b c\nmark x warn "impact only"'],
  ["right", "flow", 'dir: right\nuser "User" -> gw "Gateway" -> auth "Auth" -> api "API"\napi -> db "Postgres" store\napi -> q "Queue"\nq -> worker "Worker" -> db\ngroup "Cluster" gw auth api\ngroup "Async" q worker'],
  ["two processes", "flow", 'cli "tsx CLI" -> loader "ESM loader hook" -> esb "esbuild transform"\ncli -> child "node child"\nchild -> loader\nesb -> cache "disk cache" store\nchild -> app "your app.ts"\ngroup "Parent process" cli\ngroup "Child process" child loader esb app'],
  ["state", "state", 'node s0 start\ns0 -> idle\nidle -> busy "prompt"\nbusy -> tool "call"\ntool -> busy "result"\nbusy -> idle "settled"\nbusy -> failed "error"\ngroup "Running" busy tool'],
  ["crossing", "flow", 'a "A" -> b "B" -> c "C" -> d "D"\na -> e "E" -> d\nb -> e\ngroup "Left" a b\ngroup "Right" e\nc -> f "F"'],
  ["long title", "flow", 'dir: right\na -> b -> c\ngroup "A group title far longer than the frame it names" b'],
];

test("group layout: frames hold their members and nothing else, never overlap, at every spacing level and narrow widths", () => {
  for (const [name, kind, body] of CASES) everyLayout(ok(kind, body), name);
});

test("group layout: generated graphs and groups keep the same invariants", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let c = 0; c < 200; c++) {
    const count = 4 + rnd(9);
    const ids = Array.from({ length: count }, (_, i) => `n${i}`);
    const edges = new Set<string>();
    for (let i = 1; i < count; i++) edges.add(`n${rnd(i)} -> n${i}`);
    for (let k = rnd(4); k > 0; k--) {
      const a = rnd(count), b = rnd(count);
      if (a !== b) edges.add(`n${a} -> n${b}`);
    }
    const free = [...ids];
    const groups: string[] = [];
    for (let g = 0, gs = 1 + rnd(3); g < gs && free.length; g++) {
      const take = free.splice(rnd(free.length), 1 + rnd(Math.min(3, free.length)));
      groups.push(`group "Group ${g}" ${take.join(" ")}`);
    }
    const body = `${c % 3 === 0 ? "dir: right\n" : ""}${[...edges].join("\n")}\n${groups.join("\n")}`;
    everyLayout(ok("flow", body), `generated ${c}:\n${body}\n`);
  }
});

test("group layout: a long title in dir: right is cut with an ellipsis; the whole label stays for the tooltip", () => {
  const l = layoutFlow(ok("flow", CASES[6]![2]));
  const g = l.groups![0]!;
  assert.equal(g.label, "A group title far longer than the frame it names");
  assert.ok(g.title.endsWith("…") && g.title.length < g.label.length, g.title);
  const down = layoutFlow(ok("flow", 'a -> b -> c\ngroup "A group title far longer than the frame it names" b'));
  assert.equal(down.groups![0]!.title, down.groups![0]!.label, "down: the frame widens to its title");
});

test("no regression: a flow without groups lays out exactly as before groups existed (hashes taken from the earlier layout)", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const stored: Record<string, string> = JSON.parse(readFileSync(new URL("./layout-master.json", import.meta.url), "utf8"));
  const golden = JSON.parse(readFileSync(new URL("../../golden.json", import.meta.url), "utf8")).filter((g: { kind: string }) => g.kind === "flow" || g.kind === "state");
  const bodies: [string, string, string][] = golden.map((g: { kind: string; body: string }, i: number) => [`golden ${i}`, g.kind, g.body]);
  // The same seeded graphs the stored hashes were made from.
  let seed = 11;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let c = 0; c < 40; c++) {
    const count = 3 + rnd(10);
    const edges = new Set<string>();
    for (let i = 1; i < count; i++) edges.add(`n${rnd(i)} -> n${i}${rnd(4) === 0 ? ` "e${i}"` : ""}`);
    for (let k = rnd(4); k > 0; k--) {
      const a = rnd(count), b = rnd(count);
      if (a !== b) edges.add(`n${a} -> n${b}`);
    }
    bodies.push([`generated ${c}`, "flow", `${c % 3 === 0 ? "dir: right\n" : ""}${[...edges].join("\n")}`]);
  }
  const got: Record<string, string> = {};
  for (const [name, kind, body] of bodies) {
    const r = parseVis(kind, body);
    if (!r.ok || (r.spec as FlowSpec).sections) continue;
    const spec = r.spec as FlowSpec;
    const all: unknown[] = [];
    for (let level = 0; level < FLOW_LEVELS; level++) all.push(layoutFlow(spec, estimateWidth, level));
    for (const w of [340, 390, 700]) all.push(fitFlow(spec, estimateWidth, w));
    got[name] = createHash("sha256").update(kind + "\n" + body + "\n" + JSON.stringify(all)).digest("hex").slice(0, 16);
  }
  assert.equal(Object.keys(got).length, 49);
  assert.deepEqual(got, stored);
});
