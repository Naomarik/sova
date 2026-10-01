// §chat.markdown/vis-lenience-content: `vis` content as models write it. One test per rule; each
// shape here failed before, except the changes of meaning, which say what they drew before.
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
import type { WBlock, WireframeSpec } from "./kinds/wireframe/parse";
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
  assert.match(err("chart", '"Node" 180ms\n"Java" 2.1s\n"Go" 90').message, /mixed units ms and s: write every value in one unit/, "a bare value beside two durations");
  assert.match(err("chart", '"a" 3ms\n"b" 2GB').message, /mixed units ms and GB/);
  assert.match(err("chart", 'unit: USD\n"a" 3ms').message, /mixed units USD and ms/);
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

// Round 1: the lines weak models wrote in the eval, verbatim where they are quoted.
const drawn = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`${kind}: line ${r.line}: ${r.message}\n${body}`);
  return r;
};

test("a | inside a quoted field: timeline, layers, matrix", () => {
  const t = ok<TimelineSpec>("timeline", '2021 | "Ship it, then fix it"\n2023 | "Quality | Speed" | the honest trade-off | info');
  assert.deepEqual(t.items[1], { type: "event", when: "2023", label: "Quality | Speed", note: "the honest trade-off", tone: "info" });
  assert.deepEqual(ok<LayersSpec>("layers", '"A | B" | x, y | "note | two"').layers[0], { label: "A | B", items: ["x", "y"], note: "note | two" });
  const m = ok<MatrixSpec>("matrix", 'columns: A, B\n"x | y" | yes | "t | u"');
  assert.deepEqual([m.rows[0]!.label, m.rows[0]!.cells], ["x | y", [{ mark: "yes" }, { text: "t | u" }]]);
  // A quoted stretch that isn't the whole field splits as before.
  assert.deepEqual(ok<TimelineSpec>("timeline", '2023 | say "a | b" now').items[0], { type: "event", when: "2023", label: 'say "a', note: 'b" now' });
});

test("steps: words beside a quoted step are kept as written; a tone after the last is the row's", () => {
  const s = ok<StepsSpec>("steps", '"SAML" error | "Enter domain" -> "Redirect to IdP" -> error "invalid audience"\n"Expired" | "Email" -> "Click after 15 min" -> "Show expiry" error\n"Request link" ok | "Email" -> "Show expiry" error');
  const rows = s.items.map((i) => (i.type === "row" ? [i.label, i.tone ?? null, i.steps] : null));
  assert.deepEqual(rows, [
    ["SAML", "error", ["Enter domain", "Redirect to IdP", 'error "invalid audience"']],
    ["Expired", "error", ["Email", "Click after 15 min", "Show expiry"]],
    ["Request link", "ok", ["Email", '"Show expiry" error']],
  ]);
  assert.match(err("steps", '"A" | "a" "b" -> c').message, /not two labels: "a" "b" \(join steps with ->\)/);
});

test("flow: cache, dashed, a second tone, a decision's branches", () => {
  const f = ok<FlowSpec>("flow", 'web "Client" -> lb "Load balancer" -> api "API server" -> redis "Redis" cache\nl7a "L7 LB 1" -> a2 "app-2" "failover" dashed\nl7a -> a1 "app-1" dotted ok');
  assert.equal(shapes(f).redis, "store");
  assert.deepEqual(edges(f).slice(3), [["l7a", "a2", "failover", true], ["l7a", "a1", null, true]]);
  assert.equal(f.nodes.find((n) => n.id === "a1")!.tone, "ok");
  const r = drawn("flow", 'api "API" ok -> cache "Cache"\ncache --> api "miss" warn');
  assert.deepEqual(r.warnings, [{ line: 2, message: "node api is toned ok and warn: kept ok" }]);
  assert.equal((r.spec as FlowSpec).nodes.find((n) => n.id === "api")!.tone, "ok");
  const d = ok<FlowSpec>("flow", 'req "Request received" -> days "Within 30 days?" decision\ndays "yes" -> damaged "Item damaged?" decision\ndays "no" -> reject "Reject" error\ndamaged "yes" -> refund "Full refund" accent');
  assert.deepEqual(edges(d), [["req", "days", null, false], ["days", "damaged", "yes", false], ["days", "reject", "no", false], ["damaged", "refund", "yes", false]]);
  assert.equal(labels(d).days, "Within 30 days?");
  assert.deepEqual(edges(ok<FlowSpec>("state", 'node v "Valid?" decision\nv "yes" -> rec "Save"')), [["v", "rec", "yes", false]]);
  // Not a decision, or the edge labelled already: the second label is dropped with a warning, as before.
  assert.equal(drawn("flow", 'eng "Engineering team" -> a\neng "Engineering" -> close').warnings[0]!.message, 'node eng is labelled "Engineering team" and "Engineering": kept "Engineering team"');
  assert.equal(drawn("flow", 'v "Valid?" decision -> a\nv "yes" -> b "B" "edge"').warnings[0]!.message, 'node v is labelled "Valid?" and "yes": kept "Valid?"');
});

