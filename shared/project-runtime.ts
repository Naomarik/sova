import type { DeployReview } from "./project-contract";

/**
 * The project's software registry as the page reads it (§app/project-runtime): `GET /api/projects/:pid/runtime`.
 * The registry is the host-local statechart `runtime/<p>`; each service's live state per instance is joined
 * from the engine's status at read time, never stored.
 */

export type RuntimeStanding = "unregistered" | "awaiting-approval" | "conforming" | "registered" | "stale" | "failed";
/** `waiting`: its last turn ended on open alignment questions, answered in its session (§app.project-runtime/onboard). */
export type RuntimePlaybookState = "idle" | "running" | "waiting" | "proposed";

export interface RuntimeMemory {
  peakBytes: number | null;
  steadyBytes: number | null;
}

/** One service's state in one running copy (an instance of a checkout, or the shared unit). */
export interface RuntimeServiceLive {
  instance: string;
  /** The checkout's branch, else its folder's name; "shared" for a shared service's unit. */
  label: string;
  state: string;
  rssBytes?: number;
}

export interface RuntimeService {
  name: string;
  kind: "process" | "static" | "container";
  scope: "checkout" | "shared";
  ports: { name: string; port: number }[];
  requires: string[];
  isolation?: { method: string; why: string };
  live: RuntimeServiceLive[];
  /** The memory the last unconfined conformance measured (the larger of its two instances). */
  memory?: RuntimeMemory;
}

/** A unit still running for a service that left the definition. */
export interface RuntimeOrphan {
  name: string;
  instance: string;
  label: string;
  state: string;
}

/** A declared data resource; `sensitive`: derived from production, so no copy of it is ever shared. */
export interface RuntimeData {
  name: string;
  kind: "dir" | "hook";
  sensitive: boolean;
}

export interface RuntimeProof {
  hash: string;
  suite: number;
  pass: boolean;
  confined: boolean;
  at: string;
  failed?: { check: string; detail: string };
  /** Each scratch instance's memory and its services' (§app.project-services/conform). */
  memory?: { instances: (RuntimeMemory & { label: string; services: (RuntimeMemory & { name: string })[] })[] };
}

export interface RuntimePlaybook {
  sessionId: string;
  /** The verb playbook the run is keyed by (§app.project-runtime/verb-playbooks), its title ("Project verbs"), which
      every sentence about the run names it by, and what its proposal approves. */
  playbookId: string;
  label: string;
  approves: "definition" | "deploy";
  /** While waiting: the open alignment questions its session asks the operator. */
  questions?: number;
  /** Its session file on this host, when known (the card links it). */
  path?: string;
  title?: string;
  why?: string;
  startedBy: "operator" | "overseer";
  startedAt: string;
  /** Set once the run ended: merged, removed, not-started, no-change. */
  result?: string;
  branch?: string;
  /** The branch its worktree merges into. */
  target?: string;
  /** The definition its branch proposes, while proposed. */
  branchHash?: string;
  branchApproved?: boolean;
  branchProof?: RuntimeProof | null;
  /** While the run is live: its session as the session list reads it now (§app.project-runtime/run-progress). */
  live?: RuntimeRunLive;
  /** While proposed: what its branch proposes, read by the host (§app.project-runtime/run-report). */
  review?: RuntimeRunReview;
}

export interface RuntimeRunLive {
  working: boolean;
  /** The session's outline "now" line, when it has one. */
  now?: string;
  /** Open alignment questions its session waits on the operator for. */
  questions?: number;
}

/** The definition on a proposed run's branch at its tip, and the newest confined conformance of its hash. */
export interface RuntimeRunReview {
  def: { state: "absent" | "invalid" | "present"; hash?: string; error?: string };
  services: (Omit<RuntimeService, "live" | "requires"> & { start: "up" | "on-demand" })[];
  data: RuntimeData[];
  /** null: no `share` (nothing is shared). */
  share: { endpoints: string[]; allow: boolean } | null;
  open: { endpoint: string; path: string } | null;
  proof: RuntimeProof | null;
  /** A deploy-setup run's recipe at the branch's tip, every step to tick before Approve & Merge (absent for a definition). */
  deploy?: DeployReview;
}

export interface RuntimeFeedLine {
  at: string;
  line: string;
}

export interface ProjectRuntimeView {
  projectId: string;
  standing: RuntimeStanding;
  playbookState: RuntimePlaybookState;
  def: { state: "absent" | "invalid" | "present"; hash?: string; error?: string } | null;
  commit: string | null;
  suite: number | null;
  services: RuntimeService[];
  orphans: RuntimeOrphan[];
  data: RuntimeData[];
  sources: string[];
  /** The changed source paths while stale. */
  drift: string[] | null;
  approved: { hash: string; at: string } | null;
  /** The unconfined proof that counts for main's hash. */
  proof: RuntimeProof | null;
  confinedProof: RuntimeProof | null;
  registered: { hash: string; suite: number; commit: string | null; at: string } | null;
  playbook: RuntimePlaybook | null;
  /** What the operator may do now, as the statecharts would take it. */
  can: {
    /** The hash Approve approves (main's, else the proposing branch's), or null. */
    approve: string | null;
    approveBranch?: string;
    onboard: boolean;
    /** Why Run Playbook is not offered (a run is live, archived, the host's refusal). */
    onboardWhy?: string;
  };
  /** The registry's feed, newest first. */
  feed: RuntimeFeedLine[];
}
