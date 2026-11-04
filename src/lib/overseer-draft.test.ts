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
  overseerDraftIssue,
  capsChangedFromDefault,
  perMessageSummary,
  runningNowLine,
  PER_MESSAGE_CAP_KEYS,
  CAP_KEYS,
  CAP_LABEL,
  resetOverseerDraft,
  setOverseerDraft,
  setOverseerSaved,
  explorerOptions,
  CAP_MAX,
  CAP_DEFAULTS,
  QUICK_ACTIONS_MAX,
  QA_LABEL_MAX,
  QA_DESC_MAX,
  QA_PROMPT_MAX,
  NOTES_MAX,
  EXTRA_PROMPT_MAX,
  atDefaults,
  canAddQuickAction,
  capOf,
  completeCaps,
  formToDraft,
  lengthCount,
  overseerProblem,
  saveOverseer,
  toOverseerForm,
  resetLimits,
  resetQuickActions,
  resetExplorer,
} from "./overseer-draft";

const settings = (): OverseerSettings => ({
  version: 2,
  model: null,
  thinking: null,
  extraSystemPrompt: "",
  proactivity: "badge",
  quickActions: [{ id: "attention", label: "What Needs Me", description: "Sessions waiting on you.", prompt: "What needs my attention?" }],
  caps: { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 5, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3, extRunsPerTurn: 5 },
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
  assert.equal(out.settings.caps.explorePerTurn, "4", "the form's limits are text: the file's new value shows as typed");

  const blank = cloneOverseer({ settings: settings(), notes: "" });
  blank.settings.explorer = { backend: "pi", model: "", effort: "" };
  assert.match(overseerDraftProblem(blank)!, /idea explorer/);
  const badCap = cloneOverseer({ settings: settings(), notes: "" });
  badCap.settings.caps.explorePerTurn = -1;
  assert.match(overseerDraftProblem(badCap)!, /Ideas explored/);
});

