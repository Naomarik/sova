/**
 * Wire types for outreach (§app/outreach): sending a roster person their gathering link on a
 * channel outside Sova, WhatsApp first. Imported by the server and the operator app, so it imports
 * nothing at runtime. Never added to shared/protocol.ts (its hash is the mesh's protocol version).
 *
 * Files (host-local, never committed):
 *   <stateRoot>/outreach.json            OutreachFile: 0600, atomic, strict parse
 *   <stateRoot>/outreach-receipts.json   channel ref → send-log line, ≤ 7 days (0600)
 * Workspace repo (portable):
 *   <workspace>/outreach.jsonl           OutreachLogLine per line, append-only
 *
 * Operator routes (main listener only; refused when the request carries a peer):
 * GET  /api/outreach                     -> OutreachInfo
 * PUT  /api/outreach                     body OutreachPatch -> OutreachInfo | 400 { error }
 * GET  /api/baton/:sid/outreach          -> BatonOutreach
 * POST /api/baton/:sid/send-link         body { person?, note? } -> SendAnswer | 409 { error }
 *
 * Peer routes (peer listener; the caller is its verified StableID), only on a host whose sender is
 * `local` and whose acceptFrom lists the caller (403 { code: "not-accepted" } / 404 { code: "no-sender" }):
 * POST /api/peer/outreach/status         {} -> the sender's status frame
 * POST /api/peer/outreach/check          { digits } -> { exists }
 * POST /api/peer/outreach/send           { idem, digits, text } -> { ref, at } | error frame (idem namespaced by the caller)
 * POST /api/peer/outreach/events         { since? } -> { seq, events: receipt events of this caller's sends }
 */

export type ChannelId = "whatsapp";

/** The sender IPC v1 states (services/whatsapp/IPC.md), plus this host's own two. */
export type SenderState = "off" | "unreachable" | "unpaired" | "linking" | "connecting" | "open" | "logged-out" | "replaced" | "blocked" | "down";

export type SenderRoute = "off" | { local: { socket?: string } } | { via: { nodeId: string } };

export interface OutreachFile {
  version: 1;
  sender: SenderRoute;
  /** Which peers may send through this host's local sender. */
  acceptFrom: "all" | string[];
  /** Every send from this host is refused while on. */
  paused: boolean;
  /** A non-default auth directory of the local sender, so it is protected (§app.outreach/secrets). */
  authDir?: string;
  /** The auth directory the local sender last reported (written by Sova, protected too). */
  senderAuthDir?: string;
}

export type OutreachPatch = Partial<Pick<OutreachFile, "sender" | "acceptFrom" | "paused" | "authDir">>;

export interface SenderStatus {
  state: SenderState;
  why?: string;
  /** The sender's own pause (blocked also sets it). */
  paused?: boolean;
  /** The linked number's last 3 digits, "…123". */
  me?: string;
  limits?: { gapS: number; perHour: number; perDay: number };
  usage?: { hour: number; day: number };
  version?: string;
}

export interface OutreachInfo {
  file: OutreachFile;
  sender: SenderStatus;
  /** Paths the Overseer's file tools deny now (§app.outreach/secrets). */
  protected: string[];
  /** The sender's auth directory is not hidden from sandboxed agents (null: covered, or unknown). */
  sandboxWarning: string | null;
  /** This host's peers, for Via a peer and Accept sends from. */
  peers: { nodeId: string; label: string }[];
  /** The file on disk could not be parsed (treated as off). */
  problem?: string;
}

export type SendOutcome = "sent" | "failed" | "refused";

/**
 * What a send carries as its link: a reference the server resolves to a URL in the send's own step
 * (§app.outreach/links), never a URL or a token. `handoff`: the person's link to a gathering session
 * (minted then); `preview`: a public preview link of the project, by its id.
 */
export type LinkRef = { kind: "handoff"; session: string } | { kind: "preview"; preview: string };
export type LinkKind = LinkRef["kind"];

/** A send's answer (the routes, the tools). Never a link, a token or a number. */
export interface SendAnswer {
  outcome: SendOutcome;
  channel: ChannelId;
  name: string;
  code?: string;
  why?: string;
  retryable?: boolean;
  /** It waits in the project's hold (an unattended project overseer): goes at `goesAt` unless cancelled. */
  held?: { id: string; goesAt: string; what: string };
}
/** @deprecated the operator's Send on WhatsApp answer: a SendAnswer. */
export type SendLinkAnswer = SendAnswer;

/** GET /api/baton/:sid/outreach: who Send on WhatsApp may go to now (the operator's own view). */
export interface BatonOutreach {
  people: { id: string; name: string; ready: boolean; why?: string; /** Their WhatsApp digits, for the wa.me fallback. */ wa?: string }[];
  operatorName: string;
  publicTitle: string;
}

export type OutreachEvent = "sent" | "delivered" | "read" | "failed" | "refused" | "unknown";

/** One line of <workspace>/outreach.jsonl: never a number, token, link, message id or body. */
export interface OutreachLogLine {
  at: string;
  /** The send's id: its receipts repeat it. */
  id: string;
  personId: string;
  channel: ChannelId;
  intent: "send";
  projectId: string;
  /** The link's kind and its reference's ids (a session and hand-off, or a preview). */
  link?: LinkKind;
  sessionId?: string;
  n?: number;
  offerId?: string;
  previewId?: string;
  /** A note went with it (its text is never logged). */
  note?: true;
  by: "operator" | "operator-via-overseer" | "project-overseer";
  event: OutreachEvent;
  code?: string;
}

/** A person page's sends (§app.outreach/log), newest first: the latest event of each. */
export interface PersonSendRow {
  id: string;
  at: string;
  /** What went: the gathering's public title, "A preview", or "A message". */
  what: string;
  sessionId?: string;
  channel: ChannelId;
  event: OutreachEvent;
  code?: string;
}

/** Why a channel is not ready, as the strip's disabled button says it. */
export const OUTREACH_NOT_READY = {
  "no-number": "No WhatsApp number on the roster.",
  off: "Outreach is off: set it up in Settings → Outreach.",
  paused: "Outreach is paused.",
} as const;

/** A gathering link's default line (§app.outreach/channels): fixed, never model-written. */
export const handoffLine = (operatorName: string, publicTitle: string): string => `${operatorName} asked you a question: ${publicTitle}`;

/** The message: the note (else the link's default line), a blank line, the link. */
export const composeMessage = (line: string | undefined, url: string | undefined): string => [line, url].filter((x): x is string => !!x).join("\n\n");

/** The gathering link's whole message, as the wa.me fallback composes it. */
export const linkMessage = (operatorName: string, publicTitle: string, link: string): string => composeMessage(handoffLine(operatorName, publicTitle), link);

/** A roster WhatsApp contact as the sender takes it: digits only (country code included), or null. */
export function waDigits(contact: string | undefined | null): string | null {
  if (!contact) return null;
  const d = contact.replace(/[\s\-().+]/g, "");
  return /^\d{7,15}$/.test(d) ? d : null;
}
