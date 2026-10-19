// Run: pnpm test -- src/lib/row-place-rule.test.ts
// The rule (AGENTS.md "Commands and extensibility"): Sova's own features use the same places on its
// screens as extensions. On a session row's line 3 that place is src/lib/row-place.ts: Sova's
// built-in (the readiness badge) and then what extensions add, both drawn only by RowPlaceView in
// src/components/RowPlace.tsx. Read from the source, so a badge drawn beside the place, chips wired
// in by hand, a request per row, or extension markup in the page fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name), ext) : ext.test(d.name) && !d.name.includes(".test.") ? [join(dir, d.name)] : [],
  );
const files = walk(".", /\.tsx?$/).map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const src = (f: string) => files.find((x) => x.f === f)!.src;
const using = (tag: string) => files.filter((x) => new RegExp(`<${tag}[\\s>]`).test(x.src)).map((x) => x.f).sort();

test("line 3's place is drawn once, in the row, and extension chips only by the place", () => {
  assert.deepEqual(using("RowPlaceView"), ["components/Sidebar.tsx"]);
  assert.equal(src("components/Sidebar.tsx").match(/<RowPlaceView[\s>]/g)?.length, 1);
  assert.deepEqual(using("RowAdded"), ["components/RowPlace.tsx"]);
  // Built-ins first, then what extensions add.
  const place = src("components/RowPlace.tsx");
  assert.ok(place.indexOf("builtIns") > 0 && place.indexOf("<RowAdded") > place.indexOf("builtIns"));
  // The built-ins are drawn by position: a badge whose words change keeps its span (a <For> over
  // fresh item objects would build a new one on every readiness change).
  assert.match(place, /<Index each=\{props\.builtIns/);
  assert.doesNotMatch(place, /<For each=\{props\.builtIns/);
});

test("the readiness badge is the place's built-in, not a span drawn beside it", () => {
  assert.match(src("lib/row-place.ts"), /ROW_BUILT_INS: readonly RowBuiltIn\[\] = \[\{ id: "sova\.readiness"/);
  assert.match(src("components/Sidebar.tsx"), /<RowPlaceView session=\{s\(\)\} builtIns=\{ROW_BUILT_INS\} \/>/);
  for (const x of files.filter((x) => x.f.endsWith(".tsx"))) assert.doesNotMatch(x.src, /session-readiness|readinessBadge\(/, x.f);
});

test("only the pane asks, once per list: no row reads the extension list or fetches", () => {
  const askers = files.filter((x) => x.f.endsWith(".tsx") && /\buseRowAdditions\(/.test(x.src)).map((x) => x.f);
  assert.deepEqual(askers, ["components/Sidebar.tsx"]);
  assert.equal(src("components/Sidebar.tsx").match(/\buseRowAdditions\(/g)?.length, 1);
  assert.doesNotMatch(src("components/RowPlace.tsx"), /fetch|ExtensionsContext|useRowAdditions/);
  // The one path the place asks: no session in it.
  assert.match(src("lib/row-place.ts"), /fetch\(`\/ext\/\$\{encodeURIComponent\(id\)\}\$\{screenPath\("row"\)\}`,/);
});

test("extension content is never markup or a control in the row", () => {
  const place = src("components/RowPlace.tsx");
  assert.doesNotMatch(place, /innerHTML|outerHTML|insertAdjacentHTML|<iframe|<a[\s>]|<button[\s>]|onClick|href=/);
});
