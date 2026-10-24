import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeLanding } from "../shared/protocol";
import { isExcluded, readDecisionSettings } from "./decide-settings";
import { stateRoot } from "./state-root";
import { latestOutcome } from "./turn-outcomes";

/**
 * Ready to land (§chat.worktrees/ready-to-land): a worktree's head commit whose work is finished, kept
 * once it is so for that commit. The pure rule is `landingLive` (the code-only conditions) plus
 * "finished" (`finishedOf`, the turn card's outcome; the code-only conditions alone when Decisions'
 * attention signals are off). The store, `<state root>/ready-to-land.json`, keeps per session and tree
 * the commit that was Ready to land and whether Sova told the session to land its specs for it:
 * a later reply that asks nothing, or says something else, never takes it back; a moved head does.
 * Atomic tmp+rename; a damaged file reads as empty.
 */

/** The tree's facts the rule reads (merge-readiness TreeFacts, as far as it needs). */
export interface LandingTree {
  readable: boolean;
  merged?: boolean;
  dirty?: boolean;
  dirtyCount?: number;
  ahead?: number;
  conflicts?: number;
  tempCommit?: string;
  /** The full head sha. */
  head?: string;
}

/** The session's facts the rule reads. */
export interface LandingSession {
  running: boolean;
  openQuestions: number;
  lastCheck?: { at: number; ok: boolean };
}

/** "yes": the latest turn outcome says the work is done; "no": it doesn't, or there is none for the
    last reply; "off": no outcome is ever recorded for this session (attention off, or its folder
    excluded), so the code-only conditions decide alone. */
export type Finished = "yes" | "no" | "off";

/** The live conditions (§chat.worktrees/ready-to-land): no uncommitted file at all, a commit ahead,
    no conflict, no temporary commit, the newest check not failing, no open question, nothing running. Pure. */
export function landingLive(t: LandingTree, s: LandingSession): boolean {
  if (!t.readable || t.merged || !t.head) return false;
  if (t.dirty || (t.dirtyCount ?? 0) > 0) return false;
  if (!t.ahead || t.ahead < 1) return false;
  if (t.conflicts || t.tempCommit) return false;
  if (s.lastCheck && !s.lastCheck.ok) return false;
  return s.openQuestions === 0 && !s.running;
}

