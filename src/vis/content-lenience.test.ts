// §chat.markdown/vis-lenience-content: `vis` content as models write it. One test per rule; each
// shape here failed before, except the three changes of meaning, which say what they drew before.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChartSpec } from "./kinds/chart/parse";
import type { CodeSpec } from "./kinds/code/parse";
import type { FlowSpec } from "./kinds/flow/parse";
import type { LayersSpec } from "./kinds/layers/parse";
import type { MatrixSpec } from "./kinds/matrix/parse";
import type { SequenceSpec } from "./kinds/sequence/parse";
import type { StepsSpec } from "./kinds/steps/parse";
import type { TimelineSpec } from "./kinds/timeline/parse";
import type { TreeSpec } from "./kinds/tree/parse";
import { parseVis, visKindWord } from "./parse";
import { canonicalKind } from "./registry";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`${kind}: line ${r.line}: ${r.message}\n${body}`);
  assert.deepEqual(r.warnings, [], `${kind}: no warnings\n${body}`);
  return r.spec as T;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};
const rows = (s: ChartSpec) => s.rows.map((r) => [r.label, ...r.values]);
const edges = (s: FlowSpec) => s.edges.map((e) => [e.from, e.to, e.label ?? null, e.dashed]);
const labels = (s: FlowSpec) => Object.fromEntries(s.nodes.map((n) => [n.id, n.label]));
const shapes = (s: FlowSpec) => Object.fromEntries(s.nodes.map((n) => [n.id, n.shape]));

test("chart values: magnitudes, currency, thousands, units, gaps", () => {
  assert.deepEqual(rows(ok<ChartSpec>("chart", "Solid 32k\nReact 225K\nBig 1.5M\nHuge 2bn")), [["Solid", 32000], ["React", 225000], ["Big", 1500000], ["Huge", 2e9]]);
  const money = ok<ChartSpec>("chart", '"EC2" $4,200\n"S3" $320\n"Deal" $1.2B');
  assert.deepEqual([rows(money), money.unit], [[["EC2", 4200], ["S3", 320], ["Deal", 1.2e9]], "$"]);
  const ms = ok<ChartSpec>("chart", '"Auth" 120ms\n"Search" 910 ms');
  assert.deepEqual([rows(ms), ms.unit], [[["Auth", 120], ["Search", 910]], "ms"]);
  assert.equal(ok<ChartSpec>("chart", 'unit: ms (p95)\n"a" 120ms').unit, "ms (p95)", "unit: keeps its text when a row's unit is one of its words");
  assert.equal(ok<ChartSpec>("chart", 'unit: USD\n"a" $12').unit, "USD", "a currency is fine beside unit:");
  assert.equal(ok<ChartSpec>("chart", '"a" 500B').unit, "B", "500B alone is bytes");
  assert.deepEqual(rows(ok<ChartSpec>("chart", '"core" 91%\n"cli" n/a\n"web" —\n"docs" ?')), [["core", 91], ["cli", null], ["web", null], ["docs", null]]);
  assert.equal(ok<ChartSpec>("chart", '"core" 91%').unit, undefined, "12% sets no unit");
  assert.equal(ok<ChartSpec>("chart", "type: parts\nof: 200k\na 9000").of, 200000);
  assert.match(err("chart", '"Node" 180ms\n"Java" 2.1s').message, /mixed units ms and s: write every value in one unit/);
  assert.match(err("chart", 'unit: s\n"a" 120ms').message, /mixed units s and ms/);
  assert.match(err("chart", '"a" 1,5').message, /not a number/);
});

