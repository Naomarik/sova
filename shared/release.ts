/**
 * Release's shared shapes: a project's release in progress, its steps, its history read from the project's numbered
 * tags, and the release playbook's manifest. Types and small pure helpers only (no imports but types, no fs): the
 * server, the verbs' results (shared/project-contract.ts `VerbResult.release`), the WS feed (shared/protocol.ts
 * `release`), the release playbook maker's check and the screens read them alike.
 *
 * Words: a RELEASE is one numbered version being cut or already cut; its STEPS are the playbook's (from the manifest
 * captured at start) plus Sova's own two, `checks` and `publish`; a CHANNEL is a moving tag (`stable`) Publish moves.
 */

import type { ReleaseDecl } from "./project-contract";
import type { PushState } from "./merge-queue";

// ---- the playbook's manifest (release.json in the project's release playbook folder) -------------

export const RELEASE_MANIFEST_FILE = "release.json";
/** The step ids Sova keeps for its own steps; a manifest never declares them. */
export const SOVA_STEP_IDS = ["checks", "publish", "withdraw", "abandon"] as const;
export const MANIFEST_STEPS_MAX = 30;
/** The step whose done report carries the release commit (facts commit=, branch=); a tag-only release has none. */
export const RELEASE_COMMIT_STEP = "commit";
/** The step whose done report carries the version (facts version=). */
export const RELEASE_VERSION_STEP = "version";
export const STEP_LABEL_MAX = 60;

/** Where a step runs in the plan: `prepare` before Sova's gating checks (the release commit is made here); `check` after
    the checks passed and the release commit landed on the frozen master, before Publish (a live try-out); `after`
    after Publish (a failure there never undoes it); `withdraw` after a Withdraw (the release page marked withdrawn). */
export const MANIFEST_PHASES = ["prepare", "check", "after", "withdraw"] as const;
export type ManifestPhase = (typeof MANIFEST_PHASES)[number];
export interface ManifestStep {
  id: string;
  label: string;
  phase: ManifestPhase;
  /** Ends `held` until the operator's Continue (judgement, such as a live try-out). */
  held?: true;
  /** Its done report must carry an artifact's facts (artifact=<path>, sha256, size): a local build kept outside the repository. */
  artifact?: true;
}
export interface ReleaseManifest {
  v: 1;
  steps: ManifestStep[];
}

export class ManifestError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ManifestError";
    this.path = path;
  }
}

