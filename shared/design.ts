// Design mode's shapes (al_1): what the server keeps about a chat's designs, what the page reads, and
// the constants both sides need. Pure data and pure helpers: no DOM, no Solid, no node builtins, so
// both the server and the web app import it.

/** A design's life on its card. Queued: waiting for a seat or a provider slot; Writing: its session is
    at work; Ready: a finished page exists; Failed: the last attempt produced none. */
export type DesignStatus = "queued" | "writing" | "ready" | "failed";

/** How a design's page reaches the card while it is written: through the design tool's argument, or,
    for a provider that delivers a tool's argument whole at the end, between markers in its reply. */
export type DesignStreamRoute = "tool" | "reply";

/** What a design session says about a finished page (`design_hand_in`): all the coordinator ever knows of it. */
export interface DesignNote {
  layout: string;
  sections: string;
  type: string;
  color: string;
}

/** One finished version of a page (`A`, `A2` are versions 1 and 2 of label A). */
export interface DesignVersion {
  n: number;
  at: string;
  chars: number;
  /** What asked for it. */
  by: "first" | "refine" | "chat" | "coordinator";
  note?: DesignNote;
}

/** What is known of the message a person or the main chat last sent a design's session (t20). */
export interface DesignDelivery {
  /** queued: it waits behind the session's run; undelivered: it could not be handed over, and the
      sender's text stays in the box. */
  state: "queued" | "undelivered";
  key: string;
  at: string;
  error?: string;
}

export interface DesignUsage {
  input: number;
  output: number;
  cost: number;
}

/** One labelled design of a chat. */
export interface DesignRecord {
  label: string;
  runId: string;
  direction: string;
  /** provider/modelId. */
  model: string;
  /** The labels it was made from (Phase 3); empty for a first-generation design. */
  parents: string[];
  status: DesignStatus;
  /** Why it failed, in plain words (status "failed"). */
  error?: string;
  route: DesignStreamRoute;
  /** Finished versions, oldest first; empty until the first hand-in. */
  versions: DesignVersion[];
  /** Its session is thinking and hasn't begun the page: draw that instead of an empty Writing. */
  thinking?: true;
  /** The page being written now, while there is one. */
  live?: { version: number; chars: number };
  /** The session's id once it has one; absent while queued. */
  sessionId?: string;
  sessionFile?: string;
  /** The session can no longer be reopened: Refine starts a fresh one from the stored page (f10). */
  sessionEnded?: boolean;
  /** The model's name as the picker shows it. */
  modelName: string;
  /** The session's process, as far as the server knows. */
  workerState: "idle" | "working" | "stopped" | "ended";
  /** The model can read images; if false, Refine looks at a text outline and the card says so. */
  vision: boolean;
  delivery?: DesignDelivery;
  usage?: DesignUsage;
  createdAt: string;
  updatedAt: string;
}

/** One model row of the Setup card: two independent controls (q10, t25). */
export interface DesignModelChoice {
  /** provider/modelId. */
  ref: string;
  name: string;
  design: boolean;
  coordinator: boolean;
  vision: boolean;
  route: DesignStreamRoute;
}

export interface DesignDirection {
  name: string;
  on: boolean;
}

/** The Setup card's state: what the main chat filled in and the person changed. */
export interface DesignSetup {
  brief: string;
  models: DesignModelChoice[];
  directions: DesignDirection[];
}

export type DesignRunPhase = "setup" | "researching" | "confirm" | "generating" | "done" | "stopped";

