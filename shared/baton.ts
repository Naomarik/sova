/**
 * Wire types and marker names for baton sessions (§app/baton). Imported by the server, the
 * operator app and the share page (src/share/), so it imports nothing at runtime.
 *
 * Operator routes (main listener):
 * POST /api/baton                    body BatonStartInput -> 201 BatonStartResult
 * GET  /api/baton?path=<session>     -> BatonInfo
 * GET  /api/baton/:sid/link          -> { link: string (as BatonStartResult.link); n: number } (mints a fresh link for the current
 *                                    hand-off and revokes that hand-off's older links; 409 when the operator holds it)
 * POST /api/baton/:sid/revoke        -> BatonInfo (revokes every link of the current hand-off)
 * POST /api/baton/:sid/take          -> BatonInfo (Take back: a hand-off to the operator)
 * POST /api/baton/:sid/close         -> BatonInfo
 * POST /api/baton/:sid/extend        body { by } -> BatonInfo (raises the message limit by `by`)
 * GET  /api/baton/settings           -> BatonSettings; PUT body BatonSettings -> BatonSettings (the host's defaults)
 *
 * Share listener (the only routes it has):
 * GET  /h/<token>                    the share page
 * GET  /h/assets/*                   its build (dist-share/)
 * GET  /api/h/<token>                -> BatonView
 * POST /api/h/<token>/message        body { text } -> 202 { ok: true } | 4xx { error, code }
 * WS   /ws/h?token=<token>           ShareServerMessage stream (hello, view, streaming)
 */

/** `customType` of the marker a baton session's file carries (data `BatonMarkerData`). */
export const BATON_ENTRY = "sova-baton";
/** Beside every user message: who sent it (data `BatonSentData`). */
export const BATON_SENT_ENTRY = "sova-baton-sent";
/** A hand-off (data `BatonHandoffData`). */
export const BATON_HANDOFF_ENTRY = "sova-baton-handoff";
/** A decision the model recorded (data `BatonDecisionData`). */
export const BATON_DECISION_ENTRY = "sova-baton-decision";
/** The goal is met (data `BatonDoneData`). */
export const BATON_DONE_ENTRY = "sova-baton-done";
/** The baton went to a pool of invitees (data `BatonOfferData`); also a hand-off (it takes a hand-off number). */
export const BATON_OFFER_ENTRY = "sova-baton-offer";
/** An offer's lease changed hands (data `BatonLeaseData`). */
export const BATON_LEASE_ENTRY = "sova-baton-lease";
/** The model proposed a person for the roster (data `BatonProposalData`). */
export const BATON_PROPOSAL_ENTRY = "sova-baton-proposal";
/** The autonomous wrap-up (data `BatonWrapupData`). Everything from its "start" entry on is the
    wrap-up turn: never in the outsider view, never counted in the budget. */
export const BATON_WRAPUP_ENTRY = "sova-baton-wrapup";

/** `Handoff.to` of an offer's hand-off: nobody yet, the pool of `Offer.to`. */
export const POOL: PersonRef = "pool";
/** An offer's lease: idle time after the later of the holder's last message and the last reply.
    The server reads SOVA_BATON_LEASE_MS instead when it is set (hermetic tests only). */
export const LEASE_IDLE_MS = 15 * 60_000;

/** A session's message limit (messages in, §app.baton/goal-and-loadout): the default when
    Settings holds none, and the bounds every limit (the default, a start's own, an extension's
    result) must stay within. */
export const MESSAGES_DEFAULT = 60;
export const MESSAGES_MIN = 1;
export const MESSAGES_CAP = 1000;

/** "operator" or a roster person's id. */
export type PersonRef = string;
export const OPERATOR: PersonRef = "operator";

