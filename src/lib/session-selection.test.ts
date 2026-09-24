// Run: npx tsx --test src/lib/session-selection.test.ts
// The selection's own rules: which rows a bulk archive may touch, what the toolbar offers at one
// row and at two, what one run says afterwards, and what a poll of the session list may not do.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveBlockReason,
  archiveSummary,
  beginSelectionAction,
  blockedSentence,
  clearSelection,
  finishSelectionAction,
  groupMoveSummary,
  isSelected,
  isTextEntry,
  keepSelected,
  ownsSelectionAction,
  prunedSelection,
  pruneSelection,
  selectedPaths,
  selectedSessions,
  selectionBusy,
  selectionMode,
  selectionPlan,
  startSelection,
  toggleSelected,
  toggleSelection,
  type SelectableSession,
} from "./session-selection";

let n = 0;
const row = (over: Partial<SelectableSession> = {}): SelectableSession => ({
  path: `/s/${++n}.jsonl`,
  id: `id-${n}`,
  title: `Session ${n}`,
  archived: false,
  origin: "web",
  busy: false,
  live: null,
  ...over,
});

test("archiveBlockReason: the four blocks, and never for an archived row", () => {
  assert.equal(archiveBlockReason(row()), null);
  assert.equal(archiveBlockReason(row({ live: { pid: 7, status: "idle" } })), "open in a TUI");
  assert.equal(archiveBlockReason(row({ origin: "external" })), "not started in Sova");
  assert.equal(archiveBlockReason(row({ busy: true })), "mid-turn");
  assert.equal(archiveBlockReason(row({ workers: { working: 2, total: 3 } })), "with subagents working");
  assert.equal(archiveBlockReason(row({ workers: { working: 1, total: 1 } })), "with subagents working");
  assert.equal(archiveBlockReason(row({ live: { pid: 7, status: "idle", workers: { working: 1, total: 1 } } })), "open in a TUI");
  // Every block is about ARCHIVING. Unarchiving a TUI-live, busy, external row is fine.
  for (const over of [{ live: { pid: 7, status: "idle" } }, { origin: "external" as const }, { busy: true }, { workers: { working: 1, total: 1 } }]) {
    assert.equal(archiveBlockReason(row({ ...over, archived: true })), null);
  }
});

test("Rename is offered at exactly one session, and gone at two", () => {
  assert.equal(selectionPlan([]).canRename, false);
  assert.equal(selectionPlan([row()]).canRename, true);
  assert.equal(selectionPlan([row(), row()]).canRename, false);
  assert.equal(selectionPlan([row(), row(), row()]).canRename, false);
});

test("all archived → Unarchive; none archived → Archive; a mix is disabled, and says why", () => {
  const a = row({ archived: true });
  const b = row({ archived: true });
  const c = row();
  assert.equal(selectionPlan([a, b]).mode, "unarchive");
  assert.equal(selectionPlan([a, b]).disabled, "");
  assert.deepEqual(selectionPlan([a, b]).eligible, [a, b]);
  assert.equal(selectionPlan([c]).mode, "archive");
  const mixed = selectionPlan([a, b, c]);
  assert.equal(mixed.mode, "mixed");
  assert.match(mixed.disabled, /2 of these 3 are archived/);
  assert.deepEqual(mixed.eligible, [], "a disabled control writes nothing");
  // The unarchive side is never blocked by liveness or a running turn.
  const live = row({ archived: true, live: { pid: 3, status: "working" }, busy: true });
  assert.equal(selectionPlan([live]).disabled, "");
  assert.deepEqual(selectionPlan([live]).eligible, [live]);
});

test("a bulk archive splits the selection into what it writes and what it skips", () => {
  const ok1 = row();
  const ok2 = row();
  const tui = row({ live: { pid: 1, status: "idle" } });
  const ext = row({ origin: "external" });
  const plan = selectionPlan([ok1, tui, ok2, ext]);
  assert.deepEqual(plan.eligible, [ok1, ok2], "the list's own order, not the pick order");
  assert.deepEqual(plan.blocked.map((b) => b.reason), ["open in a TUI", "not started in Sova"]);
  assert.equal(plan.disabled, "", "some can go, so the control runs");
  // Nothing eligible at all: the control is disabled with the same reasons, said before the press.
  const none = selectionPlan([tui, ext, row({ busy: true })]);
  assert.match(none.disabled, /^Nothing here can be archived: /);
  assert.match(none.disabled, /1 open in a TUI/);
  assert.equal(selectionPlan([]).disabled, "Nothing is selected.");
});

