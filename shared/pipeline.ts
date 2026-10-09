// The project page's Pipeline and the statechart acts waiting in a hold: the wire contract between the
// org routes and the page (§app.project-overseer/pipeline, §app.project-overseer/holds).
//
// GET  /api/orgs/:id/projects/:pid/pipeline                   -> PipelineInfo
// POST /api/orgs/:id/projects/:pid/pipeline/:itemId/hold      {} -> PipelineInfo (operator only; 409 + the statechart's sentence when refused)
// POST /api/orgs/:id/projects/:pid/pipeline/:itemId/resume    {} -> PipelineInfo (same)
// GET  /api/orgs/:id/projects/:pid/pipeline/:itemId/timeline  -> PipelineTimeline
// POST /api/orgs/:id/held/:holdId/cancel {reason?}           -> { ok: true } (404 unknown; 409 + sentence when it already went ahead)

/** One gap's row (a `§gap/…` item of the project, its statechart's lane state and links). */
export interface PipelineRow {
  /** The item's stable session id, `g_` + 8. */
  itemId: string;
  /** The idea id, "§gap/<name>" (follows the ideas store's renames). */
  gap: string;
  /** The idea's title. */
  title: string;
  /** The item statechart's lane state id, verbatim ("asking", "conflicted", "on-hold", "done", …). */
  phase: string;
  /** ISO time it entered this phase. */
  since: string;
  /** Present once the phase's stall timer fired (it waited past the stall time). */
  stalled?: { since: string };
  /** Present while on hold: since when, and the lane state Resume returns to. */
  held?: { since: string; from: string };
  /** The follow-up region's state, when a follow-up gathering runs ("follow-up-asking", …); absent: none. */
  followUp?: string;
  gatherings: PipelineGathering[];
  decisions: PipelineDecision[];
  builds: PipelineBuild[];
  /** The operator's Hold / Resume are enabled events of the item now. */
  canHold: boolean;
  canResume: boolean;
}

export interface PipelineGathering {
  sessionId: string;
  /** The session file on this host, for #/s/<path>; absent when it is on another host. */
  path?: string;
  title: string;
  state: "open" | "needs-you" | "done" | "closed";
  /** Display name of who holds it; null when done or closed. */
  holder?: string | null;
}

export interface PipelineDecision {
  id: string;
  statement: string;
  /** shared/decisions DecisionState ("pending", "conflict", "drafted", "promoted", …). */
  state: string;
}

export interface PipelineBuild {
  sessionId: string;
  path?: string;
  title: string;
  turn: "idle" | "working" | "failed";
  branch?: "no-commits" | "unmerged" | "merged" | "new-since-merge";
  /** Its mode could not be set, so its first prompt was never sent (the sentence to show). */
  notPrompted?: string;
}

/**
 * An act a statechart (or the overseer's unattended tool call) started that reaches a person or the
 * client's code, waiting before it goes ahead.
 */
export interface HeldAct {
  /** `${sessionId}:${holdId}` (F19): the statechart's hold id is unique only within its session. Opaque to the UI. */
  id: string;
  projectId: string;
  itemId?: string;
  gap?: string;
  /** A noun phrase that reads as the subject of "{what} starts in {n} min unless you cancel it.":
      "A gathering with Sam Okafor about pricing". */
  what: string;
  kind: string;
  /** ISO time it goes ahead. */
  goesAt: string;
  /** ISO time it was held. */
  since: string;
  by?: "overseer" | "statechart";
  /** "hours": it waits for a person's working hours (r7), `goesAt` is when their window opens; "outage": a WhatsApp
      message waits for WhatsApp to come back, `goesAt` is its 24 h bound (then it is not sent); absent: the hold (r2). */
  wait?: "hold" | "hours" | "outage";
  /** An hours wait's person, by display name. */
  person?: string;
  /** ISO: the hold ended and it waits for the overseer to approve it (r8: an act on the project's confirm list); a stall clock runs from here. */
  reviewSince?: string;
}

export interface PipelineInfo {
  rows: PipelineRow[];
  /** This project's acts waiting in a hold, soonest first. */
  held: HeldAct[];
}

/** One row of an item's timeline, from the org's transition log. */
export interface TimelineRow {
  /** ISO; unique per org (the log's row identity). */
  at: string;
  event: string;
  /** "operator", "overseer", "statechart", or a person's display name. */
  by: string;
  /** "overseer" when the operator acted through the global Overseer. */
  via?: string;
  /** The lane state before and after, when it moved. */
  from?: string;
  to?: string;
  /** The server's sentence for what happened: "A gathering with Sam Okafor started." */
  line: string;
  /** A correction's reason, or a cancel's. */
  reason?: string;
  /** The refusal sentence, when a guard refused the act. */
  refused?: string;
  /** The transition's feed class is `quiet` (r8a: a timer re-armed, a lease renewed, bookkeeping). */
  quiet?: boolean;
}

export interface PipelineTimeline {
  itemId: string;
  rows: TimelineRow[];
}
