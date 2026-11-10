/**
 * The change a reviewer reads, written for it before it starts: it has no shell, so Sova runs the git it would have
 * run. Two files in the run's folder: `change.txt` (the commit log and the changed paths, with their status) and
 * `change.diff` (the whole diff, `git diff <base>...<commit>`, written by git straight to the file, never held in
 * memory). Removed when the review ends (removeReviewChange).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitProc } from "./copy";

export interface ReviewChange {
  /** The commit log and the changed paths. */
  summary: string;
  /** The whole diff. */
  diff: string;
}

/** The folder a run's review change goes in. */
export const reviewChangeDir = (runDir: string): string => join(runDir, "review");

/** Write the change between `base` and `commit` (in `copy`) for the reviewer. Throws what git refuses. */
export async function writeReviewChange(copy: string, base: string, commit: string, dir: string, signal?: AbortSignal): Promise<ReviewChange> {
  mkdirSync(dir, { recursive: true });
  const summary = join(dir, "change.txt");
  const diff = join(dir, "change.diff");
  const opts = signal ? { signal } : {};
  const log = await gitProc(copy, ["log", "--no-color", "--format=%h %s%n%n%b", `${base}..${commit}`], opts);
  if (log.code !== 0) throw new Error(`git log failed: ${log.out.trim().split("\n")[0] ?? ""}`);
  const names = await gitProc(copy, ["diff", "--no-color", "--name-status", `${base}...${commit}`], opts);
  if (names.code !== 0) throw new Error(`git diff --name-status failed: ${names.out.trim().split("\n")[0] ?? ""}`);
  const d = await gitProc(copy, ["diff", "--no-color", "--no-ext-diff", `--output=${diff}`, `${base}...${commit}`], opts);
  if (d.code !== 0) throw new Error(`git diff failed: ${d.out.trim().split("\n")[0] ?? ""}`);
  writeFileSync(
    summary,
    [
      `The change under review: ${commit}, against ${base} (git diff ${base}...${commit}).`,
      `The whole diff: ${diff}`,
      "",
      `## Commits (git log ${base}..${commit})`,
      "",
      log.out.trim() || "(none)",
      "",
      "## Changed paths (status, path)",
      "",
      names.out.trim() || "(none)",
      "",
    ].join("\n"),
  );
  return { summary, diff };
}

/** Remove a review's change files. Never throws. */
export function removeReviewChange(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
