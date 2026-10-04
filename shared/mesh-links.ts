// Linked sessions across mesh peers (§mesh/links): the record, messages, inbox, outbox, and the
// bodies of every link route. Their own file, outside protocol.ts on purpose (as mesh-details.ts
// and mesh-local.ts are): its hash is the mesh's compatibility fingerprint, and a later change to a
// link body must never show a host as `skewed`. A host on a build without links answers these
// routes with the plain 404 of an unknown route; a sender treats that as final (never retried).
//
// Peer listener (whois-gated like every /api/peer/* route; the caller is `requestPeer(c).nodeId`,
// never a body field; mounted after mountDetails, small bodyLimit):
// POST /api/peer/links                PeerLinkCopy -> {ok:true}   (the creating host's copy of a link
//                                     this host is a member of, in the receiver's terms: the sender
//                                     names itself as this host knows it (§mesh.links/host-names);
//                                     `you` names this host's own nodeId as the caller knows it:
//                                     stored as selfNodeId when unknown here. 403 when it names a
//                                     host this host doesn't know, 409 when its session isn't here)
// POST /api/peer/links/:id/end        PeerLinkEnd -> PeerLinkEndResult   (earliest endedAt wins,
//                                     with its `why`; 404 unknown link)
// POST /api/peer/links/:id/message    PeerLinkMessage -> PeerLinkMessageResult   (served only when
//                                     {caller, fromSession} is a member of the link and `to` is this
//                                     host's member; records it in the inbox, then delivers.
//                                     Refusals are 200 {state:"refused"}; 404 unknown link)
// GET  /api/peer/links/whoami         -> LinkWhoami   (the caller's nodeId as this host knows it)
// GET  /api/peer/links/read?id=&from=&items=&chars=  -> PeerLinkRead   (the Overseer's
//                                     sova_read_session with `host`: this host renders the slice with
//                                     its own parser and redacts it with its own secrets; 404 unknown
//                                     session)
//
// File offers (§mesh.links/offers, §mesh.links/transfer). Pull, never push: the sender packs once
// into a spool at offer time, each recipient's host pulls it with Range and reports back.
// POST /api/peer/links/:id/offers     PeerLinkOffer -> PeerLinkOfferResult   (64 KiB bodyLimit;
//                                     caller = offer.from.nodeId and a member; the one row is this
//                                     host's member. Refusals are 200 {state:"refused"}; 404 unknown
//                                     link: the sender re-copies the link first, as for messages)
// GET  /api/peer/links/:id/offers/:offer/tar   (Range: bytes=N-, If-Range: "<sha256>")
//                                     200/206 application/zstd, ETag "<sha256>", Accept-Ranges,
//                                     Content-Length, Content-Range. 503 {state:"packing", written}
//                                     + Retry-After while the spool is incomplete; 403 the caller is
//                                     not a recipient or its row isn't accepted/pulling; 410 its row
//                                     is final, or the offer expired, was cancelled or its link ended
//                                     (spool gone); 416 Range past the end; 404 unknown offer
// POST /api/peer/links/:id/offers/:offer/result   PeerOfferReport -> {ok:true}   (small bodyLimit;
//                                     caller = the row's recipient; state transitions only, idempotent)
//
// Main listener, local acts (under /api/mesh/, so the peer listener refuses them and the page proxy
// never forwards them; 404 while the mesh is off). The acting session is named in the body or query
// and must be a session this host holds (a loaded runtime) and a member of the link: sender
// identity is never taken from anything else.
// GET  /api/mesh/links?session=<id>   -> LinksList   (link_members: the links that session is in;
//                                     without `session`, every link this host knows: sova_links)
// POST /api/mesh/links                LinkCreate -> MeshLinkView   (sova_link: resolve members, write
//                                     this host's copy, fan out; 400/409 LinkError naming the member)
// POST /api/mesh/links/:id/end        -> MeshLinkView   (sova_unlink; fans out)
// POST /api/mesh/links/send           LinkSend -> LinkSendResult   (link_send)
// GET  /api/mesh/links/inbox?session=<id>&limit=<n>  -> LinkInbox   (link_inbox, newest last)
// POST /api/mesh/links/offers         LinkOfferCreate -> LinkOfferCreateResult   (link_offer: list
//                                     the paths, write the offer, start packing, fan out; 400/409
//                                     LinkError with an OfferRefusal before anything is written)
// POST /api/mesh/links/offers/:offer/accept   LinkOfferAnswer -> LinkOffer   (link_accept; the
//                                     recipient's row must be `offered` and unexpired)
// POST /api/mesh/links/offers/:offer/decline  LinkOfferDecline -> LinkOffer   (link_decline)
// GET  /api/mesh/links/offers?session=<id>    -> LinkOffersList   (link_offers: both directions,
//                                     newest first)
//
// Main listener, page reads (ordinary /api/ routes: a page reaches a peer's through
// /peer/<id>/api/links/…; not tool acts, so a peer reaching them does no harm):
// GET  /api/links/:id/thread          -> LinkThread   (this host's inbox files for that link,
//                                     merged, deduped by message id, oldest first; plus this host's
//                                     copies of the link's offers)
// POST /api/links/:id/seen            LinkSeen -> {ok:true}   (the pane opened the thread: messages
//                                     from `from` up to `at` stop counting as unread)
//
// Ordinary /api/ routes links rely on (also on the peer listener; comments in protocol.ts):
// GET  /api/sessions/by-id/:id        -> SessionSummary   (§mesh.links/by-id)
// POST /api/sessions/configure        SessionConfigure -> SessionConfigureResult   (§mesh.links/configure)

