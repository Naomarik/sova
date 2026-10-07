import { FILE_MB, MB, MESSAGES_CAP, MESSAGES_MIN, PHOTO_MB, PHOTOS_PER_CONVERSATION, PHOTOS_PER_MESSAGE, type BatonSettings } from "../../shared/baton";
import { putBatonSettings } from "./api";
import { createDraftStore } from "./settings-draft";

/** A typed whole number within [min, max], else null. */
export function parseWhole(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

/** A typed limit: a whole number within the bounds every limit shares, else null. */
export const parseLimit = (text: string): number | null => parseWhole(text, MESSAGES_MIN, MESSAGES_CAP);

/** The form as typed (strings, so a half-typed or invalid entry stays in its field and simply
    can't be saved). */
export interface BatonDraft {
  messagesMax: string;
  photosOn: boolean;
  perMessage: string;
  mb: string;
  perConversation: string;
  /** The largest file, MB (§app.baton/files). */
  fileMb: string;
}

/** A typed largest file, else null. */
export const parseFileMb = (d: BatonDraft): number | null => parseWhole(d.fileMb, FILE_MB.min, FILE_MB.max);

export const photoFields = {
  perMessage: (d: BatonDraft) => parseWhole(d.perMessage, PHOTOS_PER_MESSAGE.min, PHOTOS_PER_MESSAGE.max),
  mb: (d: BatonDraft) => parseWhole(d.mb, PHOTO_MB.min, PHOTO_MB.max),
  perConversation: (d: BatonDraft) => parseWhole(d.perConversation, PHOTOS_PER_CONVERSATION.min, PHOTOS_PER_CONVERSATION.max),
};

const toDraft = (s: BatonSettings): BatonDraft => ({
  messagesMax: String(s.messagesMax),
  photosOn: s.photos.enabled,
  perMessage: String(s.photos.perMessage),
  mb: String(Math.round(s.photos.maxBytes / MB)),
  perConversation: String(s.photos.perConversation),
  fileMb: String(Math.round((s.files?.maxBytes ?? FILE_MB.default * MB) / MB)),
});

/** Settings → Organizations' unsaved edit (settings-draft.ts: module state, held on close, forgotten
    once closed): the message limit new hand-off sessions start with, and photos in gathering chats
    (§app.baton/images). Saved by the dialog's footer. */
const store = createDraftStore<BatonDraft, BatonSettings>({
  tab: "organizations",
  label: "Organizations",
  toDraft,
  same: (d, s) => {
    const t = toDraft(s);
    return d.messagesMax.trim() === t.messagesMax && d.photosOn === t.photosOn && d.perMessage.trim() === t.perMessage && d.mb.trim() === t.mb && d.perConversation.trim() === t.perConversation && d.fileMb.trim() === t.fileMb;
  },
  problem: (d) =>
    parseLimit(d.messagesMax) === null
      ? `Organizations needs a message limit from ${MESSAGES_MIN} to ${MESSAGES_CAP.toLocaleString("en-US")}.`
      : Object.values(photoFields).some((f) => f(d) === null)
        ? "Organizations needs photo limits within their ranges."
        : parseFileMb(d) === null
          ? `Organizations needs a largest file from ${FILE_MB.min} to ${FILE_MB.max} MB.`
          : null,
  write: async (d) => {
    const result = await putBatonSettings({
      messagesMax: parseLimit(d.messagesMax)!,
      photos: { enabled: d.photosOn, perMessage: photoFields.perMessage(d)!, maxBytes: photoFields.mb(d)! * MB, perConversation: photoFields.perConversation(d)! },
      files: { maxBytes: parseFileMb(d)! * MB },
    });
    return { saved: result, result };
  },
});

export const batonDraft = store.draft;
export const setBatonDraft = store.setDraft;
export const setBatonSaved = store.setSaved;
export const batonSaving = store.saving;
export const batonSaveError = store.error;