test("chart labels without quotes: values read from the end", () => {
  assert.deepEqual(rows(ok<ChartSpec>("chart", "unit: ms\nGET /users 120\nPOST /orders 340")), [["GET /users", 120], ["POST /orders", 340]]);
  const scatter = ok<ChartSpec>("chart", "type: scatter\nAuth Service 1.2 800\nNothing Phone (2a) 349 19 warn");
  assert.deepEqual(scatter.rows.map((r) => [r.label, ...r.values, r.tone ?? null]), [["Auth Service", 1.2, 800, null], ["Nothing Phone (2a)", 349, 19, "warn"]]);
  assert.deepEqual(rows(ok<ChartSpec>("chart", "Python 3.11 runtime 45")), [["Python 3.11 runtime", 45]]);
  // Every word after the head a value: a missing series: reads the same, so it stays an error that says both.
  const e = err("chart", "Sep 28 410");
  assert.match(e.message, /2 values; expected 1 \(add series: a, b for more than one\); or quote a label with spaces: "Sep 28" 410/);
  assert.match(err("chart", "Q1 10ms 12ms").message, /not a number/);
  assert.deepEqual(rows(ok<ChartSpec>("chart", 'series: 2024, 2025\n"Q1" | 10 | 12\n| Q2 | 11 | 15')), [["Q1", 10, 12], ["Q2", 11, 15]]);
  assert.deepEqual(rows(ok<ChartSpec>("chart", "jan: 1200\nfeb: 1500 warn")), [["jan:", 1200], ["feb:", 1500]]);
  assert.deepEqual(rows(ok<ChartSpec>("chart", "X: 10\nY: 12")), [["X:", 10], ["Y:", 12]], "a capital key with numbers stays a row");
});

test("chart type words", () => {
  const type = (t: string) => ok<ChartSpec>("chart", `type: ${t}\n"a" 1${/dots/.test(t) ? " 2" : ""}`).type;
  assert.deepEqual(["column", "Bars", "hbar", "grouped", "area", "trend", "stacked bars", "pie", "donut chart", "dots"].map(type), ["bar", "bar", "bar", "bar", "line", "line", "stacked", "parts", "parts", "scatter"]);
  assert.equal(ok<ChartSpec>("chart", 'scale: logarithmic\n"a" 1').scale, "log");
});

test("kind words: aliases draw as their kind; vis-flow and vis:flow", () => {
  for (const [word, kind] of [["flowchart", "flow"], ["graph", "flow"], ["sequencediagram", "sequence"], ["fsm", "state"], ["stack", "layers"], ["filetree", "tree"], ["table", "matrix"], ["mockup", "wireframe"], ["journey", "steps"], ["pie", "chart"]] as const) assert.equal(canonicalKind(word), kind);
  assert.equal(ok<ChartSpec>("line", '"a" 1\n"b" 2').type, "line");
  assert.equal(ok<ChartSpec>("scatter", '"a" 1 2').type, "scatter");
  assert.equal(ok<ChartSpec>("pie", '"a" 1\n"b" 2').type, "parts");
  assert.equal(ok<ChartSpec>("line", 'type: bar\n"a" 1').type, "bar", "type: says otherwise");
  assert.equal(ok<FlowSpec>("flowchart", "a -> b").nodes.length, 2);
  assert.equal(ok<MatrixSpec>("table", "columns: A\nx | yes").columns[0], "A");
  assert.deepEqual([visKindWord("vis-flow"), visKindWord("vis:table"), visKindWord("vis-mode"), visKindWord("vis flowchart")], ["flow", "table", null, "flowchart"]);
  assert.match(err("gitgraph", "commit").message, /unknown kind "gitgraph"/);
});

test("settings in capitals, except in tree", () => {
  const s = ok<FlowSpec>("flow", "Title: How it flows\nCaption: One hop.\na -> b");
  assert.deepEqual([s.title, s.caption], ["How it flows", "One hop."]);
  assert.equal(ok<TimelineSpec>("timeline", "Title: T\n2013 | React").title, "T");
  assert.equal(ok<ChartSpec>("chart", 'Type: line\n"a" 1').type, "line");
  const tree = ok<TreeSpec>("tree", "Title: my project\n  src/");
  assert.deepEqual([tree.title, tree.roots[0]!.name], [undefined, "Title: my project"]);
});

test("wide arrows in flow, state, sequence and steps", () => {
  assert.deepEqual(edges(ok<FlowSpec>("flow", "a → b ⟶ c\nc => d\nd ==> e\ne ↔ a")), [["a", "b", null, false], ["b", "c", null, false], ["c", "d", null, false], ["d", "e", null, false], ["e", "a", null, false]]);
  assert.equal(ok<FlowSpec>("flow", "e ↔ a").edges[0]!.both, true);
  assert.equal(ok<SequenceSpec>("sequence", 'a → b "hi"').steps.length, 1);
  assert.deepEqual(ok<FlowSpec>("flow", 'a "x → y" -> b').nodes[0]!.label, "x → y", "inside quotes a → is text");
});

