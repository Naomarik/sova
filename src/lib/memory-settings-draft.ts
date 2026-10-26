import type { MemorySaveResult, MemorySettings, MemoryType } from "../../shared/protocol";
import { MEMORY_TYPES, memoryTypeInfo } from "../../shared/memory";
import { putMemorySettings } from "./api";
import { sameChoice, type DraftChoice } from "./delegate-form";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Memory's unsaved edits (§app.settings-dialog/memory): the summarizer's primary and
 * optional fallback, and each type's Summary size. Sova's own file, written only here and by Save as
 * default (which writes its `default` type, never the summarizer or the sizes), so no rebase; the PUT
 * carries no `default`, and the server keeps it.
 */
export interface MemoryDraft {
  primary: DraftChoice;
  fallback: DraftChoice | null;
  sizes: Record<MemoryType, number>;
}

/** The file's sizes, each type's own where it names none (an older server sends none). */
const sizesOf = (s: MemorySettings): Record<MemoryType, number> =>
  Object.fromEntries(MEMORY_TYPES.map((t) => [t, s.sizes?.[t] ?? memoryTypeInfo(t).defaultSize])) as Record<MemoryType, number>;

export const toMemoryDraft = (s: MemorySettings): MemoryDraft => ({
  primary: { ...s.summarizer.primary },
  fallback: s.summarizer.fallback ? { ...s.summarizer.fallback } : null,
  sizes: sizesOf(s),
});

/** The summarizer half (its own Reset to Defaults). */
export const sameSummarizer = (d: MemoryDraft, s: MemorySettings): boolean =>
  sameChoice(d.primary, s.summarizer.primary) && sameChoice(d.fallback, s.summarizer.fallback);

/** The Summary size half (its own Reset to Defaults). */
export const sameSizes = (d: MemoryDraft, s: MemorySettings): boolean => {
  const sizes = sizesOf(s);
  return MEMORY_TYPES.every((t) => d.sizes[t] === sizes[t]);
};

export const sameMemorySettings = (d: MemoryDraft, s: MemorySettings): boolean => sameSummarizer(d, s) && sameSizes(d, s);

/** Why the draft can't be saved, one sentence naming the form (the dialog's footer), or null. */
export function memoryDraftProblem(d: MemoryDraft): string | null {
  if (!d.primary.model) return "Memory needs a primary model.";
  if (!d.primary.effort) return "Memory needs an effort for its primary model.";
  if (d.fallback && !d.fallback.model) return "Memory needs a fallback model.";
  if (d.fallback && !d.fallback.effort) return "Memory needs an effort for its fallback model.";
  if (d.fallback && sameChoice(d.primary, d.fallback)) return "Memory has a fallback that's the same model as its primary.";
  return null;
}

/** The PUT body: the summarizer and the sizes (no `default`: the server keeps the stored one). */
export const toMemorySettings = (d: MemoryDraft): MemorySettings => ({
  version: 1,
  summarizer: { primary: { ...d.primary }, fallback: d.fallback ? { ...d.fallback } : null },
  sizes: { ...d.sizes },
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
