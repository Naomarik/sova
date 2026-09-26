import type { DelegateSaveResult, DelegateSettings } from "../../shared/protocol";
import { putDelegateSettings } from "./api";
import { cloneSettings, draftConflicts, sameSettings, type DraftSettings } from "./delegate-form";
import { createDraftStore } from "./settings-draft";

/**
 * Why a Delegate draft can't be saved, for the dialog's footer: the first row missing a model or
 * an effort, or a fallback that is its own primary (the server refuses that whatever discovery
 * says). Null when Save can write it. Pure.
 */
export function delegateDraftProblem(d: DraftSettings): string | null {
  for (const p of Object.values(d.profiles)) {
    if (!p.primary.model) return "Delegate needs a primary model.";
    if (!p.primary.effort) return "Delegate needs an effort for a primary model.";
    if (p.fallback && !p.fallback.model) return "Delegate needs a fallback model.";
    if (p.fallback && !p.fallback.effort) return "Delegate needs an effort for a fallback model.";
  }
  if (draftConflicts(d).length > 0) return "Delegate has a fallback that's the same worker as its primary.";
  return null;
}

/**
 * Settings → Modes → Delegate's unsaved edits (settings-draft.ts: module state, held on close,
 * forgotten once closed). Saving is explicit — the routing is one choice across eight rows.
 */
const store = createDraftStore<DraftSettings, DelegateSettings, DelegateSaveResult>({
  tab: "modes",
  label: "Delegate",
  toDraft: cloneSettings,
  same: sameSettings,
  problem: delegateDraftProblem,
  write: async (d) => {
    const result = await putDelegateSettings(d);
    return { saved: result.settings, warnings: result.warnings, result };
  },
});

export const delegateDraft = store.draft;
export const delegateSaved = store.saved;
export const setDelegateDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setDelegateSaved = store.setSaved;
export const delegateDirty = store.dirty;
export const delegateSaving = store.saving;
export const delegateSaveError = store.error;
export const delegateWarnings = store.warnings;
export const resetDelegateDraft = store.reset;
