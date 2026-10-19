// Run: pnpm test -- src/lib/menu-place-rule.test.ts
// The rule (AGENTS.md "Commands and extensibility"): Sova's own features use the same places on its
// screens as extensions. In the session ⋯ menu that place is src/lib/menu-place.ts: Sova's built-ins
// drawn by MenuBuiltIns, then what extensions add drawn by MenuAdded, both from
// src/components/MenuPlace.tsx. Read from the source, so extension rows hand-wired beside the
// place, a built-in drawn around it, or extension markup in the page fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const tsx = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsx(join(dir, d.name)) : d.name.endsWith(".tsx") && !d.name.includes(".test.") ? [join(dir, d.name)] : [],
  );
const files = tsx(".").map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const src = (f: string) => files.find((x) => x.f === f)!.src;
const using = (tag: string) => files.filter((x) => new RegExp(`<${tag}[\\s>]`).test(x.src)).map((x) => x.f).sort();

test("the session menu's extension rows are drawn only by the place", () => {
  assert.deepEqual(using("MenuAdded"), ["components/SessionRowMenu.tsx"]);
  assert.deepEqual(using("MenuBuiltIns"), ["components/SessionRowMenu.tsx"]);
  assert.equal(src("components/SessionRowMenu.tsx").match(/<MenuAdded[\s>]/g)?.length, 1);
  // Only the place reads which commands are menu entries.
  const readers = files.filter((x) => /\bmenuGroups\(/.test(x.src)).map((x) => x.f);
  assert.deepEqual(readers, ["components/SessionRowMenu.tsx"]);
});

test("built-ins come first, then extensions, after every one of Sova's items", () => {
  const menu = src("components/SessionRowMenu.tsx");
  const builtIns = menu.indexOf("<MenuBuiltIns");
  const added = menu.indexOf("<MenuAdded");
  assert.ok(builtIns > 0 && added > builtIns);
  // Nothing of Sova's is drawn after the extensions: the next row-level element closes the menu list.
  const tail = menu.slice(added, menu.indexOf("</div>", added));
  assert.doesNotMatch(tail, /<menu\.Item/);
});

test("Copy Path is the place's built-in, not a row drawn beside it", () => {
  const menu = src("components/SessionRowMenu.tsx");
  assert.match(menu, /SESSION_MENU_BUILT_INS: readonly MenuBuiltIn<SessionSummary>\[\] = \[\s*\{\s*id: "sova\.copy-path"/);
  assert.doesNotMatch(menu, /<menu\.Item label="Copy Path"/);
});

test("extension content is never markup in the page", () => {
  for (const f of ["components/MenuPlace.tsx", "components/SessionRowMenu.tsx"]) assert.doesNotMatch(src(f), /innerHTML|outerHTML|insertAdjacentHTML|<iframe/, f);
});
