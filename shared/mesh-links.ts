// Linked sessions across mesh peers (§mesh/links): the record, messages, inbox, outbox, and the
// bodies of every link route. Their own file, outside protocol.ts on purpose (as mesh-details.ts
// and mesh-local.ts are): its hash is the mesh's compatibility fingerprint, and a later change to a
// link body must never show a host as `skewed`. A host on a build without links answers these
// routes with the plain 404 of an unknown route; a sender treats that as final (never retried).
//
// Peer listener (whois-gated like every /api/peer/* route; the caller is `requestPeer(c).nodeId`,
// never a body field; mounted after mountDetails, small bodyLimit):
// POST /api/peer/links                PeerLinkCopy -> {ok:true}   (the creating host's copy of a link
//                                     this host is a member of; `you` names this host's own nodeId
//                                     as the caller knows it: stored as selfNodeId when unknown here.
//                                     409 when `you`'s member session isn't here)
// POST /api/peer/links/:id/end        PeerLinkEnd -> PeerLinkEndResult   (earliest endedAt wins;
//                                     404 unknown link)
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
//
// Main listener, page reads (ordinary /api/ routes: a page reaches a peer's through
// /peer/<id>/api/links/…; not tool acts, so a peer reaching them does no harm):
// GET  /api/links/:id/thread          -> LinkThread   (this host's inbox files for that link,
//                                     merged, deduped by message id, oldest first)
// POST /api/links/:id/seen            LinkSeen -> {ok:true}   (the pane opened the thread: messages
//                                     from `from` up to `at` stop counting as unread)
//
// Ordinary /api/ routes links rely on (also on the peer listener; comments in protocol.ts):
// GET  /api/sessions/by-id/:id        -> SessionSummary   (§mesh.links/by-id)
// POST /api/sessions/configure        SessionConfigure -> SessionConfigureResult   (§mesh.links/configure)

import type { SessionSummary } from "./protocol";

/** A member session of a link: the host by its Tailscale node identity, the session by id, and
    its path on its own host (resolved when the link was made). A host's peer id and label are
    never stored: look them up in this host's peers.json by nodeId at every use. */
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
}

/** `<stateRoot>/mesh-links.json`, mode 0600, written atomically like peers.json. */
export interface MeshLinksFile {
  version: 1;
  /** This host's own nodeId when the mesh doesn't say (an address-identity host): learnt from a
      PeerLinkCopy's `you` or a whoami answer. */
  selfNodeId?: string;
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
  | "special" // an Overseer, project-overseer or baton session
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
);

// --- Peer route bodies ---

export interface PeerLinkCopy {
  link: MeshLink;
  /** The recipient's nodeId as the sender knows it. */
  you: string;
}
export interface PeerLinkEnd {
  endedAt: number;
}
export interface PeerLinkEndResult {
  ok: true;
  /** The link's endedAt after this call (the earliest wins). */
  endedAt: number;
}
export interface PeerLinkMessage {
  /** The message; `from.nodeId` must equal the verified caller, `to` must include this host's member. */
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
  reason?: LinkRefusal | "same-host" | "too-few" | "worker" | "skewed";
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
}

// --- Configure (§mesh.links/configure) ---

export interface SessionConfigure {
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
