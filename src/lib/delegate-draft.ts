import { createSignal } from "solid-js";
import type { DelegateSettings } from "../../shared/protocol";
import { cloneSettings, sameSettings, type DraftSettings } from "./delegate-form";

/**
 * Settings → Modes → Delegate's unsaved edits. Module state, not the section's, because the section
 * unmounts with its tab: switching to Models and back must not throw eight rows of choices away.
 * The dialog asks before closing over a dirty draft, and forgets it once closed (a reopened dialog
 * starts from what's saved). Saving is explicit — the routing is one choice across eight rows.
 */
const [draft, setDraft] = createSignal<DraftSettings | null>(null);
const [saved, setSaved] = createSignal<DelegateSettings | null>(null);

export const delegateDraft = draft;
export const delegateSaved = saved;

export function setDelegateDraft(next: DraftSettings | null): void {
  setDraft(next);
}

/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export function setDelegateSaved(settings: DelegateSettings, { replaceDraft = false } = {}): void {
  setSaved(settings);
  if (replaceDraft || draft() === null) setDraft(cloneSettings(settings));
}

/** Edits nobody has saved yet. */
export const delegateDirty = (): boolean => {
  const d = draft();
  const s = saved();
  return !!d && !!s && !sameSettings(d, s);
};

/** The dialog closed: drop the draft, so the next open reads the saved routing afresh. */
export function resetDelegateDraft(): void {
  setDraft(null);
  setSaved(null);
}
