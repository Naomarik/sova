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

/** One file's patch; with `context`, also its old side whole (`oldText`), for opening folds. */
export const fetchDiffPatch = (scope: DiffScope, file: { path: string; oldPath?: string }, opts: { context?: boolean } = {}) => {
  const q = new URLSearchParams({ file: file.path });
  if (file.oldPath) q.set("old", file.oldPath);
  if (opts.context) q.set("context", "1");
  return getJson<DiffFilePatch>(`/api/diff/patch?${diffScopeQuery(scope)}&${q}`);
};

/** A show_changes result's scope as the endpoint's, with the session the card belongs to. */
export function scopeFromDetails(details: ShowChangesDetails, sessionPath: string): DiffScope {
  const s = details.scope;
  if (s.kind === "worktree") return { kind: "worktree", sessionPath, worktreePath: s.worktreePath };
  if (s.kind === "commit") return { kind: "commit", sessionPath, repoPath: s.repoPath, sha: s.sha };
  return { kind: "dirty", sessionPath, cwd: s.cwd };
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
