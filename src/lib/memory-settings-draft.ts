import type { MemorySaveResult, MemorySettings } from "../../shared/protocol";
import { putMemorySettings } from "./api";
import { sameChoice, type DraftChoice } from "./delegate-form";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Memory's unsaved edits (§app.settings-dialog/memory): the summarizer's primary and
 * optional fallback. Sova's own file, written only here and by Save as default (which writes its
 * `default`, never the summarizer), so no rebase; the PUT carries no `default`, and the server keeps it.
 */
export interface MemoryDraft {
  primary: DraftChoice;
  fallback: DraftChoice | null;
}

export const toMemoryDraft = (s: MemorySettings): MemoryDraft => ({
  primary: { ...s.summarizer.primary },
  fallback: s.summarizer.fallback ? { ...s.summarizer.fallback } : null,
});

export const sameMemorySettings = (d: MemoryDraft, s: MemorySettings): boolean =>
  sameChoice(d.primary, s.summarizer.primary) && sameChoice(d.fallback, s.summarizer.fallback);

/** Why the draft can't be saved, one sentence naming the form (the dialog's footer), or null. */
export function memoryDraftProblem(d: MemoryDraft): string | null {
  if (!d.primary.model) return "Memory needs a primary model.";
  if (!d.primary.effort) return "Memory needs an effort for its primary model.";
  if (d.fallback && !d.fallback.model) return "Memory needs a fallback model.";
  if (d.fallback && !d.fallback.effort) return "Memory needs an effort for its fallback model.";
  if (d.fallback && sameChoice(d.primary, d.fallback)) return "Memory has a fallback that's the same model as its primary.";
  return null;
}

/** The PUT body: the summarizer only (no `default`: the server keeps the stored one). */
export const toMemorySettings = (d: MemoryDraft): MemorySettings => ({
  version: 1,
  summarizer: { primary: { ...d.primary }, fallback: d.fallback ? { ...d.fallback } : null },
});

const store = createDraftStore<MemoryDraft, MemorySettings, MemorySaveResult>({
  tab: "memory",
  label: "Memory",
  toDraft: toMemoryDraft,
  same: sameMemorySettings,
  problem: memoryDraftProblem,
  write: async (d) => {
    const result = await putMemorySettings(toMemorySettings(d));
    return { saved: result.settings, warnings: result.warnings, result };
  },
});

export const memoryDraft = store.draft;
export const setMemoryDraft = store.setDraft;
export const setMemorySaved = store.setSaved;
export const memorySaving = store.saving;
export const memorySaveError = store.error;
export const memorySaveWarnings = store.warnings;
export const memorySaveResult = store.result;
