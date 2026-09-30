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
/** A fence that still draws: its first warning (parse.ts). */
const warning = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
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
  assert.deepEqual([err("flow", 'a -> b\nA["Label" --> b').line], [2]);
  assert.match(err("flow", 'a["x" -> b').message, /node <id> "Label"/);
  assert.match(err("flow", 'node a "A"\na "Label" -> b').message, /a has a node line: its label goes there/);
  assert.match(err("flow", "node a sparkly").message, /unknown word "sparkly"/);
  assert.match(err("flow", "orientation: down\na -> b").message, /unknown setting "orientation:"/);
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
  assert.deepEqual(warning("flow", "a -> b\nmark c"), { line: 2, message: "mark: no node c, dropped" });
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

test("flow inline labels: a string after a chain's source makes the fence inline-style", () => {
  const label = (s: FlowSpec, nid: string) => s.nodes.find((n) => n.id === nid)?.label;
  // A merge shape a model wrote: every string after an undeclared id labels that node.
  const merge = ok<FlowSpec>("flow", 'dir: right\nm1 "main: A" -> m2 "main: B" -> merged "merge commit" ok\nf1 "feature: X" -> merged');
  assert.deepEqual(merge.nodes.map((n) => [n.id, n.label, n.tone ?? null]), [
    ["m1", "main: A", null],
    ["m2", "main: B", null],
    ["merged", "merge commit", "ok"],
    ["f1", "feature: X", null],
  ]);
  assert.ok(merge.edges.every((e) => e.label === undefined), "no edge labels in an inline-style fence without node lines");
  // Only a target with a node line takes an edge label; a node line wins over any inline string.
  const mixed = ok<FlowSpec>("flow", 'web "Browser" -> srv "Server"\nnode db "Database" store\nsrv -> db "SQL"\nmark "Server"');
  assert.deepEqual(mixed.nodes.map((n) => `${n.id}=${n.label}`), ["db=Database", "web=Browser", "srv=Server"]);
  assert.deepEqual(mixed.edges.map((e) => e.label ?? null), [null, "SQL"]);
  assert.deepEqual(mixed.emphasis, [{ key: "srv", tone: "accent" }], "a mark finds an inline label");
  // A string after a source that has a node line is still an error: the label goes on that line.
  assert.match(err("flow", 'node a "A"\na "Other" -> b').message, /a has a node line/);
  // A second string after an already-labelled target is the edge's label (see the next test).
  const twice = parseVis("flow", 'a "One" -> b\nb -> a "Two"');
  assert.ok(twice.ok);
  assert.equal(label(twice.spec as FlowSpec, "a"), "One");
  assert.deepEqual((twice.spec as FlowSpec).edges.map((e) => e.label ?? null), [null, "Two"]);
  assert.deepEqual(twice.warnings, []);
  // A different string after an already-labelled SOURCE has no edge to label: the first is kept, with a warning.
  const src = parseVis("flow", 'a "One" -> b\na "Two" -> c');
  assert.ok(src.ok);
  assert.equal(label(src.spec as FlowSpec, "a"), "One");
  assert.deepEqual(src.warnings, [{ line: 2, message: 'node a is labelled "One" and "Two": kept "One"' }]);
  // Inline style reaches across panels, each panel's ids its own.
  const panels = ok<FlowSpec>("flow", '== Before ==\ntoggle "Toggle" -> old "Old path"\n== After ==\ntoggle "Toggle" -> fresh "New path"');
  assert.deepEqual(panels.sections!.map((p) => p.nodes.map((n) => n.label)), [["Toggle", "Old path"], ["Toggle", "New path"]]);
});

