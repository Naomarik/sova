// The model is taught the formats by pi-config/extensions/mode/vis-mode.md. Every example there is a
// second implementation of the grammar, so each must parse with the renderer's own parser; and the
// guide's sections must match the registry, so no kind is taught that the chat can't draw.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_TEXT } from "./core/grammar";
import type { FlowSpec } from "./kinds/flow/parse";
import type { MatrixSpec } from "./kinds/matrix/parse";
import { FRAME_HARD_CHARS, FRAME_SOFT_CHARS } from "./kinds/frame/parse";
import { parseVis, visKindWord } from "./parse";
import { KIND_WORDS, KINDS } from "./registry";
import { gatheringVisGuide, SHARE_VIS_KINDS } from "../../server/baton-vis-guide";

const GUIDE = readFileSync(new URL("../../pi-config/extensions/mode/vis-mode.md", import.meta.url), "utf8");

/** `## heading` → its text, for every section. "Shared:" sections belong to no kind. */
const sections = GUIDE.split(/^(?=## )/m)
  .filter((s) => s.startsWith("## "))
  .map((s) => ({ heading: s.slice(3, s.indexOf("\n")).trim(), text: s }));
const kindSections = sections.filter((s) => !s.heading.startsWith("Shared:"));
const wordsOf = (heading: string) => heading.split(/\s*\/\s*/);

test("every vis example in the guide parses", () => {
  const fences = [...GUIDE.matchAll(/^```(vis [a-z]+)\n([\s\S]*?)^```$/gm)];
  assert.ok(fences.length >= 8, "the guide shows examples");
  for (const [, info, body] of fences) {
    const r = parseVis(visKindWord(info!)!, body!);
    assert.ok(r.ok, `${info}: ${r.ok ? "" : `line ${r.line}: ${r.message}`}`);
    assert.deepEqual(r.warnings, [], `${info}: an example draws without warnings`);
  }
});

// The flow section's rule is conditional (inline style vs edge labels), so its examples must mean
// what the text says they mean, not merely parse.
test("the guide's flow and state examples mean what the text says", () => {
  const fences = [...GUIDE.matchAll(/^```vis (flow|state)\n([\s\S]*?)^```$/gm)].map(([, kind, body]) => {
    const r = parseVis(kind!, body!);
    assert.ok(r.ok);
    return r.spec as FlowSpec;
  });
  const [main, panels, state] = fences as [FlowSpec, FlowSpec, FlowSpec];
  const labels = (s: { nodes: { id: string; label: string }[] }) => Object.fromEntries(s.nodes.map((n) => [n.id, n.label]));
  // Inline: a node's first string is its label, the next the edge's; after a labelled node, a string is the edge's.
  assert.deepEqual(labels(main), { web: "Browser tab", srv: "Sova server", sdk: "pi session", done: "Reply streamed?" });
  assert.deepEqual(main.edges.map((e) => [e.from, e.to, e.label ?? null]), [["web", "srv", "WS /ws/chat"], ["srv", "sdk", null], ["sdk", "srv", "events"], ["srv", "done", null], ["done", "web", "yes"]]);
  assert.deepEqual(main.nodes.map((n) => n.shape), ["box", "box", "store", "decision"]);
  for (const quoted of ['srv "Sova server" "WS /ws/chat"', 'sdk --> srv "events"', 'done "Reply streamed?" decision']) assert.ok(GUIDE.includes(`\`${quoted}\``), `the bullets quote the example: ${quoted}`);
  // Groups: the main example frames the server and the session it holds.
  assert.deepEqual(main.groups, [{ label: "One process", nodes: ["srv", "sdk"] }]);
  // Panels: the same ids in both panels are two nodes each.
  assert.deepEqual(panels.sections!.map((p) => p.nodes.map((n) => n.label)), [["App", "Database"], ["App", "Cache", "Database"]]);
  // State: no inline label anywhere, so each string after a target is its edge's event.
  assert.deepEqual(state.edges.map((e) => e.label ?? null), [null, "prompt", "settled", "error"]);
  assert.ok(state.nodes.every((n) => n.label === n.id));
});

test("each kind section names registered kinds, and every registered kind has a section", () => {
  const named = kindSections.flatMap((s) => wordsOf(s.heading));
  for (const word of named) assert.ok(KIND_WORDS.includes(word), `## ${word} is not in registry.ts`);
  for (const word of KIND_WORDS) assert.ok(named.includes(word), `registry.ts kind ${word} has no ## section in vis-mode.md`);
});

test("a stub kind in the registry is a stub section in the guide, and only then", () => {
  for (const s of kindSections) {
    const stubbed = s.text.includes("<!-- stub -->");
    for (const word of wordsOf(s.heading)) assert.equal(!!KINDS[word]!.stub, stubbed, `${word}: registry stub=${!!KINDS[word]!.stub}, guide stub=${stubbed}`);
  }
});

test("the shared sections exist: emphasis and the free-form limits", () => {
  const shared = sections.filter((s) => s.heading.startsWith("Shared:")).map((s) => s.heading);
  assert.deepEqual(shared, ["Shared: emphasis", "Shared: free-form limits"]);
  assert.match(GUIDE, /mark <target> \[tone\] \["short note"\]/, "the emphasis syntax as core/emphasis.ts parses it");
  assert.match(GUIDE, /Aim under 8K characters \(the document after `title:` \/ `caption:`\); up to 16K draws marked large/);
  assert.equal(FRAME_SOFT_CHARS, 8 * 1024);
  assert.equal(FRAME_HARD_CHARS, 16 * 1024);
  assert.match(GUIDE, /at most 200 characters/);
  assert.equal(MAX_TEXT, 200);
});

test("the guide teaches several targets per mark and matrix cell tones, with examples that mean it", () => {
  assert.match(GUIDE, /`mark a, b, c "the scope set"`/);
  const matrix = [...GUIDE.matchAll(/^```vis matrix\n([\s\S]*?)^```$/gm)].map(([, body]) => parseVis("matrix", body!));
  const cells = matrix.flatMap((r) => (r.ok ? (r.spec as MatrixSpec).rows.flatMap((row) => row.cells) : []));
  assert.ok(cells.some((c) => c.tone === "ok") && cells.some((c) => c.tone === "warn"), "the matrix example tones a text cell");
});

// server/baton-vis-guide.ts rewrites this one line for gathering sessions, by its start.
test("the rules keep the '- The parser is strict:' line the gathering guide rewrites", () => {
  assert.match(GUIDE, /^Rules for every kind:\n(?:- .*\n)*- The parser is strict: .*$/m);
  const g = gatheringVisGuide(GUIDE);
  assert.match(g, /^- The parser is strict: use only the syntax below, or the person sees no drawing at all\.$/m);
  assert.doesNotMatch(g, /shows the block as plain source/);
});

// A gathering session's guide (§app.baton/abilities): the business kinds' sections of this same
// guide, so its examples are these; each must parse, and nothing else may be taught to it.
test("the gathering guide teaches only the share page's kinds, and its examples parse", () => {
  const g = gatheringVisGuide(GUIDE);
  const taught = [...g.matchAll(/^## (.*)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(taught, ["Shared: emphasis", ...KIND_WORDS.filter((w) => (SHARE_VIS_KINDS as readonly string[]).includes(w))]);
  assert.doesNotMatch(g, /<!--|vis html|vis svg|8K|16K/, "no owner notes, frames or their limits");
  assert.match(g, /Never draw people, roles, the roster, who decides what/);
  const fences = [...g.matchAll(/^```(vis [a-z]+)\n([\s\S]*?)^```$/gm)];
  assert.ok(fences.length >= SHARE_VIS_KINDS.length);
  for (const [, info, body] of fences) {
    const word = visKindWord(info!)!;
    assert.ok((SHARE_VIS_KINDS as readonly string[]).includes(word), info);
    const r = parseVis(word, body!);
    assert.ok(r.ok, `${info}: ${r.ok ? "" : `line ${r.line}: ${r.message}`}`);
  }
});
