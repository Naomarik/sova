import { createDraftStore } from "./settings-draft";

/**
 * Settings → Experimental's unsaved switch (settings-draft.ts: module state, held on close,
 * forgotten once closed): the Claude Code provider, on or off.
 */
const store = createDraftStore<boolean, boolean>({ tab: "experimental", label: "Experimental", toDraft: (on) => on, same: (a, b) => a === b });

export const claudeCodeDraft = store.draft;
export const claudeCodeSaved = store.saved;
export const setClaudeCodeDraft = store.setDraft;
export const setClaudeCodeSaved = store.setSaved;
export const acceptClaudeCodeSave = store.acceptSave;
export const claudeCodeDirty = store.dirty;
export const discardClaudeCodeDraft = store.discard;
export const resetClaudeCodeDraft = store.reset;
