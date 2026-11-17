// Which chat the Commands dialog opens on (§app.command-palette/opening): a composer's "+" opens
// it on that composer's own chat, with its button to return focus to, whichever pane is focused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closePalette, openPaletteFrom, paletteRequest } from "./palette-open";

test("each '+' opens it on its own chat, and closing clears it", () => {
  closePalette();
  assert.equal(paletteRequest(), null);
  const one = { id: "composer-menu-trigger-p1" } as unknown as HTMLElement;
  const two = { id: "composer-menu-trigger-p2" } as unknown as HTMLElement;
  openPaletteFrom("/s/pane-2.jsonl", two);
  assert.deepEqual(paletteRequest(), { path: "/s/pane-2.jsonl", trigger: two });
  openPaletteFrom("/s/pane-1.jsonl", one);
  assert.deepEqual(paletteRequest(), { path: "/s/pane-1.jsonl", trigger: one });
  closePalette();
  assert.equal(paletteRequest(), null);
});
