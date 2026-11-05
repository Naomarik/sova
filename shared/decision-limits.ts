/**
 * Settings → Decisions' limits, read by the form (src/lib/decision-form.ts) and the save
 * (server/decide-settings.ts), refused in the same words (shared/form-rules.ts).
 */
import type { CustomRule } from "./form-rules";

/** The most folders the server keeps. */
export const MAX_EXCLUSIONS = 100;

/** The exclusion lines as saved: trimmed, blanks dropped, duplicates once, in typed order. */
export const parseExclusions = (text: string): string[] => [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];

/** The Folders box, one per line: at most MAX_EXCLUSIONS, each absolute or under `~/`. */
export const EXCLUSIONS_RULE: CustomRule = {
  kind: "custom",
  label: "Folders",
  issue(text) {
    const list = parseExclusions(text);
    if (list.length > MAX_EXCLUSIONS) return `That's ${list.length} folders. Use at most ${MAX_EXCLUSIONS}.`;
    const bad = list.find((p) => !(p.startsWith("/") || p === "~" || p.startsWith("~/")));
    return bad === undefined ? null : `"${bad}" isn't a full path. Start it with / or ~/.`;
  },
};