import type { SessionSummary } from "./protocol";

/** A member session of a link: the host by its node identity as the host holding the record knows
    it (§mesh.links/host-names: a Tailscale node identity, or lan:<pin> for a LAN pairing), the
    session by id, and its path on its own host (resolved when the link was made). A host's peer id
    and label are never stored: look them up in this host's peers.json by nodeId at every use. */
export interface LinkMember {
  nodeId: string;
  sessionId: string;
  path: string;
}

/** A member named by host and session only (a sender, a recipient). */
export interface LinkMemberRef {
  nodeId: string;
  sessionId: string;
}

/** §mesh.links/record. Immutable but for `endedAt` (set once; the earliest wins). */
export interface MeshLink {
  id: string; // lk_ + 16 hex (shared/link-message.ts LINK_ID_RE)
  createdAt: number; // ms epoch, the creating host's clock
  /** nodeId of the creating host. */
  createdBy: string;
  /** Two or more, at most one per nodeId. */
  members: LinkMember[];
  endedAt?: number;
  /** Why it ended, when a host ended it for a reason of its own (a member host refused its copy). */
  endedWhy?: string;
}

/** `<stateRoot>/mesh-links.json`, mode 0600, written atomically like peers.json. */
export interface MeshLinksFile {
  version: 1;
  /** This host's own nodeId when the mesh doesn't say (an address-identity host): learnt from a
      PeerLinkCopy's `you` or a whoami answer. */
  selfNodeId?: string;
  /** Peer nodeId -> this host's nodeId as that peer knows it (its whoami answer): how this host
      names itself to that peer (§mesh.links/host-names). */
  selfAs?: Record<string, string>;
  /** Ended links included (history). */
  links: MeshLink[];
}

/** A link message (§mesh.links/delivery). */
export interface LinkMessage {
  id: string; // lm_ + 16 hex, minted by the sending host
  linkId: string;
  at: number; // ms epoch, the sending host's clock
  from: LinkMemberRef;
  to: LinkMemberRef[];
  text: string;
}

/** Why a delivery was refused. Final: never retried. */
export type LinkRefusal =
  | "ended" // the link has ended
  | "unknown-link" // this host holds no such link
  | "not-member" // the sender (or the named recipient) is not a member of the link
  | "no-session" // the member's session file isn't on its host any more
  | "archived"
  | "tui-live" // open in a TUI: never written to
  | "busy" // another writer touched the file recently, or a foreign line (the busy rule)
  | "model-off" // the member's model is off by the model policy (the message would be swallowed)
  | "special" // an Overseer, project-overseer, baton or other organization session
  | "unreachable" // the member's host is not in this host's peers.json
  | "old-build" // the member's host answered 404: a build without links
  | "mesh-off"
  | "internal";

/** One recipient's outcome. `started`: an idle member began a turn; `delivered`: a busy (or
    compacting) member will see it at its next step; `outbox`: its host is down, held here and
    retried; `refused`: final, with the reason. Acceptance is not proof the partner acted on it. */
export type LinkDelivery =
  | { to: LinkMemberRef; state: "started" | "delivered" | "outbox" }
  | { to: LinkMemberRef; state: "refused"; reason: LinkRefusal; message: string };

/** One record of a member's inbox, `<stateRoot>/mesh-links/<linkId>/<sessionId>.jsonl`, newest
    200 kept. Every message the host delivered to or sent for that member. */
