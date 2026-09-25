import { createSignal } from "solid-js";
import type { DecisionSettings } from "../../shared/protocol";
import { draftOf, sameDecision, type DecisionDraft } from "./decision-form";

/**
 * Settings → Decisions' unsaved edits. Module state, like Delegate's (delegate-draft.ts): the
 * section unmounts with its tab, and switching tabs must not throw the edit away. The dialog asks
 * before closing over a dirty draft, and forgets it once closed. The Jev key is never here.
 */
const [draft, setDraft] = createSignal<DecisionDraft | null>(null);
const [saved, setSaved] = createSignal<DecisionSettings | null>(null);

export const decisionDraft = draft;
export const decisionSaved = saved;

export function setDecisionDraft(next: DecisionDraft | null): void {
  setDraft(next);
}

/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export function setDecisionSaved(settings: DecisionSettings, { replaceDraft = false } = {}): void {
  setSaved(settings);
  if (replaceDraft || draft() === null) setDraft(draftOf(settings));
}

/** Edits nobody has saved yet. */
export const decisionDirty = (): boolean => {
  const d = draft();
  const s = saved();
  return !!d && !!s && !sameDecision(d, s);
};

/** The dialog closed: drop the draft, so the next open reads the saved settings afresh. */
export function resetDecisionDraft(): void {
  setDraft(null);
  setSaved(null);
}
