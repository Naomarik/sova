import type { ExperimentalSettings, WebSettings } from "../../shared/protocol";
import { putWebSettings } from "./api";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Experimental's unsaved switches (settings-draft.ts: module state, held on close,
 * forgotten once closed): the whole `experimental` object of WebSettings, one boolean per switch.
 * A switch is a key in ExperimentalSettings and a row in the panel, and this store saves it with
 * the rest. One switch now: `sovaModes`, Sova runs chat modes (on unless saved off; the server answers
 * every key, so the draft never guesses a default). Adversarial review moved to Settings → Alignment.
 */
const store = createDraftStore<ExperimentalSettings, ExperimentalSettings, WebSettings>({
  tab: "experimental",
  label: "Experimental",
  toDraft: (saved) => ({ ...saved }),
  same: (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => (a as unknown as Record<string, boolean>)[key] === (b as unknown as Record<string, boolean>)[key]);
  },
  write: async (draft) => {
    const result = await putWebSettings({ experimental: draft });
    return { saved: result.experimental, result };
  },
});

export const experimentalDraft = store.draft;
export const experimentalSaved = store.saved;
export const setExperimentalDraft = store.setDraft;
export const setExperimentalSaved = store.setSaved;
export const experimentalSaving = store.saving;
export const experimentalSaveError = store.error;
export const resetExperimentalDraft = store.reset;