export interface LinkInboxRecord extends LinkMessage {
  dir: "in" | "out";
  /** dir "out": per recipient, as the send returned (an `outbox` entry is updated when it drains). */
  deliveries?: LinkDelivery[];
  /** dir "in": this member's own outcome. */
  delivery?: LinkDelivery;
  /** A file offer's notice (the offer itself, its landing, a decline, the sender's one wake): an
      ordinary link message whose record is upserted by message id as the offer moves on. */
  offer?: { id: string; event: LinkOfferEvent };
}

/** One line of `<stateRoot>/mesh-links/outbox.jsonl`: something for a peer that was down. Drained
    on meshApi.onPeerUp and on a 60 s timer only while non-empty. A refusal or a 404 is final. */
export type LinkOutboxEntry = {
  id: string; // ob_ + hex
  toNodeId: string;
  at: number;
  tries: number;
  lastTry?: number;
} & (
  | { kind: "link"; body: PeerLinkCopy }
  | { kind: "end"; linkId: string; body: PeerLinkEnd }
  | { kind: "message"; linkId: string; body: PeerLinkMessage }
  | { kind: "offer"; linkId: string; body: PeerLinkOffer }
  | { kind: "offer-report"; linkId: string; offerId: string; body: PeerOfferReport }
);

// --- Peer route bodies ---

export interface PeerLinkCopy {
  link: MeshLink;
  /** The recipient's nodeId as the sender knows it. */
  you: string;
}
export interface PeerLinkEnd {
  endedAt: number;
  /** Why, when the host ending it has a reason of its own (MeshLink.endedWhy). */
  why?: string;
}
export interface PeerLinkEndResult {
  ok: true;
  /** The link's endedAt after this call (the earliest wins). */
  endedAt: number;
}
export interface PeerLinkMessage {
  /** The message, in the receiver's terms; `from.nodeId` must equal the verified caller, `to` must
      include this host's member (by any of this host's names). */
  message: LinkMessage;
  /** The sender session's title, for the tag line. Display only. */
  fromTitle?: string;
}
export type PeerLinkMessageResult =
  | { state: "started" | "delivered" }
  | { state: "refused"; reason: LinkRefusal; message: string };
export interface LinkWhoami {
  nodeId: string;
}
export interface PeerLinkRead {
  /** The rendered, redacted slice, as sova_read_session shows a local one. */
  text: string;
  /** Item index the slice started at and how many items the branch has, for paging. */
  from: number;
  total: number;
  title: string;
}

// --- Local route bodies (/api/mesh/links/*) ---

/** How this host sees one member right now. */
export interface LinkMemberView extends LinkMember {
  /** The member is on this host. */
  self: boolean;
  /** This host's peer id for the member's host; absent for self, or a host not in peers.json. */
  hostId?: string;
  /** The host's label here ("this host" wording is the caller's). */
  hostLabel: string;
  /** self | the peer's probe state | not in peers.json. */
  reach: "self" | "up" | "down" | "unknown-host";
  /** From the member host's by-id route (cached ~3 s); absent when it couldn't be read. */
  title?: string;
  cwd?: string;
  model?: string | null;
  state: "working" | "idle" | "offline" | "unknown";
  lastActivity?: number; // ms epoch
  archived?: boolean;
}
export interface MeshLinkView {
  link: MeshLink;
  members: LinkMemberView[];
}
export interface LinksList {
  links: MeshLinkView[];
}
export interface LinkCreate {
  /** `host`: a peer id here; absent = this host. `session`: a session id on that host. */
  members: Array<{ host?: string; session: string }>;
}
/** A 4xx body from a local act. `member` is the index into LinkCreate.members it names. */
export interface LinkError {
  error: string;
  reason?: OfferRefusal | "same-host" | "too-few" | "worker" | "skewed" | "lan-pairing";
  member?: number;
}
export interface LinkSend {
  /** The sending session's id: held by this host and a member of the link. */
  session: string;
  /** Required when the session is in more than one live link. */
  link?: string;
  /** A member by host label or peer id, session id or title; several; or "all". Optional with
      two members. */
  to?: string | string[];
  text: string;
}
export interface LinkSendResult {
  linkId: string;
  messageId: string;
  deliveries: LinkDelivery[];
}
export interface LinkInbox {
  records: LinkInboxRecord[];
}

// --- Page reads ---

export interface LinkThread {
  link: MeshLink;
  /** Oldest first, both directions, deduped by message id. */
  messages: LinkInboxRecord[];
  /** This host's copies of the link's offers, oldest first (by `at`). Absent from an older host. */
  offers?: LinkOffer[];
}
export interface LinkSeen {
  /** The local member whose pane read it. */
  session: string;
  /** The partner whose messages were seen. */
  from: LinkMemberRef;
  at: number;
}

