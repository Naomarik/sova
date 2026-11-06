/**
 * A subagent profile's boxes with their rules (shared/subagent-limits.ts), in the editor's order:
 * the editor's Save waits on the first that fails, and the save route refuses with it, in the same words
 * (a key the request leaves out is the file's default, so the route skips an undefined value).
 */
import type { FieldCheck } from "./form-rules";
import type { SubagentProfile } from "./subagent-profiles";
import { INSTRUCTIONS_RULE, PROFILE_NAME_RULE, ROLE_RULE, TEAM_NUMBERS, TEAM_RULES, type TeamNumberField } from "./subagent-limits";

/** A team number's value in `teams` (undefined when that part is missing). */
export const teamNumber = (teams: unknown, f: TeamNumberField): unknown => TEAM_NUMBERS[f].path.reduce<any>((o, k) => o?.[k], teams);

export function profileFields(p: SubagentProfile): FieldCheck[] {
  const t = p.teams;
  const role = (r: "coordinator" | "monitor", name: string): FieldCheck[] => [
    { rule: ROLE_RULE, value: t?.[r]?.role, label: `${name} role name` },
    { rule: INSTRUCTIONS_RULE, value: t?.[r]?.instructions, label: `${name} instructions` },
  ];
  const numbers = (fs: TeamNumberField[]) => fs.map((f) => ({ rule: TEAM_RULES[f], value: teamNumber(t, f) }));
  if (!t) return [{ rule: PROFILE_NAME_RULE, value: p.name }];
  return [
    { rule: PROFILE_NAME_RULE, value: p.name },
    ...role("coordinator", "Coordinator"),
    ...numbers(["contextPct", "everyMinutes", "pausePct", "resumeMarginMinutes"]),
    ...role("monitor", "Monitor"),
    ...numbers(["retireTimeoutMinutes"]),
  ];
}
