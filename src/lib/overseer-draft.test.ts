import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverseerSaveResult, OverseerSettings } from "../../shared/protocol";
import {
  cloneOverseer,
  mergeNotes,
  NotesConflict,
  type OverseerDraft,
  overseerSaved,
  rebaseOverseer,
  saveOverseerDraft,
  moveQuickAction,
  newQuickAction,
  overseerDirty,
  overseerDraft,
  overseerDraftProblem,
  resetOverseerDraft,
  setOverseerDraft,
  setOverseerSaved,
} from "./overseer-draft";

const settings = (): OverseerSettings => ({
  version: 1,
  model: null,
  thinking: null,
  extraSystemPrompt: "",
  proactivity: "badge",
  quickActions: [{ id: "attention", label: "What Needs Me", description: "Sessions waiting on you.", prompt: "What needs my attention?" }],
  caps: { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 5, explorePerTurn: 2 },
  explorer: { backend: "claude-code", model: "opus[1m]", effort: "medium" },
});

test("an edit anywhere — a quick action, a cap, the notes — makes the draft dirty; putting it back doesn't", () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "" });
  assert.equal(overseerDirty(), false);
  const d = cloneOverseer(overseerDraft()!);
  d.settings.quickActions[0]!.prompt = "What needs me now?";
  setOverseerDraft(d);
  assert.equal(overseerDirty(), true, "the clone is deep: editing it never edits what was saved");
  setOverseerDraft({ settings: settings(), notes: "" });
  assert.equal(overseerDirty(), false);
  setOverseerDraft({ settings: { ...settings(), caps: { ...settings().caps, archivesPerTurn: 10 } }, notes: "" });
  assert.equal(overseerDirty(), true);
  setOverseerDraft({ settings: settings(), notes: "be terse" });
  assert.equal(overseerDirty(), true);
  setOverseerSaved({ settings: settings(), notes: "x" });
  assert.equal(overseerDraft()!.notes, "be terse\nx\n", "a later load never overwrites a kept edit; what the Overseer appended follows it");
  resetOverseerDraft();
});

test("a draft that can't be saved says why", () => {
  const ok = { settings: settings(), notes: "" };
  assert.equal(overseerDraftProblem(ok), null);
  assert.match(overseerDraftProblem({ ...ok, settings: { ...settings(), caps: { ...settings().caps, createPerTurn: 1.5 } } })!, /Sessions created/);
  assert.match(overseerDraftProblem({ ...ok, settings: { ...settings(), caps: { ...settings().caps, promptsPerTurn: Number.NaN } } })!, /whole number/);
  const blank = settings();
  blank.quickActions.push(newQuickAction(blank.quickActions));
  assert.equal(overseerDraftProblem({ ...ok, settings: blank }), "Quick action 2 needs a label and a prompt.");
});

