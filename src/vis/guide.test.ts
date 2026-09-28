// The model is taught the formats by pi-config/extensions/mode/vis-mode.md. Every example there is a
// second implementation of the grammar, so each must parse with the renderer's own parser, and
// every section heading must name a registered kind.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseVis, visKindWord } from "./parse";
import { KIND_WORDS } from "./registry";

const GUIDE = readFileSync(new URL("../../pi-config/extensions/mode/vis-mode.md", import.meta.url), "utf8");

test("every vis example in the guide parses", () => {
  const fences = [...GUIDE.matchAll(/^```(vis [a-z]+)\n([\s\S]*?)^```$/gm)];
  assert.ok(fences.length >= 5, "the guide shows examples");
  for (const [, info, body] of fences) {
    const r = parseVis(visKindWord(info!)!, body!);
    assert.ok(r.ok, `${info}: ${r.ok ? "" : `line ${r.line}: ${r.message}`}`);
  }
});

test("each ## section names registered kinds", () => {
  for (const [, heading] of GUIDE.matchAll(/^## (.+)$/gm)) {
    for (const word of heading!.split(/\s*\/\s*/)) assert.ok(KIND_WORDS.includes(word), `## ${heading}: "${word}" is not in registry.ts`);
  }
});
