// A branch's place: which project it belongs to and where it merges, in one form wherever a chat names a branch.
// Pure, no DOM and no Solid: the session list's words and the Worktrees rows read the same rules.

import type { BranchPlace } from "../../shared/merge-queue";
import { tildePath } from "./format";
import { projectTabHref } from "./projects-route";
import { splitRemoteCwd } from "./remote-session";

/** The fields of a row (a worktree, a session list's branch, a queue card) its place reads. */
export interface BranchPlaceRow {
  path?: string;
  status?: "active" | "dropped" | "merged";
  /** The merge this chat recorded. */
  merge?: { target: string };
  /** The merge git found. */
  mergedInto?: { target: string };
  readiness?: { state: string; merged?: true };
  gone?: string;
  queue?: { state: string; target?: string; settled?: unknown; request?: { facts?: { state?: string } } };
  place?: BranchPlace;
}

/** Where the row's branch goes, or went, by its own state; null when it says nothing (dropped, or unknown). */
export interface PlaceClause {
  merged: boolean;
  target: string;
}

/** A landed entry, or one its host merged while the queue hasn't moved it yet (merge-queue.ts entryKeyOf). */
const landedOn = (q: BranchPlaceRow["queue"]): boolean => q?.state === "landed" || (q?.state === "requested" && q.request?.facts?.state === "merged");

/** The row's own record is the only source for a merged row: the project's usual target says nothing about it. */
export function placeClause(row: BranchPlaceRow): PlaceClause | null {
  if (row.status === "dropped") return null;
  const went = row.merge?.target ?? row.mergedInto?.target ?? (landedOn(row.queue) ? row.queue?.target : undefined);
  if (went) return { merged: true, target: went };
  const merged = row.status === "merged" || landedOn(row.queue) || row.readiness?.merged === true || row.readiness?.state === "merged" || row.gone === "merged";
  if (merged) return null;
  // A live entry lands on its own target (the chat's queue card reads that one); else the repository's.
  const entry = row.queue && row.queue.state !== "cancelled" && !row.queue.settled ? row.queue.target : undefined;
  const target = entry ?? row.place?.target;
  return target ? { merged: false, target } : null;
}

/** The {place} words, or undefined when the row carries none. */
export const placeOf = (row: Pick<BranchPlaceRow, "place">): string | undefined => row.place?.label.trim() || undefined;

/** A place that is a folder rather than a name is a machine fact: it is drawn in mono. */
export const placeIsFolder = (place: string): boolean => place.startsWith("~") || place.startsWith("/");

/** " · merges into master", " · merged into feat/parent", or "" with no clause. */
export function clauseText(row: BranchPlaceRow): string {
  const c = placeClause(row);
  return c ? ` · ${c.merged ? "merged" : "merges"} into ${c.target}` : "";
}

/** The whole line: "{place} · merges into {target}". */
export function placeLine(row: BranchPlaceRow): string | undefined {
  const place = placeOf(row);
  return place ? `${place}${clauseText(row)}` : undefined;
}

/** The one form a line naming a branch uses: "{branch} in {place}". */
export const branchInPlace = (branch: string, place: string | undefined): string => {
  const p = place?.trim();
  return p ? `${branch} in ${p}` : branch;
};

export interface PlaceFold {
  /** The "label: value" lines, the value a path or a target. */
  lines: { label: string; value: string }[];
  /** What Copy Folder copies; absent when the row has no folder. */
  copy?: string;
}

/** What the line unfolds to. Paths are written from home, never on a remote target (its $HOME isn't ours). */
export function placeFold(row: BranchPlaceRow, home: string | null): PlaceFold {
  const remote = !!row.path && !!splitRemoteCwd(row.path);
  const shown = (p: string) => (remote ? (splitRemoteCwd(p)?.remoteCwd ?? p) : tildePath(p, home));
  const lines: PlaceFold["lines"] = [];
  if (row.path) lines.push({ label: "Branch folder", value: shown(row.path) });
  const c = placeClause(row);
  if (c) lines.push({ label: c.merged ? "Merged into" : "Merges into", value: row.place?.root ? `${c.target} of ${shown(row.place.root)}` : c.target });
  return { lines, ...(row.path ? { copy: remote ? (splitRemoteCwd(row.path)?.remoteCwd ?? row.path) : row.path } : {}) };
}

/** The row fields a project's queue link and name read. */
export type QueueLinkRow = Pick<BranchPlaceRow, "place"> & { mergeProject?: { id: string; root?: string }; queue?: { project?: string } };

/** "View Merge Queue" per project the rows are in: one reads as ever, several are each named. Only a row of a project
    on the Projects list has one. */
export function queueLinksOf(rows: QueueLinkRow[]): { href: string; label: string }[] {
  const byId = new Map<string, string | undefined>();
  for (const w of rows) {
    const id = w.mergeProject?.id ?? w.queue?.project;
    // An older server sends no place: the project's folder name still reads as a name, an id never does.
    if (id && !byId.has(id)) byId.set(id, placeOf(w) ?? w.mergeProject?.root?.split("/").filter(Boolean).pop());
  }
  const several = byId.size > 1;
  return [...byId].map(([id, place]) => ({ href: projectTabHref(id, "merge-queue"), label: several && place ? `View ${place}'s Merge Queue` : "View Merge Queue" }));
}
