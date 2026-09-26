import { createSignal } from "solid-js";
import type { DecisionSettings } from "../../shared/protocol";
import { draftOf, type DecisionDraft } from "./decision-form";

/**
 * Settings → Decisions' form state. Every change is saved as it is made, so the draft differs from
 * what is saved only for a moment, or where a part can't be written yet: a fallback not fully
 * chosen or refused, a Folders line that isn't a full path, Folders text not yet left. Module
 * state, like Delegate's (delegate-draft.ts): the section unmounts with its tab, and switching
 * tabs must not throw a half-chosen fallback away. The dialog forgets it once closed, without
 * asking. The Jev key is never here.
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

/** The dialog closed: drop the draft, so the next open reads the saved settings afresh. */
export function resetDecisionDraft(): void {
  setDraft(null);
  setSaved(null);
}