test("flow and state: Mermaid habits", () => {
  const m = ok<FlowSpec>("flow", "graph LR\nA[Browser] -->|HTTPS| B{Valid?}\nB -- yes --> C(Dashboard)\nB -- \"no\" --> D[(Users DB)]\nD --> E((Done));\nclassDef hot fill:#f00\nclass A hot\nstyle B fill:#0f0\n%% a comment");
  assert.equal(m.dir, "right");
  assert.deepEqual(labels(m), { A: "Browser", B: "Valid?", C: "Dashboard", D: "Users DB", E: "Done" });
  assert.deepEqual(shapes(m), { A: "box", B: "decision", C: "round", D: "store", E: "circle" });
  assert.deepEqual(edges(m), [["A", "B", "HTTPS", true], ["B", "C", "yes", true], ["B", "D", "no", true], ["D", "E", null, true]]);
  assert.deepEqual(labels(ok<FlowSpec>("flow", 'A["Web app"] --> B')), { A: "Web app", B: "B" });
  assert.deepEqual(labels(ok<FlowSpec>("flow", "a -> B[API]")), { a: "a", B: "API" }, "a bracket labels the node even when strings after targets are edge labels");
  assert.deepEqual(edges(ok<FlowSpec>("flow", "a -> b: calls the API\nb -> c : done")), [["a", "b", "calls the API", false], ["b", "c", "done", false]]);
  const st = ok<FlowSpec>("state", 'stateDiagram-v2\n[*] --> Idle\nstate "Waiting on customer" as Wait\nIdle --> Wait : ask\nWait --> [*]');
  assert.deepEqual(labels(st), { Wait: "Waiting on customer", __start: "__start", Idle: "Idle", __end: "__end" });
  assert.deepEqual(shapes(st), { Wait: "round", __start: "start", Idle: "round", __end: "end" });
  assert.deepEqual(edges(st), [["__start", "Idle", null, true], ["Idle", "Wait", "ask", true], ["Wait", "__end", null, true]]);
  assert.equal(ok<FlowSpec>("flow", "flowchart TD\na -> b").dir, "down");
  assert.equal(ok<FlowSpec>("flow", "dir: right\ngraph TD\na -> b").dir, "right", "dir: wins over the head");
});

test("flow and state: shape and dir words, node lines in any order, strings for ids, ids", () => {
  const s = ok<FlowSpec>("flow", 'node d "Ok?" diamond\nnode db "Orders" database\nnode p pill "Pay"\na -> d\nd -> db\ndb -> p');
  assert.deepEqual([shapes(s).d, shapes(s).db, shapes(s).p, labels(s).p], ["decision", "store", "round", "Pay"]);
  assert.deepEqual(labels(ok<FlowSpec>("flow", "api -> db\ndb -> cache")), { api: "api", db: "db", cache: "cache" }, "db where an id goes is an id");
  assert.equal(ok<FlowSpec>("flow", "dir: LR\na -> b").dir, "right");
  assert.equal(ok<FlowSpec>("flow", "direction: vertical\na -> b").dir, "down");
  const q = ok<FlowSpec>("flow", '"Browser" -> "API Server" "calls"\n"API Server" -> db\napi "API" -> "API"');
  assert.deepEqual(labels(q), { browser: "Browser", "api-server": "API Server", db: "db", api: "API" });
  assert.deepEqual(edges(q), [["browser", "api-server", "calls", false], ["api-server", "db", null, false], ["api", "api", null, false]]);
  const ids = ok<FlowSpec>("flow", "1 -> 2\nweb/app -> العميل\nmark 1 \"first\"");
  assert.deepEqual(ids.nodes.map((n) => n.id), ["1", "2", "web/app", "العميل"]);
  assert.deepEqual(ids.emphasis, [{ key: "1", tone: "accent", note: "first", n: 1 }]);
  assert.match(err("flow", "a@b -> c").message, /not an id/);
});