const STEP_ID = /^[a-z][a-z0-9-]{0,30}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse release.json's text, strictly (an unknown key is refused). Throws ManifestError naming the first problem's path. */
export function parseReleaseManifest(text: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ManifestError("$", `not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObj(raw)) throw new ManifestError("$", "must be an object {v: 1, steps: [...]}");
  for (const k of Object.keys(raw)) if (k !== "v" && k !== "steps") throw new ManifestError(`$.${k}`, "unknown key");
  if (raw.v !== 1) throw new ManifestError("$.v", "must be 1");
  if (!Array.isArray(raw.steps)) throw new ManifestError("$.steps", "must be a list of steps {id, label, phase}");
  if (raw.steps.length > MANIFEST_STEPS_MAX) throw new ManifestError("$.steps", `at most ${MANIFEST_STEPS_MAX} steps`);
  const steps = raw.steps.map((s, i): ManifestStep => {
    const at = `$.steps[${i}]`;
    if (!isObj(s)) throw new ManifestError(at, "must be an object {id, label, phase}");
    for (const k of Object.keys(s)) if (!["id", "label", "phase", "held", "artifact"].includes(k)) throw new ManifestError(`${at}.${k}`, "unknown key");
    if (typeof s.id !== "string" || !STEP_ID.test(s.id)) throw new ManifestError(`${at}.id`, "a step id is lowercase letters, digits and hyphens, starting with a letter, at most 31 characters");
    if ((SOVA_STEP_IDS as readonly string[]).includes(s.id)) throw new ManifestError(`${at}.id`, `"${s.id}" is Sova's own step: the playbook never declares it`);
    if (typeof s.label !== "string" || !s.label.trim() || s.label.length > STEP_LABEL_MAX) throw new ManifestError(`${at}.label`, `must be a short label (1 to ${STEP_LABEL_MAX} characters)`);
    if (!(MANIFEST_PHASES as readonly unknown[]).includes(s.phase)) throw new ManifestError(`${at}.phase`, 'must be "prepare" (before the checks), "check" (after the checks, before Publish), "after" (after Publish) or "withdraw" (after a Withdraw)');
    if (s.held !== undefined && s.held !== true) throw new ManifestError(`${at}.held`, "must be true, or absent");
    if (s.artifact !== undefined && s.artifact !== true) throw new ManifestError(`${at}.artifact`, "must be true, or absent");
    return { id: s.id, label: s.label.trim(), phase: s.phase as ManifestPhase, ...(s.held === true ? { held: true as const } : {}), ...(s.artifact === true ? { artifact: true as const } : {}) };
  });
  if (new Set(steps.map((s) => s.id)).size !== steps.length) throw new ManifestError("$.steps", "step ids must be unique");
  // Listed in plan order: prepare, check, after, withdraw (Sova's checks and Publish sit between them).
  const rank = (p: ManifestPhase) => MANIFEST_PHASES.indexOf(p);
  for (let i = 1; i < steps.length; i++)
    if (rank(steps[i]!.phase) < rank(steps[i - 1]!.phase)) throw new ManifestError(`$.steps[${i}].phase`, "list the steps in plan order: prepare, then check, then after, then withdraw");
  // The release commit is reported by the step `commit`; its done report adds the release entry and the checks start,
  // so no prepare step can follow it.
  const ci = steps.findIndex((s) => s.id === RELEASE_COMMIT_STEP);
  if (ci >= 0 && steps[ci]!.phase !== "prepare") throw new ManifestError(`$.steps[${ci}].phase`, `the "${RELEASE_COMMIT_STEP}" step makes the release commit: it is a prepare step`);
  if (ci >= 0 && steps.slice(ci + 1).some((s) => s.phase === "prepare")) throw new ManifestError(`$.steps[${ci}]`, `the "${RELEASE_COMMIT_STEP}" step is the last prepare step: the checks start when it is done`);
  return { v: 1, steps };
}

// ---- a release and its steps ----------------------------------------------------------------------

/**
 * Where a release stands.
 * - `preparing`: its chat runs the prepare steps; the queue is frozen for it.
 * - `checking`: the queue runs its gating checks on the release entry (or, tag-only, on its commit).
 * - `ready`: every gate passed; waits for Publish (the operator's, or the release power's after its waiting period).
 * - `publishing`: Publish runs (tags, channels, the one atomic push); after-publish steps follow in `published`.
 * - `published`: the numbered tag exists and the channels point at it; after-steps may still run.
 * - `abandoned`: stopped before Publish; its release commit, if it landed, was reverted as a queue landing.
 * - `withdrawn`: was published; its channels moved back to the previous release. The numbered tag stays.
 */
export type ReleaseState = "preparing" | "checking" | "ready" | "publishing" | "published" | "abandoned" | "withdrawn";
export const RELEASE_OPEN: readonly ReleaseState[] = ["preparing", "checking", "ready", "publishing"];
export const isReleaseOpen = (s: ReleaseState): boolean => RELEASE_OPEN.includes(s);

export type StepState = "waiting" | "running" | "done" | "failed" | "skipped" | "held";
export const STEP_STATES: readonly StepState[] = ["waiting", "running", "done", "failed", "skipped", "held"];
/** The states the release chat may report (release.step); `waiting` is Sova's. */
export const REPORTED_STATES: readonly StepState[] = ["running", "done", "failed", "skipped", "held"];
export const STEP_SUMMARY_MAX = 300;
export const STEP_DETAIL_MAX = 20000;
export const NOTES_MAX = 20000;

