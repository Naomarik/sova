// Run: pnpm test -- server/test-helpers.test.ts
// A `*.test.helper.ts` file is test code that is not itself a test: the runner's globs (`*.test.ts`)
// never pick it up, and the product line count (`':!*.test.*'`) leaves it out. That holds only while
// nothing but tests imports it: this fails when a product file (anything that is neither a test nor
// another helper) imports one, and when a helper is a file the runner would run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const ROOTS = ["server", "shared", "src", "scripts", "pi-config"];
const SKIP = new Set(["node_modules", ".git", "dist"]);
const HELPER = /\.test\.helper\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(?:[cm]?[jt]sx?)$/.test(e.name) ? [relative(REPO, p)] : [];
  });
}
const files = ROOTS.flatMap((r) => walk(join(REPO, r)));
/** Every import, export-from, dynamic import or require naming a test helper. */
const helperImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']*\.test\.helper(?:\.[cm]?[jt]sx?)?)["']/g;

describe("test helpers (*.test.helper.ts)", () => {
  test("only tests and other helpers import a test helper", () => {
    const importers = new Map<string, string[]>();
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(REPO, f), "utf8").matchAll(helperImport)) {
        importers.set(m[1]!, [...(importers.get(m[1]!) ?? []), f]);
        if (!TEST.test(f) && !HELPER.test(f)) bad.push(`${f} imports ${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], "a product file imports a test helper: move what it needs out of the helper");
    // Not vacuous: the forms group's helpers exist and are imported, so the scan sees them.
    assert.ok(files.includes("server/forms-browser.test.helper.ts") && files.includes("server/settings-browser-temp.test.helper.ts"));
    assert.ok([...importers.keys()].some((k) => k.endsWith("forms-browser.test.helper")), "the scan found no import of forms-browser.test.helper");
  });

  test("the scan catches a product file importing one", () => {
    const src = `import { until } from "./forms-browser.test.helper";\nconst x = await import("../server/settings-browser-temp.test.helper.ts");`;
    assert.deepEqual([...src.matchAll(helperImport)].map((m) => m[1]), ["./forms-browser.test.helper", "../server/settings-browser-temp.test.helper.ts"]);
  });

  test("a helper is never a file the runner runs (its globs match *.test.ts) or a unit file", () => {
    const runner = readFileSync(join(REPO, "scripts/run-tests.mjs"), "utf8");
    const globs = /const GLOBS = \[([\s\S]*?)\];/.exec(runner)?.[1] ?? "";
    assert.ok(globs.includes('"server/*.test.ts"'), "the runner's GLOBS still list server/*.test.ts");
    for (const g of globs.match(/"[^"]+"/g) ?? []) assert.match(g, /\.test\.ts"$/, `runner glob ${g} could match a helper`);
    for (const f of files.filter((x) => HELPER.test(x))) assert.ok(!f.endsWith(".test.ts"), f);
  });
});
