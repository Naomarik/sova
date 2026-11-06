// Run: pnpm test -- src/lib/menu-place-rule.test.ts
// The rule (AGENTS.md "Commands and extensibility"): Sova's own features use the same places on its
// screens as extensions. Every Sova menu is one declaration (src/lib/menu-place.ts) drawn by the one
// body, MenuBody in src/components/MenuPlace.tsx: Sova's rows first, then what extensions add, drawn
// by MenuAdded. Read from the source, so extension rows hand-wired beside the body, one of Sova's
// rows drawn around it, or extension markup in the page fails here.
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

test("what extensions add is drawn only by the one body, once, and only it reads the menu entries", () => {
  assert.deepEqual(using("MenuAdded"), ["components/MenuPlace.tsx"]);
  assert.equal(src("components/MenuPlace.tsx").match(/<MenuAdded[\s>]/g)?.length, 1);
  const readers = files.filter((x) => /\bmenuGroups\(/.test(x.src)).map((x) => x.f);
  assert.deepEqual(readers, ["components/MenuPlace.tsx"]);
  // Every door draws the one body: the ⋯ (PlaceMenu) and the right-click (openMenu) are its only drawers.
  assert.deepEqual(using("MenuBody"), ["components/MenuPlace.tsx"]);
  assert.match(src("components/SessionRowMenu.tsx"), /<PlaceMenu decl=\{SESSION_MENU\}/);
  assert.match(src("components/SessionRowMenu.tsx"), /openMenu\(e, SESSION_MENU,/);
});

test("Sova's rows come first, then extensions, after every one of Sova's rows", () => {
  const body = src("components/MenuPlace.tsx");
  const own = body.indexOf("<Sections menu={menu} sections={table()} />");
  const added = body.indexOf("<MenuAdded");
  assert.ok(own > 0 && added > own);
  // Nothing of Sova's is drawn after the extensions: the next row-level element closes the menu list.
  const tail = body.slice(added, body.indexOf("</div>", added));
  assert.doesNotMatch(tail, /<(menu\.Item|Row|Sections)[\s>]/);
});

test("Copy Path is a row of the session menu's table, not a row drawn beside it", () => {
  assert.match(readFileSync(join(root, "lib/session-menu.ts"), "utf8"), /label: "Copy Path", aria: `Copy the path of \$\{name\}`/);
  for (const { f, src: s } of files) assert.doesNotMatch(s, /<menu\.Item label="Copy Path"/, f);
});

test("extension content is never markup in the page", () => {
  for (const f of ["components/MenuPlace.tsx", "components/SessionRowMenu.tsx"]) assert.doesNotMatch(src(f), /innerHTML|outerHTML|insertAdjacentHTML|<iframe/, f);
});