test("flow without an inline source string: a string after a target is the edge's label, as always", () => {
  // The guide's state idiom and a node-line flow: nothing changes.
  const st = ok<FlowSpec>("state", 'node s0 start\ns0 -> idle\nidle -> busy "prompt"\nbusy -> idle "settled"');
  assert.deepEqual(st.edges.map((e) => e.label ?? null), [null, "prompt", "settled"]);
  assert.deepEqual(st.nodes.map((n) => n.label), ["s0", "idle", "busy"]);
  // No node lines and no source string: still edge labels (the ids stay the boxes' text).
  const bare = ok<FlowSpec>("flow", 'togA -> secA "new <mode> section" -> endA');
  assert.deepEqual(bare.edges.map((e) => e.label ?? null), ["new <mode> section", null]);
  assert.equal(bare.nodes.find((n) => n.id === "secA")!.label, "secA");
});

test("flow inline style: the first string labels an unlabelled node, the next labels the edge", () => {
  const edges = (s: FlowSpec) => s.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ""}`);
  const labels = (s: FlowSpec) => Object.fromEntries(s.nodes.map((n) => [n.id, n.label]));
  // Return edges after a forward chain keep their labels (the targets are already labelled).
  const back = ok<FlowSpec>("flow", 'web "Web" -> app "App" -> store "Store"\nstore --> app "Rows"\napp --> web "Page"');
  assert.deepEqual(labels(back), { web: "Web", app: "App", store: "Store" });
  assert.deepEqual(edges(back), ["web>app", "app>store", "store>app:Rows", "app>web:Page"]);
  // Label and edge label on one unlabelled target; a later edge to it takes one string as its label.
  const three = ok<FlowSpec>("flow", 'ui "UI" -> svc "Service" "request" -> q "Queue" "event"\nui -> svc "retry"');
  assert.deepEqual(labels(three), { ui: "UI", svc: "Service", q: "Queue" });
  assert.deepEqual(edges(three), ["ui>svc:request", "svc>q:event", "ui>svc:retry"]);
  // Repeating a node's inline label is not an edge label.
  const again = ok<FlowSpec>("flow", 'x "X" -> y "Y"\nz "Z" -> y "Y" "second"');
  assert.deepEqual(edges(again), ["x>y", "z>y:second"]);
  // A target with a node line: its one string is the edge's, a second is an error.
  const lined = ok<FlowSpec>("flow", 'a "A" -> b\nnode b "B"\na -> b "go"');
  assert.deepEqual(edges(lined), ["a>b", "a>b:go"]);
  // A target with a node line: two strings are the edge's two lines (§chat.markdown/vis-lenience); a third is an error.
  assert.equal(ok<FlowSpec>("flow", 'a "A" -> b\nnode b "B"\na -> b "go" "more"').edges[1]!.label, "go\nmore");
  assert.equal(err("flow", 'a "A" -> b\nnode b "B"\na -> b "go" "more" "most"').message, 'unexpected "more" after b: one string per edge label (\\n breaks a line): -> b "go\\nmore"', "three strings: as before");
  assert.equal(err("flow", 'a "A" -> b "B" "e" "extra"').message, 'unexpected "extra" after b: one label and one edge label per target; for a second line use node b "B" "extra"');
});

test("flow: a stray string after a target says what to write instead", () => {
  const msg = (body: string) => err("flow", body).message;
  // Labelled on this line: the third string reads as a second line, which only a node line has.
  assert.equal(msg('ai1 "AI" --> d1 "Decision" "yes" "own states"'), 'unexpected "own states" after d1: one label and one edge label per target; for a second line use node d1 "Decision" "own states"');
  // Labelled earlier: both strings are the edge's, its label on two lines; a third string is an error.
  const two = ok<FlowSpec>("flow", 'api "API Server" -> db\nclient "Client" -> api "Notify completion" "POST /confirm-upload"');
  assert.deepEqual([two.nodes.find((n) => n.id === "api")!.label, two.edges[1]!.label], ["API Server", "Notify completion\nPOST /confirm-upload"]);
  assert.equal(
    msg('api "API Server" -> db\nclient "Client" -> api "Notify completion" "POST /confirm-upload" "x"'),
    'unexpected "POST /confirm-upload" after api: api is labelled "API Server" already, so "Notify completion" labels the edge; one string per edge label (\\n breaks a line): -> api "Notify completion\\nPOST /confirm-upload"',
  );
  // A string after a shape or tone word, when it can only be the edge's (the target is labelled, no
  // edge label yet): read as if written first (§chat.markdown/vis-lenience). Otherwise the strings go first.
  const late = ok<FlowSpec>("flow", 'staging "Deploy to staging" -> x\napproval "OK?" -> staging error "rejected"');
  assert.deepEqual([late.edges[1]!.label, late.nodes.find((n) => n.id === "staging")!.tone], ["rejected", "error"]);
  assert.equal(ok<FlowSpec>("flow", 'a "A" -> b "B" decision warn "go"').edges[0]!.label, "go");
  assert.equal(ok<FlowSpec>("flow", 'a -> b warn "go"').edges[0]!.label, "go", "outside inline style a string after a target is the edge's");
  assert.equal(msg('a "A" -> b error "rejected"'), 'unexpected "rejected" after b: strings go before shape and tone words: -> b "rejected" error', "b unlabelled: its label or the edge's");
  assert.equal(msg('a "A" -> b "B" "e" warn "go"'), 'unexpected "go" after b: strings go before shape and tone words: -> b "B" "e" "go" warn', "the edge has its label");
  // Outside inline style: one string, the edge's.
  assert.equal(msg('a -> b "go" "more"'), 'unexpected "more" after b: one string per edge label (\\n breaks a line): -> b "go\\nmore"');
  // A stray word keeps its message.
  assert.equal(msg("a -> b cloud"), "unexpected cloud after b");
});

test("flow: a second string after a chain's source is its second line; before the arrow it can't be an edge's", () => {
  const s = ok<FlowSpec>("flow", 'g1 "Gathering" "own states" -> n1 "English note" warn -> ai1 "Overseer" round\nai1 --> d1 "Decision" "own states"');
  const node = (id: string) => s.nodes.find((n) => n.id === id)!;
  assert.deepEqual([node("g1").label, node("g1").note], ["Gathering", "own states"]);
  assert.equal(node("n1").note, undefined);
  // After a TARGET the second string is still the edge's, never a second line.
  assert.deepEqual([node("d1").label, node("d1").note], ["Decision", undefined]);
  assert.deepEqual(s.edges.map((e) => e.label ?? null), [null, null, "own states"]);
  // Shape and tone words may follow; the fence is inline-style, as with one string.
  const shaped = ok<FlowSpec>("flow", 'ev "Something happens" "gathering ends" round accent -> llm "Overseer LLM"');
  assert.deepEqual([shaped.nodes[0]!.note, shaped.nodes[0]!.shape, shaped.nodes[0]!.tone, shaped.nodes[1]!.label], ["gathering ends", "round", "accent", "Overseer LLM"]);
  // A different second line later keeps the first, with a warning; the same one is silent.
  const twice = parseVis("flow", 'a "A" "one" -> b\na "A" "two" -> c\na "A" "one" -> d');
  assert.ok(twice.ok);
  assert.equal((twice.spec as FlowSpec).nodes[0]!.note, "one");
  assert.deepEqual(twice.warnings, [{ line: 2, message: 'node a has the second lines "one" and "two": kept "one"' }]);
  // A third string before the arrow is an error quoting the line to write.
  assert.equal(err("flow", 'g1 "Gathering" "own states" "more" -> n1').message, 'g1 takes a label and one second line before its arrow: g1 "Gathering" "own states" -> n1');
  // A source with a node line still takes no string.
  assert.match(err("flow", 'node a "A"\na "A" "x" -> b').message, /a has a node line/);
  // State too.
  assert.equal(ok<FlowSpec>("state", 's "Idle" "waiting" -> t "Busy"').nodes[0]!.note, "waiting");
});

test("flow: a line `id \"Label\" [\"second\"] [words]` with no arrow is a node line without the word", () => {
  const s = ok<FlowSpec>("flow", 'a1 "Worker starts" round\na2 "Write claims" "by hand"\na4 "Census" muted\na1 -> a2 "rule only if parent pastes it"\na2 -> a4');
  assert.deepEqual(s.nodes.map((n) => [n.id, n.label, n.note ?? null, n.shape, n.tone ?? null]), [
    ["a1", "Worker starts", null, "round", null],
    ["a2", "Write claims", "by hand", "box", null],
    ["a4", "Census", null, "box", "muted"],
  ]);
  // Like a node line, it leaves the fence out of inline style: a string after its target is the edge's.
  assert.deepEqual(s.edges.map((e) => e.label ?? null), ["rule only if parent pastes it", null]);
  // In an inline-style fence too, a target it declares takes one string, the edge's.
  const mixed = ok<FlowSpec>("flow", 'b "Build"\nw "Web" -> b "deploys"');
  assert.deepEqual([mixed.nodes.map((n) => n.label), mixed.edges[0]!.label], [["Build", "Web"], "deploys"]);
  // Sections: each panel's declarations are its own.
  const panels = ok<FlowSpec>("flow", '== A ==\nx "X"\nx -> y "go"\n== B ==\nx "Other"\nx -> y');
  assert.deepEqual(panels.sections!.map((p) => p.nodes.map((n) => n.label)), [["X", "y"], ["Other", "y"]]);
  // Declared twice (with or without the word) is an error; a source string for it too; a lone id still names node.
  assert.match(err("flow", 'a "A"\nnode a "B"').message, /node a is declared twice/);
  assert.match(err("flow", 'a "A"\na "A" -> b').message, /a has a node line/);
  assert.equal(err("flow", "a\na -> b").message, 'a lone id: declare it with node a "Label"');
  assert.match(err("flow", 'a "A" sideways').message, /unknown word "sideways"/);
  // A group line is still a group line.
  assert.deepEqual(ok<FlowSpec>("flow", 'a -> b\ngroup "G" a b').groups, [{ label: "G", nodes: ["a", "b"] }]);
});

