import type { TeamDefaults } from "../../shared/protocol";
import { sameChoice, type DraftChoice } from "./delegate-form";

/**
 * Settings → Teams' form rules: the standing coordinator and monitor every new team gets, and how
 * long a replaced member has to hand over. The worker rows are Delegate's (delegate-form.ts,
 * WorkerSlotRow), with its rule: nothing here ever picks a model the user didn't. Numbers are kept
 * as typed (NaN while a field is blank) so an unusable value is shown, never silently clamped.
 */

type Role<T> = Omit<T, "primary" | "fallback"> & { primary: DraftChoice; fallback: DraftChoice | null };
export type TeamDraft = {
  version: 1;
  coordinator: Role<TeamDefaults["coordinator"]>;
  monitor: Role<TeamDefaults["monitor"]>;
  handover: TeamDefaults["handover"];
};

export const cloneTeam = (s: TeamDefaults | TeamDraft): TeamDraft => JSON.parse(JSON.stringify(s));

const sameNumber = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));

export function sameTeam(a: TeamDefaults | TeamDraft, b: TeamDefaults | TeamDraft): boolean {
  const c = [a.coordinator, b.coordinator] as const;
  const m = [a.monitor, b.monitor] as const;
  return (
    c[0].enabled === c[1].enabled &&
    c[0].role === c[1].role &&
    c[0].instructions === c[1].instructions &&
    sameChoice(c[0].primary, c[1].primary) &&
    sameChoice(c[0].fallback, c[1].fallback) &&
    m[0].enabled === m[1].enabled &&
    m[0].role === m[1].role &&
    m[0].instructions === m[1].instructions &&
    sameChoice(m[0].primary, m[1].primary) &&
    sameChoice(m[0].fallback, m[1].fallback) &&
    sameNumber(m[0].contextPct, m[1].contextPct) &&
    sameNumber(m[0].everyMinutes, m[1].everyMinutes) &&
    m[0].usage.enabled === m[1].usage.enabled &&
    sameNumber(m[0].usage.pausePct, m[1].usage.pausePct) &&
    sameNumber(m[0].usage.resumeMarginMinutes, m[1].usage.resumeMarginMinutes) &&
    sameNumber(a.handover.retireTimeoutMinutes, b.handover.retireTimeoutMinutes)
  );
}

/** A number field's value: blank (or not a number) is NaN, which no bound accepts. */
export const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** The number fields and what each accepts: whole numbers in [min, max]. */
export const TEAM_NUMBER_BOUNDS = {
  contextPct: { min: 1, max: 100 },
  everyMinutes: { min: 1, max: 1440 },
  pausePct: { min: 1, max: 100 },
  resumeMarginMinutes: { min: 0, max: 1440 },
  retireTimeoutMinutes: { min: 1, max: 1440 },
} as const;
export type TeamNumberField = keyof typeof TEAM_NUMBER_BOUNDS;

/** Why a number field's value can't be saved, or null. */
export function numberIssue(field: TeamNumberField, value: number): string | null {
  const { min, max } = TEAM_NUMBER_BOUNDS[field];
  if (Number.isNaN(value)) return "Enter a number.";
  if (!Number.isInteger(value)) return "Use a whole number.";
  if (value < min || value > max) return `Use ${min} to ${max}.`;
  return null;
}

/** Each number field's value in the draft. */
export const teamNumbers = (d: TeamDraft): Record<TeamNumberField, number> => ({
  contextPct: d.monitor.contextPct,
  everyMinutes: d.monitor.everyMinutes,
  pausePct: d.monitor.usage.pausePct,
  resumeMarginMinutes: d.monitor.usage.resumeMarginMinutes,
  retireTimeoutMinutes: d.handover.retireTimeoutMinutes,
});

const rowComplete = (c: DraftChoice | null) => c === null || (!!c.model && !!c.effort);

/**
 * What Save waits for: every worker row has a model and an effort, every role a name, and every
 * number is in range. A role that is off still has to be complete — its values are what turning it
 * back on restores.
 */
export function teamDraftComplete(d: TeamDraft): boolean {
  return (
    [d.coordinator, d.monitor].every((r) => r.role.trim() !== "" && rowComplete(r.primary) && r.primary !== null && rowComplete(r.fallback)) &&
    (Object.entries(teamNumbers(d)) as [TeamNumberField, number][]).every(([f, v]) => numberIssue(f, v) === null)
  );
}

/** Rows the server refuses whatever discovery says: a fallback that is its own primary, or both roles under one name. */
export function teamDraftConflict(d: TeamDraft): string | null {
  for (const [name, r] of [["Coordinator", d.coordinator], ["Monitor", d.monitor]] as const)
    if (r.fallback !== null && !!r.fallback.model && sameChoice(r.primary, r.fallback)) return `${name}: the fallback is the same worker as the primary.`;
  if (d.coordinator.role.trim() !== "" && d.coordinator.role.trim().toLowerCase() === d.monitor.role.trim().toLowerCase())
    return "The coordinator and the monitor need different role names.";
  return null;
}
