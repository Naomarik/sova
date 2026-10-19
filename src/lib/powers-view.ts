// "What may happen without you" (al_3, §design.copy-deck/project-powers): the project's power
// switches as the Settings tab and the overseer's chat head show them. Pure: no Solid, no DOM.

import { POWER_COLUMNS, type Brake, type PowerColumn, type PowerGroup, type PowerId, type PowerMap, type PowersNote, type PowersView } from "../../shared/powers";

export { POWER_COLUMNS };
export type { PowerColumn, PowerId };

export const COLUMN_LABEL: Record<PowerColumn, string> = { overseer: "Overseer on its own", assistant: "Project Assistant from a client" };
/** The column's word in a switch's name, and its header below 480px. */
export const COLUMN_SHORT: Record<PowerColumn, string> = { overseer: "On its own", assistant: "From a client" };

export interface PowerRow {
  id: PowerId;
  label: string;
  /** The Project Assistant column can set it (false: the cell is "—"). */
  assistant: boolean;
}
export interface PowerGroupRow {
  id: PowerGroup;
  label: string;
  acts: PowerRow[];
}

/** The grid's groups as the server orders and names them, each with its acts; the server already left out what a standalone project lacks. */
export function powerGroups(v: Pick<PowersView, "groups" | "info">): PowerGroupRow[] {
  return v.groups
    .map((g) => ({ id: g.id, label: g.label, acts: g.powers.filter((p) => v.info[p]).map((p) => ({ id: p, label: v.info[p]!.label, assistant: v.info[p]!.assistant })) }))
    .filter((g) => g.acts.length > 0);
}

/** The Project Assistant's own list (the owner page card): only the acts it can ever set, each group keeping those. */
export const assistantGroups = (v: Pick<PowersView, "groups" | "info">): PowerGroupRow[] =>
  powerGroups(v)
    .map((g) => ({ ...g, acts: g.acts.filter((a) => a.assistant) }))
    .filter((g) => g.acts.length > 0);

/** The columns a project shows: the Project Assistant's only while an organization places it (the server marks a standalone view). */
export const columnsFor = (v: Pick<PowersView, "standalone">): readonly PowerColumn[] => (v.standalone ? ["overseer"] : POWER_COLUMNS);

export type CellState = "on" | "off" | "mixed" | "none";
export const STATE_WORD: Record<CellState, string> = { on: "On", off: "Off", mixed: "Mixed", none: "—" };

/** The acts a column's switch can set in a row: the assistant's only where it can act. */
export const settable = (acts: readonly PowerRow[], col: PowerColumn): PowerRow[] => (col === "assistant" ? acts.filter((a) => a.assistant) : [...acts]);

/** A group's (or one act's) cell in one column: On or Off when its acts agree, else Mixed; "—" when the column can set none of them. */
export function cellState(acts: readonly PowerRow[], m: Partial<PowerMap>, col: PowerColumn): CellState {
  const can = settable(acts, col);
  if (!can.length) return "none";
  const on = can.filter((a) => m[a.id] === true).length;
  return on === 0 ? "off" : on === can.length ? "on" : "mixed";
}

/** What a switch sets when pressed: Mixed and Off turn every act On; On turns every act Off. */
export const nextOn = (st: CellState): boolean => st !== "on";

/** The PATCH a switch sends: every act it sets, in its column (a group switch sends them all). */
export function powersPatch(acts: readonly PowerRow[], col: PowerColumn, on: boolean): { powers: Partial<Record<PowerColumn, Partial<PowerMap>>> } {
  return { powers: { [col]: Object.fromEntries(settable(acts, col).map((a) => [a.id, on])) } };
}

/** "5 acts" beside a group's name. */
export const actCount = (n: number): string => `${n} ${n === 1 ? "act" : "acts"}`;

/** A switch's accessible name: "People, on its own" / "Deploy, from a client". */
export const switchName = (label: string, col: PowerColumn): string => `${label}, ${COLUMN_SHORT[col].toLowerCase()}`;

