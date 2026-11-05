/**
 * The Setup chat (§app.project-setup/chat): one standing chat per project that investigates it, asks what it can't
 * find, draws the merge, release and deploy plan, trial-runs the proposed checks (merge.try) and proposes the whole
 * pipeline on its own branch, which the user lands (Land on a served project, Merge Branch otherwise).
 *
 * GET  /api/projects/:pid/setup                          -> SetupStatus
 * POST /api/projects/:pid/setup {fresh?, why?, model?, thinking?} -> SetupOpened (201; 409 with {error} when refused)
 */
import type { ReleaseSetupReview, RuntimeRunReview, MergeSetupReview } from "./project-runtime";
import type { DeployReview } from "./project-contract";

/** One check of a trial, from its run's steps (View Log: the run's id and the step's). */
export interface SetupTrialCheck {
  name: string;
  kind: "merge" | "release";
  command?: string;
  /** "not-run": a release check unchanged against the target's, left out of this trial. */
  state: "waiting" | "running" | "passed" | "failed" | "skipped" | "not-run";
  durationMs?: number;
  /** The trial run's id (mr_…): View Log opens #/projects/<id>/merge-queue/<run>. */
  run?: string;
  step?: string;
}

export interface SetupTrial {
  /** The run's id (mr_…). */
  id: string;
  commit: string;
  at: string;
  /** Passed: every check run passed. False while running too (see `state`). */
  pass: boolean;
  state: "running" | "passed" | "failed" | "machine" | "void";
  why?: string;
  checks: SetupTrialCheck[];
}

export interface SetupProposal {
  branch: string;
  target: string;
  /** The branch head the files were read at: Land and Merge Branch pin it. */
  commit: string;
  /** The project's merge queue serves it: Land; else Merge Branch. */
  served: boolean;
  /** What Merge Branch sends (POST /api/projects/:pid/runtime/merge {hash, commit}); absent: nothing valid to merge. */
  hash?: string;
  problem?: string;
  services: RuntimeRunReview["services"];
  merge: MergeSetupReview | null;
  release?: ReleaseSetupReview;
  deploy?: DeployReview;
  /** Every file the branch changes against its target at `commit` (from the merge base, renames as the new path),
      sorted; `setup` marks the ones the land gate counts (server/merge-queue/setup-branch.ts). Always sent; [] when none. */
  files: SetupProposalFile[];
  /** The newest trial of exactly `commit`; null: none yet. */
  trial: SetupTrial | null;
  /** Whether Land / Merge Branch is offered now, and why not. */
  land: { can: boolean; why?: string };
}

export interface SetupProposalFile {
  path: string;
  /** Added, modified, deleted or renamed. */
  status: "A" | "M" | "D" | "R";
  setup: boolean;
}

export interface SetupChatView {
  sessionId: string;
  path?: string;
  title: string;
  state: "idle" | "working" | "waiting" | "proposed";
  questions?: number;
  startedAt: string;
  /** The branch it works on, when it has one. */
  branch?: string;
  proposal: SetupProposal | null;
  setUp: SetupState;
}

/** What the target already has set up. */
export interface SetupState {
  merge: boolean;
  release: boolean;
  deploy: boolean;
}

/** An earlier setup chat of the project (its memory: the next chat's first message names them). */
export interface SetupHistoryItem {
  sessionId: string;
  path: string;
  startedAt: string;
  endedAt: string;
  why: "fresh" | "ended";
  branch?: string;
}

export interface SetupStatus {
  chat: SetupChatView | null;
  setUp: SetupState;
  can: { open: boolean; why?: string };
  history: SetupHistoryItem[];
}

export interface SetupOpened {
  sessionId: string;
  path: string;
  /** The existing chat was opened, nothing started. */
  reopened: boolean;
  worktree?: { path: string; branch: string };
}
