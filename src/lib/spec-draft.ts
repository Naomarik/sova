import type { SpecSaveResult, SpecSettings } from "../../shared/protocol";
import { putSpecSettings } from "./api";
import { createDraftStore } from "./settings-draft";
import { cloneSpec, sameSpec, specDraftConflict, type SpecDraft } from "./spec-form";

/** Why a Spec draft can't be saved, for the dialog's footer, or null. Pure. */
export function specDraftProblem(d: SpecDraft): string | null {
  const w = d.writer;
  if (!w) return null;
  if (!w.primary.model) return "Spec needs a model for its writer.";
  if (!w.primary.effort) return "Spec needs an effort for its writer's model.";
  if (w.fallback && !w.fallback.model) return "Spec needs a fallback model.";
  if (w.fallback && !w.fallback.effort) return "Spec needs an effort for its fallback model.";
  if (specDraftConflict(d)) return "Spec has a fallback that's the same worker as its writer.";
  return null;
}

/** Settings → Modes → Spec's unsaved edits (settings-draft.ts: module state, held on close, forgotten once closed). */
const store = createDraftStore<SpecDraft, SpecSettings, SpecSaveResult>({
  tab: "modes",
  label: "Spec",
  toDraft: cloneSpec,
  same: sameSpec,
  problem: specDraftProblem,
  write: async (d) => {
    const result = await putSpecSettings(cloneSpec(d) as SpecSettings);
    return { saved: result.settings, warnings: result.warnings, result };
  },
});

export const specDraft = store.draft;
export const specSaved = store.saved;
export const setSpecDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setSpecSaved = store.setSaved;
export const specDirty = store.dirty;
export const specSaving = store.saving;
export const specSaveError = store.error;
export const specWarnings = store.warnings;
export const resetSpecDraft = store.reset;