/** The line a session answers with when it can't land its specs. */
const SPECS_WHY_RE = /^\s*(?:[-*]\s*)?\**Can(?:'|’)t land specs:?\**:?\s*(.+?)\s*$/im;
export const specsWhyOf = (reply: string | undefined): string | undefined => {
  const m = reply ? SPECS_WHY_RE.exec(reply) : null;
  const why = m?.[1]?.replace(/[.\s]+$/, "");
  return why ? why.slice(0, 300) : undefined;
};

/** A tree's landing, or undefined. `held`: the store says this head was Ready to land already. Pure. */
export function landingOf(t: LandingTree, s: LandingSession, finished: Finished, held: boolean, drafts: readonly string[] | undefined, specsWhy?: string): WorktreeLanding | undefined {
  if (!landingLive(t, s)) return undefined;
  if (!held && finished === "no") return undefined;
  const left = drafts?.length ? [...drafts] : undefined;
  return { state: left ? "specs" : "ready", commit: t.head!, ...(left ? { drafts: left } : {}), ...(left && specsWhy ? { specsWhy } : {}) };
}

/** The reason line of a landing: "Ready to land · 3 commits ahead", "Landing specs · 2 drafts". */
export function landingReason(l: WorktreeLanding, ahead?: number): string {
  if (l.state === "ready") return ["Ready to land", ...(ahead ? [`${ahead} commit${ahead === 1 ? "" : "s"} ahead`] : [])].join(" · ");
  const n = l.drafts?.length ?? 0;
  return ["Landing specs", `${n} draft${n === 1 ? "" : "s"}`, ...(l.specsWhy ? [`can't land them: ${l.specsWhy}`] : [])].join(" · ");
}

/** Whether a session's turns get an outcome at all, and the last reply's: the default `finished`. */
export function finishedOf(sessionId: string, cwd: string, lastReplyId: string | undefined): Finished {
  const settings = readDecisionSettings();
  if (!settings.features.attention || !settings.jev.enabled || isExcluded(settings, cwd)) return "off";
  if (!lastReplyId) return "no";
  const rec = latestOutcome(sessionId);
  return rec && rec.turnId === lastReplyId && rec.outcome === "did-what-was-asked" ? "yes" : "no";
}

// ---- the store ------------------------------------------------------------------------------------

export interface HeldLanding {
  branch: string;
  commit: string;
  /** ms epoch it was first Ready to land. */
  at: number;
  /** Sova told the session to land its specs for this commit. */
  nudged?: true;
}

interface StoreFile {
  v: 1;
  trees: Record<string, HeldLanding>;
}

export const readyToLandFile = () => join(stateRoot(), "ready-to-land.json");
const keyOf = (sessionId: string, path: string) => `${sessionId}\n${path}`;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function load(file: string): StoreFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; trees?: unknown };
    if (raw?.v !== 1 || !raw.trees || typeof raw.trees !== "object") return { v: 1, trees: {} };
    const trees: Record<string, HeldLanding> = {};
    for (const [k, v] of Object.entries(raw.trees as Record<string, Partial<HeldLanding>>)) {
      if (typeof v?.branch !== "string" || typeof v.commit !== "string" || !SHA.test(v.commit) || typeof v.at !== "number") continue;
      trees[k] = { branch: v.branch, commit: v.commit, at: v.at, ...(v.nudged === true ? { nudged: true as const } : {}) };
    }
    return { v: 1, trees };
  } catch {
    return { v: 1, trees: {} };
  }
}

function save(file: string, data: StoreFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[ready-to-land] write failed:", err instanceof Error ? err.message : String(err));
  }
}

export interface LandingStore {
  /** The commit held Ready to land for this session's tree, if any. */
  held(sessionId: string, path: string): HeldLanding | undefined;
  /** Keep this commit Ready to land (a different commit replaces it). */
  hold(sessionId: string, path: string, rec: Omit<HeldLanding, "nudged">): void;
  /** Forget it: the head moved, or the branch landed. */
  drop(sessionId: string, path: string): void;
  /** Mark that Sova told the session to land its specs for this commit; false when it already had. */
  nudge(sessionId: string, path: string, commit: string): boolean;
}

/** The file store (tests pass their own file). */
export function fileLandingStore(file: () => string = readyToLandFile): LandingStore {
  return {
    held: (sid, path) => load(file()).trees[keyOf(sid, path)],
    hold(sid, path, rec) {
      const d = load(file());
      const k = keyOf(sid, path);
      if (d.trees[k]?.commit === rec.commit) return;
      d.trees[k] = { branch: rec.branch, commit: rec.commit, at: rec.at };
      save(file(), d);
    },
    drop(sid, path) {
      const d = load(file());
      const k = keyOf(sid, path);
      if (!d.trees[k]) return;
      delete d.trees[k];
      save(file(), d);
    },
    nudge(sid, path, commit) {
      const d = load(file());
      const rec = d.trees[keyOf(sid, path)];
      if (!rec || rec.commit !== commit || rec.nudged) return false;
      rec.nudged = true;
      save(file(), d);
      return true;
    },
  };
}

/** The message Sova sends a session whose finished branch still holds unpromoted spec drafts. */
export function specsNudgeText(branch: string, commit: string, drafts: readonly string[]): string {
  return (
    `Sova: ${branch} is finished at ${commit.slice(0, 7)}, but its spec drafts aren't promoted yet: ${drafts.join(", ")}. ` +
    `Make your specs official on ${branch}: promote those drafts on this branch and commit them (the user's go-ahead to land covers it: don't ask them). ` +
    "If you can't, answer with one line: Can't land specs: <why>."
  );
}
