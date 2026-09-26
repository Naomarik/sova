import { createSignal } from "solid-js";
import type { DecisionSaveResult, DecisionSettings, DecisionSettingsInfo } from "../../shared/protocol";
import { ApiError, getDecisionSettings, putDecisionSettings } from "./api";
import { draftOf, exclusionIssue, noWarnings, placeWarnings, rebaseDecision, sameDecision, settingsOf, type DecisionDraft, type PlacedWarnings } from "./decision-form";
import { sameChoice, type DraftChoice } from "./delegate-form";
import { createDraftStore, failureOf, saveRebased } from "./settings-draft";

/** Why a Decisions draft can't be saved, for the dialog's footer, or null — `decisionDraftReady`, in words. Pure. */
export function decisionDraftProblem(d: DecisionDraft): string | null {
  if (d.fallback && !d.fallback.model) return "Decisions needs a fallback model.";
  if (d.fallback && !d.fallback.effort) return "Decisions needs an effort for its fallback model.";
  const folders = exclusionIssue(d.exclusions);
  return folders ? `Decisions: ${folders}` : null;
}

/** The last save's notes, placed under the section each is about. */
const [notes, setNotes] = createSignal<PlacedWarnings>(noWarnings());
/** A fallback the server refused at the last save: it stays in the row with the reason until changed. */
const [refused, setRefused] = createSignal<{ choice: DraftChoice; reason: string } | null>(null);

/**
 * Settings → Decisions' unsaved edits (settings-draft.ts: module state, held on close, forgotten
 * once closed), saved by the dialog's Save Changes, rebased onto a fresh read first, in one write.
 * A kept draft is rebased onto each fresh read, so a field the user left alone follows the file.
 * The Jev key is never here.
 */
const store = createDraftStore<DecisionDraft, DecisionSettings, DecisionSettingsInfo>({
  tab: "decisions",
  label: "Decisions",
  toDraft: draftOf,
  same: sameDecision,
  rebase: rebaseDecision,
  problem: decisionDraftProblem,
  write: async (d, base) => {
    let sent: DecisionSettings | null = null;
    try {
      const { result } = await saveRebased(d, base, {
        read: getDecisionSettings,
        settingsOf: (i) => i.settings,
        rebase: rebaseDecision,
        same: sameDecision,
        write: (next) => putDecisionSettings((sent = settingsOf(next))),
      });
      const warnings = "warnings" in result ? (result as DecisionSaveResult).warnings : [];
      setRefused(null);
      setNotes((n) => placeWarnings(n, warnings, !sameChoice(base.fallback, result.settings.fallback)));
      return { saved: result.settings, result };
    } catch (err) {
      // A newly chosen fallback the server refused: its row says so too, until it is changed.
      const f = (sent as DecisionSettings | null)?.fallback;
      if (err instanceof ApiError && err.status === 400 && f && !sameChoice(f, base.fallback))
        setRefused({ choice: { ...f }, reason: failureOf(err).message.replace(/^Fallback model: /, "") });
      throw err;
    }
  },
  onReset: () => {
    setNotes(noWarnings());
    setRefused(null);
  },
});

export const decisionDraft = store.draft;
export const decisionSaved = store.saved;
export const setDecisionDraft = store.setDraft;
/** What the server has now. The first load seeds the draft; a kept draft is rebased onto it. */
export const setDecisionSaved = store.setSaved;
export const decisionDirty = store.dirty;
export const decisionSaving = store.saving;
export const decisionSaveError = store.error;
export const decisionNotes = notes;
export const decisionRefused = refused;
/** The last save's response: the section shows what it says (the chain line, the backfill). */
export const decisionSaveResult = store.result;
/** The dialog closed: drop the draft, so the next open reads the saved settings afresh. */
export const resetDecisionDraft = store.reset;
