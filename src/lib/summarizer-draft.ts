import { createSignal } from "solid-js";
import type { SummarizerSettings, SummarizerSettingsInfo } from "../../shared/protocol";
import { getSummarizerSettings, putSummarizerSettings } from "./api";
import { createDraftStore, saveRebased } from "./settings-draft";
import { cloneSummarizer, rebaseSummarizer, sameSummarizer, summarizerComplete } from "./summarizer-form";

/**
 * The file couldn't be read at the last load: saving is off so it isn't overwritten. The section
 * sets it from each load; the footer's Save reads it through the store's problem.
 */
const [unreadable, setUnreadable] = createSignal(false);
export const setSummarizerUnreadable = (on: boolean): void => void setUnreadable(on);

/** Why a Summaries draft can't be saved, for the dialog's footer, or null — `summarizerComplete`, in words. Pure. */
export function summarizerDraftProblem(d: SummarizerSettings): string | null {
  if (!d.primary.model) return "Summaries needs a primary model.";
  if (d.fallback && !d.fallback.model) return "Summaries needs a fallback model.";
  // What summarizerComplete refuses beyond a blank model: a fallback that is its own primary.
  if (!summarizerComplete(d)) return "Summaries has a fallback that's the same model as its primary.";
  return null;
}

/**
 * Settings → Summaries' unsaved chain (settings-draft.ts: module state, held on close, forgotten
 * once closed). The TUI can edit the file under an open form, so a kept draft is rebased onto each
 * fresh read, and Save rebases once more before it writes.
 */
const store = createDraftStore<SummarizerSettings, SummarizerSettings, SummarizerSettingsInfo>({
  tab: "summaries",
  label: "Summaries",
  toDraft: cloneSummarizer,
  same: sameSummarizer,
  rebase: rebaseSummarizer,
  problem: (d) => (unreadable() ? "Summaries can't be saved: its file can't be read." : summarizerDraftProblem(d)),
  write: async (d, base) => {
    const { result } = await saveRebased(d, base, {
      read: getSummarizerSettings,
      settingsOf: (i) => i.settings,
      rebase: rebaseSummarizer,
      same: sameSummarizer,
      write: putSummarizerSettings,
    });
    return { saved: result.settings, result };
  },
  onReset: () => setUnreadable(false),
});

export const summarizerDraft = store.draft;
export const summarizerSaved = store.saved;
export const setSummarizerDraft = store.setDraft;
export const setSummarizerSaved = store.setSaved;
export const summarizerDirty = store.dirty;
export const summarizerSaving = store.saving;
export const summarizerSaveError = store.error;
/** The last save's response: the section shows what it says (built-in models or not). */
export const summarizerSaveResult = store.result;
export const resetSummarizerDraft = store.reset;
