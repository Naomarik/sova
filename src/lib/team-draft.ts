import type { TeamDefaults, TeamDefaultsSaveResult } from "../../shared/team-defaults";
import { putTeamDefaults } from "./api";
import { createDraftStore } from "./settings-draft";
import { cloneTeam, numberIssue, sameTeam, TEAM_NUMBER_BOUNDS, teamDraftConflict, teamNumbers, type TeamDraft, type TeamNumberField } from "./team-form";

/** Each number field as the footer names it (the form's labels, without their units). */
const NUMBER_NAME: Record<TeamNumberField, string> = {
  contextPct: "context threshold",
  everyMinutes: "check interval",
  pausePct: "pause threshold",
  resumeMarginMinutes: "resume margin",
  retireTimeoutMinutes: "retire timeout",
};

/**
 * Why a Teams draft can't be saved, for the dialog's footer: the first role without a name or a
 * complete worker row, the first number out of range, then a conflict the server would refuse.
 * Null when Save can write it — `teamDraftComplete` and `teamDraftConflict` together. Pure.
 */
export function teamDraftProblem(d: TeamDraft): string | null {
  for (const [name, r] of [["coordinator", d.coordinator], ["monitor", d.monitor]] as const) {
    if (r.role.trim() === "") return `Teams needs a role name for the ${name}.`;
    if (!r.primary.model || !r.primary.effort) return `Teams needs a model and an effort for the ${name}.`;
    if (r.fallback && (!r.fallback.model || !r.fallback.effort)) return `Teams needs a model and an effort for the ${name}'s fallback.`;
  }
  for (const [field, value] of Object.entries(teamNumbers(d)) as [TeamNumberField, number][]) {
    if (numberIssue(field, value) === null) continue;
    const { min, max } = TEAM_NUMBER_BOUNDS[field];
    return Number.isNaN(value) ? `Teams needs a number for the ${NUMBER_NAME[field]}.` : `Teams needs a whole number from ${min} to ${max} for the ${NUMBER_NAME[field]}.`;
  }
  const conflict = teamDraftConflict(d);
  return conflict ? `Teams: ${conflict}` : null;
}

/** Settings → Teams' unsaved edits (settings-draft.ts: module state, held on close, forgotten once closed). */
const store = createDraftStore<TeamDraft, TeamDefaults, TeamDefaultsSaveResult>({
  tab: "teams",
  label: "Teams",
  toDraft: cloneTeam,
  same: sameTeam,
  problem: teamDraftProblem,
  write: async (d) => {
    const body = cloneTeam(d) as TeamDefaults;
    body.coordinator.role = body.coordinator.role.trim();
    body.monitor.role = body.monitor.role.trim();
    const result = await putTeamDefaults(body);
    return { saved: result.settings, warnings: result.warnings, result };
  },
});

export const teamDraft = store.draft;
export const teamSaved = store.saved;
export const setTeamDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setTeamSaved = store.setSaved;
export const teamDirty = store.dirty;
export const teamSaving = store.saving;
export const teamSaveError = store.error;
export const teamWarnings = store.warnings;
/** The last save's response: the section shows what it says (the file is stored now). */
export const teamSaveResult = store.result;
export const resetTeamDraft = store.reset;