export interface BatonMarkerData {
  v: 1;
  orgId: string;
  projectId: string;
}
export interface BatonSentData {
  v: 1;
  targetId: string;
  by: PersonRef;
}
export interface BatonHandoffData {
  v: 1;
  n: number;
  from: PersonRef;
  to: PersonRef;
  question: string;
  briefing: string;
}
export interface BatonDecisionData {
  v: 1;
  /** The topic, in a few words: files the decision in the spec. */
  area: string;
  /** Who decides it: one of the roster's decision areas as the roster spells it, or "none"
      (shared/decisions.ts OWNER_AREA_NONE). Absent from decisions recorded before owner areas. */
  ownerArea?: string;
  statement: string;
  quote: string;
  by: PersonRef;
}
export interface BatonDoneData {
  v: 1;
  summary: string;
}
export interface BatonOfferData {
  v: 1;
  n: number;
  offerId: string;
  from: PersonRef;
  to: PersonRef[];
  question: string;
  briefing: string;
}
export interface BatonLeaseData {
  v: 1;
  n: number;
  offerId: string;
  /** claimed: `by` took the offer with an accepted message; expired: `by`'s lease ran out, back to the pool. */
  event: "claimed" | "expired";
  by: PersonRef;
}
export interface BatonProposalData {
  v: 1;
  personId: string;
  name: string;
  role: string;
  why: string;
  /** Who referred them: the holder when the tool ran. */
  by: PersonRef;
}
export type BatonWrapupData =
  | { v: 1; phase: "start" }
  | { v: 1; phase: "end"; applied: { personId: string; field: string; at: string }[]; refused: WrapupRefusal[]; error?: string };

/** `TranscriptItem.batonMark`: what a baton entry renders as in the operator's transcript. */
export type BatonMark =
  | { kind: "sent"; targetId: string; by: string }
  | { kind: "handoff"; n: number; from: string; to: string; question: string; briefing: string }
  | { kind: "decision"; by: string; area: string; statement: string; quote: string }
  | { kind: "done"; summary: string }
  | { kind: "offer"; n: number; offerId: string; from: string; to: string[]; question: string; briefing: string }
  | { kind: "lease"; n: number; offerId: string; event: "claimed" | "expired"; by: string }
  | { kind: "proposal"; personId: string; name: string; role: string; why: string; by: string }
  | { kind: "wrapup"; phase: "start" }
  | { kind: "wrapup"; phase: "end"; applied: { personId: string; field: string; at: string }[]; refused: WrapupRefusal[]; error?: string };

export type BatonState = "open" | "needs-you" | "done" | "closed";

/** One move of the baton. No token and no hash: those are host state, never in the workspace repo.
    An offer is a hand-off too: `to` is POOL and `offerId` names the offer. */
export interface Handoff {
  n: number;
  from: PersonRef;
  to: PersonRef;
  question: string;
  briefing: string;
  at: string;
  offerId?: string;
}

/** A broadcast of the baton to several people (§app.baton/offers-and-leases). No tokens here. */
export interface Offer {
  id: string;
  /** Person ids invited. */
  to: string[];
  question: string;
  briefing: string;
  /** open: in the pool (nobody holds it); held: `holder` holds the lease; withdrawn: over. */
  state: "open" | "held" | "withdrawn";
  holder?: string;
  /** Everyone who has held this offer's lease, the current holder included (claim order). */
  heldBy?: string[];
  leaseUntil?: string;
  lastActivityAt?: string;
  createdAt: string;
  /** The hand-off number it went out as. */
  n: number;
}

export type BatonOwner = "operator" | { overseerOf: string /* projectId */ };

export interface WrapupRefusal {
  personId: string;
  field: string;
  reason: string;
}

/** The autonomous wrap-up after goal_done / close (§app.organizations/wrap-up). */
export interface WrapupInfo {
  /** skipped: no roster person wrote anything in the session, so no turn ran (nothing to learn). */
  state: "running" | "done" | "failed" | "skipped";
  at: string;
  applied: number;
  refused: WrapupRefusal[];
  error?: string;
}

