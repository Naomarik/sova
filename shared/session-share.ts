/**
 * Wire types of session share links (§app/session-share): a whole session shared read-only, one
 * link per recipient (named, or the optional "Anyone with the link" row), served by the host that
 * holds the session file. Imported by the server, the operator app and the share build (src/share/),
 * so it imports only types and nothing at runtime.
 *
 * Every view is built field by field on the server (server/session-share-view.ts). Conversation
 * only: user message text and assistant reply text (markdown, `vis` fences included), plus the
 * images embedded in those messages, addressed by index. Never on it: thinking, tool calls or their
 * output, the system prompt, model ids, the session id, paths, cwd, host name, costs, usage,
 * subagents, custom cards, recipient labels. Every string passes the redactor.
 *
 * Share listener (read-only; no POST):
 * GET /s/<token>                 the share build's shell (main.tsx routes /s/ to the session page)
 * GET /api/s/<token>[?v=<tab>][&before=<n>]  -> SessionShareView
 * GET /api/s/<token>/img/<n>     -> the image's bytes (Content-Type from SESSION_SHARE_IMAGE_TYPES;
 *                                   ≤ SESSION_SHARE_IMAGE_MAX_BYTES; 404 when no such image)
 * WS  /ws/s?token=<token>&v=<tab> SessionShareServerMessage stream; the page sends only
 *                                   SessionShareClientMessage (anything else closes the socket)
 * Dead links: 410 { error, code: "gone", why?: "expired" } with no names; unknown: 404
 * { error, code: "not-found" }. A dead socket closes with SESSION_SHARE_GONE_CLOSE.
 *
 * Operator routes (the operator API: the main listener, and a verified peer through the pane's host
 * scope /peer/<id>/api/…, since the host that holds a session mints and serves its shares; never
 * the share listener):
 * GET  /api/session-shares[?session=<id>]              -> SessionShare[] (newest first)
 * POST /api/session-shares  body SessionShareCreate    -> 201 SessionShareMinted
 * GET  /api/session-shares/preview?session=<id>[&cut=<c>][&from=<entryId>][&before=<n>]
 *                                                      -> SessionSharePreview (as a recipient would
 *                                                         see it; the first read fixes `cut`, later
 *                                                         reads and images pass it; `from` slices
 *                                                         it; 409 stale-preview when either is
 *                                                         gone; no token, no visit)
 * GET  /api/session-shares/preview?session=<id>&outline=1[&cut=<c>] -> SessionShareOutline (the
 *                                                         share page's picker: every shown message
 *                                                         as a short excerpt with its entry id)
 * GET  /api/session-shares/preview/img/<n>?session=<id>&cut=<c>[&from=<entryId>] -> image bytes
 * GET  /api/session-shares/:id/preview[?before=<n>]    -> SessionShareView (this share, now)
 * GET  /api/session-shares/:id/preview/img/<n>         -> image bytes
 * PATCH /api/session-shares/:id  body SessionSharePatch -> SessionShare
 * POST /api/session-shares/:id/recipients  body SessionShareAddRecipient -> SessionShareMinted
 * POST /api/session-shares/:id/recipients/:rid/relink  -> SessionShareMinted (the old link stops)
 * POST /api/session-shares/:id/recipients/:rid/revoke  -> SessionShare
 * POST /api/session-shares/:id/update  [body { cut }]  -> SessionShare (snapshot: the cut moves to the
 *                                                         previewed cut, else the current leaf)
 * POST /api/session-shares/:id/extend  body { days: SessionShareDays } -> SessionShare (every live
 *                                                         link then expires `days` from now)
 * POST /api/session-shares/:id/stop                    -> SessionShare (every link stops)
 * GET  /api/session-shares/:id/activity                -> SessionShareActivity
 * GET  /api/shares-overview                            -> SharesOverview (this host only; the
 *                                                         Shares page fans out to up peers)
 * Errors: 4xx { error, code }.
 *
 * Slices (§app.session-share/slice): a share may start at an entry (`from`) and end at its cut.
 * Entry ids go only to the operator (the outline, `from` on create, patch and preview); no
 * recipient answer, image, shell or frame carries one.
 *
 * Files (host-local, never synced or committed):
 *   <stateRoot>/session-shares.json         0600, atomic (server/session-shares.ts)
 *   <stateRoot>/session-share-visits.jsonl  the visit log of `via: "session"` links
 */

import type { LinkWarningCode } from "./public-links";

// ---- the share ----------------------------------------------------------------------------------

/** `snapshot`: the view stops at the cut entry (moved by Update to now). `live` (Follow live): no
    fixed cut; the view is the session's current branch, and open pages get a `view` push when the
    session file grows (whole entries only, never streaming). Switchable afterwards. */
export type SessionShareMode = "snapshot" | "live";

/** The expiry choices, in days; SESSION_SHARE_DEFAULT_DAYS unless chosen. */
export const SESSION_SHARE_DAYS = [1, 7, 30, 90] as const;
export type SessionShareDays = (typeof SESSION_SHARE_DAYS)[number];
export const SESSION_SHARE_DEFAULT_DAYS: SessionShareDays = 30;