test("the explorer's model lists: the shipped default is known, Claude Opus 5 is never offered", () => {
  const shipped = { backend: "claude-code" as const, model: "opus[1m]", effort: "medium" };
  const info = { backends: [{ id: "claude-code" as const, label: "Claude Code", efforts: ["low", "medium", "high"] }, { id: "pi" as const, label: "pi", efforts: ["low"] }] };
  const out = explorerOptions(
    {
      backends: [
        { id: "claude-code", label: "Claude Code", models: [{ id: "claude-opus-5", name: "Opus 5", efforts: ["low"] }, { id: "claude-opus-5[1m]", name: "Opus 5 (1M)", efforts: ["low"] }, { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low"] }] },
        { id: "pi", label: "pi", models: [{ id: "claude-code-cli/claude-opus-5", name: "x", efforts: ["low"] }, { id: "zai/glm-5.3", name: "GLM", efforts: ["low"] }] },
      ],
    },
    info,
    shipped,
  )!;
  assert.deepEqual(out.backends[0]!.models!.map((m) => m.id), ["opus[1m]", "claude-opus-5-5"]);
  assert.deepEqual(out.backends[0]!.models![0]!.efforts, ["low", "medium", "high"], "the default takes every effort its backend does");
  assert.deepEqual(out.backends[1]!.models!.map((m) => m.id), ["zai/glm-5.3"]);
  // Listed already: not duplicated. Discovery failed: still unknown, not invented.
  const listed = explorerOptions({ backends: [{ id: "claude-code", label: "Claude Code", models: [{ id: "opus[1m]", name: "Opus", efforts: ["high"] }] }] }, info, shipped)!;
  assert.deepEqual(listed.backends[0]!.models, [{ id: "opus[1m]", name: "Opus", efforts: ["high"] }]);
  const down = explorerOptions({ backends: [{ id: "claude-code", label: "Claude Code", models: null, error: "no CLI" }] }, info, shipped)!;
  assert.equal(down.backends[0]!.models, null);
  assert.equal(explorerOptions(undefined, info, shipped), undefined);
});

test("Per-message limits: all nine limits are on the page, eight folded, and the head counts the ones off their default", () => {
  assert.deepEqual([...PER_MESSAGE_CAP_KEYS, "concurrentSessions"].sort(), [...CAP_KEYS].sort(), "Running at once plus the folded eight is every limit");
  assert.equal(PER_MESSAGE_CAP_KEYS.length, 8);
  assert.equal(CAP_LABEL.extRunsPerTurn.label, "Extension commands run");
  const defaults = settings().caps;
  assert.equal(capsChangedFromDefault(defaults, defaults), 0);
  assert.equal(perMessageSummary(0), "All at default");
  assert.equal(capsChangedFromDefault({ ...defaults, concurrentSessions: 99 }, defaults), 0, "Running at once isn't in the folded group, so it isn't counted there");
  assert.equal(capsChangedFromDefault({ ...defaults, createPerTurn: 6, gatherPerTurn: 0 }, defaults), 2);
  assert.equal(capsChangedFromDefault({ ...defaults, linksPerTurn: Number.NaN }, defaults), 1, "a cleared field is a change");
  assert.equal(perMessageSummary(2), "2 changed from default");
});

test("the reason Save waits says where it is, so the folded group holding that field can open", () => {
  const base = settings();
  const at = (s: OverseerSettings) => overseerDraftIssue({ settings: s, notes: "" });
  assert.equal(at(base), null);
  for (const k of PER_MESSAGE_CAP_KEYS) assert.deepEqual(at({ ...base, caps: { ...base.caps, [k]: -1 } })?.at, { group: "per-message", key: k }, k);
  assert.deepEqual(at({ ...base, caps: { ...base.caps, concurrentSessions: 1.5 } })?.at, { group: "running" }, "Running at once is never folded");
  const qa = at({ ...base, quickActions: [...base.quickActions, { id: "custom-2", label: "", description: "", prompt: "x" }] });
  assert.deepEqual(qa?.at, { group: "quick-action", index: 1 });
  assert.equal(qa?.message, "Quick action 2 needs a label and a prompt.");
  const ex = at({ ...base, explorer: { backend: "pi", model: "", effort: "" } });
  assert.deepEqual(ex?.at, { group: "advanced" });
  assert.equal(ex?.message, "The idea explorer needs a model and an effort.");
  // The message the footer shows is the same sentence.
  assert.equal(overseerDraftProblem({ settings: { ...base, explorer: { backend: "pi", model: "", effort: "" } }, notes: "" }), ex?.message);
});

test("Running at once's live line pairs the count now with the number in the field, or the saved limit while the field is invalid", () => {
  assert.equal(runningNowLine(3, 10, 10), "Now: 3 of 10 running.");
  assert.equal(runningNowLine(3, 20, 10), "Now: 3 of 20 running.", "an unsaved edit shows what it would allow");
  assert.equal(runningNowLine(0, Number.NaN, 10), "Now: 0 of 10 running.");
  assert.equal(runningNowLine(2, -4, 5), "Now: 2 of 5 running.");
});

// ---- Settings QA (feat/settings-forms-qa): the form checks the server's limits before Save -----

test("a limit goes up to 1000, the same as the server: 1000 saves, 1001 waits", () => {
  const at = (v: number | string) => overseerDraftProblem({ settings: { ...settings(), caps: { ...settings().caps, createPerTurn: v } }, notes: "" });
  assert.equal(CAP_MAX, 1000);
  assert.equal(at(1000), null);
  assert.equal(at("1000"), null);
  assert.equal(at(0), null);
  assert.equal(at(1001), "Sessions created must be a whole number from 0 to 1000.");
  assert.equal(at("1001"), "Sessions created must be a whole number from 0 to 1000.");
});

test("a limit box holds the text typed: blank, half-typed or a letter stays as typed, red, and Save waits", () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "" });
  for (const typed of ["", "1e", "a5", "5a", "-", "1.5", " "]) {
    const d = cloneOverseer(overseerDraft()!);
    d.settings.caps.createPerTurn = typed;
    setOverseerDraft(d);
    assert.equal(overseerDraft()!.settings.caps.createPerTurn, typed, `${JSON.stringify(typed)} stays as typed`);
    assert.equal(overseerDirty(), true, `${JSON.stringify(typed)} is an unsaved change`);
    assert.match(overseerDraftProblem(overseerDraft()!)!, /Sessions created must be a whole number/, JSON.stringify(typed));
    assert.equal(capOf(typed), null);
  }
  // Typing on from an invalid box makes it valid again (it never freezes red).
  const d = cloneOverseer(overseerDraft()!);
  d.settings.caps.createPerTurn = "7";
  setOverseerDraft(d);
  assert.equal(overseerDraftProblem(overseerDraft()!), null);
  assert.equal(overseerDirty(), true);
  // The saved number typed back is no change.
  d.settings.caps.createPerTurn = "5";
  setOverseerDraft(cloneOverseer(d));
  assert.equal(overseerDirty(), false);
  resetOverseerDraft();
});

