// Blocks models really wrote that failed to draw (sessions of 2026-09-27 to 09-29), replayed as
// written. The flow ones had one plausible reading and now draw it; the rest fail with an error that
// quotes what to write instead.
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

test("replay: a tree folder's slash outside the quotes (09-29) says to move it inside", () => {
  const e = err(
    "tree",
    "title: What competes and what adds on\ncaption: Pick one per decision; add-ons go with any pick.\n\"q12 · Empty screen: pick one\"/\n  \"a · Preset cards + summary (prototype)\"\n  \"b · Select + what changes\" accent\n  \"c · Loadout sentence\"\n  \"d · Composer pill\"\n  \"Add-on: Capability board = what Custom… opens\" ok\n\"q13 · Home for saved profiles: pick one\"/\n  \"Settings → Profiles tab\" accent\n  \"Workflow launcher page\"\n  \"Add-on: Save as Profile from Custom\" ok\n  \"Add-on: Overseer proposal / started cards\" ok\n\"q14 · Session list top group: pick one\"/\n  \"a · Profile shelf\" accent\n  \"b · Stations strip\"\n  \"c · Quiet place\"\n  \"d · Traffic first\"\n  \"Add-on: New Session ▾ menu of profiles\" ok\n  \"Add-on: sender line on received messages\" ok\n  \"Add-on: Activity tab (later)\" ok\n",
  );
  assert.deepEqual([e.line, e.message], [3, 'put the / inside the quotes: "q12 · Empty screen: pick one/"']);
});

test("replay: a Mermaid sequence message (09-27) quotes the vis message", () => {
  const e = err("sequence", "title: TCP + TLS handshake\ncaption: Three messages open the socket; TLS rides on top.\nClient -> Server: SYN\nmark 2 \"the server commits resources here\"\n");
  assert.deepEqual([e.line, e.message], [3, 'write Client -> Server "SYN" (not Mermaid a -> b: msg)']);
});

test("replay: chart parts over `of:` (09-29, twice) keep their precise error", () => {
  for (const body of [
    "type: parts\nunit: MB\nof: 4.19\n\"21 earlier screenshots (read tool)\" 4.18 warn\n\"Text + your new image + JSON\" 0.23\nmark \"21 earlier screenshots (read tool)\" \"the part that grows\"\n",
    "type: parts\nunit: MB\nof: 4.19\n\"21 earlier screenshots\" 4.18 error\n\"Text + JSON framing\" 0.23\nmark \"21 earlier screenshots\" \"total 4.41 MB, over the line\"\n",
  ]) {
    const e = err("chart", body);
    assert.deepEqual([e.line, e.message], [3, "the parts add up to 4.41, more than of: 4.19"]);
  }
});