/** A recipient's label: the operator's private name for them, never shown to any viewer. */
export const RECIPIENT_LABEL_MAX = 60;
export const RECIPIENTS_MAX = 20;
export const SHARE_TITLE_MAX = 120;
/** The fixed label of the "Anyone with the link" row (§design.copy-deck/session-share). */
export const ANYONE_LABEL = "Anyone with the link";

/** `viewing`: a page is open and visible now. `open`: open, but hidden (a background tab).
    `away`: no page open. */
export type SessionSharePresence = "viewing" | "open" | "away";

/** `live`: opens now. `expired`: past its expiry. `off`: turned off, relinked, or the share stopped. */
export type SessionShareLinkState = "live" | "expired" | "off";

export interface SessionShareRecipient {
  /** r_… */
  id: string;
  /** The label; ANYONE_LABEL for the anyone row. */
  label: string;
  anyone?: true;
  state: SessionShareLinkState;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  presence: SessionSharePresence;
  /** Visits by a person (not previews, scanners or refused opens). */
  opened: number;
  /** The newest visit's last activity. */
  lastAt?: string;
}

export interface SessionShare {
  /** ss_… */
  id: string;
  /** The operator's own session id and title, for the operator app only (never on the share page). */
  sessionId: string;
  sessionTitle: string;
  /** The public title the recipients see. */
  title: string;
  mode: SessionShareMode;
  /** Snapshot: when the cut entry was written (the page's "through"); null in live mode. */
  cutAt: string | null;
  createdAt: string;
  /** Present once Stop sharing ran; every link is then `off`. */
  stoppedAt?: string;
  /** The session file is gone or unreadable: every link answers the generic dead page. */
  missing?: true;
  /** A snapshot: its cut's entry id (the slice's end; Change Slice opens on it). */
  cut?: string;
  /** A sliced share only: its start's entry id (Change Slice opens on it). */
  from?: string;
  /** A sliced share only: where it sits among the messages the whole view would show, 1-based;
      `last` null while it follows live. Absent for a whole-session share. */
  span?: SessionShareSpan;
  recipients: SessionShareRecipient[];
}

export interface SessionShareSpan {
  first: number;
  last: number | null;
  total: number;
}

/** POST /api/session-shares. `recipients`: named labels, one link each (may be empty when
    `anyone`); `anyone`: add the "Anyone with the link" row. At least one link. */
export interface SessionShareCreate {
  sessionId: string;
  /** Required for a snapshot: the `cut` of the preview the operator saw (SessionSharePreview.cut).
      The snapshot is exactly that preview; a cut no longer in the file is 409 stale-preview. */
  cut?: string;
  /** The slice's start: an entry id from the outline (absent: from the first message). Not on the
      branch to `cut` (or, live, the current branch): 409 stale-preview. */
  from?: string;
  title: string;
  mode: SessionShareMode;
  expiresInDays: SessionShareDays;
  recipients: string[];
  anyone: boolean;
}

/** PATCH /api/session-shares/:id. Turning Follow live off sets the cut to now. */
export interface SessionSharePatch {
  title?: string;
  mode?: SessionShareMode;
  /** With `mode: "snapshot"` from live: the previewed cut to stop at (else the current leaf).
      On a snapshot, alone or with `from`: the slice's new end (Save Slice). */
  cut?: string;
  /** The slice's new start; null: from the first message again. Open pages get a reset view. */
  from?: string | null;
}

/** POST …/:id/recipients: a named label, or `{ anyone: true }` (409 when one is already live). */
export type SessionShareAddRecipient = { label: string } | { anyone: true };

/** A freshly minted link, shown once: only its hash is kept. */
export interface SessionShareLink {
  recipientId: string;
  label: string;
  link: string;
}

/** Why the minted links may not open from outside: a LinkWarningCode, or `gateway-old` (the via
    gateway does not list kind `s` yet, so it can't open session links; its h and i links are
    unaffected). */
export type SessionShareWarningCode = LinkWarningCode | "gateway-old";

export interface SessionShareMinted {
  share: SessionShare;
  links: SessionShareLink[];
  /** The warning's text (LINK_WARNINGS or SESSION_SHARE_GATEWAY_OLD, the gateway named). */
  linkWarning?: string;
  linkWarningCode?: SessionShareWarningCode;
}

/** The `gateway-old` warning (§design.copy-deck/public-links); `{gateway}` is the via peer's label. */
export const SESSION_SHARE_GATEWAY_OLD = "{gateway} needs an update before it can open session links.";

// ---- the view (share page and Preview) -------------------------------------------------------------

/** An image embedded in a shown message, fetched from …/img/<n>; `n` indexes the whole view's
    images in branch order (not only this page's). */
export interface SessionShareImageRef {
  n: number;
  mime: string;
}

