import { execFile } from "node:child_process";
import { join } from "node:path";
import type { SessionSummary } from "../shared/protocol";
import { LANDING_FILE_NAME, recordGoAhead } from "../pi-config/extensions/worktrees/landing.ts";
import { stateRoot } from "./state-root";

/**
 * Go on a Ready to land row of an Overseer card the user applied (§app.overseer/card-land): the user's go-ahead to
 * land that branch at the exact commit the row showed, recorded in `landing.json` as `by: "overseer-card"`
 * (§chat.worktrees/landing-answers), then the merge captain woken through the merge-ready trigger
 * (§chat.schedules/merge-ready, "Go-ahead on the Overseer's card: …").
 *
 * Only what the user saw lands: when the branch's head is no longer that commit, or the branch is no longer Ready to
 * land, nothing is written and no one is woken; the refusal says why, for the Overseer's reply. Whether the click
 * was the user's (the card gate, §app.overseer/org-people-facing) is the caller's to check before calling this.
 */

export interface CardLandInput {
  /** The session whose worktree the row is for, by id. */
  session: string;
  branch: string;
  /** The full head sha the row showed. */
  head: string;
}

export type CardLandResult = { ok: true; branch: string; commit: string; session: string; at: string } | { ok: false; reason: string };

export interface CardLandDeps {
  /** Path of a session by id. */
  pathOf(id: string): Promise<string | undefined>;
  summary(path: string): Promise<SessionSummary | null>;
  /** The session's readiness as it reads once its turn ends (merge-readiness idleReadinessOf). */
  readiness(s: SessionSummary): Promise<SessionSummary["readiness"]>;
  /** The branch's current head sha, read in the given worktree; undefined when it can't be read. */
  branchHead(branch: string, cwd: string): Promise<string | undefined>;
  record(rec: { branch: string; commit: string; session: string; at: string }): void;
  /** Wake the merge captain now (the schedule keeper's tick, which reads the record). */
  wake(): void;
  now(): Date;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const gitBranchHead = (branch: string, cwd: string): Promise<string | undefined> =>
  new Promise((done) =>
    execFile("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd, timeout: 5_000 }, (err, out) => done(err ? undefined : String(out).trim() || undefined)),
  );

const defaults: CardLandDeps = {
  async pathOf(id) {
    return (await import("./sessions-index")).indexedSessionPaths().get(id);
  },
  async summary(path) {
    return (await import("./sessions-index")).getSessionSummary(path);
  },
  async readiness(s) {
    return (await import("./merge-readiness")).idleReadinessOf(s);
  },
  branchHead: gitBranchHead,
  record(rec) {
    recordGoAhead({ ...rec, by: "overseer-card" }, join(stateRoot(), LANDING_FILE_NAME));
  },
  wake() {
    void import("./schedules")
      .then(({ scheduleKeeper }) => scheduleKeeper()?.tick())
      .catch((err) => console.warn("[overseer-land] wake failed:", err instanceof Error ? err.message : String(err)));
  },
  now: () => new Date(),
};

const short = (sha: string) => sha.slice(0, 7);

/**
 * Record the user's go-ahead to land `branch` at `head` from an Overseer card's Go, only if the branch's head is
 * still `head` and it is still Ready to land at it, then wake the captain. Never writes otherwise.
 */
export async function recordCardGoAhead(input: CardLandInput, over: Partial<CardLandDeps> = {}): Promise<CardLandResult> {
  const d: CardLandDeps = { ...defaults, ...over };
  const { session, branch, head } = input;
  const refuse = (reason: string): CardLandResult => ({ ok: false, reason });
  if (!branch || typeof head !== "string" || !SHA.test(head)) return refuse(`The row names no branch and full commit to land${branch ? ` for ${branch}` : ""}: nothing was recorded.`);
  const path = await d.pathOf(session).catch(() => undefined);
  const s = path ? await d.summary(path).catch(() => null) : null;
  if (!s) return refuse(`${branch}'s session can't be found any more: nothing was recorded.`);
  if (s.archived) return refuse(`${branch} is no longer ready to land: its session is archived.`);
  const readiness = await d.readiness(s).catch(() => undefined);
  const tree = readiness?.trees.find((t) => t.branch === branch);
  if (!tree) return refuse(`${branch} is no longer ready to land: its session no longer tracks a worktree on it.`);
  // Read after readiness, the slow part, so the head checked is the newest one before the write.
  const now = await d.branchHead(branch, tree.path).catch(() => undefined);
  if (!now) return refuse(`Sova can't read ${branch}'s current commit, so it can't tell it is still the one you saw: nothing was recorded.`);
  if (now !== head) return refuse(`${branch} has a newer commit (${short(now)}) than the one you saw (${short(head)}).`);
  if (tree.landing?.state !== "ready" || tree.landing.commit !== head) {
    const why = tree.landing?.state === "specs" ? "its spec drafts aren't promoted" : (tree.why ?? tree.reason);
    return refuse(`${branch} is no longer ready to land${why ? `: ${why}` : ""}.`);
  }
  if (s.busy || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0) return refuse(`${branch} is no longer ready to land: its session is working right now.`);
  const at = d.now().toISOString();
  d.record({ branch, commit: head, session: s.id, at });
  d.wake();
  return { ok: true, branch, commit: head, session: s.id, at };
}
