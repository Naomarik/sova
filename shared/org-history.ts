/**
 * Wire types for an organization's history: what was durably captured, by whom,
 * why, and with which explicit links. Imported by the server, the operator app and the overseers'
 * tools, so it imports nothing at runtime.
 *
 * Three truths stay apart. The statecharts are the state (current lifecycles); the history records
 * occurrences and the explanations recorded when they happened; the index, timelines, chains and
 * packets are rebuildable projections of the history. Nothing here decides a lifecycle.
 *
 * Storage (the org's workspace repo, portable):
 *   history/events/<yyyy-mm>.jsonl   one HistoryEvent per line, structural only: no person's words,
 *                                     no free text a model or the operator wrote, no About text, no
 *                                     contact value, no link or token. Only ever appended to.
 *   history/rationale/<eventId>.json the event's private recorded reason (HistoryRationale), kept
 *                                     until an explicit purge, read only by readers allowed it.
 * Host-local (rebuildable): <stateRoot>/org-history/<org>/ (the index, problems, capture gaps).
 *
 * Links are set when they are made, never inferred: a trigger or relation is written by the capture
 * that knew it, and a later correction is a new event, never an edit.
 *
 * Operator routes (main listener only), served by server/org-history-routes.ts:
 * GET /api/orgs/:id/history?project=&kind=&outcome=&actor=&initiation=&from=&to=&q=&asOf=&cursor=&limit= -> HistoryPage
 * GET /api/orgs/:id/history/events/:eid?asOf=                  -> EventDetail
 * GET /api/orgs/:id/history/events/:eid/chain?hops=&limit=&cursor= -> HistoryChain
 * GET /api/orgs/:id/history/events/:eid/packet                 -> HistoryPacket (and POST …/history/packet {query})
 * POST /api/orgs/:id/history/events/:eid/annotate|correct      -> {event, replayed} (server/org-history-annotations.ts)
 */

/** An event's id: opaque, globally stable (`he_` + 32 random hex), minted once, never derived from a
    time, a title or a host. */
export type EventId = string;

export const HISTORY_SCHEMA = 1;

/** Read bounds (a caller may ask for less, never more). */
export const HISTORY_BOUNDS = {
  /** Search hits per page. */
  searchHits: 50,
  /** Hops a trace walks each way. */
  hops: 2,
  /** Events in one trace. */
  nodes: 100,
  /** Characters of one packet's text. */
  packetChars: 12_000,
} as const;

/** What happened, by kind: the org's own workflows and its delivery milestones (not a coding
    session's individual tool calls). A kind this version doesn't know reads as `unsupported`. */
export const HISTORY_KINDS = [
  // requests and planning
  "request.made",
  "look.started",
  "gap.filed",
  "gap.planned",
  "gap.closed",
  // gathering
  "gathering.started",
  "gathering.handed-off",
  "gathering.offered",
  "gathering.closed",
  // deliberation
  "decision.recorded",
  "decision.superseded",
  "conflict.opened",
  "conflict.settled",
  // guards and holds
  "hold.created",
  "hold.released",
  "hold.cancelled",
  "act.refused",
  // delivery
  "promotion.made",
  "build.started",
  "build.prompted",
  "build.finished",
  "merge.requested",
  "merge.observed",
  "test.observed",
  "validation.observed",
  "preview.started",
  "preview.made",
  // people and the org
  "outreach.sent",
  "owner-update.posted",
  "owner-update.removed",
  "project.placed",
  "project.archived",
  "project.unarchived",
  "person.added",
  "person.status-changed",
  "setting.changed",
  "stop.made",
  // the history about itself
  "annotation.added",
  "correction.recorded",
  "rationale.purged",
  "history.gap",
  "history.imported",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** How it came out. A decision's disposition (chosen/rejected/deferred/won't do) stays apart from a
    guard's refusal, a cancelled hold, a failed effect and an outside act whose result never came back. */
export const HISTORY_OUTCOMES = [
  "done",
  "started",
  "recorded",
  "observed",
  "held",
  "released",
  "cancelled",
  "refused",
  "failed",
  "unknown",
  "chosen",
  "rejected",
  "deferred",
  "do-not-do",
] as const;
export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];