test("a labelled start or end dot is the state it names, plus its dot", () => {
  const s = ok<FlowSpec>("state", 'node pending start "Pending payment"\npending -> paid "pay"\nnode closed end "Closed"\npaid -> closed\nmark "Pending payment" "expires in 30 min"');
  assert.deepEqual(s.nodes.map((n) => [n.id, n.label, n.shape]), [["pending:start", "", "start"], ["pending", "Pending payment", "round"], ["closed", "Closed", "round"], ["closed:end", "", "end"], ["paid", "paid", "round"]]);
  assert.deepEqual(edges(s).slice(2), [["pending:start", "pending", null, false], ["closed", "closed:end", null, false]]);
  assert.deepEqual(s.emphasis, [{ key: "pending", tone: "accent", note: "expires in 30 min", n: 1 }]);
  assert.deepEqual(ok<FlowSpec>("state", 'node s0 start "Start"\ns0 -> a').nodes[0]!.shape, "start", "a dot's own name keeps it a dot");
  assert.deepEqual(ok<FlowSpec>("state", "node s0 start\ns0 -> a").nodes.length, 2);
  // Before: a dot, its label never shown (one of the three changes of meaning).
  assert.deepEqual(ok<FlowSpec>("state", 'p "Pending" start -> paid').nodes.map((n) => n.shape), ["start", "round", "round"]);
});

test("sequence: Mermaid habits", () => {
  const s = ok<SequenceSpec>(
    "sequence",
    'sequenceDiagram\nautonumber\nparticipant c as Client app\nactor s as "Server"\nparticipant "Auth Server"\nc ->>+ s: GET /items?page=2\nactivate s\nloop every recipient\ns -> "Auth Server" check\nend\nalt cached\ns -->> c: 200 OK\nelse miss\ns --> c "fetch"\nend\nNote over c, s: synced\nnote right of s: done\ndeactivate s',
  );
  assert.deepEqual(s.actors.map((a) => [a.id, a.label]), [["c", "Client app"], ["s", "Server"], ["auth-server", "Auth Server"]]);
  assert.deepEqual(
    s.steps.map((x) => (x.type === "msg" ? [x.from, x.to, x.label ?? null, x.dashed] : x.type === "note" ? ["note", x.over, x.text] : ["==", x.label])),
    [["c", "s", "GET /items?page=2", false], ["==", "every recipient"], ["s", "auth-server", "check", false], ["==", "cached"], ["s", "c", "200 OK", true], ["==", "miss"], ["s", "c", "fetch", true], ["note", ["c", "s"], "synced"], ["note", ["s"], "done"]],
  );
  assert.deepEqual(ok<SequenceSpec>("sequence", "a -> b hello there\nb --> a ok").steps.map((x) => (x as { label?: string }).label), ["hello there", "ok"]);
  assert.deepEqual(ok<SequenceSpec>("sequence", "a -> b\nloop\nb -> a").steps[1], { type: "divider", label: "loop" });
  // A line that reads today keeps its meaning: `note over a "x"` is still two actors, over and a.
  assert.deepEqual(ok<SequenceSpec>("sequence", 'a -> b\nnote over a "x"').actors.map((a) => a.id), ["a", "b", "over"]);
});

test("rows without |: timeline and layers", () => {
  const t = ok<TimelineSpec>("timeline", "2013: React\nSep 30 — Outage — 47 min\n2016 - Vue 2\n2019 | Svelte 3");
  assert.deepEqual(t.items.map((i) => (i.type === "event" ? [i.when, i.label, i.note ?? null] : null)), [["2013", "React", null], ["Sep 30", "Outage", "47 min"], ["2016", "Vue 2", null], ["2019", "Svelte 3", null]]);
  const l = ok<LayersSpec>("layers", "Browser: React, Redux\nServer | Node");
  assert.deepEqual(l.layers.map((x) => [x.label, x.items]), [["Browser", ["React", "Redux"]], ["Server", ["Node"]]]);
});

