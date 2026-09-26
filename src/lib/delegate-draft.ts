import type { DelegateSettings } from "../../shared/protocol";
import { cloneSettings, sameSettings, type DraftSettings } from "./delegate-form";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Modes → Delegate's unsaved edits (settings-draft.ts: module state, held on close,
 * forgotten once closed). Saving is explicit — the routing is one choice across eight rows.
 */
const store = createDraftStore<DraftSettings, DelegateSettings>({ tab: "modes", label: "Delegate", toDraft: cloneSettings, same: sameSettings });

export const delegateDraft = store.draft;
export const delegateSaved = store.saved;
export const setDelegateDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setDelegateSaved = store.setSaved;
export const acceptDelegateSave = store.acceptSave;
export const delegateDirty = store.dirty;
export const discardDelegateDraft = store.discard;
/** The dialog closed: drop the draft, so the next open reads the saved routing afresh. */
export const resetDelegateDraft = store.reset;
