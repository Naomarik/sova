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
 * Host-local (never committed): per-turn counters and the watch loop's memo, under the state root.
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
 * POST   /api/orgs/:id/projects/:pid/overseer/items/code    body ItemCodeInput -> 201 ItemCodeResult (Start coding session)
 */

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
 * - L3 build: + start and prompt coding sessions in the project, within the caps and the token budget.
 */
export type Autonomy = "L0" | "L1" | "L2" | "L3";
export const AUTONOMY_LEVELS: readonly Autonomy[] = ["L0", "L1", "L2", "L3"];
export const DEFAULT_AUTONOMY: Autonomy = "L1";
/** One line per level, for the selector. */
export const AUTONOMY_MEANING: Record<Autonomy, string> = {
  L0: "Propose: reads, files gaps as ideas, asks you before anything else.",
  L1: "Gather: may also start gathering sessions with people on the roster.",
  L2: "Reconcile: may also promote agreed decisions into the spec and approve referrals.",
  L3: "Build: may also start coding sessions in the project, within the token budget.",
};

/** Per operator message (a watch-loop run shares the budget of the last one), except the `*Open`/`*Running` limits (at once). */
export interface ProjectOverseerCaps {
  gatherPerTurn: number; // default 3: gathering sessions or offers started
  gatheringsOpen: number; // default 5: its gathering sessions open (not done/closed) at once
  promotePerTurn: number; // default 20: decisions promoted
  createPerTurn: number; // default 2: coding sessions started
  promptsPerTurn: number; // default 5: prompts sent to coding sessions
  codingRunning: number; // default 2: its coding sessions running at once
  unattendedPerDay: number; // default 12: watch-loop runs per day
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
  /** The gathering sessions and offers it starts (and Send to person…): the model the person talks
      to; null = the overseer's own. `gatheringThinking` likewise. */
  gatheringModel: string | null;
  gatheringThinking: string | null;
  caps: ProjectOverseerCaps;
  /** Tokens (input + output + cache) its coding sessions may spend in total; L3 refuses beyond it. */
  tokenBudget: number;
  /** The watch loop runs for this project. */
  watch: boolean;
  extraSystemPrompt: string;
}

export type ProjectOverseerPatch = Partial<Pick<ProjectOverseerSettings, "autonomy" | "model" | "thinking" | "codingModel" | "codingThinking" | "gatheringModel" | "gatheringThinking" | "tokenBudget" | "watch" | "extraSystemPrompt">> & {
  caps?: Partial<ProjectOverseerCaps>;
};

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
  /** The level in force now: `settings.autonomy`, or L0 with a reason ("The roster has no active people yet."). */
  effective: { autonomy: Autonomy; reason?: string };
  busy: boolean;
  /** The last watch-loop run (null: never). `outcome` "skipped" carries why (busy, daily cap). */
  lastRun: { at: string; reasons: string[]; outcome: "started" | "skipped"; detail?: string } | null;
  /** Sessions it started, newest first. */
  started: StartedSession[];
  /** Replies newer than the operator last looked. */
  unread: number;
  usage: {
    /** Tokens its coding sessions have spent (sum of their lifetime totals). */
    codingTokens: number;
    tokenBudget: number;
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
}

/** Start an ordinary coding session in the project root with the item as its first prompt. */
export interface ItemCodeInput {
  todoId?: string;
  ideaId?: string;
  /** Defaults to the item's text. */
  prompt?: string;
  model?: string;
  thinking?: string;
}
export interface ItemCodeResult {
  path: string;
  sessionId: string;
}
