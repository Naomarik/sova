// The Overseer's About panel (§app.overseer/about): its words and the rows it draws from
// GET /api/overseer/abilities. Pure, for the tests; OverseerAbout.tsx draws them.
import type { OverseerAbilitiesInfo, OverseerCaps } from "../../shared/protocol";
import { CAP_KEYS, CAP_LABEL } from "./overseer-draft";

export const ABOUT_TITLE = "About the Overseer";
export const ABOUT_LOADING = "Loading what the Overseer can do…";
export const ABOUT_FAILED = "Couldn't load what the Overseer can do.";
export const EXT_NONE = "No extension gives the Overseer abilities. An extension does by marking its commands for the Overseer.";
export const EXT_NOT_RUNNING = "Not running: the Overseer can't run these until it is.";
export const EXT_JOB = "Runs as a job";

/** The extensions group's first line: the ask-first rule and the per-message limit. */
export const extIntro = (caps: OverseerCaps): string =>
  `It runs one only when you ask in your own message, at most ${caps.extRunsPerTurn} per message.`;

/** The limits now, as the panel lists them: running at once first, then each per-message one, in Settings' order. */
export function limitRows(caps: OverseerCaps): { key: keyof OverseerCaps; label: string; value: number }[] {
  const keys: (keyof OverseerCaps)[] = ["concurrentSessions", ...CAP_KEYS.filter((k) => k !== "concurrentSessions")];
  return keys.map((k) => ({ key: k, label: CAP_LABEL[k].label, value: caps[k] }));
}

/** A command's text under its label: its description for a model, else its summary, else nothing. */
export const commandText = (c: OverseerAbilitiesInfo["extensions"][number]["commands"][number]): string => c.description ?? c.summary ?? "";
