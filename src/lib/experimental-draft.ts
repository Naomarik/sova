import type { WebSettings } from "../../shared/protocol";
import { putWebSettings } from "./api";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Experimental's unsaved switch (settings-draft.ts: module state, held on close,
 * forgotten once closed): the Claude Code provider, on or off.
 */
const store = createDraftStore<boolean, boolean, WebSettings>({
  tab: "experimental",
  label: "Experimental",
  toDraft: (on) => on,
  same: (a, b) => a === b,
  write: async (on) => {
    const result = await putWebSettings({ experimental: { claudeCodeProvider: on } });
    return { saved: result.experimental.claudeCodeProvider, result };
  },
});

export const claudeCodeDraft = store.draft;
export const claudeCodeSaved = store.saved;
export const setClaudeCodeDraft = store.setDraft;
export const setClaudeCodeSaved = store.setSaved;
export const claudeCodeSaving = store.saving;
export const claudeCodeSaveError = store.error;
/** The last save's response: turning the switch on registers the provider, so the CLI status is re-read. */
export const claudeCodeSaveResult = store.result;
export const resetClaudeCodeDraft = store.reset;
