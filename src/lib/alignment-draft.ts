import type { AlignSettingsInfo } from "../../shared/protocol";
import { getAlignSettings, getWebSettings, putAlignSettings, putWebSettings } from "./api";
import { setAdversarialReview } from "./align-review";
import { createDraftStore, SaveFailed } from "./settings-draft";

/** The align mode's writing style (§chat.alignment/style). */
export type AlignStyle = AlignSettingsInfo["settings"]["style"];
/** How readily an alignment opens (§chat.alignment/eagerness); a file with none reads as Eager. */
export type AlignEagerness = NonNullable<AlignSettingsInfo["settings"]["eagerness"]>;

/**
 * Settings → Alignment, as one form (§app.settings-dialog/alignment): the Eagerness, writing style and
 * Visuals, stored in the mode extension's mode-align.json, and adversarial review, stored in Sova's settings.
 */
export interface AlignmentSettings {
  eagerness: AlignEagerness;
  style: AlignStyle;
  visuals: boolean;
  review: boolean;
}

/** Each style as Settings lists it, with its one-line description. */
export const ALIGN_STYLE_OPTIONS: readonly { id: AlignStyle; label: string; description: string }[] = [
  { id: "pm", label: "Project manager", description: "Screens, wording and behaviour only; no code. Technical detail folded into notes." },
  { id: "simplified", label: "Simplified", description: "Short sentences in everyday words, fewer items." },
  { id: "default", label: "Technical", description: "Files, code and technical trade-offs in the plan." },
];

/** The Eagerness choices, in their order, each with its one-line description (§app.settings-dialog/alignment). */
export const ALIGN_EAGERNESS_OPTIONS: readonly { id: AlignEagerness; label: string; description: string }[] = [
  { id: "eager", label: "Eager", description: "Opens an alignment card for any request that implies work, and leans toward asking first." },
  { id: "careful", label: "Careful", description: "Opens one when you want something changed; questions get their answer in chat." },
];

export const sameAlignment = (a: AlignmentSettings, b: AlignmentSettings): boolean =>
  a.eagerness === b.eagerness && a.style === b.style && a.visuals === b.visuals && a.review === b.review;

type AlignFile = { eagerness: AlignEagerness; style: AlignStyle; visuals: boolean };
/** The file's settings as the form reads them: no `eagerness` is Eager. */
const fromFile = (s: AlignSettingsInfo["settings"]): AlignFile => ({ eagerness: s.eagerness ?? "eager", style: s.style, visuals: s.visuals });

/**
 * Write what changed, each store its own write, at the same time: review to Sova's settings, Eagerness,
 * style and Visuals to mode-align.json (Eager as no field, so an Eager file keeps the bytes an older
 * device accepts). One that fails after the other landed is a partial save; what the server has now is
 * what each landed write answered, the rest as it was.
 */
export async function writeAlignment(
  draft: AlignmentSettings,
  base: AlignmentSettings,
  io: { putReview(review: boolean): Promise<boolean>; putAlign(align: AlignFile): Promise<AlignFile> } = {
    putReview: async (review) => (await putWebSettings({ alignment: { review } })).alignment.review,
    putAlign: async ({ eagerness, style, visuals }) =>
      fromFile((await putAlignSettings({ version: 1, style, visuals, ...(eagerness === "careful" ? { eagerness } : {}) })).settings),
  },
): Promise<AlignmentSettings> {
  const reviewChanged = draft.review !== base.review;
  const alignChanged = draft.eagerness !== base.eagerness || draft.style !== base.style || draft.visuals !== base.visuals;
  const [review, align] = await Promise.allSettled([
    reviewChanged ? io.putReview(draft.review) : Promise.resolve(base.review),
    alignChanged
      ? io.putAlign({ eagerness: draft.eagerness, style: draft.style, visuals: draft.visuals })
      : Promise.resolve({ eagerness: base.eagerness, style: base.style, visuals: base.visuals }),
  ]);
  const failed = [review, align].find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    const landed = (reviewChanged && review.status === "fulfilled") || (alignChanged && align.status === "fulfilled");
    const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    throw new SaveFailed(reason, landed);
  }
  const a = (align as PromiseFulfilledResult<AlignFile>).value;
  return { eagerness: a.eagerness, style: a.style, visuals: a.visuals, review: (review as PromiseFulfilledResult<boolean>).value };
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
  return { ...fromFile(align.settings), review: web.alignment?.review === true };
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
