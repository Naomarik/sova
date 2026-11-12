// Design mode's shapes (al_1): what the server keeps about a chat's designs, what the page reads, and
// the constants both sides need. Pure data and pure helpers: no DOM, no Solid, no node builtins, so
// both the server and the web app import it.

/** A design's life on its card. Queued: waiting for a seat or a provider slot; Writing: its session is
    at work; Fixing: the server sent its session back to repair a page that didn't land (`fix` says why);
    Ready: a finished page exists; Failed: the last attempt produced none. */
export type DesignStatus = "queued" | "writing" | "fixing" | "ready" | "failed";

/** Why a design is being fixed (status "fixing"), for its card. */
export interface DesignFix {
  /** In plain words, for the card: "The page was cut off." */
  reason: string;
  /** This try, from 1. */
  attempt: number;
  /** The most tries a design gets. */
  of: number;
}

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
  /** Its style, by name ("Mixed" for one made from others with none named). */
  direction: string;
  /** Its layout, by name; absent when the designer arranges its own page. */
  layout?: string;
  /** provider/modelId. */
  model: string;
  /** The labels it was made from (Phase 3); empty for a first-generation design. */
  parents: string[];
  status: DesignStatus;
  /** Why it failed, in plain words (status "failed"). */
  error?: string;
  /** Set while status is "fixing". */
  fix?: DesignFix;
  /** The last request for a change ended with no new version: why, in plain words. Gone with the next message or version. */
  unchanged?: { reason: string; at: string };
  route: DesignStreamRoute;
  /** Finished versions, oldest first; empty until the first hand-in. */
  versions: DesignVersion[];
  /** Its session is thinking and hasn't begun the page: draw that instead of an empty Writing. */
  thinking?: true;
  /** The skill folders this design may read with its skill reader, taken from its run at launch: a design revived after a
      restart keeps them. Absent: none. */
  skills?: { name: string; dir: string }[];
  /** Its session is reading a design skill and hasn't begun the page: the tile says so. Gone once the page starts. */
  readingSkill?: true;
  /** The page being written now, while there is one. */
  live?: {
    version: number;
    chars: number;
    /** An estimate, in dollars, of the session's cost so far: its finished replies' real cost plus the page written so
        far at the model's output price. Absent for a model with no price; the real `usage` replaces it when the reply ends. */
    estimateUsd?: number;
  };
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
  /** One of the composer's favorites when the card was made: it leads its provider's section. */
  favorite?: boolean;
}

export interface DesignDirection {
  name: string;
  on: boolean;
  /** A style's family ("Quiet"), which only groups the list; absent on a layout and on a run made before families. */
  family?: string;
}

/** How ticked styles and layouts make designs: pair: one layout per style, the shorter list repeating and the
    pairs shifting per model; every: each style in each layout. */
export type DesignCombine = "pair" | "every";

/** The Setup card's state: what the main chat filled in and the person changed. */
export interface DesignSetup {
  brief: string;
  models: DesignModelChoice[];
  /** The styles (the Style row); the name stays `directions` so stored runs read as they were. */
  directions: DesignDirection[];
  /** The layouts (the Layout row). Absent on a run made before layouts: none ticked. */
  layouts?: DesignDirection[];
  /** Absent reads as pair. */
  combine?: DesignCombine;
  /** What Shuffle last dealt: 0 or absent is the ticked order. */
  pairSeed?: number;
  /** The addresses in what the person wants, each with how it is used. Absent on a run made before links. */
  links?: DesignLink[];
}

/** How a link's page is used. images: its images are used (and the screen goes to designers that can read
    pictures); feel: only its look, put into words, reaches the designers; content: Not a Reference, the address is
    the page's content (a contact link, say) and is never looked at, captured or described. */
export type DesignLinkUse = "images" | "feel" | "content";
export const isDesignLinkUse = (v: unknown): v is DesignLinkUse => v === "images" || v === "feel" || v === "content";

export interface DesignLink {
  url: string;
  /** null until someone chooses; a person's choice is never replaced by the coordinator's. */
  use: DesignLinkUse | null;
  by?: "user" | "coordinator";
}