test("Markdown tables: timeline, layers, matrix", () => {
  const t = ok<TimelineSpec>("timeline", "| When | What |\n|---|---|\n| 2013 | React |");
  assert.deepEqual(t.items.map((i) => (i.type === "event" ? [i.when, i.label] : null)), [["When", "What"], ["2013", "React"]]);
  assert.deepEqual(ok<LayersSpec>("layers", "| Server | Hono, ws |").layers[0]!.items, ["Hono", "ws"]);
  const m = ok<MatrixSpec>("matrix", "| Feature | Free | Pro |\n|:---|:---:|---:|\n| SSO | no | yes |\nmark Pro \"pick\"");
  assert.deepEqual([m.columns, m.rows.map((r) => r.label), m.emphasis?.[0]?.key], [["Free", "Pro"], ["SSO"], "c1"]);
  assert.deepEqual(ok<MatrixSpec>("matrix", "Feature | Free | Pro\nSSO | no | yes").columns, ["Free", "Pro"], "no columns:: the first row is the header");
  const piped = ok<MatrixSpec>("matrix", "columns: Critic (Astra) | Advocate (K3, your side) | Coordinator\nX | yes | no | partial");
  assert.deepEqual(piped.columns, ["Critic (Astra)", "Advocate (K3, your side)", "Coordinator"]);
  // `columns: A | B` over rows of one cell: one column, as before.
  assert.deepEqual(ok<MatrixSpec>("matrix", "columns: A | B\nX | yes").columns, ["A | B"]);
  assert.match(err("matrix", "x | yes").message, /columns:/);
});

test("error text: a field that isn't a tone says so", () => {
  assert.equal(err("layers", "Database | PostgreSQL | persistent data | store").message, '"store" is not a tone (accent ok warn error info muted): a layer is: label | item, item, … | note (optional) | tone (optional)');
  assert.match(err("timeline", "2013 | React | Meta | healthy").message, /^"healthy" is not a tone/);
  assert.match(err("timeline", "2013 | React | Meta | virtual DOM").message, /^a row is/);
});

test("marks: bare notes, a colon run, indented mark lines", () => {
  const vue = ok<TimelineSpec>("timeline", '2013 | React\n2016 | Vue 2\nmark "Vue 2" templates, not JSX');
  assert.deepEqual(vue.emphasis, [{ key: "1", tone: "accent", note: "templates, not JSX", n: 1 }]);
  assert.equal(ok<TimelineSpec>("timeline", '2016 | Vue 2\nmark "Vue 2": the one warn').emphasis?.[0]?.tone, "warn");
  assert.deepEqual(ok<TimelineSpec>("timeline", "Sep 30 | outage\nmark Sep 30: the outage day").emphasis, [{ key: "0", tone: "accent", note: "the outage day", n: 1 }]);
  assert.deepEqual(ok<ChartSpec>("chart", '"A" 1\n  mark "A" "x"').emphasis, [{ key: "0", tone: "accent", note: "x", n: 1 }]);
  assert.equal(ok<CodeSpec>("code", "lang: py\n  mark 2 \"bug\"\n---\na\nb").emphasis?.[0]?.key, "2");
  // flow keeps an indented `mark "A"` a node declaration, as before.
  assert.deepEqual(ok<FlowSpec>("flow", '  mark "A"\na -> b').nodes[0], { id: "mark", label: "A", shape: "box" });
});

test("tree: indentation that isn't in steps: each line under the nearest less-indented one", () => {
  const t = ok<TreeSpec>("tree", "src/\n   lib/\n      a.ts\n  b.ts");
  assert.deepEqual(t.roots[0]!.children.map((c) => [c.name, c.children.map((x) => x.name)]), [["lib/", ["a.ts"]], ["b.ts", []]]);
});

test("code without ---", () => {
  const c = ok<CodeSpec>("code", 'lang: py\nmark 2 "bug"\ndef f():\n  return 1');
  assert.deepEqual([c.lang, c.lines, c.emphasis?.[0]?.key], ["py", ["def f():", "  return 1"], "2"]);
  assert.deepEqual(ok<CodeSpec>("code", "# a comment is code\nx = 1").lines, ["# a comment is code", "x = 1"]);
});

test("steps: the three changes of meaning (a trailing | tone, wide arrows)", () => {
  const s = ok<StepsSpec>("steps", '"Guest" | cart -> pay -> done | ok\n"Pro" warn | a -> b | ok\n"Apple Pay" | cart → sheet ⟶ fails');
  const rows = s.items.map((i) => (i.type === "row" ? [i.label, i.tone ?? null, i.steps] : null));
  assert.deepEqual(rows, [["Guest", "ok", ["cart", "pay", "done"]], ["Pro", "warn", ["a", "b | ok"]], ["Apple Pay", null, ["cart", "sheet", "fails"]]]);
});
