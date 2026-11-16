// A sidebar session row's own menu: what it offers a session and why a row can't run.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import type { ArchiveDrag } from "./drag-archive";
import { groupChoices, rowMenuOf } from "./session-context-menu";

const row = (over: Partial<SessionSummary> = {}) => ({ title: "Fix the build", archived: false, ...over }) as SessionSummary;
const ARCHIVES: ArchiveDrag = { kind: "archive" };
const NO_NOTE = { groupNote: null };

test("rowMenuOf: a self-named chat has no title rows; Gist and Reset say why they can't run", () => {
  assert.equal(rowMenuOf(row({ fixedName: "overseer" as SessionSummary["fixedName"] }), ARCHIVES, NO_NOTE).title, null);
  const plain = rowMenuOf(row(), ARCHIVES, NO_NOTE).title!;
  assert.equal(plain.gistDisabled, "No gist yet.");
  assert.equal(plain.resetDisabled, "Not renamed.");
  const renamed = rowMenuOf(row({ originalTitle: "first words", outlineGist: "Ship the menu" }), ARCHIVES, NO_NOTE).title!;
  assert.deepEqual([renamed.gist, renamed.gistDisabled, renamed.original, renamed.resetDisabled], ["Ship the menu", "", "first words", ""]);
  const same = rowMenuOf(row({ title: "Ship the menu", outlineGist: "Ship the menu" }), ARCHIVES, NO_NOTE).title!;
  assert.equal(same.gistDisabled, "The gist is already the title.");
});

test("rowMenuOf: Archive and Move to Group refuse exactly what the drop panel refuses, in its words", () => {
  assert.deepEqual(rowMenuOf(row(), ARCHIVES, NO_NOTE).archive, { label: "Archive", act: "archive", disabled: "" });
  assert.deepEqual(rowMenuOf(row({ archived: true }), { kind: "none" }, NO_NOTE).archive, { label: "Unarchive", act: "unarchive", disabled: "" });
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