/** What a step reports that Sova can check itself. `artifact`: a built file kept outside the repository (never committed). */
export interface ReleaseFacts {
  version?: string;
  commit?: string;
  branch?: string;
  url?: string;
  artifact?: ReleaseArtifact;
}
export interface ReleaseArtifact {
  path: string;
  sha256?: string;
  size?: number;
}
export const FACT_KEYS = ["version", "commit", "branch", "url", "artifact", "sha256", "size"] as const;

/** Parse release.step's `facts` list (`key=value` each) into facts; throws an Error naming the bad item. */
export function parseFacts(list: readonly string[]): ReleaseFacts {
  const out: ReleaseFacts = {};
  let art: Partial<ReleaseArtifact> = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i <= 0) throw new Error(`fact "${item}" is not key=value`);
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (!v) throw new Error(`fact "${k}" has no value`);
    if (!(FACT_KEYS as readonly string[]).includes(k)) throw new Error(`unknown fact "${k}" (one of ${FACT_KEYS.join(", ")})`);
    if (k === "artifact") art.path = v;
    else if (k === "sha256") {
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error("fact sha256 is 64 lowercase hex digits");
      art.sha256 = v;
    } else if (k === "size") {
      if (!/^\d{1,15}$/.test(v)) throw new Error("fact size is a whole number of bytes");
      art.size = Number(v);
    } else if (k === "commit") {
      if (!/^[0-9a-f]{7,64}$/.test(v)) throw new Error("fact commit is a commit sha");
      out.commit = v;
    } else if (k === "url") {
      if (!/^https?:\/\/\S+$/.test(v)) throw new Error("fact url is an http(s) URL");
      out.url = v;
    } else out[k as "version" | "branch"] = v;
  }
  if (art.sha256 !== undefined || art.size !== undefined) if (art.path === undefined) throw new Error("facts sha256 and size describe an artifact: give artifact=<path> too");
  if (art.path !== undefined) out.artifact = art as ReleaseArtifact;
  return out;
}

export type StepPhase = ManifestPhase | "sova";
export interface ReleaseStep {
  id: string;
  label: string;
  phase: StepPhase;
  held?: true;
  artifact?: true;
  state: StepState;
  /** The `checks` step: its newest merge run (mr_…), for the run page link. */
  run?: string;
  /** One line (at most STEP_SUMMARY_MAX). */
  summary?: string;
  /** In full (at most STEP_DETAIL_MAX); release.logs {step} reads it too. */
  detail?: string;
  facts?: ReleaseFacts;
  /** Who set the state last: the release chat, Sova itself (its checks, Publish, a fact), or the operator (Continue, Retry). */
  by?: "thread" | "sova" | "operator";
  at?: string;
  /** Sova's own check of the step's facts; where a report and a fact disagree, the fact wins (the state reads failed). */
  fact?: { ok: boolean; why: string };
}

export interface ReleaseRecord {
  id: string;
  project: string;
  state: ReleaseState;
  /** Once the release chat reported it (the version step's facts). */
  version: string | null;
  /** The numbered tag, once the version is known. */
  tag: string | null;
  channels: string[];
  /** The queue target's tip at start: the release is cut from it. */
  base: string;
  /** The release commit (commit: true, once reported), or `base` (tag-only). */
  commit: string | null;
  /** The release's merge queue entry (mq_…), once Sova added it. */
  entry: string | null;
  /** The release chat: its session id, its file (`path`, to prompt it), and the release worktree it works in. */
  thread: { session: string; path?: string; checkout?: string; branch?: string } | null;
  steps: ReleaseStep[];
  notes: string | null;
  artifacts: ReleaseArtifact[];
  startedAt: string;
  startedBy: "operator" | "power";
  lastReportAt: string | null;
  publish?: { at: string; by: "operator" | "power"; pushed: PushState; channelsFrom: Record<string, string | null>; error?: string };
  /** The release power's waiting period before its Publish (Cancel in Needs you). */
  power?: { heldUntil: string; act: string };
  abandoned?: { at: string; why: string; revert: string | null };
  withdrawn?: { at: string; why: string; channelsTo: Record<string, string | null> };
  manifest: ReleaseManifest;
  settings: ReleaseDecl;
  /** The operator's Release Note this release's start sent its chat (a copy; the saved note is cleared then). */
  note?: string;
  /** The assistant's or overseer's pending ask this start consumed and passed to its chat as their context. */
  asked?: { by: string; why: string };
}

