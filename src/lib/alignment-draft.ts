import type { AlignSettingsInfo } from "../../shared/protocol";
import { getAlignSettings, getWebSettings, putAlignSettings, putWebSettings } from "./api";
import { setAdversarialReview } from "./align-review";
import { createDraftStore, SaveFailed } from "./settings-draft";

/** The align mode's writing style (§chat.alignment/style). */
export type AlignStyle = AlignSettingsInfo["settings"]["style"];

/**
 * Settings → Alignment, as one form (§app.settings-dialog/alignment): the writing style and Visuals,
 * stored in the mode extension's mode-align.json, and adversarial review, stored in Sova's settings.
 */
export interface AlignmentSettings {
  style: AlignStyle;
  visuals: boolean;
  review: boolean;
}

/** Each style as Settings lists it, with its one-line description. */
export const ALIGN_STYLE_OPTIONS: readonly { id: AlignStyle; label: string; description: string }[] = [
  { id: "default", label: "Default", description: "Today's detail: files, code and technical trade-offs." },
  { id: "simplified", label: "Simplified", description: "Short sentences in everyday words, fewer items." },
  { id: "pm", label: "Project manager", description: "Screens, wording and behaviour only; no code. Technical detail folded into notes." },
];

export const sameAlignment = (a: AlignmentSettings, b: AlignmentSettings): boolean => a.style === b.style && a.visuals === b.visuals && a.review === b.review;

/**
 * Write what changed, each store its own write, at the same time: review to Sova's settings, style
 * and Visuals to mode-align.json. One that fails after the other landed is a partial save; what the
 * server has now is what each landed write answered, the rest as it was.
 */
export async function writeAlignment(
  draft: AlignmentSettings,
  base: AlignmentSettings,
  io: { putReview(review: boolean): Promise<boolean>; putAlign(style: AlignStyle, visuals: boolean): Promise<{ style: AlignStyle; visuals: boolean }> } = {
    putReview: async (review) => (await putWebSettings({ alignment: { review } })).alignment.review,
    putAlign: async (style, visuals) => (await putAlignSettings({ version: 1, style, visuals })).settings,
  },
): Promise<AlignmentSettings> {
  const reviewChanged = draft.review !== base.review;
  const alignChanged = draft.style !== base.style || draft.visuals !== base.visuals;
  const [review, align] = await Promise.allSettled([
    reviewChanged ? io.putReview(draft.review) : Promise.resolve(base.review),
    alignChanged ? io.putAlign(draft.style, draft.visuals) : Promise.resolve({ style: base.style, visuals: base.visuals }),
  ]);
  const failed = [review, align].find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    const landed = (reviewChanged && review.status === "fulfilled") || (alignChanged && align.status === "fulfilled");
    const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    throw new SaveFailed(reason, landed);
  }
  const a = (align as PromiseFulfilledResult<{ style: AlignStyle; visuals: boolean }>).value;
  return { style: a.style, visuals: a.visuals, review: (review as PromiseFulfilledResult<boolean>).value };
}

const store = createDraftStore<AlignmentSettings, AlignmentSettings>({
  tab: "alignment",
  label: "Alignment",
  toDraft: (saved) => ({ ...saved }),
  same: sameAlignment,
  write: async (draft, base) => {
    const saved = await writeAlignment(draft, base);
    setAdversarialReview(saved.review);
    return { saved, result: saved };
  },
});

export const alignmentDraft = store.draft;
export const alignmentSaved = store.saved;
export const setAlignmentDraft = store.setDraft;
export const setAlignmentSaved = store.setSaved;
export const alignmentSaving = store.saving;
export const alignmentSaveError = store.error;

/** Both stores as the form reads them. */
export async function readAlignment(): Promise<AlignmentSettings> {
  const [web, align] = await Promise.all([getWebSettings(), getAlignSettings()]);
  return { style: align.settings.style, visuals: align.settings.visuals, review: web.alignment?.review === true };
}

/**
 * At startup: the saved review switch reaches what it gates in Settings (the Reviewer section) and,
 * for a chat whose server doesn't say its own flag, the card (§chat.alignment-review/flag).
 * Unreadable leaves it off.
 */
export function loadAlignment(): void {
  getWebSettings().then(
    (s) => setAdversarialReview(s.alignment?.review === true),
    () => setAdversarialReview(false),
  );
}
