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
  /** A text choice written over several lines. */
  multiline?: true;
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

/** A team's required member, as the card shows it: who it is, why it is picked, and its model now. */
export interface PlaybookMemberView {
  id: string;
  label: string;
  /** One line: why this member is on the team, its choices filled in. */
  brief: string;
  /** Its working notes page, relative to the playbook's folder, when the playbook names one. */
  notes?: string;
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
  /** False: an "only these models" member none of whose models can run. */
  runnable: boolean;
  /** Your one-line note for it on this run ("" when none). */
  note: string;
}

/** A team: its goal and the members it must have; it adds anyone else it needs. Its coordinator and monitor
    run on your own team settings and aren't shown (they count toward the helper limit). */
export interface PlaybookTeamView {
  id: string;
  /** A short name: the playbook's, else its id. */
  label: string;
  /** One line: what the team is for, your choices filled in. */
  goal: string;
  /** The steps it works in, by id. */
  steps: string[];
  /** Your one-line note for the team on this run ("" when none). */
  note: string;
  /** Its required members, in the playbook's order; may be none. */
  members: PlaybookMemberView[];
}

export interface PlaybookStepView {
  id: string;
  title: string;
  goal?: string;
  stop: "always" | "optional" | "never";
  stopOn: boolean;
  /** The teams that work in it, by id; none: the main chat alone. */
  teams: string[];
  report?: string;
  cycle?: boolean;
}

export interface PlaybookCycleView {
  steps: string[];
  max: number;
  maxCap: number;
  askEvery: number;
  /** Keep going until the stop rule is met ("rule"), or run every cycle ("max"). */
  until?: "rule" | "max";
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
  /** The run folder: the plan, and the contents pages the run reads. */
  folder: string;
}

export interface PlaybookRunView {
  id: string;
  revision: number;
  playbook: { source: "sova" | "user" | "project"; id: string; title: string; dir: string; summary?: string };
  state: PlaybookRunState;
  changedSinceLast?: boolean;
  choices: PlaybookChoiceView[];
  teams: PlaybookTeamView[];
  /** Who runs, folded: the number of teams and of required members turned on (a member run three times counts once). */
  who: { teams: number; members: number };
  steps: PlaybookStepView[];
  cycle: PlaybookCycleView | null;
  /** The playbook's flow as a vis source (shared/playbook-flow.ts), following the card's cycle settings and
      optional stops; draw it as a ```vis <kind> fence. Absent when the playbook can't be read. */
  flow?: { kind: "flow" | "state"; body: string };
  howItRuns: string;
  /** The changing Sova commands the playbook lists, by label. */
  commands: string[];
  /** Every helper the plan starts (each team's coordinator and monitor included), and how many one chat runs at once. */
  helpers: { total: number; limit: number };
  startBlocked: string | null;
  started?: PlaybookRunStarted;
  /** Why the last Start failed, until the next edit or Start. */
  startError?: string;
  /** The playbook's description can't be read now (a draft whose playbook.json broke). */
  error?: string;
  /** The person closed the card: a draft's is gone (only a socket's news says so); a started run's was put away,
   * so it leaves the chat's cards, while reading it by its id still answers its record, marked closed. */
  closed?: true;
}

export interface PlaybookRoleEdit {
  /** null clears the card's pick. */
  pick?: PlaybookModelPick | null;
  on?: boolean;
  note?: string;
}

export interface PlaybookTeamEdit {
  note?: string;
}

/** What the card sends: each key it names replaces that part of the draft; what it leaves out stays.
    `roles` is keyed by member id; `teams` by team id. */
export interface PlaybookCardEdits {
  choices?: Record<string, unknown>;
  roles?: Record<string, PlaybookRoleEdit>;
  teams?: Record<string, PlaybookTeamEdit>;
  stops?: Record<string, boolean>;
  cycle?: { max?: number; askEvery?: number; until?: "rule" | "max" };
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

// ── The run message ─────────────────────────────────────────────────────────────────────────────

/** The instruction line Start's message opens with (server/playbook-runs/message.ts builds the rest). */
export const runInstruction = (title: string): string =>
  `Run the playbook "${title}" as its conductor: its recipe is in the playbook block below and this run's plan, frozen from the card the user started, in the run block after it. Start the helpers and teams yourself, exactly as the run block says.`;

/** What a chat's thread shows of Start's message: which run of which playbook, at which revision. */
export interface RunMessageInfo {
  runId: string;
  playbook: string;
  title: string;
  revision: number;
}

const INSTRUCTION_RE = /^Run the playbook "(.*)" as its conductor: /;
const RUN_TAG_RE = /^<run id="(pr_[a-z0-9]{12})" playbook="([^"]*)" revision="(\d+)" folder="[^"]*">$/m;

/** Start's message, recognized: its first line is the instruction and it carries a run block; null for any other text. */
export function parseRunMessage(text: string | undefined | null): RunMessageInfo | null {
  if (!text) return null;
  const head = INSTRUCTION_RE.exec(text);
  if (!head) return null;
  const tag = RUN_TAG_RE.exec(text);
  if (!tag || !text.trimEnd().endsWith("</run>")) return null;
  const unq = (v: string) => v.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  return { runId: tag[1]!, playbook: unq(tag[2]!), title: head[1]!, revision: Number(tag[3]) };
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
  if (base.teams || edits.teams) {
    const teams: Record<string, PlaybookTeamEdit> = { ...base.teams };
    for (const [id, e] of Object.entries(edits.teams ?? {})) teams[id] = { ...teams[id], ...e };
    out.teams = teams;
  }
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
