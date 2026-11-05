// A project's Setup chat as the pages draw it: the one standing chat per project that investigates it, asks what it
// can't find, draws the merge, release and deploy plan, trial-runs the proposed checks on its own branch, and proposes
// the whole pipeline there for you to land. The words each surface says, and whether Land is offered. Pure.
import type { DeployReview } from "../../shared/project-contract";
import type { ReleaseSetupReview, RuntimeRunReview } from "../../shared/project-runtime";

// The wire shapes the Setup chat's routes answer with. They move to shared/ with the server's routes; until then
// they are the frontend's reading of GET /api/projects/:id/setup.

/** One proposed check's result in a trial (merge.try) of the setup branch. */
export interface SetupTrialCheck {
  name: string;
  kind: "merge" | "release";
  command?: string;
  /** skipped: a release-only check unchanged against the target, not run. */
  state: "waiting" | "running" | "passed" | "failed" | "skipped";
  durationMs?: number;
  /** The trial's run (mr_…): View Log opens it. */
  run?: string;
}
export interface SetupTrial {
  run: string;
  /** The commit tried: the result counts for it alone. */
  commit: string;
  at: string;
  pass: boolean;
  checks: SetupTrialCheck[];
}
/** What the setup branch proposes, read by Sova from its files at `commit` (its head), never from the chat's words. */
export interface SetupProposal {
  branch: string;
  target: string;
  commit: string;
  /** The proposal's own hash: Merge Branch merges the branch that proposes it (§app.project-runtime/merge). */
  hash?: string;
  /** The merge queue serves the project: Land; else Merge Branch. */
  served: boolean;
  /** The branch's definition doesn't read. */
  problem?: string;
  services: RuntimeRunReview["services"];
  merge: { checks: { name: string; command: string; timeoutMin?: number; optional?: boolean }[] } | null;
  release?: ReleaseSetupReview;
  deploy?: DeployReview;
  /** The files the branch changes against the target. */
  files?: string[];
  /** The newest trial of this branch (any commit of it). */
  trial: SetupTrial | null;
  /** A refusal the host adds beyond the trial (the branch conflicts, it moved). */
  land?: { can: boolean; why?: string };
}
/** The project's one standing Setup chat. */
export interface SetupChatView {
  sessionId: string;
  path?: string;
  title: string;
  state: "idle" | "working" | "waiting" | "proposed";
  questions?: number;
  startedAt: string;
  proposal: SetupProposal | null;
}
/** GET /api/projects/:id/setup. */
export interface SetupRead {
  chat: SetupChatView | null;
  setUp: { merge: boolean; release: boolean; deploy: boolean };
  /** Whether Set Up with a Chat / Change Setup may open the chat now, and why not (archived, folder elsewhere, no model). */
  can: { open: boolean; why?: string };
}

/** The surfaces that offer the Setup chat. */
export type SetupSurface = "merge-queue" | "releases" | "deploy" | "settings";

/** The button: Set Up with a Chat until the part is set up, then Change Setup (both open the same chat). */
export const setupButtonLabel = (setUp: boolean): string => (setUp ? "Change Setup" : "Set Up with a Chat");

/**
 * What a surface says while its part isn't set up: what the part does, then what setting up changes, in plain
 * sentences; `target` is the branch everything lands on.
 */
export function notSetUpWords(surface: SetupSurface, target: string): { title: string; body: string } {
  switch (surface) {
    case "merge-queue":
    case "settings":
      return {
        title: "No merge queue settings are set up for this project",
        body:
          `Until they are, its chats merge branches into ${target} themselves when you ask. ` +
          `Every branch you approve is merged onto ${target} in a separate copy and checked there; ${target} then moves to exactly that commit. ` +
          "Once it is set up, branches land here only through the queue.",
      };
    case "releases":
      return {
        title: "Releases aren't set up for this project",
        body:
          `A release tags ${target} with a version, writes its notes and runs each step you agree on; until releases are set up, nothing here starts one. ` +
          "The Setup chat reads the project, asks how it releases, then proposes a release playbook and a release section of .sova/project.json on a branch to land, with the merge queue and deploys.",
      };
    case "deploy":
      return {
        title: "Main declares no deploy yet.",
        body: "A deploy ships a commit to a place you name, verifies it there, and can roll it back. The Setup chat asks how each target ships and proposes it on a branch; it runs nothing.",
      };
  }
}

