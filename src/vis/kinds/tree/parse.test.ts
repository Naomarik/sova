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
  assert.match(err("tree", "a\nmark b").message, /no item b/);
  // An indented "mark …" line is an item, not a mark.
  assert.equal(ok<TreeSpec>("tree", "a\n  mark b").roots[0]!.children[0]!.name, "mark b");
});
