import type { Git } from "./git";

/**
 * How far the code on disk has moved past what this server runs, for Restart Sova's confirm ("It
 * loads newer code: 3 new commits and uncommitted changes since it started"). The same notion of a
 * build as a chat's "On older code" (server/chat-runtime/generations.ts `buildId`): the commit when
 * the tree is clean, else the commit and a digest of its changes. So `dirty` is changes that weren't
 * there, or were different, when the server started; changes it already started with don't count.
 */
export interface DiskAhead {
  commits: number;
  dirty: boolean;
}

export interface DiskAheadProbe {
  git: Git;
  /** The commit the server started on (`GET /api/health`'s head). */
  startedHead: string | null;
  /** The build the server started with, or null when nobody recorded it. */
  startBuild: string | null;
  /** The build of the checkout now (`buildId`). */
  buildNow(): Promise<string>;
}

/** null when nothing is newer, or when git can't say. */
export async function diskAheadOf(p: DiskAheadProbe): Promise<DiskAhead | null> {
  const now = await p.buildNow().catch(() => "unknown");
  if (now === "unknown") return null;
  if (p.startBuild !== null && now === p.startBuild) return null;
  let commits = 0;
  if (p.startedHead) {
    const r = await p.git(["rev-list", "--count", `${p.startedHead}..HEAD`]);
    if (r.code !== 0) return null;
    commits = Number(r.stdout.trim()) || 0;
  }
  // `<commit>+<digest>`: the tree has changes of its own; they are new unless the start had these same ones.
  const dirty = now.includes("+") && now !== p.startBuild;
  return commits > 0 || dirty ? { commits, dirty } : null;
}
