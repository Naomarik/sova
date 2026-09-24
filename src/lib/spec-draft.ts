import { createSignal } from "solid-js";
import type { SpecSettings } from "../../shared/protocol";
import { cloneSpec, sameSpec, type SpecDraft } from "./spec-form";

/**
 * Settings → Modes → Spec's unsaved edits. Module state, like Delegate's (delegate-draft.ts): the
 * section unmounts with its tab, and switching tabs must not throw the edit away. The dialog asks
 * before closing over a dirty draft, and forgets it once closed.
 */
const [draft, setDraft] = createSignal<SpecDraft | null>(null);
const [saved, setSaved] = createSignal<SpecSettings | null>(null);

export const specDraft = draft;
export const specSaved = saved;

export function setSpecDraft(next: SpecDraft | null): void {
  setDraft(next);
}

/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export function setSpecSaved(settings: SpecSettings, { replaceDraft = false } = {}): void {
  setSaved(settings);
  if (replaceDraft || draft() === null) setDraft(cloneSpec(settings));
}

/** Edits nobody has saved yet. */
export const specDirty = (): boolean => {
  const d = draft();
  const s = saved();
  return !!d && !!s && !sameSpec(d, s);
};

/** The dialog closed: drop the draft, so the next open reads the saved writer afresh. */
export function resetSpecDraft(): void {
  setDraft(null);
  setSaved(null);
}
