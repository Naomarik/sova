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
  for (const quoted of ['web "Browser tab" ->', 'srv "Sova server" "WS /ws/chat"', 'sdk --> srv "events"', 'done "Reply streamed?" decision']) assert.ok(GUIDE.includes(`\`${quoted}\``), `the bullets quote the example: ${quoted}`);
  // Each bullet's own example means what the bullet says. Two lines anywhere: \n in the label.
  const flow = (body: string) => {
    const r = parseVis("flow", body);
    assert.ok(r.ok, body);
    return r.spec as FlowSpec;
  };
  assert.ok(GUIDE.includes('`-> gw "Gateway\\nKong"`'));
  assert.deepEqual(flow('web "Web" -> gw "Gateway\\nKong"').nodes[1]!.label, "Gateway\nKong");
  // After a target, the second string is the edge's, never a second line (the eval's most common misread).
  assert.ok(GUIDE.includes("after a target, the first string labels it and the second labels the edge, never a second line."));
  const kong = flow('web "Web" -> gw "Gateway" "Kong"');
  assert.deepEqual([kong.nodes[1]!.note, kong.edges[0]!.label], [undefined, "Kong"]);
  // A declaration alone on a line, then a string after db as a target is the edge's (inline fence or not).
  assert.ok(GUIDE.includes('`node db "Orders" store` alone on a line declares a node; then `api -> db "SQL"` labels the edge'));
  for (const body of ['node db "Orders" store\napi -> db "SQL"', 'node db "Orders" store\napi "API" -> db "SQL"']) {
    const s = flow(body);
    const db = s.nodes.find((n) => n.id === "db")!;
    assert.deepEqual([db.label, db.shape, s.edges[0]!.label], ["Orders", "store", "SQL"]);
  }
  // The eval (EVAL-REPORT.md): showing any two-string node in the flow section led a weak model to
  // write `-> b "B" "role"` on targets, drawing the role on the arrow. The parser reads a source's
  // second string and a declaration without `node`, but the guide teaches only `\n`.
  const flowSection = sections.find((s) => s.heading === "flow")!.text.replace(/<!--[\s\S]*?-->/g, "");
  // An id then two strings, at a line's or a bullet's start: only the target bullet's label + edge pair.
  const pairs = [...flowSection.matchAll(/(?:^|`)([a-z]\w*) "[^"]*" "[^"]*"/gm)].map((m) => m[1]);
  assert.deepEqual(pairs, ["srv"], "no two-string node is shown");
  // Groups: the main example frames the server and the session it holds.
  assert.deepEqual(main.groups, [{ label: "One process", nodes: ["srv", "sdk"] }]);
  // Panels: the same ids in both panels are two nodes each.
  assert.deepEqual(panels.sections!.map((p) => p.nodes.map((n) => n.label)), [["App", "Database"], ["App", "Cache", "Database"]]);
  // State: no inline label anywhere, so each string after a target is its edge's event.
  assert.deepEqual(state.edges.map((e) => e.label ?? null), [null, "prompt", "settled", "error"]);
  assert.ok(state.nodes.every((n) => n.label === n.id));
});

// The rules' "Not vis" pairs: the Mermaid side fails with a hint, the vis side draws what it says.
test("the guide's Not vis pairs: the wrong side is refused with a hint, the right side means it", () => {
  assert.match(GUIDE, /`A->>B: msg` is `a -> b "msg"`; `A\[Label\] --> B` is `a "Label" --> b`/);
  const seq = parseVis("sequence", 'A->>B: msg');
  assert.ok(!seq.ok && seq.message === 'write A -> B "msg" (not Mermaid a ->> b: msg)');
  const msg = parseVis("sequence", 'a -> b "msg"');
  assert.ok(msg.ok);
  assert.deepEqual((msg.spec as { steps: unknown[] }).steps, [{ type: "msg", from: "a", to: "b", label: "msg", dashed: false }]);
  assert.ok(!parseVis("flow", "A[Label] --> B").ok);
  const flow = parseVis("flow", 'a "Label" --> b');
  assert.ok(flow.ok);
  assert.deepEqual([(flow.spec as FlowSpec).nodes[0]!.label, (flow.spec as FlowSpec).edges[0]!.dashed], ["Label", true]);
  // Tree: the folder's slash inside the quotes.
  assert.match(GUIDE, /`"My Docs\/" "shared"`/);
  const tree = parseVis("tree", '"My Docs/" "shared"');
  assert.ok(tree.ok && (tree.spec as { roots: { name: string; note?: string }[] }).roots[0]!.name === "My Docs/");
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

test("the shared section exists (emphasis), and the free-form limits are in html / svg", () => {
  const shared = sections.filter((s) => s.heading.startsWith("Shared:")).map((s) => s.heading);
  assert.deepEqual(shared, ["Shared: emphasis"]);
  assert.match(sections.find((s) => s.heading === "html / svg")!.text, /Aim under 8K characters/);
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
  assert.doesNotMatch(g, /shows the block as source/);
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
