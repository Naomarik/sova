/**
 * Wire types for the project overseer (§app/project-overseer): one special session per org
 * project that watches its decisions, infers gaps against the roster and, at the autonomy level
 * the operator grants, starts gathering (baton) sessions, reconciles, promotes and starts coding
 * sessions. Imported by the server and the operator app, so it imports nothing at runtime.
 *
 * Files, in the org's workspace repo:
 *   <workspace>/sessions/<file>.jsonl                       its conversations (marker `sova-project-overseer`)
 *   <workspace>/projects/<projectId>/overseer/overseer.json  ProjectOverseerSettings
 *   <workspace>/projects/<projectId>/overseer/state.json     { version: 1, current, history } (session ids)
 *   <workspace>/projects/<projectId>/overseer/notes.md       its standing notes
 *   <workspace>/projects/<projectId>/overseer/actions.jsonl  every act, refused or not (OverseerAction)
 *   <workspace>/projects/<projectId>/overseer/ideas/         ideas (the Overseer's ideas store; gaps are tagged "gap")
 *   <workspace>/projects/<projectId>/overseer/todos.json     the operator's to-do items (the Overseer's todos store)
 * Host-local (never committed): the counters (each message's and each day's) and the watch loop's memo (held items too), under the state root.
 *
 * Operator routes (main listener only):
 * GET    /api/orgs/:id/projects/:pid/overseer               -> ProjectOverseerInfo (exists: false before the first open)
 * POST   /api/orgs/:id/projects/:pid/overseer               -> ProjectOverseerInfo (open or create; then mount #/s/<path>)
 * PATCH  /api/orgs/:id/projects/:pid/overseer               body ProjectOverseerPatch -> ProjectOverseerInfo
 * POST   /api/orgs/:id/projects/:pid/overseer/clear         -> ProjectOverseerInfo (a new conversation; settings, notes, ideas, todos stay)
 * GET    /api/orgs/:id/projects/:pid/overseer/ideas         -> OverseerIdeasInfo (protocol.ts shape)
 * GET    /api/orgs/:id/projects/:pid/overseer/idea?id=      -> OverseerIdeaDetail
 * PATCH  /api/orgs/:id/projects/:pid/overseer/idea?id=      body IdeaPatch (no newId) -> OverseerIdeaDetail
 * GET    /api/orgs/:id/projects/:pid/overseer/todos         -> OverseerTodosInfo (protocol.ts shape)
 * POST   /api/orgs/:id/projects/:pid/overseer/todos         body { text, ideaId?, sessionId? } -> 201 OverseerTodosInfo
 * PATCH  /api/orgs/:id/projects/:pid/overseer/todo?id=      body TodoPatch -> OverseerTodosInfo
 * DELETE /api/orgs/:id/projects/:pid/overseer/todo?id=      -> OverseerTodosInfo
 * PUT    /api/orgs/:id/projects/:pid/overseer/todos/order   body { ids: string[] } -> OverseerTodosInfo
 * DELETE /api/orgs/:id/projects/:pid/overseer/todos/done    -> OverseerTodosInfo
 * GET    /api/orgs/:id/projects/:pid/overseer/actions?limit= -> OverseerAction[] (newest first, refusals included)
 * POST   /api/orgs/:id/projects/:pid/overseer/run           -> ProjectOverseerInfo (Run Now: one watch-loop turn, now; 409 while busy)
 * POST   /api/orgs/:id/projects/:pid/overseer/items/send    body ItemSendInput -> 201 ItemSendResult (Send to person…)
 * POST   /api/orgs/:id/projects/:pid/overseer/items/code    body ItemCodeInput -> 201 ItemCodeResult (Start coding session; the global
 *                                                               Overseer alone may give { prompt, title } with no item)
 * POST   /api/orgs/:id/projects/:pid/overseer/message       body { text } -> ProjectMessageResult (the global Overseer's one route into
 *                                                               the overseer's conversation; 403 for any other caller)
 * POST   /api/orgs/:id/projects/:pid/overseer/coding        body CodingStartInput -> 201 CodingStartResult (New Coding Session: no item, no prompt)
 * POST   /api/orgs/:id/projects/:pid/overseer/worktrees/merge  body { sessionId } -> ProjectOverseerInfo (merge a coding session's branch into its target)
 * POST   /api/orgs/:id/projects/:pid/overseer/worktrees/remove body { sessionId } -> ProjectOverseerInfo (remove its worktree; the branch too once merged)
 */