/** A row of `baton.json` in the org's workspace repo. */
export interface BatonSession {
  sessionId: string;
  /** Relative to the workspace repo: "sessions/<file>.jsonl". */
  file: string;
  orgId: string;
  projectId: string;
  owner: BatonOwner;
  goal: string;
  publicTitle: string;
  participants: PersonRef[];
  /** null when done/closed, or while an open offer waits in its pool (state "open", `offerId` set). */
  holder: PersonRef | null;
  state: BatonState;
  handoffs: Handoff[];
  offers?: Offer[];
  /** The current offer (its hand-off is the last one), while it is open or held. */
  offerId?: string;
  /** The baton session this one was started from ("Start a session for Bob"). */
  parent?: string;
  wrapup?: WrapupInfo;
  budget: { messagesMax: number; messagesUsed: number };
  model?: string;
  thinking?: string;
  createdAt: string;
  closedAt?: string;
  /** The operator hid it from the org owner's page (§app.owner-page/chats). Absent: shown. */
  hiddenFromOwner?: boolean;
  /** When someone it was sent to first wrote (ISO): a roster person, or the operator for a session
      sent to the operator. Absent: nobody has yet. */
  wroteAt?: string;
  /** A settle session: the conflict it asks someone to settle (§app.requirements/routing), kept after
      a re-route closes it. */
  conflict?: { id: string; area: string };
  /** Started by the global Overseer for the operator (`sova_gather`, §app.overseer/org-attribution).
      Recorded, shown nowhere. */
  startedVia?: "overseer";
}

export interface BatonStartInput {
  orgId: string;
  projectId: string;
  /** The first holder: an active person's id, or "operator"; an array of ≥ 2 active people starts
      the session as an offer to them. */
  to: PersonRef | PersonRef[];
  publicTitle: string;
  goal: string;
  /** What the model should ask the first holder; default: the public title. */
  question?: string;
  /** The first hand-off's briefing, for its addressee. */
  briefing?: string;
  /** Started from another baton session (recorded as `parent`); projectId defaults to its project. */
  parentSessionId?: string;
  model?: string;
  thinking?: string;
  /** This session's message limit (MESSAGES_MIN..MESSAGES_CAP); default: Settings' default. */
  messagesMax?: number;
}

/** GET/PUT /api/baton/settings — the host's defaults for new baton sessions. */
export interface BatonSettings {
  messagesMax: number;
}

export interface OfferLink {
  personId: string;
  name: string;
  link: string;
  /** When it was minted (ISO): a strip showing it says it was replaced once a newer one exists. */
  at?: string;
}

export interface BatonStartResult {
  /** The session's path, for #/s/<path>. */
  path: string;
  sessionId: string;
  /** The first hand-off's link, when the first holder is a person: the share listener's public
      address + "/h/<token>" (just the path when no address is known). Shown once. */
  link?: string;
  /** One link per invitee when started as an offer. Shown once. */
  links?: OfferLink[];
  /** Set when a link was minted but no share listener is known on this host: the link is only a
      path, and nobody outside can open it until one is configured. Say so to the operator. */
  linkWarning?: string;
}

/** An offer as the operator's strip shows it. */
export interface OfferInfo {
  id: string;
  n: number;
  to: { id: string; name: string }[];
  state: Offer["state"];
  holder?: { id: string; name: string };
  leaseUntil?: string;
  lastActivityAt?: string;
  createdAt: string;
}

/** A person proposed from this session who is still waiting for the operator. No contact here. */
export interface ProposedPerson {
  id: string;
  name: string;
  role: string;
  why: string;
  /** The referrer's display name. */
  referredBy: string;
  quote?: string;
  /** Proposed decision areas; they count as operator-set only once the operator approves the person. */
  decides: string[];
}

/** GET /api/baton?path= — the operator's strip. */
export interface BatonInfo {
  session: BatonSession;
  orgName: string;
  projectName: string;
  /** personId → name, for every participant and roster person (the operator under "operator"). */
  names: Record<string, string>;
  /** Active roster people, for Take back / the operator's pickers. */
  active: { id: string; name: string; role: string }[];
  /** Links of the current hand-off that still write (count only: the host keeps hashes, never tokens). */
  liveLinks: number;
  /** personId → when their newest live link of the current hand-off (or open offer) was minted (ISO):
      a strip still showing an older one says "Replaced by a newer link." */
  linkAt: Record<string, string>;
  /** Whether a share listener is bound on this host, and where (for building a full URL). */
  share: { bound: boolean; publicUrl: string | null };
  /** The current offer, else the last one; null when none was ever made. */
  offer: OfferInfo | null;
  proposed: ProposedPerson[];
  wrapup: WrapupInfo | null;
  /** The org's owner, for the strip's Hide From {first} (`session.hiddenFromOwner`); null: none. */
  owner?: { name: string } | null;
}