test("sequence: an actor without the word; a message's two strings", () => {
  const s = ok<SequenceSpec>("sequence", 'u "User"\nr "React" info\nu -> r "click"');
  assert.deepEqual(s.actors, [{ id: "u", label: "User" }, { id: "r", label: "React", tone: "info" }]);
  const m = ok<SequenceSpec>("sequence", 'actor cdn "CDN"\nactor org "Origin"\ncdn -> org "GET /api/items?page=2&sort=-date" "cache miss, forward"');
  assert.deepEqual(m.steps[0], { type: "msg", from: "cdn", to: "org", label: "GET /api/items?page=2&sort=-date\ncache miss, forward", dashed: false });
  assert.match(err("sequence", 'a -> b "x" "y" "z"').message, /one message per line/);
});

test("chart: a label ending in a number, when a row settles the width; a tone on a row of several series", () => {
  const s = ok<ChartSpec>("chart", 'type: scatter\niPhone 16 799 22\n"Pixel 9" 799 24');
  assert.deepEqual(rows(s), [["iPhone 16", 799, 22], ["Pixel 9", 799, 24]]);
  assert.match(err("chart", "type: scatter\niPhone 16 799 22\nPixel 9 799 24").message, /3 values; expected 2/);
  assert.match(err("chart", "type: stacked\nv1.0 5 20 8\nv1.1 2 9 4").message, /3 values; expected 1/);
  const t = ok<ChartSpec>("chart", 'series: p50, p99\n"/checkout" 80 2400 warn\n"/cart" 20 300 ok\nmark "/cart" "fast"');
  assert.deepEqual([t.rows.map((r) => r.tone ?? null), t.emphasis], [[null, null], [{ key: "1", tone: "accent", note: "fast", n: 1 }, { key: "0", tone: "warn" }]]);
});

test("marks naming part of an item: a step, a layer's item or number, a folder without its slash", () => {
  const st = ok<StepsSpec>("steps", '"Sign up" | Email -> "Verify email" -> Done\n"Invite" | "Invite team" -> Done\nmark "Verify email" "x"');
  assert.deepEqual(st.emphasis, [{ key: "0", tone: "accent", note: "x", n: 1 }]);
  assert.equal(drawn("steps", '"A" | x -> Done\n"B" | y -> Done\nmark Done').warnings[0]!.message, "mark: no row Done, dropped");
  const l = ok<LayersSpec>("layers", '7 Application | HTTP, DNS\n6 Presentation | "TLS 1.3", JPEG\n4 Transport | TCP, UDP\nmark 4 "where TCP lives"\nmark TLS 1.3 "tls"');
  assert.deepEqual(l.emphasis, [{ key: "2", tone: "accent", note: "where TCP lives", n: 1 }, { key: "1", tone: "accent", note: "tls", n: 2 }]);
  const tree = '"Tax Returns/"\n  2023/\n  a.pdf\n"Photos/"\npackages/\n  ui/\n';
  const keys = (body: string) => ok<TreeSpec>("tree", tree + body).emphasis?.map((e) => e.key);
  assert.deepEqual(keys('mark "Tax Returns", Photos "folders"'), ["0", "1"]);
  assert.deepEqual(keys('mark "Tax Returns"/, "Photos"/ "folders"'), ["0", "1"]);
  assert.deepEqual(keys("mark 2023"), ["0.0"]);
  assert.deepEqual(keys("mark ui"), ["2.0"]);
});

