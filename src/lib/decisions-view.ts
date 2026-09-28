// The project page's decisions (§app/requirements): pure rules the page renders, so they run under
// tsx --test. The server owns every state; these only group, count and pick.

import { foldedRows, type Conflict, type DecisionRow, type DecisionState, type DecisionsInfo } from "../../shared/decisions";

export const DECISION_STATE: Record<DecisionState, { word: string; tone?: "info" | "warn" | "success"; hint: string }> = {
  pending: { word: "Pending", hint: "Not compared with the rest of its area yet." },
  drafted: { word: "Drafted", tone: "info", hint: "Consistent with its area and in the project's draft. Ready to promote." },
  conflict: { word: "Conflict", tone: "warn", hint: "Contradicts another decision. Promotion waits until it's settled." },
  promoted: { word: "Promoted", tone: "success", hint: "In the project's spec." },
  superseded: { word: "Superseded", hint: "A later decision replaced it." },
};

/** A promoted decision's build, as its spec record says (§app.requirements/decisions). */
export const BUILD_CHIP: Record<NonNullable<DecisionRow["build"]>, { word: string; tone?: "success"; hint: string }> = {
  built: { word: "Built", tone: "success", hint: "Its spec record has code and reviewed or verified evidence: what the build recorded, not proof." },
  "not-built": { word: "Not built yet", hint: "Its spec record has no code with reviewed or verified evidence yet. A branch not merged yet reads this way too." },
};

/** The Requirements card's build counts, or "" when nothing is promoted: " · 4 built, 9 not built yet". */
export function builtLine(spec: { built?: number; notBuilt?: number }): string {
  const built = spec.built ?? 0;
  const notBuilt = spec.notBuilt ?? 0;
  return built + notBuilt ? ` · ${built} built, ${notBuilt} not built yet` : "";
}

/** Only a drafted decision can be promoted: compared clean and written to the draft. */
export const promotable = (d: Pick<DecisionRow, "state">): boolean => d.state === "drafted";

export interface AreaGroup {
  areaKey: string;
  /** The newest decision's own wording of the area. */
  area: string;
  decisions: DecisionRow[];
}

/**
 * Decisions by area, areas in the order of their newest decision (the list arrives newest first),
 * superseded ones left out unless asked for: they are history, not the current requirement.
 */
export function areaGroups(decisions: readonly DecisionRow[], opts: { superseded: boolean }): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();
  for (const d of decisions) {
    if (d.state === "superseded" && !opts.superseded) continue;
    let g = groups.get(d.areaKey);
    if (!g) groups.set(d.areaKey, (g = { areaKey: d.areaKey, area: d.area, decisions: [] }));
    g.decisions.push(d);
  }
  return [...groups.values()];
}

/** The selection that is still promotable after a refresh: a promoted or conflicted id drops out. */
export const keepPromotable = (selected: ReadonlySet<string>, decisions: readonly DecisionRow[]): Set<string> =>
  new Set(decisions.filter((d) => selected.has(d.id) && promotable(d)).map((d) => d.id));

/** Both sides of a conflict, or null for a side the index no longer has. */
export function conflictSides(info: Pick<DecisionsInfo, "decisions">, c: Pick<Conflict, "a" | "b">): { a: DecisionRow | null; b: DecisionRow | null } {
  const byId = new Map(info.decisions.map((d) => [d.id, d]));
  return { a: byId.get(c.a) ?? null, b: byId.get(c.b) ?? null };
}

/** Counts for the page's one-line summary: "7 decisions · 2 conflicts open · 3 ready to promote". */
export function decisionsLine(info: Pick<DecisionsInfo, "decisions" | "conflicts">): string {
  const live = info.decisions.filter((d) => d.state !== "superseded").length;
  const open = info.conflicts.filter((c) => c.state === "open").length;
  const ready = info.decisions.filter(promotable).length;
  const parts = [`${live} ${live === 1 ? "decision" : "decisions"}`];
  if (open) parts.push(`${open} ${open === 1 ? "conflict" : "conflicts"} open`);
  parts.push(ready ? `${ready} ready to promote` : "none ready to promote");
  return parts.join(" · ");
}

/** A person ref's display name: the info's names, "you" for the operator. */
export const refName = (names: Record<string, string>, ref: string): string => (ref === "operator" ? "you" : (names[ref] ?? ref));

type Selectable = Pick<DecisionRow, "id" | "state" | "authorOwnsArea">;

/** A decision whose author doesn't decide its area: promotable one by one, never in bulk. */
export const outsideTheirArea = (d: Pick<DecisionRow, "authorOwnsArea">): boolean => !d.authorOwnsArea;

/**
 * The promote selection, and how it was made. `bulk` is true only while it is exactly what Select
 * All Ready chose — any tick or untick after that makes it the operator's explicit pick — and the
 * promote request carries it, so the server can hold bulk promotions to the stricter rule.
 */
export interface PromoteSelection {
  ids: Set<string>;
  bulk: boolean;
}

export const emptySelection = (): PromoteSelection => ({ ids: new Set(), bulk: false });

/** Select All Ready: every promotable decision whose author decides its area. */
export const selectAllReady = (decisions: readonly Selectable[]): PromoteSelection => ({
  ids: new Set(decisions.filter((d) => promotable(d) && !outsideTheirArea(d)).map((d) => d.id)),
  bulk: true,
});

/** One row ticked or unticked by hand: the selection is explicit from now on. */
export function toggleSelection(sel: PromoteSelection, id: string, on: boolean): PromoteSelection {
  const ids = new Set(sel.ids);
  if (on) ids.add(id);
  else ids.delete(id);
  return { ids, bulk: false };
}

/** After a refresh: drop what can no longer be promoted; how the rest was chosen doesn't change. */
export const refreshSelection = (sel: PromoteSelection, decisions: readonly DecisionRow[]): PromoteSelection => ({
  ids: keepPromotable(sel.ids, decisions),
  bulk: sel.bulk,
});

/**
 * The line under a decision that carries others: every statement folded into it, a fold of a fold
 * included (as its spec record's provenance counts them), each once. A fold may be a later
 * confirmation as well as an earlier restatement, so the line says neither. Null when none is known.
 */
export function alsoCarriesLine(d: Pick<DecisionRow, "id" | "folded">, byId: ReadonlyMap<string, Pick<DecisionRow, "id" | "folded">>): string | null {
  const n = foldedRows(d, byId).length;
  if (!n) return null;
  return n === 1 ? "Also carries 1 more statement of the same decision, with its quote." : `Also carries ${n} more statements of the same decision, with their quotes.`;
}