/** The chat's state in a few words, for the line beside its button (null: nothing worth a line). */
export function chatLine(c: SetupChatView | null | undefined): { word: string; tone: "accent" | "warn" | "neutral"; live?: true } | null {
  if (!c) return null;
  if (c.state === "waiting") return { word: c.questions ? `${c.questions} ${c.questions === 1 ? "question" : "questions"} for you` : "Waiting on you", tone: "warn" };
  if (c.state === "working") return { word: "Working", tone: "accent", live: true };
  if (c.state === "proposed") return { word: "Proposed", tone: "warn" };
  return null;
}

/** A check's trial result, as its chip says it. */
export function trialChip(c: SetupTrialCheck): { word: string; tone: "success" | "error" | "accent" | "neutral"; live?: true } {
  if (c.state === "passed") return { word: "Passed", tone: "success" };
  if (c.state === "failed") return { word: "Failed", tone: "error" };
  if (c.state === "running") return { word: "Running", tone: "accent", live: true };
  if (c.state === "skipped") return { word: "Not run (unchanged)", tone: "neutral" };
  return { word: "Waiting", tone: "neutral" };
}

/** A duration in the trial's words: "48s", "3m 12s". */
export function durationWords(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The trial in one line: "Trial of {sha}: passed", failed or running; null before the first one. */
export function trialLine(p: Pick<SetupProposal, "trial">): string | null {
  const t = p.trial;
  if (!t) return null;
  const sha = t.commit.slice(0, 7);
  if (t.checks.some((c) => c.state === "running" || c.state === "waiting")) return `Trial of ${sha}: running`;
  return `Trial of ${sha}: ${t.pass ? "passed" : "failed"}`;
}

/** The newest trial tried an older commit than the branch's head. */
export const trialStale = (p: Pick<SetupProposal, "trial" | "commit">): boolean => !!p.trial && p.trial.commit !== p.commit;

/**
 * What the proposal's main button is now, and the line beside it. A setup branch can be landed (a served project) or
 * merged (one the queue doesn't serve) only once a trial of its exact head passed: the queue checks a branch with the
 * target's checks, not the branch's own. Until then Run Trial stands in its place.
 */
export function landState(p: SetupProposal): { action: "land" | "merge" | "trial" | "wait"; can: boolean; why?: string } {
  const merge = p.served ? "land" : "merge";
  const sha = p.commit.slice(0, 7);
  if (p.problem) return { action: merge, can: false, why: `The setup on its branch doesn't read: ${p.problem.replace(/[.]\s*$/, "")}.` };
  const t = p.trial;
  const head = t && t.commit === p.commit ? t : null;
  if (head && head.checks.some((c) => c.state === "running" || c.state === "waiting")) return { action: "wait", can: false, why: `Trial of ${sha}: running` };
  if (!head || !head.pass) return { action: "trial", can: true, why: `Run a trial of ${sha} first: it lands only once its own checks pass.` };
  if (p.land && !p.land.can) return { action: merge, can: false, why: p.land.why ?? "Not ready to land." };
  return { action: merge, can: true };
}

/** What a step of the release is marked as, in the drawing's words. */
export const releaseStepMark = (s: { phase: string; held?: true }): string =>
  s.held ? "Held for you" : s.phase === "after" ? "After Publish" : s.phase === "withdraw" ? "After a Withdraw" : s.phase === "check" ? "Before Publish" : "Sova";
