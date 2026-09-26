import type { SpecSettings } from "../../shared/protocol";
import { createDraftStore } from "./settings-draft";
import { cloneSpec, sameSpec, type SpecDraft } from "./spec-form";

/** Settings → Modes → Spec's unsaved edits (settings-draft.ts: module state, held on close, forgotten once closed). */
const store = createDraftStore<SpecDraft, SpecSettings>({ tab: "modes", label: "Spec", toDraft: cloneSpec, same: sameSpec });

export const specDraft = store.draft;
export const specSaved = store.saved;
export const setSpecDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setSpecSaved = store.setSaved;
export const acceptSpecSave = store.acceptSave;
export const specDirty = store.dirty;
export const discardSpecDraft = store.discard;
export const resetSpecDraft = store.reset;
