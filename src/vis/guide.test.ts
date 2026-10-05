// The model is taught the formats by pi-config/extensions/mode/vis/: overview.md (the prompt's kind
// list), shared.md and one file per kind, which the vis_guide tool returns. Every example there is a
// second implementation of the grammar, so each must parse with the renderer's own parser; and the
// guide's files must match the registry, so no kind is taught that the chat can't draw.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_TEXT } from "./core/grammar";
import type { FlowSpec } from "./kinds/flow/parse";
import type { MatrixSpec } from "./kinds/matrix/parse";
import { FRAME_HARD_CHARS, FRAME_SOFT_CHARS } from "./kinds/frame/parse";
import { parseVis, visKindWord } from "./parse";
import { KIND_WORDS, KINDS } from "./registry";
import { gatheringVisGuide, SHARE_VIS_KINDS } from "../../server/baton-vis-guide";
import { stripVisComments, VIS_INSTRUCTIONS, VIS_KINDS, visGuide } from "../../pi-config/extensions/mode/minor.ts";

const VIS_DIR = new URL("../../pi-config/extensions/mode/vis/", import.meta.url);
/** Every file in vis/ by its name without `.md`, as written. */
const FILES: Record<string, string> = Object.fromEntries(
  readdirSync(VIS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name.slice(0, -3), readFileSync(new URL(name, VIS_DIR), "utf8")]),
);
/** The whole guide, for the checks that don't care which file holds a line. */
const GUIDE = Object.values(FILES).join("\n");