/** A row of the Agents tab's "Remotely linked agents" (§mesh.links/agents-pane), in
    SessionInsight.links and the `links` chat frame. Not a WorkerInfo: no spawn model, no usage. */
export interface LinkedAgentInfo {
  /** `link:<linkId>:<nodeId>`: the pane's selection key (never a worker id). */
  key: string;
  linkId: string;
  /** Map it through the page's own MeshInfo to a peer id (or self) for every URL: the server's
      `hostId` is the SESSION's host's id for it, meaningless when the page is served by another. */
  nodeId: string;
  sessionId: string;
  path: string;
  /** The member is on the host that serves this session (only in the Overseer's pane). */
  self: boolean;
  /** The session's host's peer id and label for the member host; fallbacks only. */
  hostId?: string;
  hostLabel: string;
  title: string;
  model: string | null;
  state: "working" | "idle" | "offline" | "unknown";
  lastActivity?: number; // ms epoch
  /** Messages from this member not yet seen here (LinkSeen). */
  unread: number;
  /** The newest non-final file transfer with this member, either way. Absent from an older host. */
  transfer?: LinkedTransfer;
}

/** LinkedAgentInfo.transfer: what the row's chip says. `received`/`size` are compressed bytes. */
export interface LinkedTransfer {
  offerId: string;
  /** "out": this member's host is sending; "in": it is receiving. */
  dir: "in" | "out";
  state: OfferRowState;
  received?: number;
  size?: number;
}

// --- File offers (§mesh.links/offers, §mesh.links/transfer) ---

/** of_ + 16 hex, minted by the sending host. */
export const OFFER_ID_RE = /^of_[0-9a-f]{16}$/;

/** One recipient's row. `offered`: no dest yet, waiting for link_accept / link_decline;
    `accepted`: dest known (implicit or answered), the pull hasn't started; `pulling`: bytes
    moving, or waiting on a packing or down sender; `extracting`: verified, tar is writing dest. */
export type OfferRowState =
  | "offered"
  | "accepted"
  | "pulling"
  | "extracting"
  | "done"
  | "declined"
  | "failed"
  | "expired"
  | "cancelled"
  | "refused";
export const OFFER_FINAL: ReadonlySet<OfferRowState> = new Set<OfferRowState>(["done", "declined", "failed", "expired", "cancelled", "refused"]);

/** Why an offer, or one recipient's row, was refused or failed. Final. */
export type OfferRefusal =
  | LinkRefusal
  | "hidden" // sender sandbox: an offered path is, or holds, a path its tools can't read
  | "not-writable" // receiver sandbox: dest, or a member under it, is outside its writable roots
  | "protected" // dest in, or reaching into, Sova's state root or the sessions dir
  | "no-path" // an offered path doesn't exist, or is `/`
  | "same-name" // two offered paths share a name (each lands at dest/<its name>)
  | "no-tar" // no tar on the host
  | "no-space" // ENOSPC while packing (sender) or downloading (receiver)
  | "bad-dest" // empty, `~user`, NUL, or not a directory
  | "bad-hash" // the download didn't match the snapshot twice
  | "tar-failed"; // tar exited non-zero while packing or extracting

/** One offered path, by the name it lands under at dest; never the sender's absolute path. */
export interface LinkOfferRoot {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  /** Regular files and their bytes, uncompressed, as listed. */
  files: number;
  bytes: number;
}

export type LinkOfferWarning =
  /** A `.git` file whose gitdir is absolute or resolves outside the offered roots: it carries no
      history. `path` is from dest (`proj/.git`). */
  | { kind: "gitlink"; root: string; path: string; gitdir: string }
  /** GNU tar's exit 1: a file changed while it was packed. */
  | { kind: "changed"; message: string };

export interface LinkOfferRecipient {
  to: LinkMemberRef;
  /** As named: by the sender (implicit) or by the recipient's link_accept. */
  dest?: string;
  /** dest was given with the offer: accepted with no turn. */
  implicit?: boolean;
  /** Absolute, as the recipient's host resolved it. */
  resolvedDest?: string;
  state: OfferRowState;
  /** Compressed bytes: served to it (the sender's copy) / on disk (the recipient's copy). */
  received?: number;
  /** ms epoch of the last byte moved; a pulling row keeps going until lastByteAt + 1 h. */
  lastByteAt?: number;
  /** Overrides the offer's expiresAt for this row (a slow pull still moving). */
  expiresAt?: number;
  startedAt?: number;
  doneAt?: number;
  retries?: number;
  /** A refusal's or failure's reason; a decline carries none. */
  reason?: OfferRefusal;
  /** The refusal, failure or decline sentence. */
  message?: string;
}