/** The operator's Release Note: at most this many characters. */
export const RELEASE_NOTE_MAX = 4000;

/** The full plan from a manifest: prepare steps, Sova's gating checks, check steps, Publish, after-publish steps, then
    the withdraw steps (they stay `waiting` unless the release is withdrawn). */
export function planOf(m: ReleaseManifest): ReleaseStep[] {
  const own = (s: ManifestStep): ReleaseStep => ({ id: s.id, label: s.label, phase: s.phase, ...(s.held ? { held: true as const } : {}), ...(s.artifact ? { artifact: true as const } : {}), state: "waiting" });
  const of = (p: ManifestPhase) => m.steps.filter((s) => s.phase === p).map(own);
  return [
    ...of("prepare"),
    { id: "checks", label: "Gating checks", phase: "sova", state: "waiting" },
    ...of("check"),
    { id: "publish", label: "Publish", phase: "sova", state: "waiting" },
    ...of("after"),
    ...of("withdraw"),
  ];
}

// ---- the view ---------------------------------------------------------------------------------------

export interface ReleaseHistoryItem {
  tag: string;
  version: string;
  sha: string;
  date: string;
  /** The changelog section when the project has one, else the tag's annotation body. */
  notes: string | null;
  /** The channels pointing at it now. */
  channels: string[];
  withdrawn?: { at: string; why: string };
  /** The release record's id, when Sova made it. */
  record?: string;
  /** Deploy targets whose last verified deploy is this commit. */
  deployedTo: string[];
}

export interface ReleaseGates {
  checksPassed: boolean;
  stepsDone: boolean;
  notes: boolean;
  /** Why Publish isn't offered yet, in plain words (empty when it is). */
  why: string[];
}

export interface ReleaseView {
  project: string;
  /** Whether the project's settings declare `release` (q13: off until initialized). */
  initialized: boolean;
  settings: ReleaseDecl | null;
  /** The settings or the manifest don't parse: what's wrong. */
  problem?: string;
  open: ReleaseRecord | null;
  /** The newest record that is not open (published, abandoned or withdrawn): its after or withdraw steps may still run. */
  last: ReleaseRecord | null;
  /** The project's deploy targets, for Plan Deploy of a release. */
  deployTargets: string[];
  /** Newest first, from the tags matching the pattern. */
  history: ReleaseHistoryItem[];
  /** The newest numbered tag not withdrawn. */
  latest: string | null;
  /** Commits on the target since `latest` (null: no release yet). */
  landingsSince: number | null;
  target: string;
  /** Whether Publish will push (an origin and merge.push not false). */
  remote: boolean;
  gates: ReleaseGates | null;
  /** Set while the queue is frozen and the release chat has been quiet past quietMin. */
  quiet: { minutes: number } | null;
  /** The operator's saved Release Note, for the next start (release.note); null when none. */
  note: { text: string; at: string } | null;
}

export interface ReleaseReport {
  view?: ReleaseView;
  release?: ReleaseRecord;
  /** release.logs: a step's detail or the checks run's log lines (newest last). */
  lines?: string[];
}

/** On the session feed (shared/protocol.ts SessionFeedMessage): a project's release view changed. Never on connect. */
export interface ReleaseFeed {
  type: "release";
  project: string;
  view: ReleaseView;
}

/** The record's id shape. */
export const RELEASE_ID = /^rl_[0-9a-z]{6,32}$/;