test("a fresh draft shows each limit as text, and a save sends numbers", async () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "" });
  assert.equal(overseerDraft()!.settings.caps.createPerTurn, "5");
  const d = cloneOverseer(overseerDraft()!);
  d.settings.caps.archivesPerTurn = "1000";
  const sent: OverseerSettings[] = [];
  await saveOverseerDraft(formToDraft(d), { settings: settings(), notes: "" }, {
    getSettings: async () => ({ settings: settings(), file: "/x", defaults: { quickActions: [], caps: settings().caps, explorer: settings().explorer } }),
    getNotes: async () => "",
    putSettings: async (s) => {
      sent.push(s);
      return { settings: s, file: "/x", defaults: { quickActions: [], caps: s.caps, explorer: s.explorer }, warnings: [] };
    },
    putNotes: async (t) => t,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.caps.archivesPerTurn, 1000);
  assert.equal(sent[0]!.caps.createPerTurn, 5);
  for (const k of CAP_KEYS) assert.equal(typeof sent[0]!.caps[k], "number", k);
  resetOverseerDraft();
});

test("a limit missing from what the server sent is filled from the defaults, never left blank and red", () => {
  const partial = settings();
  delete (partial.caps as Partial<OverseerSettings["caps"]>).extRunsPerTurn;
  const filled = completeCaps(partial, { ...settings().caps, extRunsPerTurn: 7 });
  assert.equal(filled.caps.extRunsPerTurn, 7);
  // The defaults lack it too (an older server): the form's own default.
  const both = completeCaps(partial, partial.caps);
  assert.equal(both.caps.extRunsPerTurn, CAP_DEFAULTS.extRunsPerTurn);
  resetOverseerDraft();
  setOverseerSaved({ settings: completeCaps(partial, partial.caps), notes: "" });
  assert.equal(overseerDraftProblem(overseerDraft()!), null);
  assert.equal(overseerDirty(), false);
  resetOverseerDraft();
});

test("the form checks every server limit on quick actions, notes and extra instructions before anything is sent", () => {
  const ok = settings();
  const qa = (patch: Partial<OverseerSettings["quickActions"][number]>) => ({ settings: { ...ok, quickActions: [ok.quickActions[0]!, { ...ok.quickActions[0]!, id: "b", ...patch }] }, notes: "" });
  assert.equal(overseerDraftProblem(qa({ label: "x".repeat(QA_LABEL_MAX) })), null);
  assert.equal(overseerDraftProblem(qa({ label: "x".repeat(QA_LABEL_MAX + 1) })), "Quick action 2's label can be at most 40 characters.");
  assert.equal(overseerDraftProblem(qa({ label: ` ${"x".repeat(QA_LABEL_MAX)} ` })), null, "the server trims before it counts");
  assert.equal(overseerDraftProblem(qa({ description: "x".repeat(QA_DESC_MAX) })), null);
  assert.equal(overseerDraftProblem(qa({ description: "x".repeat(QA_DESC_MAX + 1) })), "Quick action 2's description can be at most 120 characters.");
  assert.equal(overseerDraftProblem(qa({ prompt: "x".repeat(QA_PROMPT_MAX) })), null);
  assert.equal(overseerDraftProblem(qa({ prompt: "x".repeat(QA_PROMPT_MAX + 1) })), "Quick action 2's prompt can be at most 2,000 characters.");
  assert.deepEqual(overseerDraftIssue(qa({ prompt: "x".repeat(QA_PROMPT_MAX + 1) }))?.at, { group: "quick-action", index: 1 });

  const many = (n: number) => ({ settings: { ...ok, quickActions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, label: `Q${i}`, description: "", prompt: "p" })) }, notes: "" });
  assert.equal(overseerDraftProblem(many(QUICK_ACTIONS_MAX)), null);
  assert.equal(overseerDraftProblem(many(QUICK_ACTIONS_MAX + 1)), "There can be at most 12 quick actions.");
  assert.equal(canAddQuickAction(many(QUICK_ACTIONS_MAX - 1).settings.quickActions), true);
  assert.equal(canAddQuickAction(many(QUICK_ACTIONS_MAX).settings.quickActions), false, "Add Quick Action stops at 12");

  assert.equal(overseerDraftProblem({ settings: ok, notes: "x".repeat(NOTES_MAX) }), null);
  assert.equal(overseerDraftProblem({ settings: ok, notes: "x".repeat(NOTES_MAX + 1) }), "Standing notes can be at most 8,000 characters.");
  assert.deepEqual(overseerDraftIssue({ settings: ok, notes: "x".repeat(NOTES_MAX + 1) })?.at, { group: "notes" });

  assert.equal(overseerDraftProblem({ settings: { ...ok, extraSystemPrompt: "x".repeat(EXTRA_PROMPT_MAX) }, notes: "" }), null);
  assert.equal(overseerDraftProblem({ settings: { ...ok, extraSystemPrompt: "x".repeat(EXTRA_PROMPT_MAX + 1) }, notes: "" }), "Extra instructions can be at most 8,000 characters.");
  assert.deepEqual(overseerDraftIssue({ settings: { ...ok, extraSystemPrompt: "x".repeat(EXTRA_PROMPT_MAX + 1) }, notes: "" })?.at, { group: "advanced" });
  assert.equal(lengthCount("x".repeat(8001), 8000), "8,001 / 8,000");
});

