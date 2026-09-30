// Run: npx tsx --test src/lib/drag-archive.test.ts
// Dropping a row on the drop overlay's Archive tile: what the drag may do, what the tile says
// when it can't, and what the drop says.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveDragOf, archivedDropToast, archiveTileReason, blockedDropSentence, orgProjectOf, unarchivedToast } from "./drag-archive";
import type { SelectableSession } from "./session-selection";

const row = (over: Partial<SelectableSession> = {}): SelectableSession => ({
  path: "/s/1.jsonl",
  id: "id-1",
  title: "Fix the build",
  archived: false,
  origin: "web",
  busy: false,
  live: null,
  ...over,
});

test("an eligible row's Archive tile is open: no reason, no refusal", () => {
  const drag = archiveDragOf(row());
  assert.deepEqual(drag, { kind: "archive" });
  assert.equal(archiveTileReason(drag, false), null);
  assert.equal(blockedDropSentence(drag), null);
});

test("a row already in the Archive region can't be archived again, and the tile says where it already is", () => {
  // Archived, even one that would be blocked if it weren't: it's already where the gesture goes.
  const already: Partial<SelectableSession>[] = [{ archived: true }, { archived: true, origin: "external" }, { archived: true, busy: true }];
  // Archived and open in a TUI: on top while live, but archiving it again means nothing.
  already.push({ archived: true, live: { pid: 7, status: "idle" } });
  // External and not live: the Archive region lists it without an archived flag.
  already.push({ origin: "external" }, { origin: "external", busy: true });
  for (const over of already) {
    const drag = archiveDragOf(row(over));
    assert.deepEqual(drag, { kind: "none" });
    assert.equal(archiveTileReason(drag, over.archived), over.archived ? "Already archived." : "Already in the Archive.");
    assert.equal(blockedDropSentence(drag), null);
  }
});

test("a blocked row's Archive tile shows archiveBlockReason's own words and refuses the drop", () => {
  const cases: [Partial<SelectableSession>, string][] = [
    [{ live: { pid: 7, status: "idle" } }, "open in a TUI"],
    // Live wins: an external session open in a TUI is on top, and blocked for the TUI.
    [{ origin: "external", live: { pid: 7, status: "idle" } }, "open in a TUI"],
    [{ busy: true }, "mid-turn"],
    [{ workers: { working: 2, total: 2 } }, "with subagents working"],
  ];
  for (const [over, reason] of cases) {
    const drag = archiveDragOf(row(over));
    assert.deepEqual(drag, { kind: "blocked", reason });
    assert.equal(archiveTileReason(drag, false), `Can't archive: ${reason}`);
    assert.equal(blockedDropSentence(drag), `Can't archive this session: ${reason}.`);
  }
});

test("a drop that archived offers Undo; one that deleted a never-sent session does not", () => {
  assert.deepEqual(archivedDropToast(false), { text: "Archived. Find it under Archive.", undo: true });
  const gone = archivedDropToast(true);
  assert.equal(gone.undo, false);
  // It must not claim the session is in the Archive: the server deleted the file.
  assert.doesNotMatch(gone.text, /Archive\./);
});

test("an org session goes to its group's Done list in its project, and back to its project", () => {
  const org = { orgId: "o", orgName: "Mamluk Arabia", projectId: "p", projectName: "Rakiba site", kind: "gathering" } as const;
  const project = orgProjectOf({ org });
  assert.equal(project, "Rakiba site");
  assert.deepEqual(archivedDropToast(false, project), { text: "Archived. Find it in Rakiba site, under Done.", undo: true });
  assert.doesNotMatch(archivedDropToast(false, project).text, /under Archive/);
  assert.equal(unarchivedToast(project), "Moved back to Rakiba site.");
  assert.equal(unarchivedToast(orgProjectOf({})), "Moved back to Live & web.", "an ordinary session is unchanged");
  assert.equal(archivedDropToast(true, project).undo, false, "a deleted never-sent session is still deleted");
});