/** A design skill a run uses: a folder holding SKILL.md, read by the Creative Director and offered to its designers. */
export interface DesignSkill {
  /** Its SKILL.md front matter's name, else the folder's. */
  name: string;
  /** Its front matter's description; may be empty. */
  description: string;
  /** The folder holding SKILL.md, absolute. */
  dir: string;
  /** project: found in the run's folder; named: a folder the user named for this run. */
  from: "project" | "named";
}

/** A skill the user named for a run that couldn't be found: the Creative Director asks about it on the brief. */
export interface DesignSkillMissing {
  /** What the user named, as passed on. */
  asked: string;
  reason: string;
}

export type DesignRunPhase = "setup" | "researching" | "brief" | "generating" | "done" | "stopped";

/** One run: a Setup card and the batch started from it. */
export interface DesignRun {
  id: string;
  setup: DesignSetup;
  /** setup: the card is being filled in; researching: the coordinator is preparing the brief;
      brief: the brief is on the card, waiting for Start; generating: the team is at work; done: every design has
      reached Ready or Failed; stopped: the run was ended before it finished. */
  phase: DesignRunPhase;
  /** The labels this run produced, in order. */
  labels: string[];
  /** What will be built, agreed on the card before any design runs: the coordinator's first design_brief creates it. */
  brief?: DesignBrief;
  /** Why the coordinator stopped, in plain words. */
  error?: string;
  /** The chat's page images are still being captured or described: Start waits, since what goes is what's on the card. */
  imagesBusy?: "capturing" | "describing";
  /** The person's approval of a run above the free limit (q2). */
  confirmedSpend?: boolean;
  /** The design skills this run's Creative Director and designers use, fixed when the run is made. Absent: none (or a run made before skills). */
  skills?: DesignSkill[];
  /** Skills the user named for this run that weren't found. */
  skillsMissing?: DesignSkillMissing[];
  /** The images the user attached when asking for this Lookbook, by asset name: the run's own, as the ones they paste
      once it has begun are (whatever their age in the chat). Absent: none. */
  images?: string[];
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

/** The screen the coordinator found, on the brief. */
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
  /** Capturing a signed-in page's images: asked once per site, saying what's saved and which model reads it. */
  | { kind: "capture-signed-in"; origin: string }
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

/** One of the coordinator's questions on the brief, the same shape as an alignment card's. */
export interface DesignBriefQuestion {
  /** q1, q2 ...: never reused within a run. */
  id: string;
  topic: string;
  ask: string;
  context?: string;
  options?: { label: string; tradeoff: string }[];
  recommendation: { choice: string; why: string };
  /** Set once answered; the question is open until then. */
  answer?: DesignBriefAnswer;
}

export interface DesignBriefAnswer {
  /** The option picked, by index into options. */
  option?: number;
  /** The person's own words, instead of or as well as an option. */
  text?: string;
  /** recommended: Go With Recommendations answered it. */
  by: "you" | "recommended";
  at: string;
}

/** What Just Its Feel gives designers: one look at the page, in words. */
export type DesignLook =
  /** One quick look is under way, or the coordinator has still to open the page. */
  | { state: "reading" }
  | { state: "ready"; text: string; by: "vision" | "user"; model?: string }
  /** None of the person's models could read it: said plainly, never made up. */
  | { state: "unread"; reason: string };

export type DesignBriefWriting = "first" | "summary" | "answers" | "told" | "rewrite" | "screen";

export interface DesignBrief {
  /** The version on the card: every change raises it, and Start names the one it was pressed on. */
  rev: number;
  /** Raised when the summary, Full Prompt or questions change: what the coordinator's baseRev is held to. */
  textRev: number;
  summary: string;
  /** What the design sessions get, word for word; null until written. */
  prompt: string | null;
  /** user: saved by the person, so nothing else may change it. */
  promptBy: "coordinator" | "user" | null;
  /** The person edited the summary and hasn't told the coordinator anything since: it may not change it. */
  summaryHeld?: boolean;
  /** The Full Prompt is being written, and why; null when it is settled. */
  writing: { cause: DesignBriefWriting; stalled?: true; nudged?: true } | null;
  /** Something would change a Full Prompt the person saved: Keep My Prompt or Rewrite It, and Start waits. */
  conflict: { cause: "summary" | "told" | "answer" | "screen" } | null;
  questions: DesignBriefQuestion[];
  /** The look in words per link on Just Its Feel, by the link's address. */
  looks: Record<string, DesignLook>;
  /** The screen found, when there is one: Not This Screen clears it. */
  screen?: DesignConfirm;
  /** The colors and font names read off a captured page, by the link's address, as notes the designers get. Editable. */
  notes?: Record<string, { text: string; by: "capture" | "user" }>;
  /** Which images go to the designers, by the image's name; an image not listed goes. A person's click stands. */
  imageUse?: Record<string, { use: boolean; by: "user" | "coordinator" }>;
  /** How each pasted screenshot is used, by its name: rebuild (that screen is what's redesigned; designers that read pictures
      get it) or feel (only its words go). A person's click stands. */
  screenUse?: Record<string, { use: "rebuild" | "feel"; by: "user" | "coordinator" }>;
  /** Which of the run's named skills the designers use, by name, as the Creative Director chose (design_brief's skills).
      Absent: all of them. */
  skills?: string[];
  /** What the designs are estimated to cost in dollars, with the models and directions chosen now; absent when a price isn't known. */
  estimateUsd?: number;
  /** Set at Start: the brief is frozen from then on. */
  startedRev?: number;
  startedAt?: string;
}

/** Whether an image the user supplied is this run's own: pasted since the run began, or attached when it was asked for
    (run.images). Start, the Creative Director and the card all read a run's images by this one rule. */
export const runOwnImage = (a: { source: string; name: string; addedAt: string }, run: Pick<DesignRun, "createdAt" | "images">): boolean =>
  a.source === "yours" && (a.addedAt >= run.createdAt || (run.images ?? []).includes(a.name));

/** The skills a run's designers use: those the brief names among the run's skills, or all of the run's when it names none. */
export function designerSkills(run: Pick<DesignRun, "skills" | "brief">): DesignSkill[] {
  const all = run.skills ?? [];
  const picked = run.brief?.skills;
  return picked ? all.filter((s) => picked.includes(s.name)) : all;
}

/** Why Start can't be pressed: code to branch on, label for the button. */
export interface DesignBriefBlock {
  code: "question" | "writing" | "stalled" | "conflict" | "link-use" | "screenshot-use" | "look" | "images" | "no-designs";
  label: string;
}

/** The brief's named reason Start waits, or null: the server refuses Start by exactly this. `screenshots`: the names of
    the pasted screenshots that go to the designers (ticked), each of which needs Rebuild or Just Its Feel. */
export function designBriefBlock(run: Pick<DesignRun, "brief" | "setup" | "imagesBusy">, screenshots: readonly string[] = []): DesignBriefBlock | null {
  const b = run.brief;
  if (!b) return { code: "writing", label: "Writing the Brief" };
  const open = b.questions.filter((q) => !q.answer).length;
  if (open) return { code: "question", label: `Answer ${open} Question${open === 1 ? "" : "s"} First` };
  if (b.conflict) return { code: "conflict", label: "Choose Keep My Prompt or Rewrite It" };
  if (b.writing?.stalled || (b.prompt === null && !b.writing)) return { code: "stalled", label: "The Creative Director Hasn't Written the Prompt" };
  if (b.writing || b.prompt === null) return { code: "writing", label: "Writing the Full Prompt" };
  const links = run.setup.links ?? [];
  if (links.some((l) => l.use === null)) return { code: "link-use", label: "Choose How to Use Your Link" };
  if (screenshots.some((n) => !b.screenUse?.[n])) return { code: "screenshot-use", label: "Choose Rebuild or Just Its Feel" };
  if (links.some((l) => l.use === "feel" && b.looks[l.url]?.state === "reading")) return { code: "look", label: "Reading the Page's Look" };
  if (run.imagesBusy) return { code: "images", label: run.imagesBusy === "capturing" ? "Still Reading the Page's Images" : "Still Describing the Images" };
  const models = run.setup.models.filter((m) => m.design).length;
  const directions = run.setup.directions.filter((d) => d.on).length;
  if (!models || !directions) return { code: "no-designs", label: "Pick a Model and a Direction" };
  return null;
}

/** One design a setup will make. */
export interface DesignPlanItem {
  /** provider/modelId. */
  model: string;
  style: string;
  layout?: string;
}

/** A setup's designs, and how its count line reads them. */
export interface DesignPlan {
  items: DesignPlanItem[];
  models: number;
  styles: number;
  layouts: number;
  combine: DesignCombine;
  /** Pair Up: how many designs each model makes (the longer of the two lists); else 0. */
  pairs: number;
}

/** A permutation of 0..n-1 from a seed: 0 is the identity, any other seed a fixed shuffle. */
function dealOrder(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (!seed) return order;
  let s = seed >>> 0 || 1;
  const next = () => {
    // xorshift32: small, stable on every runtime, so the line and the launch deal alike.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * The one rule that turns a Setup into designs; the count line, the pairs line, the estimate, the limits and the
 * launch all read it. No layout ticked: every model makes every style. Pair Up: each model makes max(styles, layouts)
 * designs, round i pairing style i with layout i + the model's index (both lists repeating), so the pairs shift per
 * model; pairSeed shuffles the layouts' order first. Every Mix: every model makes every style in every layout.
 * Ordered style-major then model, as runs have always been labelled.
 */
export function designPlan(setup: Pick<DesignSetup, "models" | "directions" | "layouts" | "combine" | "pairSeed">): DesignPlan {
  const models = setup.models.filter((m) => m.design).map((m) => m.ref);
  const styles = setup.directions.filter((d) => d.on).map((d) => d.name);
  const ticked = (setup.layouts ?? []).filter((d) => d.on).map((d) => d.name);
  const combine: DesignCombine = setup.combine === "every" ? "every" : "pair";
  const items: DesignPlanItem[] = [];
  const base = { models: models.length, styles: styles.length, layouts: ticked.length, combine };
  if (!models.length || !styles.length) return { items, ...base, pairs: 0 };
  if (!ticked.length) {
    for (const style of styles) for (const model of models) items.push({ model, style });
    return { items, ...base, pairs: 0 };
  }
  if (combine === "every") {
    for (const style of styles) for (const layout of ticked) for (const model of models) items.push({ model, style, layout });
    return { items, ...base, pairs: 0 };
  }
  const layouts = dealOrder(ticked.length, setup.pairSeed ?? 0).map((i) => ticked[i]!);
  const rounds = Math.max(styles.length, layouts.length);
  for (let i = 0; i < rounds; i++) {
    models.forEach((model, m) => items.push({ model, style: styles[i % styles.length]!, layout: layouts[(i + m) % layouts.length]! }));
  }
  return { items, ...base, pairs: rounds };
}

/** "Bold & Vibrant · Bento", or the style alone. */
export const designDirectionLine = (d: { direction: string; layout?: string }): string => (d.layout ? `${d.direction} · ${d.layout}` : d.direction);

/** The full addresses a person's text names, in order, once each: what Setup's link rows come from. */
export function designLinksIn(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
  };
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) add(m[0]);
  for (const m of text.matchAll(/(?<![\w./-])(localhost|127\.0\.0\.1):\d{2,5}\b[^\s<>"'`)\]]*/g)) add(`http://${m[0]}`);
  return out;
}

export interface DesignCaps {
  batchDefault: number;
  askAbove: number;
  batchMax: number;
  concurrent: number;
}

/** The main chat's tool whose result anchors a Lookbook card. */
export const DESIGN_TOOL = "lookbook";

/** What a `design` result's details say when it put a card in the chat. */
export const isDesignCardDetails = (v: unknown): v is { designCard: { runId: string } } => typeof (v as { designCard?: { runId?: unknown } } | null | undefined)?.designCard?.runId === "string";

/** A batch: 6 by default, ask above 12, stop at 24 (q2). */
export const DESIGN_BATCH_DEFAULT = 6;
export const DESIGN_ASK_ABOVE = 12;
export const DESIGN_BATCH_MAX = 24;
/** Design sessions of one chat writing at once (t22): the rest read Queued. */
export const DESIGN_CONCURRENT = 6;
/** The safety stop on one reply of a design session, tool call or reply text alike: runaway output, not a page limit. */
export const DESIGN_SAFETY_CHARS = 1_048_576;
/** The times the server sends a page that didn't land back to its session before the card reads Failed. */
export const DESIGN_FIX_TRIES = 2;

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
