import type { SummarizerSettings } from "../../shared/protocol";
import { createDraftStore } from "./settings-draft";
import { cloneSummarizer, rebaseSummarizer, sameSummarizer } from "./summarizer-form";

/**
 * Settings → Summaries' unsaved chain (settings-draft.ts: module state, held on close, forgotten
 * once closed). The TUI can edit the file under an open form, so a kept draft is rebased onto each
 * fresh read, and Save rebases once more before it writes.
 */
const store = createDraftStore<SummarizerSettings, SummarizerSettings>({
  tab: "summaries",
  label: "Summaries",
  toDraft: cloneSummarizer,
  same: sameSummarizer,
  rebase: rebaseSummarizer,
});

export const summarizerDraft = store.draft;
export const summarizerSaved = store.saved;
export const setSummarizerDraft = store.setDraft;
export const setSummarizerSaved = store.setSaved;
export const acceptSummarizerSave = store.acceptSave;
export const summarizerDirty = store.dirty;
export const discardSummarizerDraft = store.discard;
export const resetSummarizerDraft = store.reset;