/** One run: a Setup card and the batch started from it. */
export interface DesignRun {
  id: string;
  setup: DesignSetup;
  /** setup: the card is being filled in; researching: the coordinator is looking for the screen;
      confirm: it waits for Design This Screen; generating: the team is at work; done: every design has
      reached Ready or Failed; stopped: the run was ended before it finished. */
  phase: DesignRunPhase;
  /** The labels this run produced, in order. */
  labels: string[];
  /** The screen the coordinator asks you to confirm (q14): set in phase confirm, kept for the card. */
  confirm?: DesignConfirm;
  /** Why the coordinator stopped, in plain words. */
  error?: string;
  /** The person's approval of a run above the free limit (q2). */
  confirmedSpend?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Everything a chat's Design card and Gallery tab read (`GET /api/design?path=`). */
export interface DesignChatView {
  v: 1;
  sessionId: string;
  runs: DesignRun[];
  designs: DesignRecord[];
  /** Filled in by the coordinator's own code (a2); null before it starts. */
  coordinator: DesignCoordinatorView | null;
  caps: DesignCaps;
}

/** The coordinator as the page reads it. */
export interface DesignCoordinatorView {
  sessionId: string;
  sessionFile: string;
  model: string;
  status: "starting" | "running" | "idle" | "ended";
  /** Its card's full text, newest revision (a2); empty until it writes one. */
  card: string;
  revision: number;
  delivery?: DesignDelivery;
  /** Designs it knows of: their count, for the card's header. */
  tracking: number;
  /** A question it is waiting on you for, on its card. */
  ask?: DesignAsk;
}

/** What the coordinator found, for Design This Screen / Not This Screen. */
export interface DesignConfirm {
  text: string;
  /** Picture addresses, served by this Sova. */
  screenshots: string[];
  url?: string;
  /** The page in words, for a coordinator that reads no images. */
  outline?: string;
}

/** A yes-or-no (or a sign-in) the coordinator raised on its card; only a click answers it. */
export type DesignAsk = { id: string; text: string } & (
  | { kind: "start-project"; project: string; instance?: string; branch?: string }
  | { kind: "stop-project"; project: string; instance: string }
  | { kind: "site"; origin: string }
  | { kind: "sign-in"; origin: string; fields: string[]; reason?: string }
  | { kind: "test-account"; origin: string; fields: string[] }
  /** `design_new` in one turn is one launch: above the free limit it asks first. */
  | { kind: "spend"; count: number }
);

/** The answer to a sign-in on the coordinator's card. */
export interface DesignSignInAnswer {
  username?: string;
  password?: string;
  account?: string;
  code?: string;
}

/** A sign-in answer as a route accepts it: only those fields, each a short string. */
export function isDesignSignInAnswer(v: unknown): v is DesignSignInAnswer {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = Object.entries(v);
  return e.length > 0 && e.every(([k, x]) => ["username", "password", "account", "code"].includes(k) && typeof x === "string" && x.length <= 4096);
}

export interface DesignCaps {
  batchDefault: number;
  askAbove: number;
  batchMax: number;
  concurrent: number;
}

/** The main chat's tool whose result anchors a Design card. */
export const DESIGN_TOOL = "design";

/** What a `design` result's details say when it put a card in the chat. */
export const isDesignCardDetails = (v: unknown): v is { designCard: { runId: string } } => typeof (v as { designCard?: { runId?: unknown } } | null | undefined)?.designCard?.runId === "string";

/** A batch: 6 by default, ask above 12, stop at 24 (q2). */
export const DESIGN_BATCH_DEFAULT = 6;
export const DESIGN_ASK_ABOVE = 12;
export const DESIGN_BATCH_MAX = 24;
/** Design sessions of one chat writing at once (t22): the rest read Queued. */
export const DESIGN_CONCURRENT = 6;
/** The largest page a design session may write, enforced by the stream guard (t30). */
export const DESIGN_OUTPUT_TOKENS = 32_768;
/** The same budget as characters, at about 4 a token: the stream guard counts characters. */
export const DESIGN_OUTPUT_CHARS = DESIGN_OUTPUT_TOKENS * 4;

/** The marker lines a no-tool-stream model writes its page between, in its reply (q15, t31). */
export const DESIGN_PAGE_OPEN = "<<<design-page>>>";
export const DESIGN_PAGE_CLOSE = "<<<end-design-page>>>";

/** Providers that deliver a tool's argument whole at the end (report E1, t8). */
const NO_TOOL_STREAM_PROVIDERS = ["ollama-cloud", "google", "google-vertex", "google-gemini-cli", "google-antigravity"];

/** The route a model's page takes to the card. */
export function designRouteOf(ref: string): DesignStreamRoute {
  const provider = ref.split("/", 1)[0] ?? "";
  return NO_TOOL_STREAM_PROVIDERS.includes(provider) ? "reply" : "tool";
}

/** The label after `n` earlier ones of a chat: A … Z, then AA, AB … (t14). */
export function designLabel(n: number): string {
  let i = n;
  let out = "";
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

/** A label as the routes accept it. */
export const isDesignLabel = (s: unknown): s is string => typeof s === "string" && /^[A-Z]{1,4}$/.test(s);