import type { GatheringAbilities } from "./baton";

/** `customType` of the marker a project overseer's file carries (data `ProjectOverseerMarkerData`). */
export const PROJECT_OVERSEER_ENTRY = "sova-project-overseer";

export interface ProjectOverseerMarkerData {
  v: 1;
  orgId: string;
  projectId: string;
}

/**
 * How far the overseer may act in a run the operator did not start (a watch-loop turn). The
 * operator's own chat messages always get every tool, under the caps. Enforced in the tool
 * wrapper, never by the prompt.
 * - L0 propose: read, keep notes, file ideas (gaps), ask with a confirm card.
 * - L1 gather: + start gathering sessions and offers to roster people, run the reconciler.
 * - L2 reconcile: + promote non-conflicting decisions into the project's spec, approve or decline referrals.
 * - L3 build: + start and prompt coding sessions in the project, within the caps.
 */
export type Autonomy = "L0" | "L1" | "L2" | "L3";
export const AUTONOMY_LEVELS: readonly Autonomy[] = ["L0", "L1", "L2", "L3"];
export const DEFAULT_AUTONOMY: Autonomy = "L1";
/** One line per level, for the selector. */
export const AUTONOMY_MEANING: Record<Autonomy, string> = {
  L0: "Propose: reads, files gaps as ideas, asks you before anything else.",
  L1: "Gather: may also start gathering sessions with people on the roster.",
  L2: "Reconcile: may also promote agreed decisions into the spec and approve referrals.",
  L3: "Build: may also start coding sessions in the project, within its limits.",
};

/** A limit that may be Unlimited: `null` (§app.project-overseer/limits). */
export type Allowance = number | null;

/**
 * The project overseer's limits (§app.project-overseer/limits). `*PerTurn`: per message the
 * operator sends (their turns); `*PerDay`: on its own (every run the operator did not start), per
 * local day on this host; `unattendedPerDay`: looks on its own per day. Each may be Unlimited
 * (null). `gatheringsOpen`/`codingRunning`: at once, in every turn, never Unlimited: they are what
 * stops a burst.
 */
export interface ProjectOverseerCaps {
  gatherPerTurn: Allowance; // default 3: gathering sessions or offers started
  promotePerTurn: Allowance; // default 20: decisions promoted
  createPerTurn: Allowance; // default 2: coding sessions started
  promptsPerTurn: Allowance; // default 5: prompts sent to coding sessions
  gatherPerDay: Allowance; // default 6
  promotePerDay: Allowance; // default 60
  createPerDay: Allowance; // default 4
  promptsPerDay: Allowance; // default 12
  unattendedPerDay: Allowance; // default 12: watch-loop runs per day
  gatheringsOpen: number; // default 5 (0–20): its gathering sessions open (not done/closed) at once
  codingRunning: number; // default 2 (0–10): its coding sessions running at once
}

export const DEFAULT_PO_CAPS: ProjectOverseerCaps = {
  gatherPerTurn: 3,
  promotePerTurn: 20,
  createPerTurn: 2,
  promptsPerTurn: 5,
  gatherPerDay: 6,
  promotePerDay: 60,
  createPerDay: 4,
  promptsPerDay: 12,
  unattendedPerDay: 12,
  gatheringsOpen: 5,
  codingRunning: 2,
};
/** Allowances: whole numbers from 0 to this, or Unlimited. */
export const ALLOWANCE_MAX = 1000;
/** The at-once limits' maximums: never Unlimited. */
export const AT_ONCE_MAX = { gatheringsOpen: 20, codingRunning: 10 } as const;
export type AtOnceKey = keyof typeof AT_ONCE_MAX;
export const isAtOnce = (k: keyof ProjectOverseerCaps): k is AtOnceKey => k in AT_ONCE_MAX;