/** Said (toast and announce) after a switch is saved. */
export const switchDone = (label: string, col: PowerColumn, on: boolean, group: boolean): string =>
  `${label}, ${COLUMN_SHORT[col].toLowerCase()}: ${group ? (on ? "all on" : "all off") : on ? "on" : "off"}.`;

/** The group's name button: "Show the 4 acts in People" / "Hide …". */
export const expandName = (g: Pick<PowerGroupRow, "label" | "acts">, open: boolean): string => `${open ? "Hide" : "Show"} the ${actCount(g.acts.length)} in ${g.label}`;

/** How many acts are On in one column, over every act that column can set. */
export function onCount(groups: readonly PowerGroupRow[], m: Partial<PowerMap>, col: PowerColumn): { on: number; of: number } {
  const acts = groups.flatMap((g) => settable(g.acts, col));
  return { on: acts.filter((a) => m[a.id] === true).length, of: acts.length };
}

const stop = (s: string): string => s.trim().replace(/[.\s]+$/, "");

/**
 * The head's button name: what is on in each column shown, the brake if any, and what it does.
 * "What may happen without you: on its own 5 of 14 on, from a client 0 of 5 on. Change."
 */
export function powersButtonName(groups: readonly PowerGroupRow[], m: Readonly<Record<PowerColumn, Partial<PowerMap>>>, cols: readonly PowerColumn[], brake: Brake | null): string {
  const part = (col: PowerColumn) => {
    const c = onCount(groups, m[col], col);
    return `${COLUMN_SHORT[col].toLowerCase()} ${c.on} of ${c.of} on`;
  };
  return `What may happen without you: ${cols.map(part).join(", ")}.${brake ? ` Paused: ${stop(brake.reason)}.` : ""} Change.`;
}

/** The always-allowed short line above the switches; its disclosure holds the full list. */
export const ALWAYS_LINE = "Some acts are always allowed, whatever the switches say.";
export const ALWAYS_DISCLOSURE = "What it can always do";

/** The disclosure's list: the server's phrases, one per row, each starting with a capital and no stop. */
export const alwaysItems = (items: readonly string[]): string[] =>
  items
    .map(stop)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));

/** A cell the column can't set ("—"): its tooltip, and its hidden name. */
export const NONE_TIP = "Not available to the client";
export const noneName = (name: string): string => `${name}: not available to the client`;

/** A switch's accessible name: its name, ", mixed" while its acts differ, and the brake while one holds it Off. */
export const switchLabel = (name: string, st: CellState, held: boolean): string =>
  `${name}${st === "mixed" ? ", mixed" : ""}${held ? ", paused: acts as Off" : ""}`;

/** The head's one state chip: Working while its turn runs, else Paused (its reason in the title) while a brake holds every switch Off. */
export function stateChip(busy: boolean, brake: Brake | null): { tone: "accent" | "warn"; text: string; title?: string } | null {
  if (busy) return { tone: "accent", text: "Working" };
  if (brake) return { tone: "warn", text: "Paused", title: brake.reason };
  return null;
}

/** The one-time note, while unseen: "Levels are now switches." and what changed, or an older Sova's level re-derived. */
export function powersNote(note: PowersNote | null | undefined): { title: string; body: string } | null {
  if (!note || note.seen) return null;
  if (note.kind === "rederived")
    return {
      title: `The switches were set again from level ${note.from}.`,
      body: `A computer on an older Sova changed this project's level to ${note.from}, so what that level lets it do on its own is On and everything else is Off. The Project Assistant's switches are as they were.`,
    };
  return {
    title: "Levels are now switches.",
    body: `What level ${note.from} let it do on its own is On; everything else is Off. One thing is looser: the overseer no longer approves its own waiting acts, so an act that is On goes ahead after the waiting period unless you cancel it in Needs you.`,
  };
}

/** The Paused banner's body: the server's reason, then what the brake does to the switches. */
export const brakeBody = (b: Brake): string => `${b.reason.trim().replace(/([^.])$/, "$1.")} Until you resume, every switch acts as Off. What you set is kept.`;

/** Resume's done line. */
export const brakeDone = "Resumed. The switches are in force again.";
