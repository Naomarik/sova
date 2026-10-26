import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReadinessState, WorktreeLanding } from "../shared/protocol";
import { isExcluded, readDecisionSettings } from "./decide-settings";
import { stateRoot } from "./state-root";
import { latestOutcome } from "./turn-outcomes";

/**
 * Ready to land (§chat.worktrees/ready-to-land): a worktree's head commit whose work is finished, kept
 * once it is so for that commit. The pure rule is `landingLive` (the code-only conditions, on the tree's readiness) plus
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
  /** The uncommitted entries git lists (a folder ends in "/"), when known. */
  dirtyFiles?: string[];
  /** The branch it merges into. */
  base?: string;
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

/** The live conditions (§chat.worktrees/ready-to-land): the tree's readiness is ready or waiting (a commit ahead,
    no conflict, no temporary commit, the newest check not failing, no open question, nothing running), with
    a head and no uncommitted file at all. Pure. */
export const landingLive = (t: LandingTree, state: ReadinessState): boolean =>
  !!t.head && !t.dirty && !t.dirtyCount && (state === "ready" || state === "waiting-approval");

/** One thing that keeps a finished branch from Ready to land, as Sova's note counts it, and what fixes it. */
export interface LandingBlocker {
  kind: "uncommitted" | "drafts" | "conflicts" | "temp" | "check";
  /** "1 uncommitted folder", "11 spec drafts to make official". */
  text: string;
  /** What the session does about it. */
  fix: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What still blocks a finished branch's landing card (§chat.worktrees/ready-to-land), each counted, for the
 * things the session can fix itself: uncommitted files, unpromoted spec drafts, conflicts with its base, a
 * temporary commit, a failing check. undefined when the rule doesn't ask (nothing to land, merged, a turn
 * running, an open question: none of those is the session's to fix now). Pure.
 */
export function landingBlockers(t: LandingTree, s: LandingSession, drafts: readonly string[] | undefined): LandingBlocker[] | undefined {
  if (!t.readable || t.merged || !t.head || !t.ahead || s.running || s.openQuestions > 0) return undefined;
  const out: LandingBlocker[] = [];
  const dirty = t.dirtyCount ?? (t.dirty ? 1 : 0);
  if (dirty > 0) {
    const files = t.dirtyFiles?.length === dirty ? t.dirtyFiles : undefined;
    const folders = files?.filter((f) => f.endsWith("/")).length ?? 0;
    const what = files && folders === dirty ? plural(dirty, "uncommitted folder") : files && folders === 0 ? plural(dirty, "uncommitted file") : `${dirty} uncommitted ${dirty === 1 ? "file or folder" : "files and folders"}`;
    out.push({ kind: "uncommitted", text: what, fix: "commit or remove what is uncommitted" });
  }
  if (drafts?.length) out.push({ kind: "drafts", text: `${plural(drafts.length, "spec draft")} to make official`, fix: "promote the spec drafts on this branch and commit them (the user's go-ahead to land covers it: don't ask them)" });
  if (t.conflicts) out.push({ kind: "conflicts", text: `conflicts with ${t.base ?? "its base"} in ${plural(t.conflicts, "file")}`, fix: `merge ${t.base ?? "its base"} in and resolve them` });
  if (t.tempCommit) out.push({ kind: "temp", text: `a temporary commit ("${t.tempCommit.slice(0, 60)}")`, fix: "reword or squash the temporary commit" });
  if (s.lastCheck && !s.lastCheck.ok) out.push({ kind: "check", text: "a failing check run", fix: "fix what the check reports and run it again" });
  return out;
}

/** The message Sova sends a finished session whose branch can't be offered for landing yet (§chat.worktrees/ready-to-land).
    It names what blocks the landing and never mentions Land It or a card: there is no card to press. Once nothing
    blocks it, the user's typed go-ahead lands it, which the session records with `worktree land`. */
export function blockedNoteText(branch: string, commit: string, blockers: readonly LandingBlocker[]): string {
  const list = blockers.map((b) => b.text).join(", ");
  const fixes = blockers.map((b) => b.fix).join("; ");
  return `Sova: ${branch} is finished at ${commit.slice(0, 7)}, but it can't be queued to land yet: ${list}. On ${branch}, ${fixes}. Once nothing blocks it, the user's go-ahead lands it: when they type "land it" in this chat, record it with the worktree tool's land action.`;
}

/** The line a session answers with when it can't land its specs. */
const SPECS_WHY_RE = /^\s*(?:[-*]\s*)?\**Can(?:'|’)t land specs:?\**:?\s*(.+?)\s*$/im;
export const specsWhyOf = (reply: string | undefined): string | undefined => {
  const m = reply ? SPECS_WHY_RE.exec(reply) : null;
  const why = m?.[1]?.replace(/[.\s]+$/, "");
  return why ? why.slice(0, 300) : undefined;
};

/** A tree's landing, or undefined. `held`: the store says this head was Ready to land already. Pure. */
export function landingOf(t: LandingTree, state: ReadinessState, finished: Finished, held: boolean, drafts: readonly string[] | undefined, specsWhy?: string): WorktreeLanding | undefined {
  if (!landingLive(t, state)) return undefined;
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
  /** Per session and tree, the head commit Sova last told the session what blocks its landing card at. */
  told?: Record<string, string>;
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
    const told: Record<string, string> = {};
    const rawTold = (raw as { told?: unknown }).told;
    if (rawTold && typeof rawTold === "object") for (const [k, v] of Object.entries(rawTold as Record<string, unknown>)) if (typeof v === "string" && SHA.test(v)) told[k] = v;
    return { v: 1, trees, ...(Object.keys(told).length ? { told } : {}) };
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
  /** Mark that Sova told the session what blocks its landing card at this commit; false when it already had. */
  tell(sessionId: string, path: string, commit: string): boolean;
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
    tell(sid, path, commit) {
      const d = load(file());
      const k = keyOf(sid, path);
      if (d.told?.[k] === commit) return false;
      // Kept for the newest 500 trees: a told commit only ever stops a repeat.
      const told = Object.entries({ ...(d.told ?? {}), [k]: commit }).slice(-500);
      d.told = Object.fromEntries(told);
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