/** What an allowance counts. */
export type PoLimitKind = "gather" | "promote" | "create" | "prompt";
export const PO_LIMIT_KINDS: readonly PoLimitKind[] = ["gather", "promote", "create", "prompt"];
export const PER_TURN: Record<PoLimitKind, keyof ProjectOverseerCaps> = { gather: "gatherPerTurn", promote: "promotePerTurn", create: "createPerTurn", prompt: "promptsPerTurn" };
export const PER_DAY: Record<PoLimitKind, keyof ProjectOverseerCaps> = { gather: "gatherPerDay", promote: "promotePerDay", create: "createPerDay", prompt: "promptsPerDay" };
/** What each kind counts, in a sentence ("3 of 6 gathering sessions started"). */
export const LIMIT_WHAT: Record<PoLimitKind, string> = { gather: "gathering sessions started", promote: "decisions promoted", create: "coding sessions started", prompt: "prompts to coding sessions" };

/** Each limit's field label on the project page; the server's 400 sentences use the same words. */
export const PO_CAP_LABEL: Record<keyof ProjectOverseerCaps, string> = {
  gatherPerTurn: "Gathering sessions started (each message you send)",
  promotePerTurn: "Decisions promoted (each message you send)",
  createPerTurn: "Coding sessions started (each message you send)",
  promptsPerTurn: "Prompts to coding sessions (each message you send)",
  gatherPerDay: "Gathering sessions started (on its own, each day)",
  promotePerDay: "Decisions promoted (on its own, each day)",
  createPerDay: "Coding sessions started (on its own, each day)",
  promptsPerDay: "Prompts to coding sessions (on its own, each day)",
  unattendedPerDay: "Looks (on its own, each day)",
  gatheringsOpen: "Gathering sessions open",
  codingRunning: "Coding sessions running",
};

/** Why a limit's value can't be saved, as the page and the server say it, or null. Pure. */
export function capProblem(k: keyof ProjectOverseerCaps, v: unknown): string | null {
  if (isAtOnce(k)) {
    if (v === null) return `${PO_CAP_LABEL[k]} can't be Unlimited: it's what stops a burst.`;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= AT_ONCE_MAX[k] ? null : `${PO_CAP_LABEL[k]} must be a whole number from 0 to ${AT_ONCE_MAX[k]}.`;
  }
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= ALLOWANCE_MAX) ? null : `${PO_CAP_LABEL[k]} must be a whole number from 0 to ${ALLOWANCE_MAX}, or Unlimited.`;
}

/** Pace (§app.project-overseer/limits): minutes between looks on its own, and the soon look's delay. */
export const DEFAULT_WATCH_GAP_MIN = 10;
export const DEFAULT_SOON_LOOK_SEC = 60;
export const GAP_CHOICES = [2, 5, 10, 30, 60] as const;
/** null = Off. */
export const SOON_CHOICES = [30, 60, 120, 300, null] as const;
export const gapProblem = (v: unknown): string | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440 ? null : "Looks at most every must be a whole number of minutes from 1 to 1440.";
export const soonProblem = (v: unknown): string | null =>
  v === null || (typeof v === "number" && Number.isInteger(v) && v >= 30 && v <= 3600) ? null : "The soon look must be a whole number of seconds from 30 to 3600, or Off.";

/** How long an act that reaches a person or the client's code waits in its hold before it goes ahead
    (minutes; 0 = no hold: it goes ahead at once). */
export const DEFAULT_HOLD_MIN = 10;
export const HOLD_MIN_MAX = 1440;
export const HOLD_CHOICES = [0, 2, 5, 10, 30, 60] as const;
export const holdProblem = (v: unknown): string | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= HOLD_MIN_MAX ? null : `The hold must be a whole number of minutes from 0 to ${HOLD_MIN_MAX} (0: no hold).`;