/** Each kind's file: its name, its `# vis <kind>` heading's words, its text. overview and shared are no kind's. */
const kindFiles = Object.entries(FILES)
  .filter(([name]) => name !== "overview" && name !== "shared")
  .map(([name, text]) => ({ name, heading: /^# vis (.*)$/m.exec(text)?.[1]?.trim() ?? "", text }));
const wordsOf = (heading: string) => heading.split(/\s*\/\s*/);
const isStub = (word: string) => !!KINDS[word]!.stub;

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
  const fences = [...`${FILES.flow}\n${FILES.state}`.matchAll(/^```vis (flow|state)\n([\s\S]*?)^```$/gm)].map(([, kind, body]) => {
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
  // In an offline eval of weak models (2026-09-30), showing any two-string node in the flow section
  // led one to write `-> b "B" "role"` on targets, drawing the role on the arrow. The parser reads a
  // source's second string and a declaration without `node`, but the guide teaches only `\n`.
  const flowSection = FILES.flow!.replace(/<!--[\s\S]*?-->/g, "");
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
test("the guide's Not vis pairs: the right side means it, and the wrong side (read anyway) means the same", () => {
  assert.match(GUIDE, /`A->>B: msg` is `a -> b "msg"`; `A\[Label\] --> B` is `a "Label" --> b`/);
  const msg = parseVis("sequence", 'a -> b "msg"');
  assert.ok(msg.ok);
  assert.deepEqual((msg.spec as { steps: unknown[] }).steps, [{ type: "msg", from: "a", to: "b", label: "msg", dashed: false }]);
  const seq = parseVis("sequence", "A->>B: msg");
  assert.ok(seq.ok);
  assert.deepEqual((seq.spec as { steps: unknown[] }).steps, [{ type: "msg", from: "A", to: "B", label: "msg", dashed: false }]);
  const flow = parseVis("flow", 'a "Label" --> b');
  assert.ok(flow.ok);
  assert.deepEqual([(flow.spec as FlowSpec).nodes[0]!.label, (flow.spec as FlowSpec).edges[0]!.dashed], ["Label", true]);
  const mermaid = parseVis("flow", "A[Label] --> B");
  assert.ok(mermaid.ok);
  assert.deepEqual([(mermaid.spec as FlowSpec).nodes[0]!.label, (mermaid.spec as FlowSpec).edges[0]!.dashed], ["Label", true]);
  // Tree: the folder's slash inside the quotes.
  assert.match(GUIDE, /End folder names with `\/`, inside quotes: `"My Docs\/"`, never `"My Docs"\/`\./);
  assert.match(GUIDE, /`"My Docs\/" "shared"`/);
  const tree = parseVis("tree", '"My Docs/" "shared"');
  assert.ok(tree.ok && (tree.spec as { roots: { name: string; note?: string }[] }).roots[0]!.name === "My Docs/");
  // The guide's "never" form still draws the same folder (the parser reads its one meaning).
  const outside = parseVis("tree", '"My Docs"/ "shared"');
  assert.ok(outside.ok);
  assert.deepEqual(outside.spec, tree.spec);
});

test("one file per registered kind: each names registered kinds, as its file name does", () => {
  const named = kindFiles.flatMap((f) => wordsOf(f.heading));
  for (const f of kindFiles) assert.deepEqual(wordsOf(f.heading), f.name.split("-"), `vis/${f.name}.md: its heading names its file's kinds`);
  for (const word of named) assert.ok(KIND_WORDS.includes(word), `vis ${word} is not in registry.ts`);
  for (const word of KIND_WORDS) assert.equal(named.filter((w) => w === word).length, 1, `registry.ts kind ${word} has one file in vis/`);
});

test("a stub kind in the registry is a stub file in the guide, and only then", () => {
  for (const f of kindFiles) {
    const stubbed = f.text.includes("<!-- stub -->");
    for (const word of wordsOf(f.heading)) assert.equal(isStub(word), stubbed, `${word}: registry stub=${isStub(word)}, guide stub=${stubbed}`);
  }
});

test("the overview lists every kind file once, and the prompt exactly the registry's kinds that aren't stubs", () => {
  const listed = (text: string) => [...text.matchAll(/^- ([a-z]+(?: \/ [a-z]+)*): /gm)].map((m) => m[1]!);
  // As written: one line per kind file, stubs included, in the registry's order.
  assert.deepEqual(listed(FILES.overview!).flatMap(wordsOf), KIND_WORDS);
  assert.deepEqual(listed(FILES.overview!).map((h) => h.replace(" / ", "-")).sort(), kindFiles.map((f) => f.name).sort());
  // As sent: the stubs' lines dropped, no owner notes; vis_guide takes exactly these words.
  assert.deepEqual(listed(VIS_INSTRUCTIONS).flatMap(wordsOf), KIND_WORDS.filter((w) => !isStub(w)));
  assert.deepEqual(VIS_KINDS, KIND_WORDS.filter((w) => !isStub(w)));
  assert.doesNotMatch(VIS_INSTRUCTIONS, /<!--/);
  assert.match(VIS_INSTRUCTIONS, /call `vis_guide` with that kind/);
});

test("vis_guide returns the shared rules, then that kind's file, owner notes stripped", () => {
  const shared = stripVisComments(FILES.shared!);
  for (const word of VIS_KINDS) {
    const file = kindFiles.find((f) => wordsOf(f.heading).includes(word))!;
    assert.equal(visGuide(word), `${shared}\n\n${stripVisComments(file.text)}`, word);
    assert.doesNotMatch(visGuide(word), /<!--/);
  }
  assert.equal(visGuide("html"), visGuide("svg"));
  assert.match(visGuide("wireframe"), /^# vis: rules for every kind\n- One statement per line;[\s\S]*\n\n# vis wireframe\nLow-fi screens:/);
  for (const word of ["mermaid", "overview", "shared", "html-svg", ...KIND_WORDS.filter(isStub)]) assert.throws(() => visGuide(word), /No vis kind/, word);
});

// The emphasis section's one line of every kind's targets moved into the kinds' files.
test("each kind's file says what its marks target", () => {
  for (const f of kindFiles) {
    if (f.name === "html-svg") continue; // emphasis does not apply to frames
    const says = f.name === "wireframe" ? /`mark` a block by its first text or a screen by its name/ : /^- `mark` targets: .+\.$/m;
    assert.match(stripVisComments(f.text), says, f.name);
  }
});

test("the shared rules carry the mark syntax, and the free-form limits are in html / svg", () => {
  assert.match(FILES["html-svg"]!, /Aim under 8K characters/);
  assert.match(FILES.shared!, /mark <target> \[tone\] \["short note"\]/, "the emphasis syntax as core/emphasis.ts parses it");
  assert.match(GUIDE, /Aim under 8K characters \(the document after `title:` \/ `caption:`\); up to 16K draws marked large/);
  assert.equal(FRAME_SOFT_CHARS, 8 * 1024);
  assert.equal(FRAME_HARD_CHARS, 16 * 1024);
  assert.match(GUIDE, /at most 200 characters/);
  assert.equal(MAX_TEXT, 200);
});

test("the guide quotes a mark target with spaces, and its timeline example marks one that way", () => {
  assert.match(GUIDE, /A target is its item's exact label, quoted if it has spaces \(even if its row isn't\): `mark "Vue 2" "…"`/);
  assert.match(GUIDE, /No ids; mark a row, not a step\./, "steps: a mark names a row");
  const body = /^```vis timeline\n([\s\S]*?)^```$/m.exec(GUIDE)![1]!;
  assert.match(body, /^mark "Vue 2" /m);
  const r = parseVis("timeline", body);
  assert.ok(r.ok && r.warnings.length === 0);
  const spec = r.spec as { items: { label?: string }[]; emphasis?: { key: string }[] };
  assert.deepEqual(spec.emphasis!.map((e) => spec.items[Number(e.key)]!.label), ["Vue 2"], "the mark lands on the Vue 2 row");
});

test("the guide teaches several targets per mark and matrix cell tones, with examples that mean it", () => {
  assert.match(GUIDE, /`mark a, b, c "the scope set"`/);
  const matrix = [...GUIDE.matchAll(/^```vis matrix\n([\s\S]*?)^```$/gm)].map(([, body]) => parseVis("matrix", body!));
  const cells = matrix.flatMap((r) => (r.ok ? (r.spec as MatrixSpec).rows.flatMap((row) => row.cells) : []));
  assert.ok(cells.some((c) => c.tone === "ok") && cells.some((c) => c.tone === "warn"), "the matrix example tones a text cell");
});

test("the guide asks for a matrix column name with a comma quoted, and its example means it", () => {
  const line = /^Quote a column name that has a comma: `(columns: [^`]+)`\.$/m.exec(GUIDE);
  assert.ok(line, "the matrix section's quoting line");
  const r = parseVis("matrix", `${line![1]}\nLinear history | no | yes`);
  assert.ok(r.ok && r.warnings.length === 0);
  assert.deepEqual((r.spec as MatrixSpec).columns, ["Merge", "Rebase, then merge"]);
});

// server/baton-vis-guide.ts rewrites this one line for gathering sessions, by its start.
test("the rules keep the '- The parser is strict:' line the gathering guide rewrites", () => {
  assert.match(FILES.shared!, /^# vis: rules for every kind\n(?:- .*\n)*- The parser is strict: .*$/m);
  const g = gatheringVisGuide();
  assert.match(g, /^- The parser is strict: use only the syntax below, or the person sees no drawing at all\.$/m);
  assert.doesNotMatch(g, /shows the block as source/);
});

// A gathering session's guide (§app.baton/abilities), in two tiers: the figure kinds' sections of
// this same guide plus a static svg, and with interactive drawings an html section too. Its examples
// must parse cleanly, and nothing else may be taught to it: never code.
for (const html of [false, true]) {
  test(`the gathering guide${html ? " with interactive drawings" : ""} teaches only the share page's kinds, and its examples parse`, () => {
    const g = gatheringVisGuide(undefined, { html });
    const taught = [...g.matchAll(/^## (.*)$/gm)].map((m) => m[1]!.trim());
    assert.deepEqual(taught, ["Shared: emphasis", ...KIND_WORDS.filter((w) => (SHARE_VIS_KINDS as readonly string[]).includes(w)), "svg", ...(html ? ["html"] : [])]);
    assert.doesNotMatch(g, /<!--|8K|16K|vis_check|## code|vis code/, "no owner notes, the chat's limits or tools, never code");
    assert.match(g, /Never draw people, roles, the roster, who decides what/);
    assert.match(g, /a sequence's actors are systems or steps .*never people or roles/);
    assert.match(g, /It is shown as an image: no `<script>`, no animation, no buttons or links/);
    if (html) {
      for (const rule of [/Fit a phone first/, /Aim under 4K characters/, /Nothing external/, /Play or Step button/, /Never ask for a password, contact details/, /applies to all text in the markup and the script too/])
        assert.match(g.slice(g.indexOf("## html")), rule);
    } else assert.doesNotMatch(g, /vis html|## html/);
    const fences = [...g.matchAll(/^```(vis [a-z]+)\n([\s\S]*?)^```$/gm)];
    assert.ok(fences.length >= SHARE_VIS_KINDS.length + 1 + (html ? 1 : 0));
    for (const [, info, body] of fences) {
      const word = visKindWord(info!)!;
      assert.ok([...SHARE_VIS_KINDS, "svg", ...(html ? ["html"] : [])].includes(word), info);
      const r = parseVis(word, body!);
      assert.ok(r.ok && r.warnings.length === 0, `${info}: ${r.ok ? r.warnings.join("; ") : `line ${r.line}: ${r.message}`}`);
      if (word === "svg") assert.match(body!, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "an svg drawn as an image needs its namespace");
    }
  });
}

// The gathering guide as last reviewed (the split of vis-mode.md kept it byte for byte; the e2e
// round's rule fixes then changed it). A deliberate edit to shared.md or a share kind's file changes
// it: check the new text reads right for a gathering session, then put its hash here.
test("the gathering guide is the text last reviewed", () => {
  assert.equal(createHash("sha256").update(gatheringVisGuide()).digest("hex"), "010b137f57e9284700d1022a020b19c71a6d603eaa17c35e43f67f03bcd377eb");
  assert.equal(createHash("sha256").update(gatheringVisGuide(undefined, { html: true })).digest("hex"), "07f8d2ef46e01c583e794f094160e5a1c9f3bd1b07831cb6508f694fc48fc38f");
});
