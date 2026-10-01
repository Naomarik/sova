// Blocks models really wrote that failed to draw (sessions of 2026-09-27 to 09-30, and eval replies),
// replayed as written. The flow, tree, chart and mark ones had one plausible reading and now draw it;
// the sequence one fails with an error that quotes what to write instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowSpec } from "./kinds/flow/parse";
import { parseVis } from "./parse";

const ok = (kind: string, body: string): FlowSpec => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  assert.deepEqual(r.warnings, []);
  return r.spec as FlowSpec;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};
const node = (s: FlowSpec, id: string) => {
  const n = s.nodes.find((x) => x.id === id)!;
  return [n.label, n.note ?? null, n.shape, n.tone ?? null];
};
const edges = (s: FlowSpec) => s.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ""}`);

test("replay: declarations without `node` (09-28, 'expected an arrow after a1')", () => {
  const s = ok(
    "flow",
    "title: The spec lifecycle, master vs the branch\ncaption: Same steps; on the branch a tool enforces each one instead of the agent's memory.\ndir: right\n== Master today ==\na1 \"Worker starts\" round\na2 \"Write claims\"\na3 \"Edit code\"\na4 \"Census\" muted\na5 \"Evidence + promote\"\na6 \"Merge + Also changes\" warn\na1 -> a2 \"rule only if parent pastes it\"\na2 -> a3\na3 -> a4 \"if remembered\"\na4 -> a5\na5 -> a6 \"line from memory\"\n== The branch ==\nb1 \"Worker starts\" round\nb2 \"Write claims\"\nb3 \"Edit code\"\nb4 \"Census (automatic)\" ok\nb5 \"Evidence + promote\"\nb6 \"Landing gate\" accent\nb7 \"Merge + Also changes\" ok\nb1 -> b2 \"rule injected\"\nb2 -> b3\nb3 -> b4 \"after every command\"\nb4 -> b5\nb5 -> b6 \"unmapped files need a claim\"\nb6 -> b7 \"list computed from git\"\nmark b4 warn \"runs per command, not per file: the round-3 failure\"\nmark b7 \"wrong line sent back\"\n",
  );
  assert.deepEqual(s.sections!.map((p) => p.nodes.map((n) => n.label)), [
    ["Worker starts", "Write claims", "Edit code", "Census", "Evidence + promote", "Merge + Also changes"],
    ["Worker starts", "Write claims", "Edit code", "Census (automatic)", "Evidence + promote", "Landing gate", "Merge + Also changes"],
  ]);
  assert.deepEqual(node(s, "a1"), ["Worker starts", null, "round", null]);
  assert.deepEqual(node(s, "b4"), ["Census (automatic)", null, "box", "ok"]);
  assert.deepEqual(edges(s).slice(0, 5), ["a1>a2:rule only if parent pastes it", "a2>a3", "a3>a4:if remembered", "a4>a5", "a5>a6:line from memory"]);
  assert.deepEqual(s.emphasis!.map((e) => e.key), ["b4", "b7"]);
});

test("replay: two strings after a chain's source (09-29, 'expected an arrow after ev')", () => {
  const s = ok(
    "flow",
    "title: Checking moves vs making them\ncaption: In (a) the chart only says yes or no; in (c) it also starts the action itself.\n== Chart checks (a) ==\nev \"Something happens\" \"gathering ends\" -> llm \"Overseer LLM\" \"judges what to do\" round accent\nllm -> chk \"Chart: allowed now?\" decision\nchk -> act \"Action happens\" \"yes\"\nchk --> llm \"no: refusal sentence\"\n== Chart acts (c) ==\nev2 \"Something happens\" \"gathering ends\" -> ch2 \"Chart\" \"sees it and acts\" round warn\nch2 -> act2 \"Action happens\"\nch2 --> llm2 \"LLM only writes the words\"\nmark ch2 warn \"no judgment between the fact and the action\"\n",
  );
  assert.deepEqual(node(s, "ev"), ["Something happens", "gathering ends", "box", null]);
  assert.deepEqual(node(s, "ev2"), ["Something happens", "gathering ends", "box", null]);
  // After a target the second string stays the edge's, as it always was.
  assert.deepEqual(node(s, "llm"), ["Overseer LLM", null, "round", "accent"]);
  assert.deepEqual(edges(s).slice(0, 4), ["ev>llm:judges what to do", "llm>chk", "chk>act:yes", "chk>llm:no: refusal sentence"]);
});

test("replay: two strings after a chain's source, and a target's second string (09-29, 'expected an arrow after g1')", () => {
  const s = ok(
    "flow",
    "title: Before and after the refit\ncaption: The pieces had states before; the gaps between them were English notes.\n== Before ==\ng1 \"Gathering\" \"own states\" -> n1 \"English note\" warn -> ai1 \"Overseer guesses next step\" round\nai1 --> d1 \"Decision\" \"own states\"\nd1 -> n2 \"English note\" warn -> ai1\n== After ==\ng2 \"Gathering chart\" accent -> d2 \"Decision chart\" accent -> b2 \"Build chart\" accent\nb2 -> m2 \"Merged\"\n",
  );
  assert.deepEqual(node(s, "g1"), ["Gathering", "own states", "box", null]);
  assert.deepEqual(node(s, "n1"), ["English note", null, "box", "warn"]);
  assert.deepEqual(node(s, "d1"), ["Decision", null, "box", null]);
  assert.deepEqual(edges(s).slice(0, 5), ["g1>n1", "n1>ai1", "ai1>d1:own states", "d1>n2", "n2>ai1"]);
});

test("replay: a tree folder's slash outside the quotes (09-29) draws the folders", () => {
  const r = parseVis(
    "tree",
    "title: What competes and what adds on\ncaption: Pick one per decision; add-ons go with any pick.\n\"q12 · Empty screen: pick one\"/\n  \"a · Preset cards + summary (prototype)\"\n  \"b · Select + what changes\" accent\n  \"c · Loadout sentence\"\n  \"d · Composer pill\"\n  \"Add-on: Capability board = what Custom… opens\" ok\n\"q13 · Home for saved profiles: pick one\"/\n  \"Settings → Profiles tab\" accent\n  \"Workflow launcher page\"\n  \"Add-on: Save as Profile from Custom\" ok\n  \"Add-on: Overseer proposal / started cards\" ok\n\"q14 · Session list top group: pick one\"/\n  \"a · Profile shelf\" accent\n  \"b · Stations strip\"\n  \"c · Quiet place\"\n  \"d · Traffic first\"\n  \"Add-on: New Session ▾ menu of profiles\" ok\n  \"Add-on: sender line on received messages\" ok\n  \"Add-on: Activity tab (later)\" ok\n",
  );
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  assert.deepEqual(r.warnings, []);
  const roots = (r.spec as { roots: { name: string; children: unknown[] }[] }).roots;
  assert.deepEqual(roots.map((x) => [x.name, x.children.length]), [
    ["q12 · Empty screen: pick one/", 5],
    ["q13 · Home for saved profiles: pick one/", 4],
    ["q14 · Session list top group: pick one/", 7],
  ]);
});

test("replay: a Mermaid sequence message (09-27) reads as the vis message (§chat.markdown/vis-lenience-content)", () => {
  const r = parseVis("sequence", "title: TCP + TLS handshake\ncaption: Three messages open the socket; TLS rides on top.\nClient -> Server: SYN\nClient -> Server \"ACK\"\nmark 2 \"the server commits resources here\"\n");
  assert.ok(r.ok && r.warnings.length === 0);
  assert.deepEqual((r.spec as { steps: unknown[] }).steps[0], { type: "msg", from: "Client", to: "Server", label: "SYN", dashed: false });
});

test("replay: chart parts over `of:` (09-29, twice) draw without of:, with a warning", () => {
  for (const body of [
    "type: parts\nunit: MB\nof: 4.19\n\"21 earlier screenshots (read tool)\" 4.18 warn\n\"Text + your new image + JSON\" 0.23\nmark \"21 earlier screenshots (read tool)\" \"the part that grows\"\n",
    "type: parts\nunit: MB\nof: 4.19\n\"21 earlier screenshots\" 4.18 error\n\"Text + JSON framing\" 0.23\nmark \"21 earlier screenshots\" \"total 4.41 MB, over the line\"\n",
  ]) {
    const r = parseVis("chart", body);
    if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
    assert.deepEqual(r.warnings, [{ line: 3, message: "the parts add up to 4.41, more than of: 4.19: drawn without of:" }]);
    const spec = r.spec as { of?: number; rows: unknown[]; emphasis?: unknown[] };
    assert.deepEqual([spec.of, spec.rows.length, spec.emphasis!.length], [undefined, 2, 1]);
  }
});

test("replay: a timeline mark on a date with a space (09-30, 'mark: unexpected 30') marks that row", () => {
  const r = parseVis("timeline", "title: Active window per day (first \u2192 last commit)\ncaption: Code lands around the clock, every day \u2014 00:0x to 23:5x, not in human workday bursts.\nSep 19 | 08:27 \u2013 23:51 | 75 commits\nSep 20 | 00:20 \u2013 15:04 | 26 commits\nSep 21 | 01:52 \u2013 23:59 | 74 commits\nSep 22 | 00:00 \u2013 22:55 | 207 commits\nSep 23 | 05:02 \u2013 22:56 | 25 commits\nSep 24 | 00:26 \u2013 23:57 | 70 commits\nSep 25 | 00:28 \u2013 23:51 | 237 commits\nSep 26 | 00:22 \u2013 23:14 | 92 commits\nSep 27 | 01:08 \u2013 23:29 | 211 commits\nSep 28 | 00:33 \u2013 23:58 | 265 commits\nSep 29 | 00:03 \u2013 23:22 | 275 commits\nSep 30 | 00:09 \u2013 22:43 | 495 commits\nmark Sep 30 \"one commit every ~2.7 minutes, all day\"\n");
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual((r.spec as { emphasis?: unknown[] }).emphasis, [{ key: "11", tone: "accent", note: "one commit every ~2.7 minutes, all day", n: 1 }]);
});

test("replay: two ids as one mark (a Haiku eval reply, 'mark: unexpected s3') mark both, one note", () => {
  const flow = ok("flow", "title: Image Upload Strategies  \ncaption: Server-mediated vs. direct-to-S3 with presigned URLs.\n\n== Through API Server ==\nbrowser \"Browser\" -> api \"API Server\" \"POST /upload\"\napi -> s3 \"S3\" \"PUT\"\ns3 --> api \"OK\"\napi --> browser \"Success\"\nmark api \"processes all image data\"\n\n== Direct to S3 ==\nbrowser \"Browser\" -> api \"API Server\" \"GET /presigned-url\"\napi --> browser \"Signed URL\"\nbrowser -> s3 \"S3\" \"PUT (signed)\"\ns3 --> browser \"Success\"\nmark browser s3 \"direct upload, no server proxy\"\n");
  // Ids name the first panel that has them (§chat.markdown/vis-flow-sections), as a lone `mark browser` does.
  assert.deepEqual(flow.emphasis!.map((e) => [e.key, e.n]), [["api", 1], ["browser", 2], ["s3", 2]]);
});

// The other shapes an earlier eval's report names (`mark Data tier`, `mark a -> b`), in blocks written around them.
test("replay: a layer label with a space marks it; an unreadable mark is dropped", () => {
  const layers = parseVis("layers", "Web tier | nginx\nData tier | Postgres, Redis\nmark Data tier warn \"one primary\"\n");
  if (!layers.ok) assert.fail(layers.message);
  assert.deepEqual([layers.warnings, (layers.spec as { emphasis?: unknown[] }).emphasis], [[], [{ key: "1", tone: "warn", note: "one primary", n: 1 }]]);
  const arrow = parseVis("flow", 'a -> b\nmark a -> b "the hop"\nmark b\n');
  if (!arrow.ok) assert.fail(arrow.message);
  assert.deepEqual(arrow.warnings, [{ line: 2, message: 'mark: unexpected -> (after the target: a tone and/or a "note"); mark dropped' }]);
  assert.deepEqual((arrow.spec as FlowSpec).emphasis!.map((e) => e.key), ["b"]);
});

test("replay: a layers row with its tone before its note (eval, glm-5.3) draws with the two swapped; timeline too", () => {
  const r = parseVis("layers", "title: The TCP/IP model\ncaption: Ports live at the Transport layer — TCP and UDP carry the port numbers.\nApplication | HTTP, DNS\nTransport | TCP, UDP | accent | where ports live\nInternet | IP, ICMP\nLink | Ethernet, Wi-Fi\nmark Transport \"port numbers appear here\"\n");
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual((r.spec as { layers: unknown[] }).layers[1], { label: "Transport", items: ["TCP", "UDP"], note: "where ports live", tone: "accent" });
  const t = parseVis("timeline", "Sep 30 | Outage | error | 47 minutes\n");
  assert.ok(t.ok);
  assert.deepEqual((t.spec as { items: unknown[] }).items[0], { type: "event", when: "Sep 30", label: "Outage", note: "47 minutes", tone: "error" });
  // Only a row that couldn't be read otherwise: a trailing tone reads as before, no tone at all is still an error.
  const both = parseVis("layers", "A | b | warn | error\n");
  assert.deepEqual(both.ok && (both.spec as { layers: unknown[] }).layers[0], { label: "A", items: ["b"], note: "warn", tone: "error" });
  assert.equal(parseVis("layers", "A | b | c | d\n").ok, false);
  assert.equal(parseVis("timeline", "2020 | a | b | c\n").ok, false);
});

// Four blocks from sessions (09-2x) that failed on a line with one reading, replayed as written.
test("replay: `node` as an id, `-> done end` in a state, a dotted Mermaid arrow, a code `mark:` line", () => {
  const nodeId = ok("flow", 'title: App Deployment Architecture\ncaption: Both services run in a single Node process on the VM.\nclients "Clients" -> nginx "nginx\\nreverse proxy"\nnginx -> node "Node.js process\\n(API + Job runner)"\nnode -> db "Managed Postgres"\nmark node "one VM, one process, two services"\n');
  assert.deepEqual(edges(nodeId), ["clients>nginx", "nginx>node", "node>db"]);
  assert.deepEqual(nodeId.emphasis!.map((e) => e.key), ["node"]);
  const state = ok("state", 'node s0 start\ns0 -> placed\nplaced -> paid "payment received"\nplaced -> cancelled "cancel before payment"\npaid -> delivered "ships"\ndelivered -> done end\ncancelled -> done end\nmark paid "payment committed"\n');
  assert.deepEqual(node(state, "done"), ["done", null, "end", null]);
  assert.deepEqual(edges(state).slice(-2), ["delivered>done", "cancelled>done"]);
  const dotted = ok("flow", 'client "Client" -> gw "API Gateway\\nRoutes & load balances"\ngw -> auth "Auth Service\\nValidates tokens, manages users"\nauth -.-> gw "token valid?"\n');
  assert.deepEqual(dotted.edges.map((e) => [e.from, e.to, e.label ?? null, e.dashed]), [["client", "gw", null, false], ["gw", "auth", null, false], ["auth", "gw", "token valid?", true]]);
  const code = parseVis("code", 'lang: js\nmark: 3 error "off-by-one: should be i < arr.length"\nmark: 4 "arr[i] is undefined when i === arr.length, making total NaN"\n---\nfunction sum(arr) {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\n');
  if (!code.ok) assert.fail(code.message);
  assert.deepEqual(code.warnings, []);
  assert.deepEqual((code.spec as { emphasis?: unknown[] }).emphasis, [{ key: "3", tone: "error", note: "off-by-one: should be i < arr.length", n: 1 }, { key: "4", tone: "accent", note: "arr[i] is undefined when i === arr.length, making total NaN", n: 2 }]);
});

test("round 2 leniences keep their bounds: `node a` still declares, an indented or empty mark: is not a mark, shapes in a plain chain need an id before them", () => {
  assert.deepEqual(node(ok("flow", 'node a "A" round\na -> b\n'), "a"), ["A", null, "round", null]);
  const tree = parseVis("tree", "root\n  mark: x\n");
  assert.equal(tree.ok, false, "an indented mark: is a setting the tree doesn't take, as before");
  assert.equal(parseVis("timeline", "2020 | a\nmark:\n").ok, false, "mark: with nothing after it is still an unknown setting");
  const plain = ok("flow", 'a -> b "go" decision\nb -> c\n');
  assert.deepEqual([node(plain, "b"), plain.edges[0]!.label], [["b", null, "decision", null], "go"]);
  assert.equal(parseVis("flow", "a -> b round square\n").ok, false);
});

test("replay: a labelled target's two strings (a Haiku eval reply, 'unexpected \"multipart stream\" after s3b') are its edge's two lines", () => {
  const s = ok("flow", 'title: Image Upload Strategies\ncaption: API-mediated vs. direct-to-cloud with presigned URLs.\n\n== Upload via API ==\nclient "Client (browser)" -> api "API server" "POST /upload"\napi -> s3 "S3 bucket" "PutObject"\ns3 --> api "upload complete"\napi --> client "image URL"\ngroup "One round trip" client api s3\nmark api "all traffic passes through"\n\n== Presigned URL (direct upload) ==\nclient "Client" -> api2 "API server" "POST /presign"\napi2 -> s3b "S3 bucket" "GeneratePresignedURL"\ns3b --> api2 "signed URL"\napi2 --> client "URL + headers"\nclient -> s3b "PUT (signed)" "multipart stream"\ns3b --> client "201 Created"\ngroup "Separate flows" api2 s3b\nmark client "handles large files without tying up server"\nmark s3b "validates signature, not your auth"\n');
  assert.deepEqual(edges(s).slice(-2), ["client@2>s3b:PUT (signed)\nmultipart stream", "s3b>client@2:201 Created"]);
  assert.deepEqual(node(s, "s3b"), ["S3 bucket", null, "box", null]);
});

test("replay: a string after a labelled target's tone (a Haiku eval reply, 'strings go before shape and tone words') labels the edge", () => {
  const s = ok("flow", 'title: CI/CD Pipeline\ncaption: Automated testing and linting, then manual approval before production deployment.\nlint "Lint\\n(eslint + prettier)" -> test "Test\\n(vitest)" -> build "Build\\n(docker image)" -> staging "Deploy to staging" -> approval "Manual approval?" decision\napproval -> prod "Deploy to prod" ok\napproval -> staging error "rejected"\nmark approval "gates production"\n');
  assert.deepEqual(edges(s).slice(-2), ["approval>prod", "approval>staging:rejected"]);
  assert.deepEqual(node(s, "staging"), ["Deploy to staging", null, "box", "error"]);
});
