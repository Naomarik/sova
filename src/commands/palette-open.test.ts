// Run: pnpm test -- src/commands/palette-open.test.ts
// Who opened the command palette, and for which chat (§app.command-palette/opening): a composer's
// "+" opens it on that composer's chat with its button to return focus to; the key opens it on the
// open chat, and closes it whoever opened it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closePalette, openPaletteFrom, paletteRequest, togglePaletteFromKey } from "./palette-open";

test("the '+' opens it on its own chat; the key closes it, then opens it on the open chat", () => {
  closePalette();
  assert.equal(paletteRequest(), null);
  const trigger = { id: "composer-menu-trigger-p2" } as unknown as HTMLElement;
  openPaletteFrom("/s/pane-2.jsonl", trigger);
  assert.deepEqual(paletteRequest(), { origin: "plus", path: "/s/pane-2.jsonl", trigger });
  togglePaletteFromKey(); // open, from wherever: the key closes it
  assert.equal(paletteRequest(), null);
  togglePaletteFromKey();
  assert.deepEqual(paletteRequest(), { origin: "key", path: null, trigger: null });
  closePalette();
  assert.equal(paletteRequest(), null);
});