/** An offer: `<stateRoot>/mesh-links/<linkId>/offers.json` on the sender and on every recipient's
    host (each holding only its own row). */
export interface LinkOffer {
  id: string;
  linkId: string;
  /** ms epoch, the sender's clock. */
  at: number;
  /** at + 24 h. */
  expiresAt: number;
  from: LinkMemberRef;
  roots: LinkOfferRoot[];
  /** Totals, uncompressed, as listed. */
  files: number;
  bytes: number;
  exclude?: string[];
  note?: string;
  warnings?: LinkOfferWarning[];
  /** Set when the spool is complete. */
  snapshot?: { sha256: string; size: number; encoding: "zstd"; packedAt: number };
  /** The sender's packing; `written` is compressed bytes so far. */
  packing?: { state: "packing" | "ready" | "failed"; written?: number; error?: string };
  /** The sender's copy: every recipient. A recipient's copy: its own row only. */
  recipients: LinkOfferRecipient[];
  /** The sender's copy: its one wake has been delivered (every row final, or the first failure). */
  wokeSender?: boolean;
}

/** What an inbox record's notice is about. */
export type LinkOfferEvent = "offered" | "landed" | "declined" | "failed" | "finished" | "expired" | "cancelled";

// Peer bodies

export interface PeerLinkOffer {
  /** `from.nodeId` must equal the verified caller; `recipients` is the callee's one row. */
  offer: LinkOffer;
  /** The sender session's title, for the tag line and the notice. Display only. */
  fromTitle?: string;
}
export type PeerLinkOfferResult =
  /** dest given: resolved and checked, the pull is queued. */
  | { state: "accepted"; resolvedDest: string }
  /** No dest: the offer message reached the agent. */
  | { state: "offered"; delivery: "started" | "delivered" }
  | { state: "refused"; reason: OfferRefusal; message: string };
/** A recipient's row moved (the sender marks `pulling` itself, at the first tar GET). */
export interface PeerOfferReport {
  /** The recipient member's session id. */
  session: string;
  state: "accepted" | "extracting" | "declined" | "done" | "failed" | "refused";
  resolvedDest?: string;
  /** Compressed bytes on the recipient's disk. */
  received?: number;
  /** ms from the first byte to done. */
  took?: number;
  reason?: OfferRefusal;
  message?: string;
}

// Local acts

export interface LinkOfferCreate {
  /** The offering session: held by this host and a member of the link. */
  session: string;
  link?: string;
  /** As LinkSend.to. */
  to?: string | string[];
  /** Resolved against the session's cwd; `~` expanded; absolute allowed. */
  paths: string[];
  /** Pattern without `/`: any path component (`node_modules`, `*.log`); with `/`: the member name
      from the root (`proj/dist`). `*`, `?`, `**`, `[…]`. No default excludes. */
  exclude?: string[];
  /** A directory on the recipient's host; each path lands at dest/<its name>. One for all, or by
      member as `to` names them. Given: implicit accept. */
  dest?: string | Record<string, string>;
  note?: string;
}
/** One recipient's answer to the fan-out. */
export type LinkOfferDelivery = { to: LinkMemberRef } & (PeerLinkOfferResult | { state: "outbox" });
export interface LinkOfferCreateResult {
  offer: LinkOffer;
  deliveries: LinkOfferDelivery[];
}
export interface LinkOfferAnswer {
  /** The recipient session: held by this host and the offer's recipient. */
  session: string;
  dest: string;
}
export interface LinkOfferDecline {
  session: string;
  reason?: string;
}
export interface LinkOffersList {
  offers: LinkOffer[];
}

// --- Configure (§mesh.links/configure) ---

export interface SessionConfigure {
  subagent_profile?: string;
  path: string;
  /** "provider/model". */
  model?: string;
  thinking?: string;
  mode?: string;
  /** The full set of minor modes to have on. */
  minorModes?: string[];
}
/** 200 body. 4xx: {error} (400 unknown mode/minor mode or bad body, 404 no session, 409 TUI-live,
    archived, mid-turn, subagents working, busy writer, model policy). Nothing changes on a refusal. */
export interface SessionConfigureResult {
  ok: true;
  model: string | null;
  thinking: string | null;
  mode?: string;
  minorModes?: string[];
}

/** The by-id route's answer. */
export type SessionById = SessionSummary;