test("new quick actions get unused ids; moves stay in range", () => {
  const a = newQuickAction([{ id: "custom-2", label: "", description: "", prompt: "" }]);
  assert.notEqual(a.id, "custom-2");
  assert.deepEqual(moveQuickAction([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveQuickAction([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveQuickAction([1, 2, 3], 2, 1), [1, 2, 3]);
});

/** The two files as the server holds them, and every write a save makes. */
function fakeServer(settings: OverseerSettings, notes: string) {
  const file = { settings: cloneOverseer({ settings, notes }).settings, notes };
  const puts: { settings: OverseerSettings[]; notes: { text: string; base: string }[] } = { settings: [], notes: [] };
  const io = {
    getSettings: async () => ({ settings: cloneOverseer(file).settings, file: "/x/overseer.json", defaults: { quickActions: [], caps: settings.caps, explorer: settings.explorer } }),
    getNotes: async () => file.notes,
    putSettings: async (s: OverseerSettings): Promise<OverseerSaveResult> => {
      puts.settings.push(s);
      file.settings = s;
      return { settings: s, file: "/x/overseer.json", defaults: { quickActions: [], caps: s.caps, explorer: s.explorer }, warnings: [] };
    },
    putNotes: async (text: string, base: string) => {
      puts.notes.push({ text, base });
      if (base !== file.notes) throw new Error("409");
      file.notes = text;
      return text;
    },
  };
  return { file, puts, io };
}

test("a save never writes back a model the composer changed after the form loaded (E2E F4, repro A)", async () => {
  const loaded: OverseerDraft = { settings: { ...settings(), model: "zai/glm-5.3", thinking: "high" }, notes: "" };
  const server = fakeServer(loaded.settings, "");
  // The composer switches the Overseer's model while the form sits on its older copy.
  server.file.settings = { ...server.file.settings, model: "ollama-cloud/glm-5.3", thinking: "medium" };
  const edited = cloneOverseer(loaded);
  edited.settings.extraSystemPrompt = "end with an owl";
  await saveOverseerDraft(edited, loaded, server.io);
  assert.equal(server.puts.settings.length, 1);
  assert.equal(server.file.settings.model, "ollama-cloud/glm-5.3", "the field the user didn't touch keeps the file's value");
  assert.equal(server.file.settings.thinking, "medium");
  assert.equal(server.file.settings.extraSystemPrompt, "end with an owl");
  assert.equal(server.puts.notes.length, 0, "untouched notes are never written");
});

test("a save never deletes a note the Overseer added after the form loaded (E2E F4, repro B)", async () => {
  const loaded: OverseerDraft = { settings: settings(), notes: "First note.\n" };
  const server = fakeServer(loaded.settings, loaded.notes);
  server.file.notes = "First note.\nSecond note: the tester likes kiwis.\n"; // sova_note append
  const edited = cloneOverseer(loaded);
  edited.settings.caps.archivesPerTurn = 49;
  await saveOverseerDraft(edited, loaded, server.io);
  assert.equal(server.file.settings.caps.archivesPerTurn, 49);
  assert.match(server.file.notes, /kiwis/);
  assert.equal(server.puts.notes.length, 0);

  // The user edited the notes too: their edit, with the Overseer's appended line after it.
  const server2 = fakeServer(loaded.settings, "First note.\nSecond note: the tester likes kiwis.\n");
  const withNotes = { ...cloneOverseer(loaded), notes: "First note, reworded.\n" };
  const out = await saveOverseerDraft(withNotes, loaded, server2.io);
  assert.equal(out.notes, "First note, reworded.\nSecond note: the tester likes kiwis.\n");
  assert.deepEqual(server2.puts.notes, [{ text: out.notes, base: "First note.\nSecond note: the tester likes kiwis.\n" }]);
  assert.equal(server2.puts.settings.length, 0, "unchanged settings are never written");
});

test("a rewrite by the Overseer under an edit of the notes is refused before anything is written", async () => {
  const loaded: OverseerDraft = { settings: settings(), notes: "old\n" };
  const server = fakeServer(loaded.settings, "entirely new\n"); // sova_note replace
  const edited = { settings: { ...settings(), proactivity: "brief" as const }, notes: "old, edited\n" };
  await assert.rejects(saveOverseerDraft(edited, loaded, server.io), NotesConflict);
  assert.equal(server.puts.settings.length + server.puts.notes.length, 0);
});

test("mergeNotes: untouched follows the file, an append carries over, a rewrite is a conflict", () => {
  assert.equal(mergeNotes("a\n", "a\n", "a\nb\n"), "a\nb\n");
  assert.equal(mergeNotes("a2\n", "a\n", "a\n"), "a2\n");
  assert.equal(mergeNotes("a2\n", "a\n", "a\nb\n"), "a2\nb\n");
  assert.equal(mergeNotes("", "", "b\n"), "b\n");
  assert.equal(mergeNotes("mine", "", "b\n"), "mine\nb\n");
  assert.equal(mergeNotes("a2\nb", "a\n", "a\nb\n"), "a2\nb", "already has the appended line");
  assert.equal(mergeNotes("a2\n", "a\n", "z\n"), null);
});

test("a fresh load under a kept draft keeps the user's edits and takes everything else from the file", () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "n\n" });
  const d = cloneOverseer(overseerDraft()!);
  d.settings.caps.createPerTurn = 1;
  setOverseerDraft(d);
  // Another tab's return, a reopen: the file now has a new model and an appended note.
  setOverseerSaved({ settings: { ...settings(), model: "ollama-cloud/glm-5.3" }, notes: "n\nkiwis\n" });
  assert.equal(overseerDraft()!.settings.model, "ollama-cloud/glm-5.3");
  assert.equal(overseerDraft()!.notes, "n\nkiwis\n");
  assert.equal(overseerDraft()!.settings.caps.createPerTurn, 1);
  assert.equal(overseerDirty(), true, "only the user's own edit is unsaved");
  assert.equal(overseerSaved()!.settings.model, "ollama-cloud/glm-5.3");
  const back = cloneOverseer(overseerDraft()!);
  back.settings.caps.createPerTurn = 5;
  setOverseerDraft(back);
  assert.equal(overseerDirty(), false);
  resetOverseerDraft();
});

test("rebase goes cap by cap; a field added to the settings later follows the file too", () => {
  const base: OverseerDraft = { settings: settings(), notes: "" };
  const mine = cloneOverseer(base);
  mine.settings.caps.createPerTurn = 1;
  const fresh = cloneOverseer(base);
  fresh.settings.caps.archivesPerTurn = 7;
  (fresh.settings as unknown as Record<string, unknown>).future = "x";
  const out = rebaseOverseer(mine, base, fresh);
  assert.equal(out.settings.caps.createPerTurn, 1);
  assert.equal(out.settings.caps.archivesPerTurn, 7);
  assert.equal((out.settings as unknown as Record<string, unknown>).future, "x");
});

test("the exploratory agent: an edit is dirty, deep-cloned, rebased as one choice, and must be complete", () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "" });
  const d = cloneOverseer(overseerDraft()!);
  d.settings.explorer.effort = "high";
  assert.equal(overseerSaved()!.settings.explorer.effort, "medium", "the clone is deep: the saved copy keeps its effort");
  setOverseerDraft(d);
  assert.equal(overseerDirty(), true);

  // The file changed a cap meanwhile: the user's explorer stays, the cap follows the file.
  const fresh = settings();
  fresh.caps.explorePerTurn = 4;
  const out = rebaseOverseer(d, { settings: settings(), notes: "" }, { settings: fresh, notes: "" });
  assert.deepEqual(out.settings.explorer, { backend: "claude-code", model: "opus[1m]", effort: "high" });
  assert.equal(out.settings.caps.explorePerTurn, 4);

  const blank = cloneOverseer({ settings: settings(), notes: "" });
  blank.settings.explorer = { backend: "pi", model: "", effort: "" };
  assert.match(overseerDraftProblem(blank)!, /exploratory agent/);
  const badCap = cloneOverseer({ settings: settings(), notes: "" });
  badCap.settings.caps.explorePerTurn = -1;
  assert.match(overseerDraftProblem(badCap)!, /Ideas explored/);
});