test("code: a later mark with a note on a line a range only highlighted takes it", () => {
  const code = "\n---\nfunc fetch(url string) ([]byte, error) {\n\tvar body []byte\n\tfor attempt := 0; attempt < 3; attempt++ {\n\t\tbody, _ = get(url)\n\t}\n\treturn body, nil\n}";
  const c = ok<CodeSpec>("code", 'lang: go\nmark 3-5 "three-line retry loop"\nmark 4 error "_ discards the error"' + code);
  assert.deepEqual(c.emphasis, [{ key: "3", tone: "accent", note: "three-line retry loop", n: 1 }, { key: "5", tone: "accent" }, { key: "4", tone: "error", note: "_ discards the error", n: 2 }]);
  // The range's own first line, or a mark with no note: already marked, as before.
  assert.equal(drawn("code", 'mark 3-5 "loop"\nmark 3 error "bug"' + code).warnings[0]!.message, "mark 3: already marked, dropped");
  assert.equal(drawn("code", 'mark 3-5 "loop"\nmark 4 error' + code).warnings[0]!.message, "mark 4: already marked, dropped");
});

test("chart sizes and durations: one unit, each value converted", () => {
  const bytes = ok<ChartSpec>("chart", 'scale: log\nunit: bytes\nTweet 280\nJPEG photo 3.5MB\nFeature film 4GB\n"Wikipedia dump" 22GB');
  assert.deepEqual([bytes.unit, rows(bytes)], ["bytes", [["Tweet", 280], ["JPEG photo", 3.5e6], ["Feature film", 4e9], ["Wikipedia dump", 22e9]]]);
  // `G` is GB beside a size; `M` stays a magnitude.
  assert.deepEqual(rows(ok<ChartSpec>("chart", 'unit: bytes\n"JPEG" 3.5M\n"Film" 4.3G')), [["JPEG", 3.5e6], ["Film", 4.3e9]]);
  assert.deepEqual(rows(ok<ChartSpec>("chart", '"a" 1GiB\n"b" 512MiB')), [["a", 1024], ["b", 512]]);
  const ms = ok<ChartSpec>("chart", '"Node" 180ms\n"Java" 2.1s\n"Batch" 1.5 min');
  assert.deepEqual([ms.unit, rows(ms)], ["ms", [["Node", 180], ["Java", 2100], ["Batch", 90000]]]);
  const s = ok<ChartSpec>("chart", 'unit: s\n"a" 120ms\n"b" 3');
  assert.deepEqual([s.unit, rows(s)], ["s", [["a", 0.12], ["b", 3]]]);
  // One unit, or another family, or a scatter: as before.
  assert.equal(ok<ChartSpec>("chart", '"a" 4G\n"b" 5G').unit, "G");
  assert.match(err("chart", '"a" 4G\n"b" 5ms').message, /mixed units G and ms/);
  assert.match(err("chart", 'type: scatter\n"a" 1ms 2s').message, /mixed units ms and s/);
});

test("chart: bare words before a row's | are its label when it reads no other way", () => {
  assert.deepEqual(rows(ok<ChartSpec>("chart", "type: line\nSep 24 | 120\nSep 25 | 140")), [["Sep 24", 120], ["Sep 25", 140]]);
  assert.deepEqual(rows(ok<ChartSpec>("chart", "series: a, b\nSep 24 | 1 | 2")), [["Sep 24", 1, 2]]);
  assert.match(err("chart", "Sep 24 120").message, /quote a label with spaces: "Sep 24" 120/);
});

