import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { summaryStats } from "./tool-diff-stats";

const piPatch = "--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n+B2\n c\n";

test("a closed card counts +n −m off the recorded patch only", () => {
  assert.deepEqual(summaryStats("edit", { patch: piPatch }), { added: 2, removed: 1 });
  const structuredPatch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [" a", "-b", "-c", "+d"] }];
  assert.deepEqual(summaryStats("edit", { structuredPatch }), { added: 1, removed: 2 });
  assert.deepEqual(summaryStats("write", { structuredPatch }), { added: 1, removed: 2 });
});

test("without a recorded patch there is no count: the snippets and the written text are never diffed", () => {
  assert.equal(summaryStats("edit", undefined), null);
  assert.equal(summaryStats("edit", {}), null);
  assert.equal(summaryStats("edit", { structuredPatch: [] }), null);
  assert.equal(summaryStats("write", { created: true }), null);
  assert.equal(summaryStats("bash", { patch: piPatch }), null);
});

test("the counter cannot reach the line diff, the word diff or highlighting", () => {
  // Follow every relative import from the module; none may be the diff engine's heavy parts.
  const here = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      const spec = resolve(dirname(file), m[1]!);
      walk(spec.endsWith(".ts") ? spec : `${spec}.ts`);
    }
  };
  walk(resolve(here, "tool-diff-stats.ts"));
  const names = [...seen].map((f) => f.slice(here.length + 1));
  assert.ok(names.includes("diff/parse.ts"), names.join(", ")); // the walk does follow imports
  for (const heavy of ["diff/line-diff.ts", "diff/intraline.ts", "diff/render.ts", "diff/highlight.ts", "markdown.ts", "diff/index.ts"])
    assert.ok(!names.includes(heavy), `${heavy} is reachable: ${names.join(", ")}`);
});
