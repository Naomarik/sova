// The mode menu's footer: the sentence saying what a switch here does,
// and whether this chat's mode is already the one new sessions start from. Pure, so each string can
// be tested against the state it must NOT be said in — a button that offers to save what is already
// saved is the case this exists to rule out.

import type { ModeInfo } from "../../shared/protocol";

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