test("flow and state: the same node line written twice is one node", () => {
  const s = ok<FlowSpec>("state", "node s0 start\nnode done end\ns0 -> idle\nnode done end\nidle -> done");
  assert.deepEqual(shapes(s), { s0: "start", done: "end", idle: "round" });
  assert.match(err("state", "node done end\nnode done end warn").message, /node done is declared twice/);
  assert.match(err("flow", 'node a "A"\nnode a "B"').message, /node a is declared twice/);
});

test("flow and state: a node line with its shape before its id, or a label and no id", () => {
  // haiku R2 state-player: the final state's line, its id and shape swapped.
  const p = ok<FlowSpec>("state", 'node s0 start\nnode end done\ns0 -> stopped\nstopped -> done "quit"');
  assert.deepEqual(shapes(p), { s0: "start", done: "end", stopped: "round" });
  assert.deepEqual(edges(p), [["s0", "stopped", null, false], ["stopped", "done", "quit", false]]);
  // An edge naming the shape word as a node, or a tone after it: as before.
  assert.match(err("state", "node s0 start\nnode end done\ns0 -> end").message, /unknown word "done"/);
  assert.deepEqual(shapes(ok<FlowSpec>("state", "node end warn\na -> end")), { end: "round", a: "round" });
  // haiku R2 state-ticket: states named by label on their node lines and in edges.
  const t = ok<FlowSpec>("state", 'node s0 start\nnode New\nnode "In progress"\nnode "Waiting on customer" warn\ns0 -> New\nNew -> "In progress" "start work"\n"In progress" -> "Waiting on customer" "awaiting input"\nmark "Waiting on customer" info "SLA clock pauses"');
  assert.deepEqual(t.nodes.map((n) => [n.id, n.label, n.tone ?? null]), [["s0", "s0", null], ["New", "New", null], ["in-progress", "In progress", null], ["waiting-on-customer", "Waiting on customer", "warn"]]);
  assert.deepEqual(edges(t), [["s0", "New", null, false], ["New", "in-progress", "start work", false], ["in-progress", "waiting-on-customer", "awaiting input", false]]);
  assert.deepEqual(t.emphasis, [{ key: "waiting-on-customer", tone: "info", note: "SLA clock pauses", n: 1 }]);
  // In inline style the string after it is still the edge's; a word that could be an id: as before.
  assert.deepEqual(edges(ok<FlowSpec>("flow", 'node "Cache" store\napi "API" -> "Cache" "get"')), [["api", "cache", "get", false]]);
  assert.match(err("flow", 'node "In progress" prog').message, /expected a node id after node/);
});

test("timeline: a label's own tone or note; a mark without the row's (…)", () => {
  const t = ok<TimelineSpec>("timeline", '2024-03-01 | Alpha\n2024-06-30 | Beta warn\n2024-07-14 | GA "was 2024-06-30" ok\nmark "Beta" "slipped"');
  assert.deepEqual(t.items, [
    { type: "event", when: "2024-03-01", label: "Alpha" },
    { type: "event", when: "2024-06-30", label: "Beta", tone: "warn" },
    { type: "event", when: "2024-07-14", label: "GA", note: "was 2024-06-30", tone: "ok" },
  ]);
  assert.deepEqual(t.emphasis, [{ key: "1", tone: "accent", note: "slipped", n: 1 }]);
  // A quoted label, a tone field already there, or a note field already there: as written.
  const kept = ok<TimelineSpec>("timeline", '2024 | "Launch ok"\n2025 | Beta warn | late | error\n2026 | Beta "x" | note');
  assert.deepEqual(kept.items.map((i) => (i.type === "event" ? [i.label, i.note ?? null, i.tone ?? null] : null)), [["Launch ok", null, null], ["Beta warn", "late", "error"], ['Beta "x"', "note", null]]);
  const js = ok<TimelineSpec>("timeline", '2009 | CommonJS (Node.js)\n2015 | ES6 Modules (ECMAScript)\nmark CommonJS ok\nmark "ES6 Modules"');
  assert.deepEqual(js.emphasis?.map((e) => e.key), ["0", "1"]);
  assert.equal(drawn("timeline", "2009 | A (x)\n2015 | A (y)\nmark A").warnings[0]!.message, "mark: no row A, dropped");
});