/** The act kinds an unattended act of the project's may be marked with "needs overseer confirmation"
    (r8(4), q12): such an act, once held, waits past its hold until the overseer approves or cancels it.
    Each is an act's `:confirm-kind` in the charts. Display order. No "message" (r10: sova_send never reaches a
    gathering, so no act has that kind). */
export const CONFIRM_KINDS = ["gather", "offer", "close", "promote", "build", "prompt", "owner-update", "send", "roster-approve", "roster-decline"] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];
/** Every kind reaches a person or the client's code, so every one is on by default. */
export const DEFAULT_CONFIRM_KINDS: readonly ConfirmKind[] = CONFIRM_KINDS;
export const confirmKindsProblem = (v: unknown): string | null =>
  Array.isArray(v) && v.every((k) => (CONFIRM_KINDS as readonly unknown[]).includes(k)) && new Set(v).size === v.length
    ? null
    : `confirmKinds must list act kinds from: ${CONFIRM_KINDS.join(", ")}.`;

/**
 * Something a refusal held for later (host-local, in the watch memo): `key` is `day:<kind>`,
 * `message:<kind>` or `looks`; `retryAt` (ISO) is when the watch loop turns it into a
 * reason to look, null = when the operator raises the limit.
 */
export interface HeldItem {
  key: string;
  /** What it counts ("gathering sessions started", "looks"). */
  what: string;
  /** The refusal's sentence. */
  why: string;
  since: string;
  retryAt: string | null;
}

/** Used and the limit (null = Unlimited), per kind. */
export type AllowanceUse = Record<PoLimitKind, { used: number; max: Allowance }>;

/** The mode a coding session the project starts runs in (the mode extension's major mode and minor
    modes). `align` is never allowed: nobody answers a coding session's alignment questions. */
export interface ProjectCodingMode {
  mode: "normal" | "delegate";
  /** Canonical order; only "spec" may be on. */
  minorModes: string[];
}

export interface ProjectOverseerSettings {
  version: 1;
  autonomy: Autonomy;
  /** "provider/model"; null = the new-session default. */
  model: string | null;
  thinking: string | null;
  /** The coding sessions it starts (sova_create_session, Start coding session): "provider/model", or
      null = the overseer's own model; `codingThinking` likewise (null = the overseer's own level). */
  codingModel: string | null;
  codingThinking: string | null;
  /** The mode its coding sessions start in; null = Automatic (normal, with spec on when the project
      root has a spec, `.sova/spec/manifest.json`). The overseer may never exceed it: delegate only
      when set here, spec never turned off when it is on. */
  codingMode: ProjectCodingMode | null;
  /** The gathering sessions and offers it starts (and Send to person…): the model the person talks
      to; null = the overseer's own. `gatheringThinking` likewise. */
  gatheringModel: string | null;
  gatheringThinking: string | null;
  /** What its gathering sessions can do (§app.baton/abilities); null = Automatic (draw on, read
      links off). The overseer may never turn read links on beyond it. */
  gatheringAbilities: GatheringAbilities | null;
  caps: ProjectOverseerCaps;
  /** It looks on its own at most every this many minutes (1–1440). */
  watchGapMin: number;
  /** A reason to look soon starts a look this many seconds after it (30–3600); null = Off. */
  soonLookSec: number | null;
  /** The watch loop runs for this project. */
  watch: boolean;
  /** An act that reaches a person or the client's code waits this many minutes in its hold, where
      the operator (Needs you) or the overseer may cancel it (0–1440; 0 = no hold). */
  holdMin: number;
  /** The act kinds that, held, wait for the overseer's confirmation (CONFIRM_KINDS; default all). */
  confirmKinds: ConfirmKind[];
  extraSystemPrompt: string;
}

