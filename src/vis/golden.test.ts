// No regression: fences that drew before the lenient parser (soft warnings, inline flow labels,
// panel-local ids, sequence label marks, the character budget) must parse to the very same spec.
// golden.json holds synthetic fences and the guide's examples as they were, each with the spec the
// earlier parser produced. Regenerate it only for a deliberate change to what a valid fence means.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseVis } from "./parse";

const GOLDEN: { from: string; kind: string; body: string; spec: unknown }[] = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));

test("every fence that parsed before parses to the same spec, without warnings", () => {
  assert.ok(GOLDEN.length >= 30);
  for (const g of GOLDEN) {
    const r = parseVis(g.kind, g.body);
    assert.ok(r.ok, `${g.from} vis ${g.kind}: ${r.ok ? "" : `line ${r.line}: ${r.message}`}\n${g.body}`);
    assert.deepEqual(r.warnings, [], `${g.from} vis ${g.kind}\n${g.body}`);
    assert.deepEqual(JSON.parse(JSON.stringify(r.spec)), g.spec, `${g.from} vis ${g.kind}\n${g.body}`);
  }
});