/** The outcome's word. */
export const OUTCOME_WORDS: Record<HistoryOutcome, string> = {
  done: "Done",
  started: "Started",
  recorded: "Recorded",
  observed: "Observed",
  held: "Held",
  released: "Released",
  cancelled: "Cancelled",
  refused: "Refused",
  failed: "Failed",
  unknown: "Unknown",
  chosen: "Chosen",
  rejected: "Rejected",
  deferred: "Deferred",
  "do-not-do": "Won't do",
};

/** The kind's own headline, used when the reader may not read (or there is no) recorded `what`. */
export const KIND_HEADLINES: Record<HistoryKind, string> = {
  "request.made": "Request made",
  "look.started": "Look started",
  "gap.filed": "Gap filed",
  "gap.planned": "Gap planned",
  "gap.closed": "Gap closed",
  "gathering.started": "Gathering started",
  "gathering.handed-off": "Gathering handed off",
  "gathering.offered": "Gathering offered",
  "gathering.closed": "Gathering closed",
  "decision.recorded": "Decision recorded",
  "decision.superseded": "Decision superseded",
  "conflict.opened": "Conflict opened",
  "conflict.settled": "Conflict settled",
  "hold.created": "Act held",
  "hold.released": "Held act released",
  "hold.cancelled": "Held act cancelled",
  "act.refused": "Act refused",
  "promotion.made": "Requirements promoted",
  "build.started": "Coding session started",
  "build.prompted": "Coding session prompted",
  "build.finished": "Coding session finished",
  "merge.requested": "Merge requested",
  "merge.observed": "Merge observed",
  "test.observed": "Test result observed",
  "validation.observed": "Validation result observed",
  "preview.started": "Preview link requested",
  "preview.made": "Preview link made",
  "outreach.sent": "WhatsApp send",
  "owner-update.posted": "Owner update posted",
  "owner-update.removed": "Owner update taken down",
  "project.placed": "Project placed",
  "project.archived": "Project archived",
  "project.unarchived": "Project unarchived",
  "person.added": "Person added",
  "person.status-changed": "Person's status changed",
  "setting.changed": "Setting changed",
  "stop.made": "Stopped",
  "annotation.added": "Added later",
  "correction.recorded": "Correction recorded",
  "rationale.purged": "Reason purged",
  "history.gap": "History not saved",
  "history.imported": "History imported",
};

/** Who, as recorded: a stable id and a role, never a profile field (no contact, no steering). */
export interface ActorRef {
  kind: "operator" | "person" | "project-overseer" | "global-overseer" | "model" | "sova" | "statechart" | "system" | "worker" | "session" | "validation-runner" | "external";
  /** A person id, a project id (its overseer), a worker or session id. */
  id?: string;
  /** The operator acting through the global Overseer. */
  via?: "overseer";
  /** A model's id, only when the runtime supplied it. */
  model?: string;
  /** The session it acted in, only when the runtime supplied it. */
  session?: string;
}

/** A value not recorded. Never filled in with the operator or anyone else. */
export interface Unknown {
  unknown: true;
  why?: string;
}

export function isUnknown(v: unknown): v is Unknown {
  return typeof v === "object" && v !== null && (v as Unknown).unknown === true;
}

/** What allowed the act, as evaluated for that act: never inherited from what started the chain. */
export interface Authorization {
  kind: "operator-act" | "attended-turn" | "autonomy-level" | "grant" | "confirm-card" | "hold-release" | "person-decision" | "safety" | "none";
  /** The level in force, for `autonomy-level`. */
  level?: string;
  attended?: boolean;
  /** The grant, card or hold it rests on, by id. */
  ref?: string;
  by?: ActorRef;
}

/** Five facts, never one. */
export interface ActorBundle {
  initiatedBy: ActorRef | Unknown;
  decidedBy: ActorRef | Unknown;
  recordedBy: ActorRef | Unknown;
  executedBy: ActorRef | Unknown;
  authorization: Authorization | Unknown;
}

export interface EntityRef {
  type: "org" | "project" | "person" | "gap" | "gathering" | "decision" | "conflict" | "build" | "hold" | "promotion" | "session" | "commit" | "file" | "outreach" | "owner-update" | "setting" | "spec-claim" | "look" | "preview" | "instance";
  id: string;
}

/** A trigger: the request, timer, tool call, effect, spawn or notification this event actually came
    from, written when it was queued or created. The only causal link. */
export interface Trigger {
  event: EventId;
  via: "request" | "timer" | "tool-call" | "effect" | "spawn" | "notification" | "operator-act" | "invocation";
}