export type ProjectOverseerPatch = Partial<Pick<ProjectOverseerSettings, "autonomy" | "model" | "thinking" | "codingModel" | "codingThinking" | "codingMode" | "gatheringModel" | "gatheringThinking" | "gatheringAbilities" | "watchGapMin" | "soonLookSec" | "watch" | "holdMin" | "confirmKinds" | "extraSystemPrompt">> & {
  caps?: Partial<ProjectOverseerCaps>;
};

/** How the last unattended run went; `started` means it is running now. */
export type LastRunOutcome = "started" | "finished" | "stopped" | "cut-off" | "skipped";

export interface ProjectOverseerInfo {
  orgId: string;
  projectId: string;
  projectName: string;
  /** A conversation exists. False until the first POST. */
  exists: boolean;
  /** The current conversation: mount the normal chat page on it. */
  path: string | null;
  id: string | null;
  /** Earlier conversations, newest first (read-only). */
  history: { id: string; path: string; title: string; lastActiveAt: string }[];
  settings: ProjectOverseerSettings;
  /** The mode a coding session started now gets (`settings.codingMode`, or what Automatic resolves to now). */
  codingModeNow: ProjectCodingMode;
  /** What a gathering session started now gets (`settings.gatheringAbilities`, or Automatic). */
  gatheringAbilitiesNow: GatheringAbilities;
  /** Coding sessions run in their own git worktree and branch when the project root is in a git
      repository; `reason` (a tail: "it isn't a Git repository.") says why not: they then run in the
      root itself. `sessions`: every coding session the project started, newest first. */
  worktrees: { available: boolean; reason?: string; sessions: CodingWorktree[] };
  /** The level in force now: `settings.autonomy`, or L0 with a reason ("The roster has no active people yet."). */
  effective: { autonomy: Autonomy; reason?: string };
  /** When an attach on this host paused it at L0 (ISO): unattended runs wait and the level in force
      is L0 until the operator sets its level here. Null or absent: not paused. */
  paused?: string | null;
  busy: boolean;
  /** The last watch-loop run (null: never). `started`: running now; then `finished`, `stopped`
      (why: the guard's trip, the model's error, "Stopped."), `cut-off` (the server stopped during
      it), or `skipped` (why: busy, daily cap). */
  lastRun: { at: string; reasons: string[]; outcome: LastRunOutcome; detail?: string } | null;
  /** Sessions it started, newest first. */
  started: StartedSession[];
  /** Replies newer than the operator last looked. */
  unread: number;
  usage: {
    /** What each allowance has used: the operator's last message's, and today's on its own. */
    allowance: { message: AllowanceUse; today: AllowanceUse };
    /** What refusals held for later (§app.project-overseer/limits). */
    held: HeldItem[];
    unattendedToday: number;
    lastWatchAt: string | null;
    /** Why the watch loop wants to look, not yet looked at. */
    pending: string[];
  };
}

export interface StartedSession {
  sessionId: string;
  /** On this host, for #/s/<path>; null when the file is not here. */
  path: string | null;
  title: string;
  kind: "gathering" | "offer" | "coding";
  /** Baton state for gathering/offer; "idle" | "working" for coding. */
  state: string;
  createdAt: string;
  /** A coding session's own worktree branch, when it has one. */
  worktree?: { branch: string; state: CodingWorktree["state"] };
}

/**
 * One coding session the project started (the overseer's or the operator's), with its own git
 * worktree (§app.project-overseer/coding-worktrees), or the reason it runs in the project root.
 * `worktree` is a path on the host that started it (host-local); the branch is in the client repo.
 */
