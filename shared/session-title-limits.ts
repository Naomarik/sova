/**
 * Settings → Summaries → Session titles' limits, read by the form (src/lib/session-title-settings-form.ts)
 * and the save (server/session-titles-settings.ts), refused in the same words (shared/form-rules.ts).
 */
import type { WholeRule } from "./form-rules";

export const TITLE_RULES = {
  intervalMinutes: { kind: "whole", label: "Minutes between checks", min: 1, max: 1440 },
  quietMinutes: { kind: "whole", label: "Quiet minutes", min: 0, max: 1440 },
} satisfies Record<"intervalMinutes" | "quietMinutes", WholeRule>;