test("wireframe: a leaf block written after a line's texts is another block", () => {
  const tree = (b: WBlock): unknown => [b.type, ...b.texts, ...(b.tone ? [b.tone] : []), ...(b.to !== undefined ? [`->${b.to}`] : []), ...(b.children.length ? [b.children.map(tree)] : [])];
  const w = ok<WireframeSpec>("wireframe", 'screen "Orders"\nlist\n  item "#1042" "2 items" badge "Delivered" ok -> "Detail"\n    button "Track"\ntext "Have an account?" link "Sign in" -> "Detail"\nbutton "Refund" | button "Resend"\nchart "Costs" parts\nscreen "Detail"\nheader "Order"');
  assert.deepEqual(w.screens[0]!.blocks.map(tree), [
    ["list", [["item", "#1042", "2 items", "->1", [["badge", "Delivered", "ok"], ["button", "Track"]]]]],
    ["text", "Have an account?"],
    ["link", "Sign in", "->1"],
    ["button", "Refund"],
    ["button", "Resend"],
    ["chart", "Costs"],
  ]);
  assert.equal(w.screens[0]!.blocks[5]!.chart, "pie");
  // A block word with no text of its own, or on a tabs line: as before.
  assert.equal(drawn("wireframe", 'button "Terms" link').warnings[0]!.message, 'ignored "link" (after the texts: a tone, on, wide)');
  assert.deepEqual(ok<WireframeSpec>("wireframe", 'tabs "A, B" button "C"').screens[0]!.blocks[0]!.items, ["A", "B", "button", "C"]);
});

test("flow, state and sequence: an arrow written backwards", () => {
  const f = ok<FlowSpec>("flow", 'vps "VPS cron" --> main "periodic pull"\napp "Live app" <- vps\nb <-- app');
  assert.deepEqual(edges(f), [["vps", "main", null, true], ["vps", "app", null, false], ["app", "b", null, true]]);
  assert.deepEqual([labels(f).app, labels(f).main], ["Live app", "periodic pull"]);
  const s = ok<SequenceSpec>("sequence", 'actor w "Worker"\nactor q "Queue"\nw <- q "dequeue"\nw <-- q "ack"');
  assert.deepEqual(s.steps, [{ type: "msg", from: "q", to: "w", label: "dequeue", dashed: false }, { type: "msg", from: "q", to: "w", label: "ack", dashed: true }]);
});

test("sequence: dashed or a tone after a message's label", () => {
  const s = ok<SequenceSpec>("sequence", 'actor app "App"\nactor auth "Auth"\napp -> auth "POST /token" dashed\napp -> auth "token request\\n(code + code_verifier)" accent\nauth --> app "tokens" dashed warn\nmark 2 "checks S256"');
  assert.deepEqual(s.steps.map((m) => (m.type === "msg" ? [m.label, m.dashed] : null)), [["POST /token", true], ["token request\n(code + code_verifier)", false], ["tokens", true]]);
  assert.deepEqual(s.emphasis, [{ key: "step:1", tone: "accent", note: "checks S256", n: 1 }, { key: "step:2", tone: "warn" }]);
  // Bare words stay the label; any other word after a string: as before.
  assert.equal((ok<SequenceSpec>("sequence", "a -> b hello accent").steps[0] as { label: string }).label, "hello accent");
  assert.match(err("sequence", 'a -> b "x" later').message, /one message per line/);
});

test("flow: two strings after an unlabelled target in edge-label style", () => {
  const f = ok<FlowSpec>("flow", 'bar -> parse "Parse URL"\nparse -> cache "Cache?" decision\ncache -> render "Render" "hit"\nresp -> render');
  assert.deepEqual(edges(f), [["bar", "parse", "Parse URL", false], ["parse", "cache", "Cache?", false], ["cache", "render", "hit", false], ["resp", "render", null, false]]);
  assert.deepEqual([labels(f).render, labels(f).cache], ["Render", "cache"]);
  // Labelled already, or three strings: as before.
  assert.match(err("flow", 'a -> r "R" "x"\nb -> r "y" "z"').message, /unexpected "z"/);
  assert.match(err("flow", 'a -> b "x" "y" "z"').message, /unexpected "y"/);
});