export interface CodingWorktree {
  sessionId: string;
  /** The session file on this host, for #/s/<path>; null when it is not here (on another host: no gesture acts on it). */
  path: string | null;
  title: string;
  startedBy: "overseer" | "operator";
  /** An operator's row the global Overseer started for them: "Started by you, via the Overseer". */
  via?: "overseer";
  /** `sova/<name>`; null for a session in the project root. */
  branch: string | null;
  /** Why it runs in the project root (a tail: "it isn't a Git repository."). */
  inRoot?: string;
  /** The worktree's top level when it exists on this host. */
  worktree: string | null;
  /** The commit it was cut from. */
  base: string | null;
  /** The branch it merges into (the root's branch when it was cut). */
  target: string | null;
  /** open: its folder is here, not merged; merged: its branch is in target (by Merge Branch or by hand);
      removed: Remove Worktree ran; missing: its folder is gone otherwise; root: it runs in the project root. */
  state: "open" | "merged" | "removed" | "missing" | "root";
  /** Its work is in target, read from git (merged by Merge Branch or by hand); when the branch is gone
      or git can't be read, the recorded merge or removal with its branch (only a merged one is). */
  merged: boolean;
  /** True when the branch no longer exists (deleted with a merged worktree, or by hand): nothing left to merge. Absent otherwise. */
  branchGone?: boolean;
  /** The last Merge Branch (history: a branch merged once may have new commits since). */
  mergedAt?: string;
  /** Merged before and not merged now: its commits that target lacks. Absent otherwise. */
  newSinceMerge?: number;
  removedAt?: string;
  /** Commits on the branch beyond base. */
  ahead: number;
  /** Uncommitted changes in the worktree. */
  dirty: boolean;
  /** The session itself is working. */
  running: boolean;
  /** Its workers running now. */
  workers: number;
  createdAt: string;
  /** Git could not be read. */
  error?: string;
}

/** A gap the overseer inferred is an idea (OverseerIdeasInfo) with the tag "gap", id `§gap/<name>`,
    and, when it knows it, the tag `area-<areaKey>` (the decision area); who should answer is in its prose. */
export const GAP_TAG = "gap";

/** Send an idea or to-do item to a person: a gathering (baton) session, owner the operator. */
export interface ItemSendInput {
  todoId?: string;
  ideaId?: string;
  /** A person's id, "operator", or ≥ 2 people (an offer). */
  to: string | string[];
  /** Required: shown to the person verbatim (never taken from the item). */
  publicTitle: string;
  /** Required: the first question, shown to the person verbatim. */
  question: string;
  /** For the session's model only; defaults to the item's text. */
  goal?: string;
  /** Default: settings.gatheringModel, else the overseer's own model (and thinking likewise). */
  model?: string;
  thinking?: string;
}
export interface ItemSendResult {
  path: string;
  sessionId: string;
  /** One per invitee, shown once. */
  links: { personId: string; name: string; link: string }[];
  /** r7: the person is off hours; it went at once (the operator's own act): when their window opens (ISO). */
  offHours?: string;
}

/** Start an ordinary coding session in the project root with the item as its first prompt. */
export interface ItemCodeInput {
  todoId?: string;
  ideaId?: string;
  /** Defaults to the item's text. */
  prompt?: string;
  /** With no item (the global Overseer only): the session's title. */
  title?: string;
  model?: string;
  thinking?: string;
}
/** POST …/overseer/message: where the text went (idle: a turn started; mid-turn: queued as a follow-up). */
export interface ProjectMessageResult {
  queued: boolean;
  sessionId: string;
  path: string;
}

export interface ItemCodeResult {
  path: string;
  sessionId: string;
  /** The worktree it runs in; absent when it runs in the root (`note`, a tail, says why). */
  worktree?: { path: string; branch: string };
  note?: string;
  /** Its mode could not be set, so its first prompt was not sent (the session exists and is listed). */
  notPrompted?: string;
}

/** New Coding Session: a coding session tied to no to-do or idea, with no first prompt (the operator writes it in the composer). */
export interface CodingStartInput {
  /** Names the branch and the row; absent: `sova/coding-<hex>`, and the row is untitled until the first message. */
  title?: string;
  model?: string;
  thinking?: string;
}
export type CodingStartResult = Omit<ItemCodeResult, "notPrompted"> & {
  /** Its mode could not be set (the session exists and is listed): the sentence to show. */
  modeNotSet?: string;
};
