import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { TreeSpec } from "./parse";

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

test("tree: indentation or tree-drawing art, notes and tones", () => {
  const indented = ok<TreeSpec>("tree", 'src/\n  lib/\n    vis.ts "parser" accent\n  main.tsx warn\nREADME.md');
  const art = ok<TreeSpec>("tree", 'src/\n├── lib/\n│   └── vis.ts "parser" accent\n└── main.tsx warn\nREADME.md');
  assert.deepEqual(indented, art);
  assert.equal(indented.roots.length, 2);
  const lib = indented.roots[0]!.children[0]!;
  assert.deepEqual(lib.children[0], { key: "0.0.0", name: "vis.ts", note: "parser", tone: "accent", children: [] });
  assert.equal(indented.roots[0]!.children[1]!.tone, "warn");
  assert.match(err("tree", "a\n  b\n      c").message, /more than one level/);
  assert.match(err("tree", "a\n  b\n   c").message, /not a multiple of 2/);
});

test("tree: mark an item by name (first match, depth first) or quoted name", () => {
  const s = ok<TreeSpec>("tree", 'src/\n  index.ts\n  lib/\n    index.ts\n"My Docs"\nmark index.ts "the entry"\nmark "My Docs" muted');
  assert.deepEqual(s.emphasis, [
    { key: "0.0", tone: "accent", note: "the entry", n: 1 },
    { key: "1", tone: "muted" },
  ]);
  assert.match(warning("tree", "a\nmark b").message, /no item b, dropped/);
  // An indented "mark …" line is an item, not a mark.
  assert.equal(ok<TreeSpec>("tree", "a\n  mark b").roots[0]!.children[0]!.name, "mark b");
});

test("tree: a lone / right after a quoted name is the folder's slash, the same as inside the quotes", () => {
  const inside = ok<TreeSpec>("tree", '"My Docs/" "shared" ok\n  a');
  // Outside the quotes (then the end of the line, or a space): the same spec as inside.
  assert.deepEqual(ok<TreeSpec>("tree", '"My Docs"/ "shared" ok\n  a'), inside);
  assert.deepEqual(ok<TreeSpec>("tree", '"q12 · Empty screen: pick one"/\n  "a · Preset cards"').roots.map((r) => [r.name, r.children.map((c) => c.name)]), [["q12 · Empty screen: pick one/", ["a · Preset cards"]]]);
  // A name already ending in / takes no second one.
  assert.equal(ok<TreeSpec>("tree", '"Docs/"/').roots[0]!.name, "Docs/");
  // A slash joined to more text has no single reading: the did-you-mean stays.
  assert.equal(err("tree", '"Docs"/x').message, 'put the / inside the quotes: "Docs/"x');
  assert.equal(err("tree", '"Docs"/"shared"').message, 'put the / inside the quotes: "Docs/""shared"');
});