test("over-long notes never half-save: the dialog's save is skipped before any settings are written", async () => {
  resetOverseerDraft();
  setOverseerSaved({ settings: settings(), notes: "" });
  const d = cloneOverseer(overseerDraft()!);
  d.settings.proactivity = "brief";
  d.notes = "x".repeat(NOTES_MAX + 1);
  setOverseerDraft(d);
  assert.equal(overseerDirty(), true);
  assert.match(overseerProblem()!, /^Overseer: Standing notes can be at most 8,000 characters\.$/);
  assert.equal(await saveOverseer(), "skipped", "nothing is sent while the form has a problem");
  resetOverseerDraft();
});

test("each Reset to Defaults is greyed out when its group already holds the defaults", () => {
  const defaults = { quickActions: settings().quickActions, caps: settings().caps, explorer: settings().explorer };
  const form = toOverseerForm({ settings: settings(), notes: "" });
  assert.deepEqual(atDefaults(form, defaults), { limits: true, quickActions: true, explorer: true });
  form.settings.caps.linksPerTurn = "";
  form.settings.quickActions = [];
  form.settings.explorer = { ...form.settings.explorer, effort: "high" };
  assert.deepEqual(atDefaults(form, defaults), { limits: false, quickActions: false, explorer: false });
  form.settings.caps.linksPerTurn = "3";
  assert.equal(atDefaults(form, defaults).limits, true, "the default typed back counts");
});

test("each Overseer Reset to Defaults puts back its group alone, limits as box text", () => {
  const defaults = { quickActions: settings().quickActions, caps: settings().caps, explorer: settings().explorer };
  const form = toOverseerForm({ settings: settings(), notes: "keep" });
  form.settings.caps.createPerTurn = "1e";
  form.settings.quickActions = [];
  form.settings.explorer = { backend: "pi", model: "", effort: "" };
  form.settings.proactivity = "brief";
  const limits = resetLimits(form, defaults);
  assert.deepEqual(limits.settings.caps, toOverseerForm({ settings: settings(), notes: "" }).settings.caps);
  assert.deepEqual(limits.settings.quickActions, [], "only its own group");
  assert.equal(limits.settings.proactivity, "brief");
  assert.equal(limits.notes, "keep");
  assert.deepEqual(resetQuickActions(form, defaults).settings.quickActions, defaults.quickActions);
  assert.notEqual(resetQuickActions(form, defaults).settings.quickActions[0], defaults.quickActions[0], "a copy");
  assert.deepEqual(resetExplorer(form, defaults).settings.explorer, defaults.explorer);
  assert.equal(resetExplorer(form, defaults).settings.caps.createPerTurn, "1e");
  const all = resetExplorer(resetQuickActions(resetLimits(form, defaults), defaults), defaults);
  assert.deepEqual(atDefaults(all, defaults), { limits: true, quickActions: true, explorer: true });
  assert.equal(overseerDraftProblem(all), null);
});
