// The mode menu's footer: the sentence saying what a switch here does,
// and whether this chat's mode is already the one new sessions start from. Pure, so each string can
// be tested against the state it must NOT be said in — a button that offers to save what is already
// saved is the case this exists to rule out.

import type { ModeInfo } from "../../shared/protocol";
import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";

/** A mode as the footer reads it: this chat's, or the default's. The same three fields
    `/mode default` writes, so "already the default" compares exactly what a save would change. */
export interface ShownMode {
  mode: string;
  minorModes: string[];
  strict: boolean;
}

/** The footer's sentence, after the `strict:` chip: a switch is this chat's own — nothing else
    follows it — and new sessions start from the default, which the button below it sets. */
export const FOOT_NOTE = "A switch here is this chat's own. New sessions start from the default.";

/** The button, in each of its three states: it can be pressed, it was already done, or it is
    working. */
export const SAVE_LABEL = "Save as default";
export const SAVED_LABEL = "Already the default";
export const SAVING_LABEL = "Saving…";

/** "delegate · strict · align" — a mode the way the extension's own "Default mode saved" toast
    writes it (activeSummary in pi-config/extensions/mode/index.ts): strict is named only when on. */
export function modeSummary(m: ShownMode): string {
  return [m.mode, ...(m.strict ? ["strict"] : []), ...m.minorModes].join(" · ");
}

/**
 * Whether this chat's mode already IS the default: the same major, the same strict flag, and the
 * same minors in the same order — the three fields a save writes, so a chat with strict on is not
 * "already the default" against a file with strict off. Minors are compared in order: both sides
 * come through the extension's own normalizeState (state.ts), so the order is canonical and two
 * equal sets written in a different order are not the same mode to anyone else either.
 * Unknown on either side (the file not read yet, this chat's mode not arrived yet) is NOT "already
 * the default": the button stays pressable, and the press is what would find out.
 */
export function isDefaultMode(def: Pick<ModeInfo, "mode" | "minorModes" | "strict"> | null, current: ShownMode | null): boolean {
  if (!def || !current) return false;
  return (
    def.mode === current.mode &&
    def.strict === current.strict &&
    def.minorModes.length === current.minorModes.length &&
    def.minorModes.every((m, i) => m === current.minorModes[i])
  );
}

/** The button's label for its state. */
export function saveLabel(state: "idle" | "saving" | "done"): string {
  return state === "saving" ? SAVING_LABEL : state === "done" ? SAVED_LABEL : SAVE_LABEL;
}

/** The button's `title`: what the press will make (or has made) true, with the mode it names. A
    description, never the accessible name — the visible label is the name (WCAG 2.5.3), so a
    voice-control user can say what they see. */
export function saveTitle(shown: ShownMode | null, already: boolean): string {
  if (!shown) return already ? "New sessions already start from the default mode." : "Make this chat's mode the default for new sessions.";
  return already ? `New sessions already start from ${modeSummary(shown)}.` : `New sessions will start from ${modeSummary(shown)}.`;
}

// ── The subagent profile in the menu ────────────────────────────────────────

/** The save makes the default the mode AND the profile together, so "already" covers both:
    this chat's pick against this device's `default` (its own file, never synced). */
export function isDefaultAll(
  def: Pick<ModeInfo, "mode" | "minorModes" | "strict"> | null,
  current: ShownMode | null,
  profiles: Pick<SubagentProfilesInfo, "current" | "default"> | null,
): boolean {
  if (!profiles) return false; // not read yet: unknown is never "already the default"
  return isDefaultMode(def, current) && profiles.current.id !== null && profiles.current.id === profiles.default;
}

/** The announce after the save: both halves named, so it never claims less than it wrote. */
export function savedAnnounce(mode: ShownMode | null, profileName: string | null): string {
  const modeText = mode ? modeSummary(mode) : null;
  const saved = [modeText, profileName ? `Subagents: ${profileName}` : null].filter(Boolean).join(" · ");
  return saved ? `Default saved: ${saved}. New sessions start here.` : "Default saved. New sessions start here.";
}

/** The picker's search: a case-insensitive name match, in list order (the server puts Off first). */
export function filterProfiles<T extends { name: string }>(profiles: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? profiles.filter((p) => p.name.toLowerCase().includes(q)) : [...profiles];
}

/** The line under an empty search result. A live fact, then the absence — and the way out. */
export function noProfileMatch(query: string): string {
  return `No subagent profile matches \u201c${query.trim()}\u201d.`;
}

/** An id and placeholder name for a new profile, skipping ones already taken. */
export function nextSetup(profiles: readonly { id: string; name: string }[]): { id: string; name: string } {
  let n = 1;
  while (profiles.some((p) => p.id === `setup-${n}` || p.name.toLowerCase() === `setup ${n}`)) n++;
  return { id: `setup-${n}`, name: `Setup ${n}` };
}
