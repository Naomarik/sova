/**
 * Settings → Subagents' limits, read by the editor (src/lib/subagent-profiles-draft.ts) and by the
 * save (server/subagent-profiles.ts, before the library's own parse), so both refuse in the same
 * words (shared/form-rules.ts). The numbers are the subagents extension's (team-defaults.ts).
 */
import type { TextRule, WholeRule } from "./form-rules";

export const PROFILE_NAME_RULE: TextRule = { kind: "text", label: "Profile name", min: 1, max: 48 };
export const ROLE_RULE: TextRule = { kind: "text", label: "Role name", min: 1, max: 64, trim: true, empty: "Name the role." };
export const INSTRUCTIONS_RULE: TextRule = { kind: "text", label: "Instructions", max: 4000 };

/** The teams section's number boxes, where each sits in a profile's `teams`, and its hint. */
export const TEAM_NUMBERS = {
  contextPct: { path: ["monitor", "contextPct"], hint: "Start wrap-up when a member's context is this full." },
  everyMinutes: { path: ["monitor", "everyMinutes"], hint: "How often the monitor checks in." },
  pausePct: { path: ["monitor", "usage", "pausePct"], hint: "Pause the team when a provider is this close to its limit." },
  resumeMarginMinutes: { path: ["monitor", "usage", "resumeMarginMinutes"], hint: "Wait this long after the limit resets before resuming." },
  retireTimeoutMinutes: { path: ["handover", "retireTimeoutMinutes"], hint: "How long a replaced member has to hand over." },
} as const;
export type TeamNumberField = keyof typeof TEAM_NUMBERS;

export const TEAM_RULES: Record<TeamNumberField, WholeRule> = {
  contextPct: { kind: "whole", label: "Wrap-up context %", min: 1, max: 100 },
  everyMinutes: { kind: "whole", label: "Check every (minutes)", min: 1, max: 1440 },
  pausePct: { kind: "whole", label: "Pause usage %", min: 1, max: 100 },
  resumeMarginMinutes: { kind: "whole", label: "Resume margin (minutes)", min: 0, max: 1440 },
  retireTimeoutMinutes: { kind: "whole", label: "Retire timeout (minutes)", min: 1, max: 1440 },
};
