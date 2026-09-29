import type { DelegateOptions, SessionTitleSettings } from "../../shared/protocol";
import { sameChoice, type DraftChoice } from "./delegate-form";

/**
 * Settings → Summaries → Session titles' form rules (§app.settings-dialog/summaries): the switch,
 * two whole-minute fields and the Delegate worker rows. Pure. The minute fields are held as typed
 * text, so a half-typed value is shown as typed and said wrong under its field, never rounded.
 */

export interface SessionTitleDraft {
  version: 1;
  enabled: boolean;
  intervalMinutes: string;
  quietMinutes: string;
  primary: DraftChoice;
  fallback: DraftChoice | null;
}

export const INTERVAL = { min: 1, max: 1440 } as const;
export const QUIET = { min: 0, max: 1440 } as const;

export const toTitleDraft = (s: SessionTitleSettings): SessionTitleDraft => ({
  version: 1,
  enabled: s.enabled,
  intervalMinutes: String(s.intervalMinutes),
  quietMinutes: String(s.quietMinutes),
  primary: { ...s.primary },
  fallback: s.fallback ? { ...s.fallback } : null,
});

/** A whole number of minutes in range, or null. */
export function minutesOf(text: string, range: { min: number; max: number }): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= range.min && n <= range.max ? n : null;
}

/** Why a minute field can't be saved, in the words under it, or null. */
export function minutesIssue(text: string, range: { min: number; max: number }): string | null {
  return minutesOf(text, range) === null ? `A whole number of minutes, ${range.min} to ${range.max}.` : null;
}

export function sameTitleSettings(d: SessionTitleDraft, s: SessionTitleSettings): boolean {
  return (
    d.enabled === s.enabled &&
    minutesOf(d.intervalMinutes, INTERVAL) === s.intervalMinutes &&
    minutesOf(d.quietMinutes, QUIET) === s.quietMinutes &&
    sameChoice(d.primary, s.primary) &&
    sameChoice(d.fallback, s.fallback)
  );
}

/** Why the draft can't be saved, one sentence naming the form (the dialog's footer), or null. */
export function titleDraftProblem(d: SessionTitleDraft): string | null {
  if (minutesOf(d.intervalMinutes, INTERVAL) === null) return "Session titles needs a whole number of minutes between checks.";
  if (minutesOf(d.quietMinutes, QUIET) === null) return "Session titles needs a whole number of quiet minutes.";
  if (!d.primary.model) return "Session titles needs a primary model.";
  if (!d.primary.effort) return "Session titles needs an effort for its primary model.";
  if (d.fallback && !d.fallback.model) return "Session titles needs a fallback model.";
  if (d.fallback && !d.fallback.effort) return "Session titles needs an effort for its fallback model.";
  if (d.fallback && sameChoice(d.primary, d.fallback)) return "Session titles has a fallback that's the same model as its primary.";
  return null;
}

/** The PUT body; only called once titleDraftProblem is null. */
export const toTitleSettings = (d: SessionTitleDraft): SessionTitleSettings => ({
  version: 1,
  enabled: d.enabled,
  intervalMinutes: minutesOf(d.intervalMinutes, INTERVAL)!,
  quietMinutes: minutesOf(d.quietMinutes, QUIET)!,
  primary: { ...d.primary },
  fallback: d.fallback ? { ...d.fallback } : null,
});

/**
 * Delegate's offer without its subagent marks: a title model obeys only the global policy switch,
 * which the server's `unusable` reasons already carry, so "off for subagents" would be wrong here.
 */
export function withoutSubagentMarks(options: DelegateOptions | undefined): DelegateOptions | undefined {
  if (!options) return options;
  return { ...options, backends: options.backends.map((b) => ({ ...b, models: b.models?.map(({ denied: _denied, ...m }) => m) ?? null })) };
}
