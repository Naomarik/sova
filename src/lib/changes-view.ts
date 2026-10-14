// The changes viewer's plumbing (§chat.changes/viewer): the diff endpoint's two reads, the
// remembered layout choices, and the small words the viewer shows. No Solid here beyond the
// remembered signals, so the pure parts test under tsx.

import { createSignal } from "solid-js";
import type { DiffFilePatch, DiffFileStatus, DiffScope, DiffSummary } from "../../shared/protocol";
import { diffScopeQuery } from "../../shared/protocol";
import type { ShowChangesDetails } from "../../pi-config/extensions/show-changes/details";
import { readKey, writeKey } from "./storage-keys";

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error("The Sova server isn't reachable.");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const fetchDiffSummary = (scope: DiffScope) => getJson<DiffSummary>(`/api/diff/summary?${diffScopeQuery(scope)}`);

/** One file's patch; with `context`, also its old side whole (`oldText`), for opening folds.
    A comparison with commits also asks which commits each hunk came from (`origins=1`, on the
    same read), so the steps name their commits without another request. */
export const fetchDiffPatch = (scope: DiffScope, file: { path: string; oldPath?: string }, opts: { context?: boolean } = {}) => {
  const q = new URLSearchParams({ file: file.path });
  if (file.oldPath) q.set("old", file.oldPath);
  if (opts.context) q.set("context", "1");
  if (scopeHasCommits(scope)) q.set("origins", "1");
  return getJson<DiffFilePatch>(`/api/diff/patch?${diffScopeQuery(scope)}&${q}`);
};

/** Whether a comparison's changes come from commits (an uncommitted one has none). */
export const scopeHasCommits = (scope: DiffScope) => scope.kind !== "dirty";

/** A show_changes result's scope as the endpoint's, with the session the card belongs to. A branch
    card is pinned to the base and head commits it saved (the diff the tool checked), and a card
    limited to paths stays limited to them. */
export function scopeFromDetails(details: ShowChangesDetails, sessionPath: string): DiffScope {
  const s = details.scope;
  const paths = details.paths?.length ? { paths: [...details.paths] } : {};
  if (s.kind === "worktree")
    return { kind: "worktree", sessionPath, worktreePath: s.worktreePath, pin: { base: s.base, head: s.head, baseRef: s.baseRef, branch: s.branch }, ...paths };
  if (s.kind === "commit") return { kind: "commit", sessionPath, repoPath: s.repoPath, sha: s.sha, ...paths };
  return { kind: "dirty", sessionPath, cwd: s.cwd, ...paths };
}

/** "a1b2c3d" */
export const sha7 = (sha: string) => sha.slice(0, 7);

/** A step's commits in the steps list: "a1b2c3d · 1 commit" or "a1b2c3d → 9f8e7d6 · 3 commits". */
export function commitsCaption(commits: readonly string[]): string {
  if (commits.length === 1) return `${sha7(commits[0]!)} · 1 commit`;
  return `${sha7(commits[0]!)} → ${sha7(commits.at(-1)!)} · ${commits.length} commits`;
}

/** The open step's commits row: "From 1 commit · a1b2c3d" or "From 3 commits · a1b2c3d → 9f8e7d6". */
export function commitsSummary(commits: readonly string[]): string {
  if (commits.length === 1) return `From 1 commit · ${sha7(commits[0]!)}`;
  return `From ${commits.length} commits · ${sha7(commits[0]!)} → ${sha7(commits.at(-1)!)}`;
}

/** Why an agent step shows nothing (§chat.changes/viewer, Empty steps). */
export function emptyReason(step: { empty?: "taken" | "gone"; heldBy?: readonly number[] }): string | null {
  if (step.empty === "gone") return "Nothing left to show: these changes are no longer in the diff";
  if (step.empty !== "taken") return null;
  const held = step.heldBy ?? [];
  if (held.length === 0) return "Nothing left to show: earlier steps already hold these changes";
  if (held.length === 1) return `Nothing left to show: step ${held[0]} already holds these changes`;
  const list = held.length === 2 ? `${held[0]} and ${held[1]}` : `${held.slice(0, -1).join(", ")}, and ${held.at(-1)}`;
  return `Nothing left to show: steps ${list} already hold these changes`;
}

/** Does `path` fall under the agent's filter (a file, or a folder prefix)? No filter keeps all. */
export function inPaths(path: string, paths: string[] | undefined): boolean {
  if (!paths?.length) return true;
  return paths.some((p) => {
    const q = p.replace(/\/+$/, "");
    return path === q || path.startsWith(`${q}/`);
  });
}

/** What the comparison is, in words: "Uncommitted changes against HEAD", "feat/x against master
    (merge-base)", "Commit abc1234 against abc1234^1". */
export function scopeTitle(summary: Pick<DiffSummary, "base" | "head" | "scope">): string {
  const s = summary.scope;
  if (s.kind === "dirty") return `Uncommitted changes against ${summary.base.label}`;
  if (s.kind === "commit") return `Commit ${summary.head.label} against ${summary.base.label}`;
  return `${summary.head.label} against ${summary.base.label}`;
}

export const STATUS_WORD: Record<DiffFileStatus, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  T: "Type changed",
  B: "Binary",
};

/** Status letter → the chip tone the design system uses for it. */
export const STATUS_TONE: Record<DiffFileStatus, "warn" | "success" | "error" | "info"> = {
  M: "warn",
  A: "success",
  D: "error",
  R: "info",
  T: "info",
  B: "info",
};

/** "3 files · +12 −4" */
export function countsLine(files: number, added: number, removed: number): string {
  return `${files} ${files === 1 ? "file" : "files"} · +${added} −${removed}`;
}

/** A step's number as the viewer prints it (a round badge carries it). */
export function stepMark(n: number): string {
  return String(n);
}

const PANE_KEY = "sova:changes-pane";

const store = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Whether the viewer's left pane is hidden, remembered on this device. */
export const [changesPaneHidden, setChangesPaneHiddenSignal] = createSignal(store() ? readKey(store()!, PANE_KEY) === "hidden" : false);
export function setChangesPaneHidden(hidden: boolean): void {
  setChangesPaneHiddenSignal(hidden);
  const s = store();
  if (s) writeKey(s, PANE_KEY, hidden ? "hidden" : "shown");
}