test("blockedSentence counts reasons, most common first, and never names rows", () => {
  assert.equal(blockedSentence([]), "");
  assert.equal(blockedSentence([{ reason: "mid-turn" }]), "1 mid-turn");
  assert.equal(
    blockedSentence([{ reason: "mid-turn" }, { reason: "open in a TUI" }, { reason: "open in a TUI" }]),
    "2 open in a TUI, 1 mid-turn",
  );
});

test("one run, one sentence: what it did, what it skipped, what failed", () => {
  assert.equal(
    archiveSummary({ mode: "archive", done: 3, blocked: [], failed: [] }),
    "Archived 3 sessions.",
  );
  assert.equal(
    archiveSummary({ mode: "unarchive", done: 1, blocked: [], failed: [] }),
    "Unarchived 1 session.",
  );
  assert.equal(
    archiveSummary({ mode: "archive", done: 2, blocked: [{ reason: "open in a TUI" }], failed: [{ reason: "The server said no." }] }),
    "Archived 2 sessions. Skipped 1: 1 open in a TUI. 1 failed: The server said no.",
  );
  assert.equal(
    archiveSummary({ mode: "archive", done: 0, blocked: [{ reason: "mid-turn" }, { reason: "mid-turn" }], failed: [] }),
    "Archived nothing. Skipped 2: 2 mid-turn.",
  );
  // Two rows that failed the same way say that reason once, not twice.
  assert.equal(
    archiveSummary({ mode: "archive", done: 0, blocked: [], failed: [{ reason: "The server is gone." }, { reason: "The server is gone." }] }),
    "Archived nothing. 2 failed: The server is gone.",
  );
  assert.equal(groupMoveSummary({ done: 2, groupName: "Work", failed: 0 }), "Moved 2 sessions to “Work”.");
  assert.equal(groupMoveSummary({ done: 1, groupName: null, failed: 1 }), "Moved 1 session out of their group. 1 failed.");
});

test("toggleSelected adds, removes, and never mutates the set it was handed", () => {
  const before: ReadonlySet<string> = new Set(["/a"]);
  const withB = toggleSelected(before, "/b");
  assert.deepEqual([...before], ["/a"]);
  assert.deepEqual([...withB].sort(), ["/a", "/b"]);
  assert.deepEqual([...toggleSelected(withB, "/a")], ["/b"]);
});

test("pruning keeps the SAME set when nothing is gone — a poll must not re-render the list", () => {
  const selected: ReadonlySet<string> = new Set(["/a", "/b"]);
  assert.equal(prunedSelection(selected, ["/a", "/b", "/c"]), selected, "same identity, not just equal");
  assert.equal(prunedSelection(selected, ["/b", "/a"]), selected, "order is not a change");
  const empty: ReadonlySet<string> = new Set();
  assert.equal(prunedSelection(empty, []), empty, "an empty selection is handed straight back");
  const pruned = prunedSelection(selected, ["/a"]);
  assert.notEqual(pruned, selected);
  assert.deepEqual([...pruned], ["/a"]);
});

test("selectedSessions reads the list's order, whatever order the rows were picked in", () => {
  const a = row();
  const b = row();
  const c = row();
  assert.deepEqual(selectedSessions([a, b, c], new Set([c.path, a.path])), [a, c]);
});

test("the store: a hold selects the held row, clicks toggle, Cancel forgets everything", () => {
  const a = row();
  const b = row();
  assert.equal(selectionMode(), false);
  startSelection(a.path);
  assert.equal(selectionMode(), true);
  assert.deepEqual([...selectedPaths()], [a.path]);
  startSelection(a.path); // a second hold on the same row must not deselect it
  assert.deepEqual([...selectedPaths()], [a.path]);
  toggleSelection(b.path);
  assert.equal(isSelected(b.path), true);
  toggleSelection(b.path);
  assert.equal(isSelected(b.path), false);
  // A poll of the list drops nothing that is still there, and drops what isn't.
  pruneSelection([a.path, b.path]);
  assert.deepEqual([...selectedPaths()], [a.path]);
  pruneSelection([b.path]);
  assert.deepEqual([...selectedPaths()], []);
  assert.equal(selectionMode(), true, "an empty selection is still selection mode");
  // What an action does with the rows it couldn't touch: keep them, and stay in the mode.
  keepSelected([a.path, b.path]);
  assert.deepEqual([...selectedPaths()].sort(), [a.path, b.path].sort());
  assert.equal(selectionMode(), true);
  keepSelected([]); // nothing left over: the mode ends with the run
  assert.equal(selectionMode(), false);
  assert.deepEqual([...selectedPaths()], []);
  startSelection(a.path);
  clearSelection();
  assert.equal(selectionMode(), false);
  assert.deepEqual([...selectedPaths()], []);
});