test("flow inline style: shape and tone words may follow an inline label, on sources and targets", () => {
  const s = ok<FlowSpec>("flow", 'build "Build" -> gate "Manual approval" decision -> prod "Deploy" ok\ndb "Orders DB" store warn -> build "reads"');
  const node = (id: string) => s.nodes.find((n) => n.id === id)!;
  assert.deepEqual([node("gate").shape, node("gate").label], ["decision", "Manual approval"]);
  assert.deepEqual([node("db").shape, node("db").tone, node("db").label], ["store", "warn", "Orders DB"]);
  assert.equal(node("prod").tone, "ok");
  assert.equal(node("build").shape, "box");
  assert.deepEqual(s.edges.map((e) => e.label ?? null), [null, null, "reads"]);
  // In any order, one of each; two different shapes are an error, as are two tones.
  assert.equal(ok<FlowSpec>("flow", 'a "A" -> b "B" error round').nodes[1]!.shape, "round");
  assert.match(err("flow", 'a "A" -> b "B" round\na -> b store').message, /node b is shaped round and store/);
  // A node line's own shape wins over none, and disagrees with a different chain shape.
  assert.equal(ok<FlowSpec>("flow", 'a "A" -> b decision\nnode b "B"').nodes.find((n) => n.id === "b")!.shape, "decision");
  assert.match(err("flow", 'a "A" -> b decision\nnode b "B" store').message, /shaped store on its node line and decision/);
  // Outside inline style too (§chat.markdown/vis-lenience): a shape word after a chain id is its shape.
  assert.equal(ok<FlowSpec>("flow", "a -> b decision").nodes[1]!.shape, "decision");
  const st = ok<FlowSpec>("state", 'idle -> busy "prompt" circle');
  assert.deepEqual([st.nodes[1]!.shape, st.edges[0]!.label], ["circle", "prompt"]);
});
