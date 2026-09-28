// The model is taught the formats by pi-config/extensions/mode/vis-mode.md. Every example there is a
// second implementation of the grammar, so each must parse with the renderer's own parser; and the
// guide's sections must match the registry, so no kind is taught that the chat can't draw.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseVis, visKindWord } from "./parse";
import { KIND_WORDS, KINDS } from "./registry";

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
  }
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
  assert.match(GUIDE, /8 KB/);
});
