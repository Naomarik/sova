// The rule (§design/context-menus): every right-click or hold menu opens through the shared piece,
// components/ContextMenu.tsx, and right-click and hold come only as a pair, with the same items
// for a mouse and a finger. Read from the source, so a menu opened by hand beside the piece, a
// door with no hold, an own hold that never reports its release, or a body that picks its items
// by pointer kind fails here. A new place is a deliberate edit of PLACES.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** Every place with a right-click or hold menu: the file that makes and draws it (its items), the
    pure model of its items, and the files that give elements a door to it. */
const PLACES = [{ menu: "components/SessionContextMenu.tsx", model: "lib/session-context-menu.ts", doors: ["components/Sidebar.tsx"] }];

const SHARED = "components/ContextMenu.tsx";
const RULES = "lib/context-menu.ts";

const root = join(import.meta.dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) && !d.name.includes(".test.") ? [join(dir, d.name)] : [],
  );
const files = walk(".").map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const src = (f: string) => files.find((x) => x.f === f)!.src;
const calling = (re: RegExp) => files.filter((x) => re.test(x.src)).map((x) => x.f).sort();

/** The text of the call's argument list starting at `open` (an index at its "("). */
const argsAt = (s: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
};

test("only the shared piece opens, places and times a pointer's menu", () => {
  for (const name of ["createOpenOnRelease", "pointMenuSpot", "pointMenuRoom", "createKeyMenuMark", "contextMenuAction", "createMenuHold", "contextPointerKind", "pressHeld", "createOutsidePress"])
    assert.deepEqual(calling(new RegExp(`\\b${name}\\(`)).filter((f) => f !== RULES), [SHARED], name);
  // No `open` leaves the piece: a door is the only way in.
  assert.doesNotMatch(src(SHARED), /return \{[^}]*\bopen\b[^}]*\};?\s*\}\s*$/);
  assert.match(src(SHARED), /return \{ door, Panel \};/);
});

test("the places with a right-click or hold menu are exactly PLACES", () => {
  assert.deepEqual(calling(/\bcreateContextMenu\s*(<[^>]*>)?\(/).filter((f) => f !== SHARED), PLACES.map((p) => p.menu).sort());
  assert.deepEqual(calling(/\.door\(\{/).filter((f) => f !== SHARED), [...new Set(PLACES.flatMap((p) => p.doors))].sort());
});

test("every door has its hold: the shared one, or a place's own that reports its release", () => {
  for (const f of PLACES.flatMap((p) => p.doors)) {
    const s = src(f);
    const doors = [...s.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\w+\.door\(/g)];
    assert.ok(doors.length > 0, `${f}: a door is kept in a name, so its attach and held can be checked`);
    for (const d of doors) {
      const [, name] = d;
      const opts = argsAt(s, d.index! + d[0].length - 1);
      assert.match(opts, /\bhold:\s*("shared"|\{)/, `${f}: ${name}'s hold is "shared" or the place's own`);
      assert.ok(new RegExp(`\\b${name}\\.attach\\(`).test(s), `${f}: ${name} is attached (right-click and hold together)`);
      if (/\bhold:\s*\{/.test(opts)) assert.ok(new RegExp(`\\b${name}\\.held\\(`).test(s), `${f}: ${name}'s own hold reports its release`);
    }
  }
});

test("a contextmenu handler outside the piece only swallows a gesture's echo", () => {
  // The shapes in use today: a hold's or a drag's echo swallowed, the drop overlay's noScroll.
  const ECHO = [/^onContextMenu=\{\(e\) => \w+\.suppressed\(\) && e\.preventDefault\(\)\}$/, /^onContextMenu: \(e: MouseEvent\) => \w+\.suppressed\(\) && e\.preventDefault\(\),$/, /^onContextMenu=\{bind\.onContextMenu\}$/, /^f\("contextmenu", noScroll, true\);$/];
  for (const { f, src: s } of files) {
    if (f === SHARED || f === RULES) continue;
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || !/\bonContextMenu\b|["']contextmenu["']/.test(t)) continue;
      assert.ok(
        ECHO.some((re) => re.test(t)),
        `${f}: "${t}" handles a contextmenu by hand; a menu opens through ContextMenu.tsx's door`,
      );
    }
  }
});

test("a menu's items are the same for a mouse and a finger: its body never reads the pointer", () => {
  // The panel hands the body no pointer kind; nor may the body find one itself.
  const POINTER = /pointerType|PointerKind|pointer:\s*(coarse|fine)|hover:\s*none|maxTouchPoints|ontouchstart|TouchEvent|\bkind\(\)/;
  for (const p of PLACES) for (const f of [p.menu, p.model]) assert.equal(src(f).match(POINTER)?.[0], undefined, f);
  const shared = src(SHARED);
  const ask = shared.indexOf("interface Ask<K> {");
  assert.ok(ask >= 0);
  assert.doesNotMatch(shared.slice(ask, shared.indexOf("\n}", ask)), /kind/i, "the ask carries no pointer kind");
});
