import { getModelPolicy, putModelPolicy } from "./api";
import { cacheModelPolicy, clonePolicy, rebasePolicy, samePolicy, type ModelPolicy } from "./model-policy";
import { createDraftStore, saveRebased } from "./settings-draft";

/**
 * Settings → Models' unsaved switches (settings-draft.ts: module state, held on close, forgotten
 * once closed). One Save writes the whole policy. The TUI and a peer's sync write the same file, so
 * a kept draft is rebased onto each fresh read, and Save rebases once more before it writes. The
 * picker follows the saved policy at once.
 */
const store = createDraftStore<ModelPolicy, ModelPolicy>({
  tab: "models",
  label: "Models",
  toDraft: clonePolicy,
  same: samePolicy,
  rebase: rebasePolicy,
  write: async (d, base) => {
    const { result } = await saveRebased(d, base, {
      read: () => getModelPolicy(),
      settingsOf: (p) => p,
      rebase: rebasePolicy,
      same: samePolicy,
      write: putModelPolicy,
    });
    cacheModelPolicy(result);
    return { saved: result, result };
  },
});

export const policyDraft = store.draft;
export const policySaved = store.saved;
export const setPolicyDraft = store.setDraft;
export const setPolicySaved = store.setSaved;
export const policyDirty = store.dirty;
export const policySaving = store.saving;
export const policySaveError = store.error;
export const resetPolicyDraft = store.reset;
