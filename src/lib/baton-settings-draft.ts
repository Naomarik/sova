import { FILE_MB, MB, type BatonSettings } from "../../shared/baton";
import { BATON_RULES } from "../../shared/baton-limits";
import { check } from "../../shared/form-rules";
import type { ModelPick } from "../../shared/powers";
import { putAssistantDefault, putBatonSettings } from "./api";
import { createDraftStore } from "./settings-draft";

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
  /** The Project Assistant's default model and thinking (§app.project-assistant/models), or null. */
  assistant: ModelPick | null;
}

/** A pick as stored: the model and its thinking only (a GET's price is dropped). */
export const plainPick = (p: ModelPick | null | undefined): ModelPick | null => (p ? { model: p.model, ...(p.thinking ? { thinking: p.thinking } : {}) } : null);

/** Two defaults are the same: model and thinking. */
export const samePick = (a: ModelPick | null | undefined, b: ModelPick | null | undefined): boolean =>
  (a?.model ?? null) === (b?.model ?? null) && (a?.thinking ?? null) === (b?.thinking ?? null);

type Box = keyof typeof BATON_RULES;
/** A box's number once its rule takes it, else null. */
export const boxValue = (d: BatonDraft, key: Box): number | null => {
  const r = check(BATON_RULES[key], d[key]);
  return r.ok ? r.value : null;
};

/** The boxes in page order, each with its rule (the draft store's `fields`). */
export const batonFields = (d: BatonDraft) => (Object.keys(BATON_RULES) as Box[]).map((k) => ({ rule: BATON_RULES[k], value: d[k] }));

/** The saved settings as the form shows them. */
export const batonDraftOf = (s: BatonSettings): BatonDraft => ({
  messagesMax: String(s.messagesMax),
  photosOn: s.photos.enabled,
  perMessage: String(s.photos.perMessage),
  mb: String(Math.round(s.photos.maxBytes / MB)),
  perConversation: String(s.photos.perConversation),
  fileMb: String(Math.round((s.files?.maxBytes ?? FILE_MB.default * MB) / MB)),
  assistant: plainPick(s.assistant),
});

/** Settings → Organizations' unsaved edit (settings-draft.ts: module state, held on close, forgotten
    once closed): the message limit new hand-off sessions start with, photos and files in gathering chats
    (§app.baton/images), and the Project Assistant's default model. Saved by the dialog's footer. */
const store = createDraftStore<BatonDraft, BatonSettings>({
  tab: "organizations",
  label: "Organizations",
  toDraft: batonDraftOf,
  same: (d, s) => {
    const t = batonDraftOf(s);
    return d.messagesMax.trim() === t.messagesMax && d.photosOn === t.photosOn && d.perMessage.trim() === t.perMessage && d.mb.trim() === t.mb && d.perConversation.trim() === t.perConversation && d.fileMb.trim() === t.fileMb && samePick(d.assistant, t.assistant);
  },
  fields: batonFields,
  write: async (d) => {
    const result = await putBatonSettings({
      messagesMax: boxValue(d, "messagesMax")!,
      photos: { enabled: d.photosOn, perMessage: boxValue(d, "perMessage")!, maxBytes: boxValue(d, "mb")! * MB, perConversation: boxValue(d, "perConversation")! },
      files: { maxBytes: boxValue(d, "fileMb")! * MB },
    });
    // The Project Assistant's default has its own route (mesh `admin`): sent only when it differs from the stored one.
    let assistant = result.assistant ?? null;
    if (!samePick(d.assistant, assistant)) assistant = (await putAssistantDefault(plainPick(d.assistant))).assistant;
    const saved = { ...result, assistant };
    return { saved, result: saved };
  },
});

export const batonDraft = store.draft;
export const setBatonDraft = store.setDraft;
export const setBatonSaved = store.setSaved;
export const batonSaving = store.saving;
export const batonSaveError = store.error;
/** The settings as last saved (or read): the default's price is this one's. */
export const batonSaved = store.saved;
