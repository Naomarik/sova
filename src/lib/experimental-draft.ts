import type { ExperimentalSettings, WebSettings } from "../../shared/protocol";
import { getWebSettings, putWebSettings } from "./api";
import { setAdversarialReview } from "./align-review";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Experimental's unsaved switches (settings-draft.ts: module state, held on close,
 * forgotten once closed): the whole `experimental` object of WebSettings, one boolean per switch.
 * A switch is a key in ExperimentalSettings and a row in the panel, and this store saves it with
 * the rest. What is SAVED (never the draft) drives the features it gates: applySaved.
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
    applySaved(result.experimental);
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

/** The saved switches reach what they gate: adversarial review's card UI and Reviewer row (§chat.alignment-review/flag). */
export function applySaved(experimental: ExperimentalSettings): void {
  setAdversarialReview(experimental.adversarialReview === true);
}

/** At startup: read the saved switches once. Unreadable leaves everything off. */
export function loadExperimental(): void {
  getWebSettings().then((s) => applySaved(s.experimental), () => applySaved({ adversarialReview: false }));
}