test("layers and timeline: a row ending in |, a tone field mark", () => {
  const l = ok<LayersSpec>("layers", "Registers | CPU registers | <1 ns |\nL1 | L1 cache | 1 ns | accent |\nDRAM | DIMMs | 100 ns | mark\nNVMe | SSD | 100 µs | muted\nmark L1 \"fast\"");
  assert.deepEqual(l.layers.map((x) => [x.label, x.note ?? null, x.tone ?? null]), [["Registers", "<1 ns", null], ["L1", "1 ns", "accent"], ["DRAM", "100 ns", null], ["NVMe", "100 µs", "muted"]]);
  assert.deepEqual(l.emphasis, [{ key: "1", tone: "accent", note: "fast", n: 1 }, { key: "2", tone: "accent" }]);
  // A mark line on the same row keeps its own tone and note.
  assert.deepEqual(ok<LayersSpec>("layers", 'A | x | n | mark\nmark A warn "why"').emphasis, [{ key: "0", tone: "warn", note: "why", n: 1 }]);
  const t = ok<TimelineSpec>("timeline", "2015 | Intern | first job |\n2023 | Manager | team of 6 | mark");
  assert.deepEqual([t.items.map((i) => (i.type === "event" ? i.note : null)), t.emphasis], [["first job", "team of 6"], [{ key: "1", tone: "accent" }]]);
  assert.match(err("layers", "A | x | n | store").message, /"store" is not a tone/);
});

test("matrix: Mark in capitals", () => {
  const m = ok<MatrixSpec>("matrix", 'columns: Chrome, Safari\nWebGPU | yes | partial\nMark "WebGPU" "gated"');
  assert.deepEqual(m.emphasis, [{ key: "0", tone: "accent", note: "gated", n: 1 }]);
});

test("tree: an extension glued after a quoted name", () => {
  const t = ok<TreeSpec>("tree", 'components/\n  "Nav Bar".tsx "the menu"\n  Footer.tsx\nmark "Nav Bar".tsx "refactor"');
  assert.deepEqual([t.roots[0]!.children[0]!.name, t.roots[0]!.children[0]!.note], ["Nav Bar.tsx", "the menu"]);
  assert.deepEqual(t.emphasis, [{ key: "0.0", tone: "accent", note: "refactor", n: 1 }]);
});

test("chart: a | glued to a value; more rows that settle the width", () => {
  const p = ok<ChartSpec>("chart", "type: stacked\nseries: Design, Build, QA\nv1.0 | 5 | 20 | 8\nv2.0 | 10| 35 | 15");
  assert.deepEqual(rows(p), [["v1.0", 5, 20, 8], ["v2.0", 10, 35, 15]]);
  const s = ok<ChartSpec>("chart", "type: scatter\niPhone 16 799 22\nGalaxy S24 859 21\nNothing Phone (2a) 349 19 accent");
  assert.deepEqual(rows(s), [["iPhone 16", 799, 22], ["Galaxy S24", 859, 21], ["Nothing Phone (2a)", 349, 19]]);
  const d = ok<ChartSpec>("chart", "type: line\nSep 24 120\nSep 25 135\nSep 26 128\nmark Sep 25 \"peak\"");
  assert.deepEqual([rows(d), d.emphasis?.map((e) => e.key)], [[["Sep 24", 120], ["Sep 25", 135], ["Sep 26", 128]], ["1"]]);
  // The same labels either way, or no repeated first word: as before.
  assert.match(err("chart", "Sep 24 120\nSep 24 130").message, /2 values; expected 1/);
  assert.match(err("chart", "Q1 2024 100\nQ2 2024 130").message, /2 values; expected 1/);
});
