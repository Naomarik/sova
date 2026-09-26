import { clonePolicy, rebasePolicy, samePolicy, type ModelPolicy } from "./model-policy";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Models' unsaved switches (settings-draft.ts: module state, held on close, forgotten
 * once closed). One Save writes the whole policy. The TUI and a peer's sync write the same file, so
 * a kept draft is rebased onto each fresh read, and Save rebases once more before it writes.
 */
const store = createDraftStore<ModelPolicy, ModelPolicy>({
  tab: "models",
  label: "Models",
  toDraft: clonePolicy,
  same: samePolicy,
  rebase: rebasePolicy,
});

export const policyDraft = store.draft;
export const policySaved = store.saved;
export const setPolicyDraft = store.setDraft;
export const setPolicySaved = store.setSaved;
export const acceptPolicySave = store.acceptSave;
export const policyDirty = store.dirty;
export const discardPolicyDraft = store.discard;
export const resetPolicyDraft = store.reset;
