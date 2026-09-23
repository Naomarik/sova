import type { GitFileChange, GitRepoSummary, GitSummary } from "../../shared/protocol";
import { fetchGitSummary } from "./api";
import { tildePath } from "./format";

/**
 * The words of the Repository section (SessionDetails), pure so each one can be tested for the
 * case it must NOT say: a partial status is never "clean", a missing count is never "+0 −0", and
 * an upstream is never called up to date by a client that doesn't fetch.
 */

/** How long an answer on screen is left alone before a visible surface reads it again. */
export const GIT_REFRESH_MS = 30_000;

/** "main", "main · no commits yet", or "Detached at 1a2b3c4". */
export function headLabel(s: GitRepoSummary): string {
  if (s.head.kind === "detached") return s.head.oid ? `Detached at ${s.head.oid.slice(0, 7)}` : "Detached";
  return s.unborn ? `${s.head.name} · no commits yet` : s.head.name;
}

/** Ahead/behind as this repository last saw its upstream. "Level with" rather than "up to date":
    nothing here fetches, so the far side may have moved. */
export function upstreamLabel(s: GitRepoSummary): string {
  const u = s.upstream;
  if (!u) return "None set";
  if ("gone" in u) return `${u.name} is gone`;
  if (u.ahead === 0 && u.behind === 0) return `Level with ${u.name}`;
  const parts = [u.ahead > 0 && `${u.ahead} ahead`, u.behind > 0 && `${u.behind} behind`].filter(Boolean);
  return `${parts.join(", ")} ${u.name}`;
}

export const UPSTREAM_TITLE = "Counted against the upstream as this repository last fetched it. Sova never fetches.";

/** "Clean", or the non-zero tallies — "At least …" when git status was cut short. */
export function changesLabel(s: GitRepoSummary): string {
  if (s.clean) return "Clean";
  const c = s.counts;
  const parts = [
    c.conflicted > 0 && `${c.conflicted} conflicted`,
    c.staged > 0 && `${c.staged} staged`,
    c.unstaged > 0 && `${c.unstaged} unstaged`,
    c.untracked > 0 && `${c.untracked} untracked`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return s.statusPartial ? "Not fully read" : "Clean";
  return s.statusPartial ? `At least ${parts.join(" · ")}` : parts.join(" · ");
}

/** The per-row count, or the word for why there is none. */
export function fileLines(f: GitFileChange): string {
  if (f.kind === "untracked") return f.path.endsWith("/") ? "untracked folder" : "untracked";
  if (f.lines === "binary") return "binary";
  if (f.lines === null) return "not counted";
  return `+${f.lines.added} −${f.lines.removed}`;
}

const SIDE: Record<string, string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type changed",
};

/** What happened to the path, staged side first: "staged renamed from a.ts · unstaged modified". */
export function changeLabel(f: GitFileChange): string {
  if (f.kind === "conflicted") return "conflicted";
  if (f.kind === "untracked") return "not tracked yet";
  const from = f.from !== undefined ? ` from ${f.from}` : "";
  const parts = [f.staged && `staged ${SIDE[f.staged]}${f.staged === "renamed" || f.staged === "copied" ? from : ""}`, f.unstaged && `unstaged ${SIDE[f.unstaged]}`].filter(
    Boolean,
  ) as string[];
  const label = parts.join(" · ") || "changed";
  return f.submodule ? `submodule · ${label}` : label;
}

/** Why some counts are missing, or null when every tracked path was counted. */
export function linesNote(s: GitRepoSummary): string | null {
  switch (s.lines) {
    case "ok":
      return null;
    case "partial":
      return "Line counts stopped at the size limit. Paths past it say \"not counted\".";
    case "timeout":
      return "Counting lines took too long in this repository. Rows say \"not counted\".";
    case "failed":
      return "Git couldn't count lines here. Rows say \"not counted\".";
  }
}

/** The summary line of the file list: "7 changed paths · +120 −40". The sum covers counted paths
    only, which the note beside it says when that isn't all of them. */
export function filesHeadline(s: GitRepoSummary): string {
  const n = s.filesTotal;
  const paths = `${s.statusPartial ? "At least " : ""}${n} changed ${n === 1 ? "path" : "paths"}`;
  return s.added + s.removed > 0 ? `${paths} · +${s.added} −${s.removed}` : paths;
}

/** Listed fewer than there are: the sentence that says so, or null. */
export function capNote(s: GitRepoSummary): string | null {
  return s.files.length < s.filesTotal ? `Showing the first ${s.files.length} of ${s.filesTotal}.` : null;
}

/** A path with its control characters written out the way git quotes them ("new\\nline.txt"), so
    a newline in a name reads as part of it rather than breaking the row. The raw path stays in the
    row's title. */
export function visiblePath(p: string): string {
  return p.replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\n" ? "\\n" : c === "\t" ? "\\t" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

/** The folder a read ran in, the same way: "~/…" here, "target:/path" on a target. */
export function placeLabel(s: Pick<GitSummary, "where" | "cwd">, home: string | null): string {
  return s.where.kind === "remote" ? `${s.where.target}:${s.cwd}` : tildePath(s.cwd, home);
}

/** The repository root as a person reads it: "~/…" here, "target:/path" on a target. */
export function rootLabel(s: GitRepoSummary, home: string | null): string {
  return s.where.kind === "remote" ? `${s.where.target}:${s.root}` : tildePath(s.root, home);
}

// ---------------------------------------------------------------------------
// loading

const inflight = new Map<string, Promise<GitSummary>>();

/** GET /api/sessions/git. Callers asking about the same session at once (the pane and the info
    modal both open) share one request; `fresh` (the Refresh button) asks the server to skip its
    cache, and a plain read joins a fresh one already running rather than starting its own. */
export function loadGitSummary(path: string, fresh = false): Promise<GitSummary> {
  const key = `${fresh ? "fresh" : "any"}:${path}`;
  const running = inflight.get(key) ?? (fresh ? undefined : inflight.get(`fresh:${path}`));
  if (running) return running;
  const p = fetchGitSummary(path, fresh).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