export type SessionShareItem =
  /** A user message: its text (clipboard paths stripped) and embedded images. */
  | { kind: "user"; n: number; text: string; at?: string; images?: SessionShareImageRef[] }
  /** An assistant reply: its text as markdown (vis fences included) and embedded images. */
  | { kind: "reply"; n: number; text: string; at?: string; images?: SessionShareImageRef[] };

/** The first read returns the newest SESSION_SHARE_PAGE items; `before` (an item's `n`) asks for
    the page before it. */
export const SESSION_SHARE_PAGE = 200;

export interface SessionShareView {
  title: string;
  /** When the share was created. */
  sharedAt: string;
  mode: SessionShareMode;
  /** The time of the newest entry the view includes (the cut in snapshot mode). */
  through: string | null;
  /** Items in order, oldest first; `n` is the item's index in the whole view. */
  items: SessionShareItem[];
  /** Present when earlier items exist: pass it as `?before=` for the page before. */
  before?: number;
  /** Every image in the whole view, in order (so Preview can show them all before minting). */
  images: number;
  /** The share starts after a message the whole session would show (no count, nothing of it). */
  earlier?: true;
  /** Opaque and random: the same while each view extends or shortens the one before (same start,
      one path, so item numbers keep their meaning). A view of another lineage replaces the page's
      (earlier pages included), and an earlier page read in another lineage is dropped. */
  lineage?: string;
}

/** The operator's Preview (never on the share page): the view plus the cut it was built at, to
    pass to the mint (and to its later pages and images). */
export interface SessionSharePreview extends SessionShareView {
  cut: string;
  /** The `from` it was sliced at, echoed. */
  from?: string;
}

/** The share page's picker (operator only): every message the share would show at `cut`, whole
    session, oldest first. `n` is the item's index in the whole (unsliced) view. */
export interface SessionShareOutline {
  cut: string;
  items: SessionShareOutlineItem[];
}

export interface SessionShareOutlineItem {
  /** The entry id: what `from` names, and a snapshot's `cut` when the slice ends here. */
  id: string;
  n: number;
  kind: "user" | "reply";
  at?: string;
  /** The scrubbed text, cut at a token boundary to at most SESSION_SHARE_EXCERPT_MAX characters. */
  excerpt: string;
  images: number;
}

export const SESSION_SHARE_EXCERPT_MAX = 160;

export type SessionShareServerMessage =
  /** The newest page again: sent on Update to now, a mode switch, and in live mode when the
      session grew. `reset`: its lineage differs from the last view pushed, so the page replaces
      its view (earlier pages already read included) instead of merging. */
  | { type: "view"; view: SessionShareView; reset?: true }
  | { type: "error"; code: "gone"; why?: "expired" };

/** The only frame a page sends: whether the page is visible (visibilitychange). */
export type SessionShareClientMessage = { t: "vis"; on: boolean };

/** Close code of a share socket whose link died (revoked, stopped, expired, session gone). */
export const SESSION_SHARE_GONE_CLOSE = 4410;
/** Open sockets per link; beyond it the oldest is closed. */
export const SESSION_SHARE_SOCKETS_PER_LINK = 4;
/** The largest image the image route serves, and the types it serves. */
export const SESSION_SHARE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const SESSION_SHARE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

// ---- activity ---------------------------------------------------------------------------------------

/** One visit (folded with its later activity), preview, refused open or cap line. Device family
    only: no address, user agent or token is kept. */
export interface SessionShareVisit {
  kind: "visit" | "preview" | "refused" | "capped";
  at: string;
  lastSeenAt?: string;
  device: string;
  bot?: true;
}

export interface SessionShareRecipientActivity {
  recipientId: string;
  presence: SessionSharePresence;
  opened: number;
  lastAt?: string;
  /** Newest first. */
  visits: SessionShareVisit[];
}

/** GET /api/session-shares/:id/activity. */
export interface SessionShareActivity {
  shareId: string;
  recipients: SessionShareRecipientActivity[];
}

// ---- the Shares page (#/shares) ---------------------------------------------------------------------

/** A live org link (§app/baton hand-off `/h/`, §app/owner-page owner `/i/`), read-only from the
    existing stores and visit log. Turn Off Link uses the existing routes: a hand-off's
    POST /api/baton/:sessionId/revoke, an owner link's POST /api/orgs/:orgId/owner/revoke. */
export interface OrgLinkRow {
  kind: "handoff" | "owner";
  orgId: string;
  orgName: string;
  personId: string;
  personName: string;
  /** A hand-off: the baton session's id, its public title and the hand-off number. */
  sessionId?: string;
  sessionTitle?: string;
  n?: number;
  /** A hand-off: the baton's state (BatonState); an owner link: "live". */
  state: string;
  createdAt: string;
  expiresAt: string;
  presence?: SessionSharePresence;
  opened: number;
  lastAt?: string;
  /** Newest first. */
  visits: SessionShareVisit[];
}

/** GET /api/shares-overview: every live public link this host serves. */
export interface SharesOverview {
  sessionShares: SessionShare[];
  orgLinks: OrgLinkRow[];
}
