/**
 * A playbook run: the card a playbook with a playbook.json opens, its draft, and the
 * plan Start freezes. Kept in Sova's own store keyed by the run's id, never by a session (server/playbook-runs/).
 * The page draws a PlaybookRunView the server builds and sends edits keyed to the revision it shows.
 * Pure types and small pure helpers: the page, the server and the tests share them.
 */

/** Where a choice's value came from, as the card labels it. */
export type PlaybookChoiceOrigin = "default" | "last" | "standing" | "message" | "looked-up" | "you";

export const PLAYBOOK_CHOICE_ORIGIN_WORDS: Record<PlaybookChoiceOrigin, string> = {
  default: "Default",
  last: "Same as last time",
  standing: "Your standing answer",
  message: "From your message",
  "looked-up": "Looked up",
  you: "Your pick",
};

/** One model a role may run on: a model ref ("provider/id", as a chat or a pi worker names it, or
    "claude-code/<id>" for a Claude Code worker) and an optional effort. */
export interface PlaybookModelPick {
  model: string;
  effort?: string;
}

export type PlaybookChoiceType = "text" | "number" | "toggle" | "choice" | "multi" | "list" | "models";

export interface PlaybookChoiceView {
  id: string;
  label: string;
  help?: string;
  type: PlaybookChoiceType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** string | number | boolean | string[] | PlaybookModelPick[]; null: no value yet. */
  value: unknown;
  origin: PlaybookChoiceOrigin;
  required: boolean;
  ask: "always" | "once" | "optional";
  eachCycle?: boolean;
}

/** One entry of a role's model chain as resolved now. */
export interface PlaybookModelView {
  model: string;
  effort?: string;
  /** "GLM 5.3" */
  label: string;
  /** "ZAI" */
  provider: string;
  usable: boolean;
  /** Why it can't run, when it can't. */
  why?: string;
}

export type PlaybookModelSource = "card" | "list" | "profile" | "chat";

export interface PlaybookRoleView {
  id: string;
  /** "Main chat" for the main role. */
  label: string;
  main: boolean;
  kind?: string;
  count: number;
  per?: string;
  optional: boolean;
  on: boolean;
  only: boolean;
  /** The playbook's whole list, the card's pick first when there is one. */
  chain: PlaybookModelPick[];
  /** The chain as resolved now, entry by entry. */
  models: PlaybookModelView[];
  /** What the model picker offers. */
  options: PlaybookModelPick[];
  resolved: { model: string; modelLabel: string; provider: string; effort?: string; source: PlaybookModelSource; reason?: string } | null;
  /** False: an "only these models" role none of whose models can run. */
  runnable: boolean;
  note: string;
  /** The exact brief this role receives (its prompt with the choices filled in, then the note). */
  prompt: string;
  /** The team it runs in, when it runs in one. */
  team?: string;
}

export interface PlaybookStepView {
  id: string;
  title: string;
  stop: "always" | "optional" | "never";
  stopOn: boolean;
  runs: "main" | "team" | "helpers";
  team?: string;
  roles: string[];
  report?: string;
  cycle?: boolean;
}

export interface PlaybookTeamView {
  id: string;
  label: string;
  roles: string[];
  coordinator: { modelLabel: string; effort?: string };
  monitor: { modelLabel: string; effort?: string };
}

export interface PlaybookCycleView {
  steps: string[];
  max: number;
  maxCap: number;
  askEvery: number;
  rule?: string;
}

export type PlaybookRunState = "draft" | "starting" | "started";

export interface PlaybookRunStarted {
  at: string;
  revision: number;
  /** The chat conducting the run. */
  chat: { id: string; path: string; title?: string };
  /** A new chat was opened for it (the playbook asks for its own permissions, or none showed the card). */
  newChat: boolean;
  /** The chat whose card started it, when it isn't the conducting chat. */
  fromChat?: { id: string; path: string };
  /** The run folder: the plan, each helper's brief, team layouts. */
  folder: string;
}

export interface PlaybookRunView {
  id: string;
  revision: number;
  playbook: { source: "sova" | "user" | "project"; id: string; title: string; dir: string; summary?: string };
  state: PlaybookRunState;
  changedSinceLast?: boolean;
  choices: PlaybookChoiceView[];
  roles: PlaybookRoleView[];
  teams: PlaybookTeamView[];
  steps: PlaybookStepView[];
  cycle: PlaybookCycleView | null;
  howItRuns: string;
  /** The changing Sova commands the playbook lists, by label. */
  commands: string[];
  helpers: { total: number; limit: number };
  startBlocked: string | null;
  started?: PlaybookRunStarted;
  /** Why the last Start failed, until the next edit or Start. */
  startError?: string;
  /** The playbook's description can't be read now (a draft whose playbook.json broke). */
  error?: string;
  /** Only in a socket's news: the draft was closed, so the card goes away. */
  closed?: true;
}

export interface PlaybookRoleEdit {
  /** null clears the card's pick. */
  pick?: PlaybookModelPick | null;
  on?: boolean;
  note?: string;
}

/** What the card sends: each key it names replaces that part of the draft; what it leaves out stays. */
export interface PlaybookCardEdits {
  choices?: Record<string, unknown>;
  roles?: Record<string, PlaybookRoleEdit>;
  stops?: Record<string, boolean>;
  cycle?: { max?: number; askEvery?: number };
}

// ── Wire bodies ─────────────────────────────────────────────────────────────────────────────────

/** POST /api/playbook-runs */
export interface PlaybookRunOpenBody {
  playbook: { source: "sova" | "user" | "project"; id: string };
  cwd: string;
  /** The chat showing the card (its session path); none from the new chat screen. */
  path?: string;
  /** Words typed after /<id>. */
  text?: string;
}
/** PATCH /api/playbook-runs/:run */
export interface PlaybookRunEditBody {
  revision: number;
  edits: PlaybookCardEdits;
}
/** POST /api/playbook-runs/:run/start and /defaults */
export interface PlaybookRunRevisionBody {
  revision: number;
}

/** The SovaEvent a chat's sockets hear when one of its runs changes. */
export const PLAYBOOK_RUN_EVENT = "playbook.run";

/** A run id: "pr_" and 12 lowercase letters or digits. */
export const PLAYBOOK_RUN_ID = /^pr_[a-z0-9]{12}$/;
export const isPlaybookRunId = (s: unknown): s is string => typeof s === "string" && PLAYBOOK_RUN_ID.test(s);

/** Live helpers one chat may run at once, and seats in one team (the subagents extension's limits). */
export const HELPER_LIMIT = 24;

/** Merge `edits` onto `base` (the stored edits): each named part replaces, a role's fields one by one. */
export function mergeEdits(base: PlaybookCardEdits, edits: PlaybookCardEdits): PlaybookCardEdits {
  const out: PlaybookCardEdits = {
    ...(base.choices || edits.choices ? { choices: { ...base.choices, ...edits.choices } } : {}),
    ...(base.stops || edits.stops ? { stops: { ...base.stops, ...edits.stops } } : {}),
    ...(base.cycle || edits.cycle ? { cycle: { ...base.cycle, ...edits.cycle } } : {}),
  };
  if (base.roles || edits.roles) {
    const roles: Record<string, PlaybookRoleEdit> = { ...base.roles };
    for (const [id, e] of Object.entries(edits.roles ?? {})) {
      const next: PlaybookRoleEdit = { ...roles[id], ...e };
      if (e.pick === null) delete next.pick;
      roles[id] = next;
    }
    out.roles = roles;
  }
  return out;
}
