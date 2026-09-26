import { MESSAGES_CAP, MESSAGES_MIN, type BatonSettings } from "../../shared/baton";
import { putBatonSettings } from "./api";
import { createDraftStore } from "./settings-draft";

/** A typed limit: a whole number within the bounds every limit shares, else null. */
export function parseLimit(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= MESSAGES_MIN && n <= MESSAGES_CAP ? n : null;
}

/** Settings → Organizations' unsaved edit (settings-draft.ts: module state, held on close, forgotten
    once closed): the message limit new hand-off sessions start with, as typed (a string, so a
    half-typed or invalid entry stays in the field and simply can't be saved). Saved by the dialog's footer. */
const store = createDraftStore<string, BatonSettings>({
  tab: "organizations",
  label: "Organizations",
  toDraft: (s) => String(s.messagesMax),
  same: (d, s) => d.trim() === String(s.messagesMax),
  problem: (d) => (parseLimit(d) === null ? `Organizations needs a message limit from ${MESSAGES_MIN} to ${MESSAGES_CAP.toLocaleString("en-US")}.` : null),
  write: async (d) => {
    const result = await putBatonSettings({ messagesMax: parseLimit(d)! });
    return { saved: result, result };
  },
});

export const batonDraft = store.draft;
export const setBatonDraft = store.setDraft;
export const setBatonSaved = store.setSaved;
export const batonSaving = store.saving;
export const batonSaveError = store.error;
