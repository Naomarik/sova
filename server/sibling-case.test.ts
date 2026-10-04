// No two siblings an extensionless import can reach (modules and directories) may differ only by
// case once their extensions are dropped (`parts.ts` beside `Parts.tsx`). An import (`./parts`)
// then means one file on every runtime and file system: Bun 1.4.2's resolver matches such names
// case-insensitively (docs/bun-quirks.md), and macOS's default file system can't hold both.
// Stylesheets and other assets are always imported with their extension, so `app.css` beside
// `App.tsx` is fine.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TREES = ["src", "server", "shared", join("pi-config", "extensions")];

/** A name without its last extension, lowercased: what an extensionless, case-blind import matches. */
export const stemKey = (name: string) => name.replace(/(?<=.)\.[^.]*$/, "").toLowerCase();
const stem = (name: string) => name.replace(/(?<=.)\.[^.]*$/, "");
/** What `./x` can resolve to: a module or a directory (its index). */
const MODULE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

function collisions(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const byKey = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (e.isDirectory()) collisions(join(dir, e.name), out);
    else if (!MODULE.test(e.name)) continue;
    const k = e.isDirectory() ? e.name.toLowerCase() : stemKey(e.name);
    const s = e.isDirectory() ? e.name : stem(e.name);
    const names = byKey.get(k) ?? new Set();
    names.add(s);
    byKey.set(k, names);
  }
  for (const [, names] of byKey) {
    if (names.size < 2) continue;
    const clash = entries.filter((e) => (e.isDirectory() || MODULE.test(e.name)) && names.has(e.isDirectory() ? e.name : stem(e.name))).map((e) => e.name);
    out.push(`${relative(ROOT, dir)}: ${clash.sort().join(", ")}`);
  }
}

test("the key drops one extension and the case", () => {
  assert.equal(stemKey("Parts.tsx"), stemKey("parts.ts"));
  assert.equal(stemKey("parts.css"), "parts");
  assert.notEqual(stemKey("parts.test.ts"), stemKey("parts.ts"));
  assert.equal(stemKey(".hidden"), ".hidden");
});

test("no siblings differ only by case, extensions aside", () => {
  const out: string[] = [];
  for (const t of TREES) collisions(join(ROOT, t), out);
  assert.deepEqual(out, [], `rename one of each group so an extensionless import is unambiguous:\n${out.join("\n")}`);
});
