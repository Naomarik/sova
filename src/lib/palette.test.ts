// The Commands dialog's model (§app/command-palette): the four This chat rows in order, the
// reasons a row can't act, nothing acting unless chosen, and the filter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionRows, enterTarget, filterRows, moveActive, NO_ROW, REASON, type PaletteComposer } from "./palette";

const composer: PaletteComposer = { off: null, hideTools: false, hideThinking: false, playbooks: true };
const rowsOf = (c: Partial<PaletteComposer> = {}) => actionRows({ ...composer, ...c });

test("the list: exactly Attach images, Hide tool calls, Hide thinking, Playbooks, in that order", () => {
  assert.deepEqual(
    rowsOf().map((r) => [r.key, r.label, r.disabled]),
    [
      ["this:attach", "Attach images", null],
      ["this:hide-tools", "Hide tool calls", null],
      ["this:hide-thinking", "Hide thinking", null],
      ["this:playbooks", "Playbooks", null],
    ],
  );
});

test("the hide rows say what a pick will do, flipping with each preference on its own", () => {
  const labels = (c: Partial<PaletteComposer>) => rowsOf(c).map((r) => r.label);
  assert.deepEqual(labels({ hideTools: true }), ["Attach images", "Show tool calls", "Hide thinking", "Playbooks"]);
  assert.deepEqual(labels({ hideThinking: true }), ["Attach images", "Hide tool calls", "Show thinking", "Playbooks"]);
});

test("disabled: the composer's own reason for attach and playbooks, never for the hide rows; playbooks needs a Sova chat", () => {
  const off = "This session is open in a terminal, so Sova won't write to it.";
  const why = (c: Partial<PaletteComposer>) => rowsOf(c).map((r) => r.disabled);
  assert.deepEqual(why({ off, playbooks: false }), [off, null, null, off]);
  assert.deepEqual(why({ playbooks: false }), [null, null, null, REASON.noPlaybooks]);
});

test("no row is active until an arrow makes one so; Enter with none, or on a disabled row, acts on nothing", () => {
  const rows = rowsOf();
  assert.equal(enterTarget(rows, NO_ROW), null);
  const lone = filterRows(rows, "attach");
  assert.equal(lone.length, 1);
  assert.equal(enterTarget(lone, NO_ROW), null); // one match still isn't chosen
  assert.equal(enterTarget([], 0), null);
  // ↓ from none is the first row, ↑ from none the last; both wrap
  assert.equal(moveActive(NO_ROW, 4, 1), 0);
  assert.equal(moveActive(NO_ROW, 4, -1), 3);
  assert.equal(moveActive(3, 4, 1), 0);
  assert.equal(moveActive(0, 4, -1), 3);
  assert.equal(moveActive(NO_ROW, 0, 1), NO_ROW);
  assert.equal(enterTarget(lone, moveActive(NO_ROW, lone.length, 1))?.key, "this:attach");
  const blocked = rowsOf({ playbooks: false });
  assert.equal(enterTarget(blocked, 3), null);
});

test("filter: by the label's words, best match first; nothing for no match; blank shows all", () => {
  const rows = rowsOf();
  assert.deepEqual(filterRows(rows, "hide").map((r) => r.key), ["this:hide-tools", "this:hide-thinking"]);
  assert.deepEqual(filterRows(rows, "thinking").map((r) => r.key), ["this:hide-thinking"]);
  assert.deepEqual(filterRows(rows, "  PLAY ").map((r) => r.key), ["this:playbooks"]);
  // a label prefix outranks a word inside it: "t" starts "tool" and "thinking", not "Attach"
  assert.deepEqual(filterRows(rows, "t").map((r) => r.key), ["this:hide-tools", "this:hide-thinking", "this:attach"]);
  assert.deepEqual(filterRows(rows, "undo"), []);
  assert.equal(filterRows(rows, "   ").length, 4);
});
