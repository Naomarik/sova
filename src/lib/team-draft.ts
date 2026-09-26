import { createSignal } from "solid-js";
import type { TeamDefaults } from "../../shared/team-defaults";
import { cloneTeam, sameTeam, type TeamDraft } from "./team-form";

/**
 * Settings → Teams' unsaved edits. Module state, like Delegate's (delegate-draft.ts): the section
 * unmounts with its tab, and switching tabs must not throw the edit away. The dialog asks before
 * closing over a dirty draft, and forgets it once closed.
 */
const [draft, setDraft] = createSignal<TeamDraft | null>(null);
const [saved, setSaved] = createSignal<TeamDefaults | null>(null);

export const teamDraft = draft;
export const teamSaved = saved;

export function setTeamDraft(next: TeamDraft | null): void {
  setDraft(next);
}

/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export function setTeamSaved(settings: TeamDefaults, { replaceDraft = false } = {}): void {
  setSaved(settings);
  if (replaceDraft || draft() === null) setDraft(cloneTeam(settings));
}

/** Edits nobody has saved yet. */
export const teamDirty = (): boolean => {
  const d = draft();
  const s = saved();
  return !!d && !!s && !sameTeam(d, s);
};

/** The dialog closed: drop the draft, so the next open reads the saved defaults afresh. */
export function resetTeamDraft(): void {
  setDraft(null);
  setSaved(null);
}
