import type { DelegateOptions, SessionTitleSettings } from "../../shared/protocol";
import { check, firstIssue } from "../../shared/form-rules";
import { TITLE_RULES } from "../../shared/session-title-limits";
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

export const toTitleDraft = (s: SessionTitleSettings): SessionTitleDraft => ({
  version: 1,
  enabled: s.enabled,
  intervalMinutes: String(s.intervalMinutes),
  quietMinutes: String(s.quietMinutes),
  primary: { ...s.primary },
  fallback: s.fallback ? { ...s.fallback } : null,
});

/** A minute box's number once its rule takes it, else null. */
const minutes = (d: SessionTitleDraft, key: keyof typeof TITLE_RULES): number | null => {
  const r = check(TITLE_RULES[key], d[key]);
  return r.ok ? r.value : null;
};

export function sameTitleSettings(d: SessionTitleDraft, s: SessionTitleSettings): boolean {
  return (
    d.enabled === s.enabled &&
    minutes(d, "intervalMinutes") === s.intervalMinutes &&
    minutes(d, "quietMinutes") === s.quietMinutes &&
    sameChoice(d.primary, s.primary) &&
    sameChoice(d.fallback, s.fallback)
  );
}

/** The form's boxes in page order, then the model rows' problem (the draft store's `fields`). */
export const titleFields = (d: SessionTitleDraft) => [
  { rule: TITLE_RULES.intervalMinutes, value: d.intervalMinutes },
  { rule: TITLE_RULES.quietMinutes, value: d.quietMinutes },
  {
    message: !d.primary.model
      ? "Choose a primary model."
      : !d.primary.effort
        ? "Choose an effort for the primary model."
        : d.fallback && !d.fallback.model
          ? "Choose a fallback model, or no fallback."
          : d.fallback && !d.fallback.effort
            ? "Choose an effort for the fallback model."
            : d.fallback && sameChoice(d.primary, d.fallback)
              ? "The fallback is the same as the primary. Choose another model, or no fallback."
              : null,
  },
];

/** Why the draft can't be saved, or null. */
export const titleDraftProblem = (d: SessionTitleDraft): string | null => firstIssue(titleFields(d))?.message ?? null;

/** The PUT body; only called once the draft has no problem. */
export const toTitleSettings = (d: SessionTitleDraft): SessionTitleSettings => ({
  version: 1,
  enabled: d.enabled,
  intervalMinutes: minutes(d, "intervalMinutes")!,
  quietMinutes: minutes(d, "quietMinutes")!,
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
