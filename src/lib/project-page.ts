// The project page's summary and tabs (§app.organizations/project-page): the count chips, the
// Overview's attention line, the Requirements tab's counts line, the Settings tab's summaries
// and the Limits table. Pure: no Solid, no DOM.

import { AUTONOMY_MEANING, type Autonomy, type ProjectOverseerCaps } from "../../shared/project-overseer";
import { gapWords, holdWords, soonWords } from "./project-overseer-view";
import type { ProjectTab } from "./projects-route";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "L3 Build": the level and the first word of its meaning. */
export const levelWords = (a: Autonomy): string => `${a} ${AUTONOMY_MEANING[a].split(":")[0]}`;

/** The section a chip brings into view: an element id on its tab. */
export type ChipSection = "project-coding" | "project-previews" | "project-cost" | "project-conflicts" | "project-decisions" | "project-ideas" | "project-todos";

export interface SummaryChip {
  id: string;
  label: string;
  tab: ProjectTab;
  section: ChipSection;
  tone?: "warn";
  title?: string;
}

/** What the summary counts; a count not read yet is undefined and its chip is left out (never 0). */
export interface SummaryCounts {
  sessions?: number;
  previews?: number;
  /** The total as the Cost card writes it (`$27.21`, `≈$4.10`). */
  cost?: string;
  conflicts?: number;
  /** Live decisions (not superseded), and how many are ready to promote. */
  decisions?: { total: number; ready: number };
  /** Open ideas: the gaps the overseer filed, and the rest. */
  ideas?: { gaps: number; other: number };
  /** Where the ideas list is: Requirements while an org places the project, else Overview. */
  ideasTab?: ProjectTab;
  todos?: number;
}

/** The strip of count chips under the overseer line, in the page's order. */
export function summaryChips(c: SummaryCounts): SummaryChip[] {
  const out: SummaryChip[] = [];
  if (c.sessions !== undefined) out.push({ id: "sessions", label: count(c.sessions, "session"), tab: "overview", section: "project-coding", title: "Coding sessions" });
  if (c.previews !== undefined) out.push({ id: "previews", label: count(c.previews, "preview"), tab: "overview", section: "project-previews", title: "Active preview links" });
  if (c.cost !== undefined) out.push({ id: "cost", label: c.cost, tab: "cost", section: "project-cost", title: "At API prices" });
  if (c.conflicts !== undefined)
    out.push({ id: "conflicts", label: count(c.conflicts, "conflict"), tab: "requirements", section: "project-conflicts", tone: c.conflicts > 0 ? "warn" : undefined, title: "Open conflicts" });
  if (c.decisions !== undefined)
    out.push({ id: "decisions", label: count(c.decisions.total, "decision"), tab: "requirements", section: "project-decisions", title: `${c.decisions.ready} ready to promote` });
  if (c.ideas !== undefined) {
    const { gaps, other } = c.ideas;
    out.push({ id: "ideas", label: !gaps && c.ideasTab === "overview" ? count(other, "idea") : other ? `${count(gaps, "gap")} · ${count(other, "idea")}` : count(gaps, "gap"), section: "project-ideas", title: "Open gaps and ideas", tab: c.ideasTab ?? "requirements" });
  }
  if (c.todos !== undefined) out.push({ id: "todos", label: count(c.todos, "to-do"), tab: "overview", section: "project-todos", title: "Open to-do items" });
  return out;
}

/** The Overview's banner while something waits on the operator; null when nothing does. */
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

/** The approval list as one line (§app.project-overseer/reviews). */
export function confirmSummary(on: readonly string[], all: readonly string[], label: (kind: string) => string): string {
  const chosen = all.filter((k) => on.includes(k));
  if (!chosen.length) return "None waits for its approval.";
  if (chosen.length === all.length) return `All ${all.length} wait for its approval.`;
  return `${chosen.length} of ${all.length} wait for its approval: ${chosen.map(label).join(", ")}.`;
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
