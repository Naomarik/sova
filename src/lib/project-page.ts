// The project page's tabs (§app.organizations/project-page): the Sessions tab's attention line, the Requirements tab's counts line, the Settings tab's summaries
// and the Limits table. Pure: no Solid, no DOM.

import type { ProjectOverseerCaps } from "../../shared/project-overseer";
import { gapWords, holdWords, soonWords } from "./project-overseer-view";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The Sessions tab's banner while something waits on the operator; null when nothing does. */
export function attentionLine(openConflicts: number, ready: number): string | null {
  const parts = [openConflicts ? `${count(openConflicts, "conflict")} open` : "", ready ? `${count(ready, "decision")} ready to promote` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

/** The Requirements tab's one line for its empty sections, in the tab's order; null when none is empty. */
export function emptySectionsLine(empty: { conflicts: boolean; decisions: boolean; pipeline: boolean; ideas: boolean }): string | null {
  const names = [empty.conflicts && "conflicts", empty.decisions && "decisions", empty.pipeline && "pipeline rows", empty.ideas && "ideas"].filter((x): x is string => !!x);
  if (!names.length) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)!}`;
  return `No ${list} yet.`;
}

// ---- Limits as one table (§app.project-overseer/limits) ------------------------------------------------

export const LIMIT_COLUMNS = ["message", "day", "once"] as const;
export type LimitColumn = (typeof LIMIT_COLUMNS)[number];
export const LIMIT_COLUMN_LABEL: Record<LimitColumn, string> = { message: "Per message", day: "Per day", once: "At once" };

type CapKey = keyof ProjectOverseerCaps;
/** One row per limit; a column the limit doesn't have is absent. `placed`: a limit on what only an
    organization's tools do (gatherings, promotion), shown only while one places the project. */
export const LIMIT_ROWS: readonly { label: string; cells: Partial<Record<LimitColumn, CapKey>>; placed?: true }[] = [
  { label: "Gathering sessions started", cells: { message: "gatherPerTurn", day: "gatherPerDay" }, placed: true },
  { label: "Decisions promoted", cells: { message: "promotePerTurn", day: "promotePerDay" }, placed: true },
  { label: "Coding sessions started", cells: { message: "createPerTurn", day: "createPerDay" } },
  { label: "Prompts to coding sessions", cells: { message: "promptsPerTurn", day: "promptsPerDay" } },
  { label: "Looks", cells: { day: "unattendedPerDay" } },
  { label: "Gathering sessions open", cells: { once: "gatheringsOpen" }, placed: true },
  { label: "Coding sessions running", cells: { once: "codingRunning" } },
];

/** A limit's cell, read-only: its number, or ∞ for Unlimited. */
export const limitCell = (v: number | null): string => (v === null ? "∞" : String(v));

/** The pace under the table, in one line. */
export const paceLine = (gapMin: number, soonSec: number | null, holdMin: number): string =>
  `Looks at most every ${gapWords(gapMin)} · ${soonSec === null ? "No sooner look after a session finishes" : `Within ${soonWords(soonSec)} after a session finishes`} · Hold: ${holdWords(holdMin)}`;

/** Activity shows its newest few until Show All. */
export const ACTIVITY_SHOWN = 5;