/** Every other relation: shown with its own label, never as a cause. */
// A relation on event X with target Y reads 'X <type> Y' (X supersedes Y; X supports Y; a decision X
// recorded-in the gathering Y it was recorded in; an act X named-target the start Y of the session it was
// addressed to, or of a decision its start data declares; a note or a correction X about the event Y it names, read
// from its `about`).
export const RELATION_TYPES = ["supports", "related", "supersedes", "amends", "revokes", "corrects", "adopts", "context-of", "source-for", "named-target", "depends-on", "member-of", "recorded-in", "about"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Relation {
  type: RelationType;
  target: { event: EventId } | { entity: EntityRef };
}

/** A link refused when the event was recorded, kept so it is said, not lost. */
export interface RefusedLink {
  /** The event id, key or batch ref it named. */
  target: string;
  as: "triggeredBy" | RelationType;
  why: "cycle" | "no-such-event" | "other-org";
}

/** A deliberate choice, a choice not to act included. */
export interface DecisionBody {
  disposition: "choose" | "reject" | "defer" | "do-not-do";
  /** Stable option ids and their outcome; their labels and reasons are in the rationale. */
  options: { id: string; outcome: "selected" | "rejected" | "deferred" | "do-not-do" }[];
  /** The scope it covers beyond the event's projects (a gap, an area key). */
  scope?: EntityRef[];
  authority: ActorRef | Unknown;
  /** For defer: the date it waits for (its condition's words are in the rationale). */
  reviewAt?: number;
}

/** A quote's check against its message, through the neutral reader. Every value but `checked` reads
    "not checked". */
export type QuoteCheck = "checked" | "quote-not-found" | "speaker-mismatch" | "source-unavailable" | "unchecked";

/** What an event cites. Never a file path or a share link. */
export type EvidenceRef = { n: number } & (
  /** `why`: the exact reason an `unchecked` quote wasn't checked (a fixed sentence, never the message's words). */
  | { kind: "transcript"; session: string; entry: string; span?: [number, number]; speaker?: ActorRef; digest?: { sha: string; len: number }; check: QuoteCheck; why?: string }
  | { kind: "event"; event: EventId }
  /** A row of the statecharts' transition log, by its session, time and row key. */
  | { kind: "log-row"; session: string; at: number; k?: string }
  | { kind: "runtime"; what: string; session?: string; at?: number }
  | { kind: "git"; repo: "project" | "workspace"; project?: string; commit?: string; branch?: string }
  | { kind: "spec"; project: string; claim: string }
  | { kind: "validation"; runner: string; result: "passed" | "failed" | "unknown"; project?: string }
);

/** Where a citation stands when read. */
export type SourceAvailability = "available" | "missing" | "withheld" | "changed" | "unsupported-version" | "corrupt" | "other-host" | "unchecked";

/** The policy the act was evaluated under, at that attempt. */
export interface PolicyAt {
  attended: boolean;
  autonomy?: string;
  inForce?: string;
  paused?: boolean;
  hold?: string;
  card?: string;
  grants?: string[];
}

/** One line of history/events/<yyyy-mm>.jsonl. Structural only. */
export interface HistoryEvent {
  v: typeof HISTORY_SCHEMA;
  id: EventId;
  org: string;
  kind: HistoryKind;
  outcome: HistoryOutcome;
  /** Membership as of the event: the project it belongs to (null: org-level) and the others it affects. */
  projects: { primary: string | null; affected: string[] };
  entities: EntityRef[];
  actors: ActorBundle;
  times: {
    recordedAt: number;
    /** When it happened, when the source knows (absent: not recorded). */
    occurredAt?: number;
  };
  /** The adapter that wrote it (and its version), the key that makes recording the same happening twice
      record it once, and the journal step it was written in (`txn`: grouping only, never a link). */
  source: { adapter: string; version: number; key: string; txn?: string };
  /** Other keys this event answers to (`effect:<key>`, `invoke:<runId>`, `hold:<id>`), so a later
      capture can name it as a trigger by key. */
  aliases?: string[];
  /** Local order without a hostname: the writer's epoch and its sequence. Never compared across writers. */
  writer: { epoch: string; seq: number };
  triggeredBy: Trigger[];
  relations: Relation[];
  refusedLinks?: RefusedLink[];
  decision?: DecisionBody;
  evidence: EvidenceRef[];
  policy?: PolicyAt;
  capture: { origin: "live" | "imported" | "gap"; importedAt?: number; importOf?: { kind: string; id: string } };
  /** It has a rationale file (it may since have been purged). */
  rationale?: boolean;
  /** An annotation's, correction's or purge's subject. */
  about?: EventId;
  /** A correction's structural change to its subject; as-of reads apply it from its recordedAt. */
  correction?: { projects?: { primary: string | null; affected: string[] } };
  /** history.gap: the interval history wasn't saved in. */
  gap?: { from: number; to: number };
}

/** history/rationale/<eventId>.json: what the event's recorder wrote, and the cited quotes. */
export interface HistoryRationale {
  v: typeof HISTORY_SCHEMA;
  event: EventId;
  /** The headline: what was decided or happened, verb and object. */
  what?: string;
  reason?: { text: string; author: ActorRef | Unknown; contemporaneous: boolean };
  options?: { id: string; label: string; reason?: string; condition?: string }[];
  /** Quoted words, by the evidence `n` they come from. */
  quotes?: { n: number; text: string }[];
}

/** What a capture hands the recorder: an event without what the recorder mints. */
export interface HistoryInput {
  kind: HistoryKind;
  outcome: HistoryOutcome;
  projects: { primary: string | null; affected?: string[] };
  entities?: EntityRef[];
  actors: Partial<ActorBundle>;
  occurredAt?: number;
  source: { adapter: string; version: number; key: string };
  aliases?: string[];
  triggeredBy?: Trigger[];
  /** Triggers by key (a `source.key` or alias), resolved against the index and the earlier inputs of the
      same batch. Unresolved: an optional one is left out ("Trigger not recorded"), a required one is
      refused and noted in `refusedLinks`. */
  parentKeys?: { key: string; via: Trigger["via"]; optional?: boolean }[];
  relations?: Relation[];
  /** Relations to an event by key, resolved like `parentKeys`. With `entity`, one that resolves to nothing
      (its event was recorded before capture started, or never) is kept as a relation to that entity: a
      reference read as not in this history, never an event and never a cause. */
  relationKeys?: { key: string; type: RelationType; optional?: boolean; entity?: EntityRef }[];
  decision?: DecisionBody;
  evidence?: EvidenceRef[];
  policy?: PolicyAt;
  capture?: HistoryEvent["capture"];
  about?: EventId;
  correction?: HistoryEvent["correction"];
  gap?: HistoryEvent["gap"];
  rationale?: Omit<HistoryRationale, "v" | "event">;
}

/** Who reads, and so what a result may hold. Nothing else reads it. */
export type HistoryReader = { role: "operator" } | { role: "global-overseer" } | { role: "project-overseer"; project: string };

export const INITIATIONS = ["operator", "overseer", "person", "system", "unknown"] as const;
export type Initiation = (typeof INITIATIONS)[number];

export interface HistoryQuery {
  /** Any of these, as the event's own project or one it affects. */
  projects?: string[];
  kinds?: HistoryKind[];
  outcomes?: HistoryOutcome[];
  /** Actor keys, any role: `operator`, `person:<id>`, `project-overseer:<p>`, `global-overseer`, `model`, `sova`, … */
  actors?: string[];
  initiation?: Initiation[];
  /** Recorded time, inclusive. */
  from?: number;
  to?: number;
  /** Literal words, all of them, in the headline and readable rationale. */
  text?: string;
  /** Read as of this time: corrections, supersessions and events recorded later don't apply. */
  asOf?: number;
  limit?: number;
  cursor?: string;
  /** The events grouped under this one (Show Details): its recorded consequences written in the same
      journal step. Without it, a grouped event is listed only under its group's row. */
  groupOf?: EventId;
}

/** The index's freshness. */
export interface IndexFreshness {
  /** The newest recorded event it includes (the as-of high-water mark). */
  through: number | null;
  events: number;
  /** False while the event files have bytes not yet indexed. */
  current: boolean;
  rebuiltAt: number | null;
}

/** What the history covers. */
export interface HistoryCoverage {
  /** The first live-captured event, null with none. */
  capturedSince: number | null;
  /** Imported events reach back to here (earlier history partial). */
  importedSince: number | null;
  /** Capture gaps (the event id only for a reader who may open org-level events). */
  gaps: { from: number; to: number; event?: EventId }[];
  /** A capture gap still open (history can't be saved now), from when. */
  savingSince: number | null;
  problems: HistoryProblem[];
}

export interface HistoryProblem {
  kind: "unreadable" | "id-conflict" | "torn-tail";
  file: string;
  line?: number;
  event?: EventId;
  why: string;
}

export interface ProjectLabel {
  id: string;
  name: string;
  archived?: boolean;
}

/** An actor as a reader sees it: its record and a display label. */
export type ActorView = (ActorRef & { label: string }) | Unknown;

/** A row of a list. Headline and reason are server-made from what the reader may read. */
export interface EventSummary {
  id: EventId;
  kind: HistoryKind | "unsupported";
  outcome: HistoryOutcome | "unsupported";
  headline: string;
  /** The recorded reason's first line, when there is one and the reader may read it. */
  reason?: string;
  reasonState: "recorded" | "added-later" | "not-recorded" | "purged" | "withheld";
  disposition?: DecisionBody["disposition"];
  project: ProjectLabel | null;
  affected: ProjectLabel[];
  recordedAt: number;
  occurredAt?: number;
  /** Absent on a boundary card for a reader who may see only its kind, outcome, time and project. */
  actors?: { initiatedBy: ActorView; decidedBy: ActorView; recordedBy: ActorView; executedBy: ActorView; authorization: Authorization | Unknown };
  initiation: Initiation;
  attended?: boolean;
  origin: HistoryEvent["capture"]["origin"];
  /** Superseded, revoked or amended as of the read. */
  superseded?: { by: EventId; type: "supersedes" | "revokes" | "amends"; at: number };
  /** A boundary card: an event of another project, shown only because a permitted link reaches it; it
      is never counted as a filtered row and carries kind, outcome, time and project only. */
  boundary?: boolean;
  /** Lower-level events grouped under this row (Show Details), counted from what the reader may see. */
  group?: { count: number };
}

export interface HistoryPage {
  items: EventSummary[];
  /** Events matching that the reader may see, before paging. */
  total: number;
  cursor: string | null;
  /** With a project filter only: distinct events outside it, readable here, that a recorded link
      reaches from a matching event of the result ("{n} linked outside this filter"). */
  linkedOutside?: number;
  freshness: IndexFreshness;
  coverage: HistoryCoverage;
}

export interface EvidenceView {
  ref: EvidenceRef;
  availability: SourceAvailability;
  /** The quoted words, when the reader may read them. */
  quote?: string;
}

export interface LinkView {
  event: EventSummary;
  /** A trigger's `via`, or a relation's type. */
  via?: Trigger["via"];
  type?: RelationType;
  direction: "in" | "out";
}

export interface EventDetail {
  event: EventSummary;
  record: HistoryEvent | null;
  rationale: HistoryRationale | null;
  options: { id: string; outcome: string; label?: string; reason?: string; condition?: string }[];
  evidence: EvidenceView[];
  triggeredBy: LinkView[];
  resultedIn: LinkView[];
  related: LinkView[];
  /** Annotations and corrections recorded later, oldest first. */
  later: EventSummary[];
  /** Triggers named but not in this index ("Trigger not recorded" applies only with none named). */
  unresolved: EventId[];
  refusedLinks: RefusedLink[];
  freshness: IndexFreshness;
}

export interface ChainEdge {
  from: EventId;
  to: EventId;
  /** A trigger (`via`, causal) or a relation (`type`); never both. */
  via?: Trigger["via"];
  type?: RelationType;
  /** Which it is: a trigger is a `cause`, every other recorded relation a `relation`, never a cause. */
  link: "cause" | "relation";
}

export interface HistoryChain {
  root: EventId;
  /** Each with its hop: negative before the event, positive after it. `reached`: through recorded triggers only
      (`cause`, a cause or a consequence), or through a relation somewhere on the way (`relation`); none on the root. */
  nodes: (EventSummary & { hop: number; reached?: "cause" | "relation" })[];
  edges: ChainEdge[];
  /** Events the reader may see past the bound on each side, not returned (never a withheld one). */
  omitted: { before: number; after: number };
  cursor: string | null;
  /** Events in the chain with no recorded trigger ("Trigger not recorded"). */
  noTrigger: EventId[];
  freshness: IndexFreshness;
}

/** A bounded, deterministic context packet: the same history and input give the same text. */
export interface HistoryPacket {
  scope: { query?: HistoryQuery; event?: EventId; reader: HistoryReader["role"]; project?: string };
  asOf: number | null;
  text: string;
  events: EventId[];
  citations: { n: number; event: EventId; kind: EvidenceRef["kind"]; availability: SourceAvailability }[];
  unknowns: string[];
  /** Events the reader may see that were cut for the bound, and their characters (never a withheld one). */
  omitted: { events: number; chars: number };
  freshness: IndexFreshness;
}

/** The acts that still go when history can't be saved: a fixed list of
    (statechart, event), never a caller's say-so. Each one run then is covered by a capture gap. */
export const SAFETY_ACTS: readonly { statechart: string | "*"; event: string }[] = [
  { statechart: "*", event: "hold/cancel" },
  { statechart: "project", event: "services/down" },
];

/** One kind's capture promise. */
export interface CaptureRow {
  kind: HistoryKind;
  /** Where the fact comes from (a statechart event, a route, a tool). */
  source: string;
  /** How the five actor facts are filled. */
  actors: string;
  /** The source key's shape. */
  key: string;
  /** The capture adapter and version that promise it, null until one does. When capture started is never
      written here: it is the org's own first captured event (coverage `capturedSince`, read at runtime). */
  by: { adapter: string; version: number } | null;
}

/** The org's step adapter (server/org-history-capture.ts `ADAPTER`, `ADAPTER_VERSION`). */
export const ORG_STEPS = { adapter: "org-steps", version: 1 } as const;

/** The capture matrix: a kind no adapter promises (`by` null) is not captured. Rows are the capture adapters'. */
export const CAPTURE_MATRIX: readonly CaptureRow[] = [
  // server/org-history-capture.ts (adapter `org-steps` v1), inside the org host's commit. Actors are the act's
  // envelope as stamped: operator → all operator; via the global Overseer → decided by it (a confirm card is its authorization, never the operator's decision);
  // overseer → decided and recorded by the project overseer, initiated by the operator only in an attended turn;
  // statechart → decided by the statechart; model → recorded by the gathering's model; anything unsaid unknown.
  // Links, all relations (never a cause) from ids the step itself carries: an act on a gap, a gathering, a build,
  // a decision or a conflict names the event that started it (`named-target`: gap:<g>, sc:baton/<org>/<sid>,
  // sc:build/<p>/<sid>, decision:<id>, conflict:<sid>); one recorded before capture is kept as an entity reference.
  { kind: "request.made", source: "watch operator/run-now", actors: "operator act", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "look.started", source: "a watch's sova/look run (Run Now's: triggered by it)", actors: "initiated: operator for Run Now, else unknown; decided: statechart", key: "look:<run id>", by: ORG_STEPS },
  { kind: "gap.filed", source: "placement gap/file", actors: "the act's envelope", key: "step:<journal>:<i>, alias gap:<gap id>", by: ORG_STEPS },
  { kind: "gap.planned", source: "item gather/plan", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "gap.closed", source: "item gap/drop", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "gathering.started", source: "placement baton/start, item gather/start", actors: "the act's envelope", key: "step:<journal>:<i>, alias sc:baton/<org>/<session id>; named-target its gap", by: ORG_STEPS },
  { kind: "gathering.handed-off", source: "baton baton/hand-to, baton/handoff", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "gathering.offered", source: "baton baton/offer", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "gathering.closed", source: "baton baton/close, baton/goal-done", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "decision.recorded", source: "baton baton/record-decision (record_decision, marker recovery), recorded-in its gathering; sova_decide; the operator's stated settle (the decision statechart's start with no gathering, triggered by its conflict/settle by the id it declared)", actors: "decided: the sender-marked person (quote checked), the recording model, or the operator; recorded: the model, overseer or Sova", key: "decision:<decision id>", by: ORG_STEPS },
  { kind: "decision.superseded", source: "decision reconcile/result entering superseded with its supersededBy (a reconciler run, a settle by hand): supersedes the earlier, related to the later", actors: "decided: not recorded; recorded: sova", key: "superseded:<decision id>:<by id>", by: ORG_STEPS },
  { kind: "conflict.opened", source: "a conflict statechart's start", actors: "the reconciler's", key: "conflict:<session>", by: ORG_STEPS },
  { kind: "conflict.settled", source: "conflict conflict/settle", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "hold.created", source: "any held act", actors: "the act's envelope", key: "hold:<session>:<hold id>", by: ORG_STEPS },
  { kind: "hold.released", source: "hold/approve; hold/released (by approval, or by its timer in the host's timer call)", actors: "decided: the approver, or the statechart at its time", key: "step:<journal>:<i> / release:<session>:<hold id>", by: ORG_STEPS },
  { kind: "hold.cancelled", source: "hold/cancel", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "act.refused", source: "any refused act with an actor; hold/dropped", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "promotion.made", source: "reconciler decision/promote (named-target each id asked); its promote effect's answer (adopts each id promoted)", actors: "the act's envelope; the answer: an outside result", key: "step:<journal>:<i> / answer:<effect key>", by: ORG_STEPS },
  { kind: "build.started", source: "project/item build/start, project verbs/onboard (named-target its gap and the decisions its build statechart was started with); make-worktree's answer", actors: "the act's envelope", key: "step:<journal>:<i>, alias sc:build/<project>/<session id>", by: ORG_STEPS },
  { kind: "build.prompted", source: "build build/prompt, project session/prompt", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "build.finished", source: "build turn/ended (each turn)", actors: "executed: the coding session; decided unknown", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "merge.requested", source: "build build/merge", actors: "the act's envelope", key: "step:<journal>:<i>, alias effect:<key>", by: ORG_STEPS },
  { kind: "merge.observed", source: "the merge effect's answer (commit); build correct/merged", actors: "an outside result; a correction: its envelope", key: "answer:<effect key>", by: ORG_STEPS },
  { kind: "validation.observed", source: "runtime conform effect's answer", actors: "an outside result", key: "answer:<effect key>", by: ORG_STEPS },
  { kind: "preview.started", source: "project preview/start (the coding session it serves; named-target its build start), project services/share (the running copy's instance id); never a link, a token or the purpose", actors: "the act's envelope", key: "step:<journal>:<i>, alias effect:<key>", by: ORG_STEPS },
  { kind: "preview.made", source: "the preview or services-share effect's answer (the preview by id, alias preview:<id>; a failure without its text)", actors: "an outside result", key: "answer:<effect key>", by: ORG_STEPS },
  { kind: "outreach.sent", source: "placement outreach/send (a preview link it carries: the preview by id, named-target preview:<id>); outreach-send's answer (sent, refused, failed, unknown)", actors: "the act's envelope; person by id only", key: "step:<journal>:<i> / answer:<effect key>", by: ORG_STEPS },
  { kind: "owner-update.posted", source: "placement owner-update/post", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "project.placed", source: "org project/place, when it started the project's placement", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "project.archived", source: "project project/archive", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "project.unarchived", source: "project project/unarchive", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "person.added", source: "org person/add (the person by id only, never their profile)", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "person.status-changed", source: "person person/approve, person/decline, person/leave, person/revert, when its status moved", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "setting.changed", source: "org owner/set, placement stakeholder/set, spec/freeze, watch operator/level-set, decision decision/owner-area, person person/edit of their decision areas", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "stop.made", source: "project services/down", actors: "the act's envelope", key: "step:<journal>:<i>", by: ORG_STEPS },
  { kind: "rationale.purged", source: "Purge Reason… (history routes)", actors: "initiated, decided, recorded: operator; executed: sova", key: "purge:<event id>", by: null },
  { kind: "history.gap", source: "the recorder, once saving works again", actors: "recorded and executed: sova; the rest unknown", key: "gap:<from>", by: null },
  { kind: "history.imported", source: "the one-time import", actors: "recorded and executed: sova; the rest unknown", key: "import:<source kind>:<source id>", by: { adapter: "import", version: 1 } },
  // Not captured in this release: no adapter writes these (a referral's proposed person and a person's other
  // profile edits aren't captured either).
  { kind: "test.observed", source: "none yet", actors: "", key: "", by: null },
  { kind: "owner-update.removed", source: "none yet", actors: "", key: "", by: null },
  // server/org-history-annotations.ts: the operator's own request only (never the Overseer or a model)
  { kind: "annotation.added", source: "POST …/history/events/:eid/annotate {requestId, what, reason}: about the event, Added later", actors: "initiated, decided, recorded: operator; executed: sova", key: "note:<requestId>", by: { adapter: "history-notes", version: 1 } },
  { kind: "correction.recorded", source: "POST …/history/events/:eid/correct {requestId, what, reason, projects?}: corrects the event", actors: "initiated, decided, recorded: operator; executed: sova", key: "correction:<requestId>", by: { adapter: "history-notes", version: 1 } },
];
