// A sidebar session row's own menu: what it offers a session and why a row can't run.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import type { ArchiveDrag } from "./drag-archive";
import { groupChoices, rowMenuOf } from "./session-context-menu";

const row = (over: Partial<SessionSummary> = {}) => ({ title: "Fix the build", archived: false, ...over }) as SessionSummary;
const ARCHIVES: ArchiveDrag = { kind: "archive" };
const NO_NOTE = { groupNote: null };

test("rowMenuOf: a self-named chat has no title rows; Regenerate waits on its own run, Reset says why it can't run", () => {
  assert.equal(rowMenuOf(row({ fixedName: "overseer" as SessionSummary["fixedName"] }), ARCHIVES, NO_NOTE).title, null);
  assert.equal(rowMenuOf(row({ fixedName: "overseer" as SessionSummary["fixedName"] }), ARCHIVES, NO_NOTE, true).title, null);
  const plain = rowMenuOf(row(), ARCHIVES, NO_NOTE).title!;
  assert.deepEqual([plain.regenerateDesc, plain.regenerateDisabled, plain.resetDisabled], ["A short name from what the session became.", "", "Not renamed."]);
  const renamed = rowMenuOf(row({ originalTitle: "first words" }), ARCHIVES, NO_NOTE).title!;
  assert.deepEqual([renamed.original, renamed.resetDisabled], ["first words", ""]);
  const running = rowMenuOf(row(), ARCHIVES, NO_NOTE, true).title!;
  assert.equal(running.regenerateDisabled, "Regenerating title…");
});

test("rowMenuOf: a compressed chat offers no Regenerate Title (its conversation isn't opened), and keeps Rename and Reset", () => {
  assert.equal(rowMenuOf(row(), ARCHIVES, NO_NOTE).title!.regenerate, true);
  assert.equal(rowMenuOf(row({ archived: true }), { kind: "none" }, NO_NOTE).title!.regenerate, true, "an archived chat still can");
  const packed = rowMenuOf(row({ archived: true, compressed: true, originalTitle: "first words" }), { kind: "none" }, NO_NOTE).title!;
  assert.equal(packed.regenerate, false);
  assert.deepEqual([packed.original, packed.resetDisabled], ["first words", ""], "Rename and Reset stay");
});

test("rowMenuOf: Archive and Move to Group refuse exactly what the drop panel refuses, in its words", () => {
  assert.deepEqual(rowMenuOf(row(), ARCHIVES, NO_NOTE).archive, { label: "Archive", act: "archive", disabled: "" });
  assert.deepEqual(rowMenuOf(row({ archived: true }), { kind: "none" }, NO_NOTE).archive, { label: "Unarchive", act: "unarchive", disabled: "" });
  assert.equal(rowMenuOf(row({ archived: true, compressed: true }), { kind: "none" }, NO_NOTE).archive.act, null, "a compressed chat has no Unarchive");
  assert.deepEqual(rowMenuOf(row(), { kind: "blocked", reason: "its turn is running" }, NO_NOTE).archive, { label: "Archive", act: null, disabled: "Can't archive: its turn is running" });
  assert.equal(rowMenuOf(row(), { kind: "none" }, NO_NOTE).archive.disabled, "Already in the Archive.");
  const note = "Groups hold this host's sessions only. That one lives on box.";
  assert.equal(rowMenuOf(row(), ARCHIVES, { groupNote: note }).moveDisabled, note);
  assert.equal(rowMenuOf(row(), ARCHIVES, { groupNote: "Organization sessions stay with their project." }).moveDisabled, "Organization sessions stay with their project.");
  assert.equal(rowMenuOf(row(), ARCHIVES, NO_NOTE).moveDisabled, "");
  assert.deepEqual(
    groupChoices({ remove: { name: "Work" }, groups: [{ id: "g1", name: "Work", count: 2, current: true, disabled: null }, { id: "g2", name: "Play", count: 0, current: false, disabled: note }] }),
    [
      { id: null, name: "No group", current: false, disabled: "" },
      { id: "g1", name: "Work", current: true, disabled: "" },
      { id: "g2", name: "Play", current: false, disabled: note },
    ],
  );
});