export interface BatonSummaryField {
  /** Holder's display name, or null when no one holds it (done/closed). */
  holder: string | null;
  state: BatonState;
  /** Present while the operator holds it after a hand-off: the Needs-you detail. */
  needsYou?: { from: string; question: string; since: number };
  /** Present while a person holds it through a hand-off with no live link: the operator must send one. */
  sendLink?: { to: string; question: string; since: number };
  /** Present while an offer is open or held. `holder` is the claimer's name. */
  offer?: { state: "open" | "held"; invited: number; holder?: string };
  /** When the newest live link of the current hand-off (or open offer) was minted (ISO): it moves on
      every Get Link, so an open strip reads its data again. */
  linkAt?: string;
  /** People proposed from this session still waiting for approval (attention kind "roster-proposal"). */
  proposals?: { personId: string; name: string; role: string; by: string; since: number }[];
  /** Someone it was sent to has written (the row's `wroteAt`): In progress, not Not started. */
  written?: true;
  /** A person (not a link previewer or a scanner) opened one of its links. */
  opened?: true;
  /** A settle session, and the area of the conflict it settles. */
  settle?: { area: string };
}

// ---- the outsider view -----------------------------------------------------------------------------

export type BatonViewItem =
  /** `by`: the sender's person id in the operator's and the overseer's views; on a share page never
      an id — "you" (the viewer), "operator", or "person-<n>" numbered within that view. */
  | { kind: "message"; id: string; by: PersonRef; name: string; text: string; at?: string }
  /** `cutOff`: the reply stopped before it finished (the stream guard, a shutdown, Take back, Stop);
      its text is at most CUT_REPLY_MAX characters. */
  | { kind: "reply"; id: string; text: string; at?: string; cutOff?: true }
  | { kind: "handoff"; id: string; n: number; from: string; to: string; question: string; briefing?: string }
  | { kind: "decision"; id: string; by: string; area: string; statement: string }
  | { kind: "done"; id: string; summary: string }
  /** An offer. `to` = the invitees' names in the view with no viewer (the project overseer's) only;
      on a share page it is empty (no invitee learns who else was asked) and `invited` is the count.
      The briefing only for an invitee (or the view with no viewer). */
  | { kind: "offer"; id: string; n: number; from: string; to: string[]; invited: number; question: string; briefing?: string };

/** Why a link can't write now. "taken": another invitee of the same offer holds its lease (the page
    names nobody); "withdrawn": the offer is over; "newer-link": the viewer holds the baton, through a
    newer link of theirs. */
export type ViewerReason = "moved-on" | "done" | "needs-operator" | "budget" | "taken" | "withdrawn" | "newer-link";

/** Why a link answers 410, when the page may say it: it expired, or its offer went to someone else.
    Every other dead link (closed, turned off, its person left) says nothing more: a forwarded link
    must not reveal it. */
export type GoneWhy = "expired" | "withdrawn";

export interface BatonView {
  publicTitle: string;
  state: BatonState;
  /** The holder's name, null when done/closed. */
  holder: string | null;
  /** Share page only: the viewer's own name, and whether their link may write now. */
  viewer?: { name: string; canWrite: boolean; reason?: ViewerReason };
  items: BatonViewItem[];
}

export type ShareServerMessage =
  | { type: "view"; view: BatonView }
  /** The reply being written, text only, so far. Cleared by the next `view`. */
  | { type: "streaming"; text: string }
  | { type: "error"; code: string; message: string; why?: GoneWhy };

export const SHARE_TEXT_MAX = 4000;
/** A reply that stopped before it finished shows at most this much on a share page, marked cut off. */
export const CUT_REPLY_MAX = SHARE_TEXT_MAX;

/** The Needs-you question when the limit sends the baton to the operator (the operator's own). */
export const LIMIT_QUESTION = "The message limit is reached. Extend it to go on, or close the session.";
/** What the people in the conversation read on that hand-off instead. */
export const LIMIT_REACHED_FOR_PEOPLE = "This conversation reached its message limit.";
