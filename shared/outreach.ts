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
 * The sender's controls (§app.outreach/sender-controls; main listener only, and never the Overseer's:
 * a request carrying its sender header is 403):
 * POST /api/outreach/sender/reconnect    {} -> OutreachInfo | 409 { error } (local, or relayed to a `via` peer)
 * POST /api/outreach/sender/pause        { on: boolean } -> OutreachInfo | 409 { error } (local sender only)
 * POST /api/outreach/sender/start        {} -> OutreachInfo | 409 { error } (local, its systemd unit inactive)
 *
 * Linking a phone (§app.outreach/sender-link; guarded the same, and 409 unless the sender is local):
 * POST /api/outreach/sender/link         { phone? } -> SenderLinkView | 409 { error, code? } (starts a link)
 * GET  /api/outreach/sender/link         -> SenderLinkView (the newest QR or code while it runs; no-store)
 * POST /api/outreach/sender/link/cancel  {} -> SenderLinkView | 409 { error }
 * POST /api/outreach/sender/unlink       { confirm: "UNLINK" } -> OutreachInfo | 400 | 409 { error }
 *
 * The senders this host can use (§app.outreach/sender-list; main listener only, never the Overseer's):
 * GET  /api/outreach/senders             -> SenderList
 *
 * Each organization's number (§app.outreach/org-sender; guarded the same):
 * GET  /api/outreach/orgs/:orgId         -> OrgSenderView
 * PUT  /api/outreach/orgs/:orgId         { sender: <entry id> | null } -> OrgSenderView | 400
 *
 * The controls and the link routes take `sender: <entry id>` in the body (GET: `?sender=`), and
 * `GET /api/outreach?sender=<id>` answers that sender's state; absent: the default.
 *
 * Peer routes (peer listener; the caller is its verified StableID), only on a host whose sender is
 * `local` and whose acceptFrom lists the caller (403 { code: "not-accepted" } / 404 { code: "no-sender" }):
 * POST /api/peer/outreach/status         {} -> the sender's status frame
 * POST /api/peer/outreach/check          { digits } -> { exists }
 * POST /api/peer/outreach/send           { idem, digits, text } -> { ref, at } | error frame (idem namespaced by the caller)
 * POST /api/peer/outreach/events         { since? } -> { seq, events: receipt events of this caller's sends }
 * POST /api/peer/outreach/reconnect      {} -> the sender's answer; needs the `admin` grant (a full-control
 *                                        peer), never while blocked (403 { code: "refused" })
 */

export type ChannelId = "whatsapp";

/** The sender IPC v1 states (services/whatsapp/IPC.md), plus this host's own two. */
export type SenderState = "off" | "unreachable" | "unpaired" | "linking" | "connecting" | "open" | "logged-out" | "replaced" | "blocked" | "down";

/** The default sender: off, this host's own (`local`), a sender added on this host (`number`, by its name), or a peer's. */
export type SenderRoute = "off" | { local: { socket?: string } } | { number: { id: string } } | { via: { nodeId: string } };

/** A further sender on this host (§app.outreach/sender-list): its own process and socket; its entry id is `local:<id>`. */
export interface LocalNumber {
  id: string;
  socket: string;
}

/** An added number's name: lowercase letters, digits and dashes, at most 32. */
export const NUMBER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A sender's entry id (§app.outreach/sender-list): `local`, `local:<name>` or `peer:<StableID>`. */
export const ENTRY_ID = /^(local|local:[a-z0-9][a-z0-9-]{0,31}|peer:[A-Za-z0-9_-]{1,128})$/;
export const LABEL_MAX = 24;

/** Why a number's label can't be kept, or null: at most 24 characters, never 4 digits in a row (a label never holds a number). */
export function labelProblem(label: string): string | null {
  const t = label.trim();
  if (!t) return "A label can't be empty.";
  if (t.length > LABEL_MAX) return `A label is at most ${LABEL_MAX} characters.`;
  if (/\d{4}/.test(t.replace(/[\s\-().+]/g, ""))) return "A label can't hold a phone number: use a name, like Office.";
  return null;
}

/** The entry id of a route (null: off). */
export function routeEntryId(route: SenderRoute): string | null {
  if (route === "off") return null;
  if ("local" in route) return "local";
  if ("number" in route) return `local:${route.number.id}`;
  return `peer:${route.via.nodeId}`;
}

export interface OutreachFile {
  version: 1;
  /** The default sender (§app.outreach/sender-list); off sends nothing from this host. */
  sender: SenderRoute;
  /** Further senders on this host, one number each. */
  numbers?: LocalNumber[];
  /** The operator's label per entry id. */
  labels?: Record<string, string>;
  /** Each organization's own pick, by entry id (§app.outreach/org-sender); absent: the default. */
  orgs?: Record<string, string>;
  /** Which peers may send through this host's local sender. */
  acceptFrom: "all" | string[];
  /** Every send from this host is refused while on. */
  paused: boolean;
  /** A non-default auth directory of the local sender, so it is protected (§app.outreach/secrets). */
  authDir?: string;
  /** The auth directory the local sender last reported (written by Sova, protected too). */
  senderAuthDir?: string;
}

export type OutreachPatch = Partial<Pick<OutreachFile, "sender" | "acceptFrom" | "paused" | "authDir" | "numbers" | "labels">>;

export interface SenderStatus {
  state: SenderState;
  why?: string;
  /** ISO: the next automatic reconnect, while `connecting` waits on a backoff or `down` waits for the budget. */
  retryAt?: string;
  /** The sender's own pause (blocked also sets it). */
  paused?: boolean;
  /** The linked number's last 3 digits, "…123". */
  me?: string;
  limits?: { gapS: number; perHour: number; perDay: number };
  usage?: { hour: number; day: number };
  /** Automatic reconnects used and allowed (the reconnect budget). */
  reconnects?: { hour: number; day: number; perHour: number; perDay: number };
  version?: string;
  /** ISO: since when Sova has read this state (unreachable included); absent before a second reading. */
  since?: string;
}

/** The sender's systemd user unit on this host, when it is installed and serves the socket Sova uses. */
export interface SenderUnit {
  name: string;
  /** `systemctl --user show`'s ActiveState: Start is offered only while it is inactive or failed. */
  active: string;
}

export interface OutreachInfo {
  file: OutreachFile;
  /** The entry `sender`, `unit` and the controls are about (`?sender=<id>`, else the default); absent while off. */
  selected?: string;
  sender: SenderStatus;
  /** Paths the Overseer's file tools deny now (§app.outreach/secrets). */
  protected: string[];
  /** The sender's auth directory is not hidden from sandboxed agents (null: covered, or unknown). */
  sandboxWarning: string | null;
  /** This host's peers, for Via a peer and Accept sends from. */
  peers: { nodeId: string; label: string }[];
  /** The file on disk could not be parsed (treated as off). */
  problem?: string;
  /** The selected local sender's unit (Start Sender), when installed and serving its socket; absent otherwise. */
  unit?: SenderUnit;
}

/**
 * A link Sova started on its own host's sender (§app.outreach/sender-link), as the page polls it.
 * `qr` and `code` are as good as the number's credentials: only in this answer, never logged or kept.
 */
export interface SenderLinkView {
  /** idle: none started (or it was dropped); starting: asked; waiting: for the phone; then linked or ended. */
  phase: "idle" | "starting" | "waiting" | "linked" | "ended";
  mode?: "qr" | "code";
  /** The newest QR the sender issued, while waiting with a QR. */
  qr?: string;
  /** How many QRs this link has issued so far (each new one replaces the last). */
  qrCount?: number;
  /** The 8-character pairing code, while waiting with a code. */
  code?: string;
  /** The last 3 digits of the number the code is for, "…234". */
  phoneTail?: string;
  /** Linked: the number's last 3 digits, "…123". */
  me?: string;
  /** Ended: the sender's sentence ("The QR code expired before the phone scanned it."). */
  why?: string;
}

/** One sender this host can use (§app.outreach/sender-list); `id` names it (`local`, `local:<name>`, `peer:<StableID>`). */
export interface SenderEntry {
  id: string;
  where: "local" | "peer";
  /** The peer's StableID (where: peer). */
  nodeId?: string;
  /** An added number's socket (id `local:<name>`). */
  socket?: string;
  /** The operator's label, else "This host", the added number's name, or the peer's name. */
  label: string;
  status: SenderStatus;
  /** It is the default. */
  chosen: boolean;
}

/** GET /api/outreach/orgs/:orgId (§app.outreach/org-sender): the organization's number. */
export interface OrgSenderView {
  /** Outreach is off on this host: nothing goes, whatever the pick. */
  off: boolean;
  /** The organization's own pick, or null: the default. */
  choice: string | null;
  /** The number its messages go from now. */
  effective?: { id: string; label: string; me?: string };
  /** The pick names a number no longer on the list: the default is used. */
  gone?: string;
  /** The default's entry, for "Default ({label} …123)". */
  default?: { id: string; label: string; me?: string };
  options: { id: string; label: string; me?: string }[];
}

export interface SenderList {
  senders: SenderEntry[];
}

/** The states a person has to deal with: sends are refused at once, and Needs you says so (§app.outreach/sender-health). */
export const SENDER_DOWN_STATES: ReadonlySet<SenderState> = new Set(["down", "logged-out", "replaced", "blocked", "unpaired"]);

/** How long the sender may be unreachable before Needs you says so: a restart takes seconds. */
export const SENDER_UNREACHABLE_ALERT_MS = 5 * 60_000;

/** Sova's own sentence for unpaired: the sender's points at its terminal command, Sova's at Settings (`sova-whatsapp status` keeps the sender's). */
export const UNPAIRED_WHY = "No device is linked to the sender yet: link a phone in Settings → Outreach on the sender's host.";

/** The why Sova says for a state: the sender's own, except unpaired's. */
export const sovaWhy = (s: Pick<SenderStatus, "state" | "why">): string | undefined => (s.state === "unpaired" ? UNPAIRED_WHY : s.why);

/** "WhatsApp is down: {why}" for a state that refuses sends, else null. */
export function senderDownWhy(s: Pick<SenderStatus, "state" | "why">): string | null {
  if (!SENDER_DOWN_STATES.has(s.state) && s.state !== "unreachable") return null;
  return `WhatsApp is down: ${sovaWhy(s) ?? (s.state === "unreachable" ? "the sender doesn't answer." : `the sender is ${s.state}.`)}`;
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
  people: {
    id: string;
    name: string;
    ready: boolean;
    why?: string;
    /** Why not ready, as the send log's code: `sender-down` means WhatsApp is down, so the strip offers the fallbacks at once. */
    code?: string;
    /** Their WhatsApp digits, for the wa.me fallback. */ wa?: string;
  }[];
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
  /** The number it went from (§app.outreach/org-sender): its entry id, its label, and its last 3 digits "…123"; never the number. */
  sender?: string;
  senderLabel?: string;
  from?: string;
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
  /** The number that reached them: its label and last 3 digits, when the log says. */
  from?: { label?: string; me?: string };
}

/** Why a channel is not ready, as the strip's disabled button says it. */
export const OUTREACH_NOT_READY = {
  "no-number": "No WhatsApp number on the roster.",
  off: "Outreach is off: set it up in Settings → Outreach.",
  paused: "Outreach is paused.",
  "sender-paused": "WhatsApp sending is paused on the sender's host.",
} as const;

/** Why a link can't go (§app.outreach/links): the send log's `code` and the sentence. Never a URL or a number. */
export interface LinkRefusal {
  code: string;
  why: string;
}

/**
 * A send's log code as a clause, for "The WhatsApp message to {name} was not sent: {reason}."
 * (Needs you, §app.outreach/send): the log keeps codes only, so the reason is said from the code.
 */
export const NOT_SENT_REASONS: Record<string, string> = {
  off: "outreach is off (Settings → Outreach)",
  paused: "outreach is paused",
  "no-number": "they have no WhatsApp number on the roster",
  "session-unknown": "the gathering session isn't in this organization",
  "other-project": "the link belongs to another project",
  "session-ended": "the gathering session has ended",
  "not-invited": "they are not invited to the open offer",
  "not-reached": "they are not reached yet",
  "not-holder": "they don't hold the baton",
  "preview-unknown": "the preview doesn't exist",
  "preview-off": "the preview was turned off",
  "preview-expired": "the preview expired",
  "preview-address": "no preview address was available (Settings → Public links)",
  "address-off": "no public address is set (Settings → Public links)",
  "address-unreachable": "the public address can't be reached",
  "address-not-accepted": "the gateway doesn't accept this host's links",
  "not-on-whatsapp": "the number has no WhatsApp account",
  limited: "the sender's rate limit was reached",
  "not-connected": "the sender wasn't connected",
  unreachable: "the sender couldn't be reached",
  unknown: "the sender didn't say whether it went",
  "unknown-after-restart": "Sova restarted during the send",
  "sender-down": "WhatsApp sending was down",
  "sender-paused": "WhatsApp sending was paused on the sender's host",
  "logged-out": "the phone unlinked the sender's device",
  replaced: "another copy of the sender took over the number",
  blocked: "WhatsApp refused the sender's account",
  restricted: "WhatsApp restricted the sender's account",
  unpaired: "no device is linked to the sender",
};

export const notSentReason = (code: string | undefined): string => (code && NOT_SENT_REASONS[code]) || (code ? `the send ended with code ${code}` : "the send didn't go");

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