test("isTextEntry: a caret, not merely an <input> — Escape on a row's checkbox is the sidebar's", () => {
  // The bug this pins: every <input> counted as a text field, so Escape on a row checkbox — the
  // one control selection mode puts under the keyboard — never left the mode.
  assert.equal(isTextEntry({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextEntry({ tagName: "input", type: "CHECKBOX" }), false, "tag and type are case-insensitive");
  for (const type of ["radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"]) {
    assert.equal(isTextEntry({ tagName: "INPUT", type }), false, type);
  }
  for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date"]) {
    assert.equal(isTextEntry({ tagName: "INPUT", type }), true, type);
  }
  assert.equal(isTextEntry({ tagName: "INPUT" }), true, "no type attribute is text, per HTML");
  assert.equal(isTextEntry({ tagName: "INPUT", type: "some-future-type" }), true, "unknown types are text, not buttons");
  assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: "DIV" }), false);
  assert.equal(isTextEntry({ tagName: "BUTTON" }), false);
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(undefined), false);
});

test("the action lock: one action owns the tab, and the toolbar's gestures are refused meanwhile", () => {
  clearSelection();
  startSelection("/a");
  toggleSelection("/b");
  assert.equal(selectionBusy(), false);
  const token = beginSelectionAction();
  assert.ok(token !== null);
  assert.equal(selectionBusy(), true);
  assert.equal(beginSelectionAction(), null, "a second action cannot start");
  // While it runs, nothing may move the selection out from under it.
  toggleSelection("/c");
  startSelection("/d");
  assert.deepEqual([...selectedPaths()].sort(), ["/a", "/b"]);
  assert.equal(ownsSelectionAction(token!), true);
  assert.equal(finishSelectionAction(token!, ["/b"]), true);
  assert.equal(selectionBusy(), false);
  assert.deepEqual([...selectedPaths()], ["/b"], "its leftovers land, because it still owned the tab");
  assert.equal(selectionMode(), true);
});

test("a run that comes back to a tab that moved on writes NOTHING", async () => {
  // The shape this pins: Archive pressed, Cancel, selection mode re-entered with other rows
  // picked — and then the first run's requests land. Its leftovers must not reappear over them.
  clearSelection();
  startSelection("/old-1");
  toggleSelection("/old-2");
  const stale = beginSelectionAction();
  assert.ok(stale !== null);
  const inFlight = new Promise<readonly string[]>((resolve) => setTimeout(() => resolve(["/old-1"]), 20));
  // The user gives up on it: Cancel (or the sidebar unmounting) takes the tab back.
  clearSelection();
  assert.equal(selectionBusy(), false, "the tab is free again");
  assert.equal(ownsSelectionAction(stale!), false);
  // A new selection, and a new action on top of it.
  startSelection("/new-1");
  const fresh = beginSelectionAction();
  assert.ok(fresh !== null);
  assert.notEqual(fresh, stale, "tokens never repeat");
  // Now the old one lands.
  const leftovers = await inFlight;
  assert.equal(finishSelectionAction(stale!, leftovers), false, "it no longer owns the tab");
  assert.deepEqual([...selectedPaths()], ["/new-1"], "the newer selection is untouched");
  assert.equal(selectionBusy(), true, "and the newer action still holds the tab");
  assert.equal(finishSelectionAction(fresh!, []), true);
  assert.equal(selectionMode(), false, "a clean run ends the mode");
  assert.equal(selectionBusy(), false);
});

test("an action that throws still hands the tab back (the caller's finally)", async () => {
  clearSelection();
  startSelection("/a");
  const token = beginSelectionAction();
  assert.ok(token !== null);
  try {
    await Promise.reject(new Error("the server is gone"));
  } catch {
    finishSelectionAction(token!, ["/a"]);
  }
  assert.equal(selectionBusy(), false);
  assert.deepEqual([...selectedPaths()], ["/a"]);
  clearSelection();
});
