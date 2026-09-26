import type { DecisionSettings } from "../../shared/protocol";
import { draftOf, rebaseDecision, sameDecision, type DecisionDraft } from "./decision-form";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Decisions' unsaved edits (settings-draft.ts: module state, held on close, forgotten
 * once closed), saved by Save Changes. A kept draft is rebased onto each fresh read, so a field the
 * user left alone follows the file. The Jev key is never here.
 */
const store = createDraftStore<DecisionDraft, DecisionSettings>({
  tab: "decisions",
  label: "Decisions",
  toDraft: draftOf,
  same: sameDecision,
  rebase: rebaseDecision,
});

export const decisionDraft = store.draft;
export const decisionSaved = store.saved;
export const setDecisionDraft = store.setDraft;
/** What the server has now. The first load seeds the draft; a kept draft is rebased onto it. */
export const setDecisionSaved = store.setSaved;
export const acceptDecisionSave = store.acceptSave;
export const decisionDirty = store.dirty;
export const discardDecisionDraft = store.discard;
/** The dialog closed: drop the draft, so the next open reads the saved settings afresh. */
export const resetDecisionDraft = store.reset;
