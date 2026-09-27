// The Agents tab's "Remotely linked agents" (§mesh.links/agents-pane): pure decisions only —
// which host a member's URLs go to, the sections, the state chip, the thread's rows, the file
// offers' status rows — so LinkedAgents.tsx just renders them.

import type { LinkInboxRecord, LinkMemberRef, LinkOffer, LinkOfferRecipient, LinkThread, LinkedAgentInfo, LinkedTransfer, OfferRowState } from "../../shared/mesh-links";
import type { MeshInfo } from "../../shared/protocol";
import type { Tone } from "../components/ui";
import { duration, thousands } from "./format";
import { bytes } from "./mesh-details";

/** Where the page reaches a member: `host` is a peer id of the host serving the page (null = the
    page's own host), or the member's host isn't one that host knows. */
export type LinkReach = { ok: true; host: string | null } | { ok: false };

/**
 * A member's host, as the page's own host knows it. The server's `hostId` is the SESSION's host's
 * id for it, which means nothing when another host serves the page, so the nodeId is mapped through
 * the page's own MeshInfo. A member on the session's own host (`self`, the Overseer's pane) is
 * wherever that session is.
 */
export function linkReach(
  row: Pick<LinkedAgentInfo, "nodeId" | "self">,
  mesh: Pick<MeshInfo, "self" | "peers"> | null | undefined,
  sessionHost: string | null,
): LinkReach {
  if (row.self) return { ok: true, host: sessionHost };
  if (!row.nodeId || !mesh) return { ok: false };
  if (mesh.self.nodeId === row.nodeId) return { ok: true, host: null };
  const peer = mesh.peers.find((p) => p.nodeId === row.nodeId);
  return peer ? { ok: true, host: peer.id } : { ok: false };
}

/**
 * Which host's inbox the thread (and its seen mark) is read from: a member host's, since only a
 * member host keeps an inbox for the link. The pane's session's host is one, except in the
 * Overseer's pane for a link it made between other hosts (the creating host keeps a copy of the
 * link, but no inbox): there, the first member host the page can reach. None reachable: no thread.
 */
export function threadHost(
  group: readonly Pick<LinkedAgentInfo, "nodeId" | "self">[],
  overseer: boolean,
  mesh: Pick<MeshInfo, "self" | "peers"> | null | undefined,
  sessionHost: string | null,
): LinkReach {
  if (!overseer || group.some((r) => r.self)) return { ok: true, host: sessionHost };
  for (const r of group) {
    const reach = linkReach(r, mesh, sessionHost);
    if (reach.ok) return reach;
  }
  return { ok: false };
}

/** The host's label for a row: the page's own name for it when it knows the host, else the
    session's host's. */
export function linkHostLabel(
  row: Pick<LinkedAgentInfo, "nodeId" | "self" | "hostLabel">,
  mesh: Pick<MeshInfo, "self" | "peers"> | null | undefined,
): string {
  if (!row.self && mesh) {
    if (mesh.self.nodeId && mesh.self.nodeId === row.nodeId) return mesh.self.label || mesh.self.hostname || row.hostLabel;
    const peer = mesh.peers.find((p) => p.nodeId === row.nodeId);
    if (peer?.label) return peer.label;
  }
  return row.hostLabel;
}

/** One section of the list: a link and its rows. */
export interface LinkGroup {
  linkId: string;
  keys: string[];
}

const STATE_ORDER: Record<LinkedAgentInfo["state"], number> = { working: 0, idle: 1, unknown: 2, offline: 3 };

/** Rows grouped by link, in the order links first appear; inside a link, working members first,
    then by title. A member pane is usually one link; the Overseer's is every link on the host. */
export function linkGroups(rows: readonly LinkedAgentInfo[]): LinkGroup[] {
  const out: LinkGroup[] = [];
  const byLink = new Map<string, LinkedAgentInfo[]>();
  for (const r of rows) {
    const at = byLink.get(r.linkId);
    if (at) at.push(r);
    else {
      byLink.set(r.linkId, [r]);
      out.push({ linkId: r.linkId, keys: [] });
    }
  }
  for (const g of out) {
    g.keys = byLink
      .get(g.linkId)!
      .slice()
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title))
      .map((r) => r.key);
  }
  return out;
}

/** A link id short enough for a heading: `lk_` and its first 6 hex digits. */
export const shortLinkId = (id: string): string => id.slice(0, 9);

/** The section's heading names its link only when there are several (the Overseer's pane):
    one link needs no id. */
export const linkGroupId = (linkId: string, groups: number): string | null => (groups > 1 ? shortLinkId(linkId) : null);

/** A row's state chip: working pulses (only while its source is live); idle carries "as of" its
    last activity; offline is muted; a state the host couldn't read says so. */
export interface LinkStateChip {
  text: string;
  tone?: Tone | "accent";
  live: boolean;
  asOf?: number;
}

export function linkStateChip(row: Pick<LinkedAgentInfo, "state" | "lastActivity">, liveSource: boolean): LinkStateChip {
  switch (row.state) {
    case "working":
      return { text: "Working", tone: liveSource ? "accent" : undefined, live: liveSource };
    case "idle":
      return { text: "Idle", live: false, asOf: row.lastActivity };
    case "offline":
      return { text: "Offline", live: false, asOf: row.lastActivity };
    case "unknown":
      return { text: "State unknown", live: false, asOf: row.lastActivity };
  }
}

/** "3 unread" / "1 unread"; null for none. */
export const unreadText = (n: number): string | null => (n > 0 ? `${n} unread` : null);

/** A pi session file's id: `<timestamp>_<id>.jsonl`. Null for a path of another shape. */
export function sessionIdOfPath(path: string): string | null {
  const m = /_([^_/]+)\.jsonl$/.exec(path);
  return m ? m[1]! : null;
}

/** One row of the thread between the members, oldest first. */
export interface ThreadRow {
  id: string;
  at: number;
  /** Who wrote it, by title and host. */
  from: string;
  /** Written by the member this pane belongs to (right-aligned), or by a partner. */
  own: boolean;
  text: string;
  /** Per recipient, for a sent message: what the send returned, when it wasn't plain delivery. */
  notes: string[];
}

const sameRef = (a: LinkMemberRef, b: LinkMemberRef) => a.nodeId === b.nodeId && a.sessionId === b.sessionId;

const DELIVERY_NOTE: Record<string, string> = {
  outbox: "held until its host is up",
};

/**
 * The thread's rows for the pane of `viewer` (the local member; null in the Overseer's pane, where
 * no member is "own"). `names` gives each member row a label; a member the pane has no row for
 * (the viewer itself) reads as `viewerName`. Deduped by message id: the host's inbox files are
 * merged, and a message sent between two of its own members would be in both.
 */
export function threadRows(
  thread: Pick<LinkThread, "messages">,
  viewer: LinkMemberRef | null,
  names: readonly Pick<LinkedAgentInfo, "nodeId" | "sessionId" | "title" | "hostLabel">[],
  viewerName = "This session",
): ThreadRow[] {
  const seen = new Set<string>();
  const out: ThreadRow[] = [];
  for (const m of [...thread.messages].sort((a, b) => a.at - b.at)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const own = !!viewer && sameRef(m.from, viewer);
    const named = names.find((n) => n.nodeId === m.from.nodeId && n.sessionId === m.from.sessionId);
    out.push({
      id: m.id,
      at: m.at,
      from: own ? viewerName : named ? `${named.title} · ${named.hostLabel}` : `Session ${m.from.sessionId.slice(0, 8)}`,
      own,
      text: m.text,
      notes: deliveryNotes(m, names),
    });
  }
  return out;
}

/** What a sent message's recipients got, only where it was not a plain delivery. */
function deliveryNotes(m: LinkInboxRecord, names: readonly Pick<LinkedAgentInfo, "nodeId" | "sessionId" | "title">[]): string[] {
  const all = m.deliveries ?? (m.delivery ? [m.delivery] : []);
  return all.flatMap((d) => {
    if (d.state === "started" || d.state === "delivered") return [];
    const who = names.find((n) => n.nodeId === d.to.nodeId && n.sessionId === d.to.sessionId)?.title ?? d.to.sessionId;
    return [d.state === "refused" ? `Refused by ${who}: ${d.message}` : `${who}: ${DELIVERY_NOTE[d.state] ?? d.state}`];
  });
}

/** The newest message from `from` in the thread, for LinkSeen; null when it has sent nothing. */
export function newestFrom(thread: Pick<LinkThread, "messages">, from: LinkMemberRef): number | null {
  let at: number | null = null;
  for (const m of thread.messages) if (sameRef(m.from, from) && (at === null || m.at > at)) at = m.at;
  return at;
}

/** What makes the open thread worth fetching again: anything the row says about new traffic,
    and a transfer moving (the server throttles those pushes). */
export const threadSignature = (row: Pick<LinkedAgentInfo, "unread" | "lastActivity" | "state" | "transfer">): string => {
  const t = row.transfer;
  return `${row.unread}:${row.lastActivity ?? ""}:${row.state}:${t ? `${t.offerId}:${t.state}:${t.received ?? ""}` : ""}`;
};

// --- File offers (§mesh.links/offers, §mesh.links/transfer) ---

/** "12 MB / 41 MB", "12 MB" with no size yet; null when nothing has moved. */
export function progressText(received: number | undefined, size: number | undefined): string | null {
  if (received === undefined) return null;
  return size ? `${bytes(received)} / ${bytes(size)}` : bytes(received);
}

/**
 * The member row's transfer chip, beside its state chip: what that member is doing with its newest
 * open offer. `dir` is the member's side ("out": it sends). No pulse: the state chip carries that.
 * Null for a final state (the server omits those; an older host sends no `transfer`).
 */
export function transferChip(t: LinkedTransfer | undefined): { text: string; title: string } | null {
  if (!t) return null;
  const verb = t.dir === "out" ? "Sending" : "Receiving";
  const progress = progressText(t.received, t.size);
  const title = `File offer ${t.offerId}`;
  switch (t.state) {
    case "offered":
      return { text: "Waiting for an answer", title };
    case "accepted":
      return { text: `${verb}…`, title };
    case "pulling":
      return { text: progress ? `${verb} ${progress}` : `${verb}…`, title };
    case "extracting":
      return { text: "Unpacking", title };
    default:
      return null;
  }
}

/** One recipient's line under an offer. */
export interface OfferRecipientLine {
  key: string;
  /** The recipient, by title (or "This session"). */
  who: string;
  state: OfferRowState;
  /** "Offered", "Pulling", "Unpacking", "Landed", "Failed"… */
  label: string;
  tone?: Tone;
  /** "12 MB / 41 MB" while pulling. */
  progress: string | null;
  /** Where it lands, as its host resolved it, else as named. */
  dest: string | null;
  /** The moment worth showing: done, else started. */
  at: number | null;
  /** How long a landed pull took. */
  took: string | null;
  /** The refusal, failure or decline sentence. */
  message: string | null;
}

/** One offer's status row in the thread, beside the messages by `at`. */
export interface OfferRow {
  id: string;
  at: number;
  /** The sender, as a message's author reads. */
  from: string;
  own: boolean;
  /** From this session ("out"), to it ("in"), or between others (the Overseer's pane). */
  dir: "out" | "in" | null;
  /** "Offered", "Offered to this session". */
  verb: string;
  /** "proj/, notes.md": the names they land under; a directory ends in `/`. */
  roots: string;
  /** "5,012 files · 41 MB", uncompressed as listed. */
  size: string;
  /** The sender's packing, while it isn't ready: "Packing · 3 MB written", "Packing failed: …". */
  packing: string | null;
  note: string | null;
  warnings: string[];
  recipients: OfferRecipientLine[];
}

const ROW_STATE: Record<OfferRowState, { label: string; tone?: Tone }> = {
  offered: { label: "Offered" },
  accepted: { label: "Accepted" },
  pulling: { label: "Pulling" },
  extracting: { label: "Unpacking" },
  done: { label: "Landed", tone: "success" },
  declined: { label: "Declined" },
  failed: { label: "Failed", tone: "error" },
  expired: { label: "Expired" },
  cancelled: { label: "Cancelled" },
  refused: { label: "Refused", tone: "warn" },
};

type Names = readonly Pick<LinkedAgentInfo, "nodeId" | "sessionId" | "title" | "hostLabel">[];

function memberName(ref: LinkMemberRef, viewer: LinkMemberRef | null, names: Names, viewerName: string, withHost: boolean): string {
  if (viewer && sameRef(ref, viewer)) return viewerName;
  const named = names.find((n) => n.nodeId === ref.nodeId && n.sessionId === ref.sessionId);
  if (!named) return `Session ${ref.sessionId.slice(0, 8)}`;
  return withHost ? `${named.title} · ${named.hostLabel}` : named.title;
}

function recipientLine(r: LinkOfferRecipient, offer: LinkOffer, viewer: LinkMemberRef | null, names: Names, viewerName: string): OfferRecipientLine {
  const s = ROW_STATE[r.state];
  const moving = r.state === "pulling" || r.state === "extracting";
  return {
    key: `${r.to.nodeId}:${r.to.sessionId}`,
    who: memberName(r.to, viewer, names, viewerName, false),
    state: r.state,
    label: r.state === "pulling" && r.retries ? `${s.label}, resumed ${r.retries}×` : s.label,
    ...(s.tone ? { tone: s.tone } : {}),
    progress: moving ? progressText(r.received, offer.snapshot?.size) : null,
    dest: r.resolvedDest ?? r.dest ?? null,
    at: r.doneAt ?? r.startedAt ?? null,
    took: r.state === "done" && r.doneAt && r.startedAt ? duration(r.doneAt - r.startedAt) : null,
    message: r.message ?? (r.reason ? `Reason: ${r.reason}.` : null),
  };
}

const plural = (n: number, one: string) => `${thousands(n)} ${one}${n === 1 ? "" : "s"}`;

/** The offers' status rows, oldest first, deduped by id. Read-only, as the whole pane is. */
export function offerRows(offers: readonly LinkOffer[], viewer: LinkMemberRef | null, names: Names, viewerName = "This session"): OfferRow[] {
  const seen = new Set<string>();
  const out: OfferRow[] = [];
  for (const o of [...offers].sort((a, b) => a.at - b.at)) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const p = o.packing;
    const own = !!viewer && sameRef(o.from, viewer);
    const dir = own ? "out" : viewer && o.recipients.some((r) => sameRef(r.to, viewer)) ? "in" : null;
    out.push({
      id: o.id,
      at: o.at,
      from: memberName(o.from, viewer, names, viewerName, true),
      own,
      dir,
      verb: dir === "in" ? `Offered to ${viewerName.toLowerCase()}` : "Offered",
      roots: o.roots.map((r) => (r.kind === "dir" ? `${r.name}/` : r.name)).join(", "),
      size: `${plural(o.files, "file")} · ${bytes(o.bytes)}`,
      packing: !p || p.state === "ready" ? null : p.state === "failed" ? `Packing failed${p.error ? `: ${p.error}` : "."}` : `Packing${p.written ? ` · ${bytes(p.written)} written` : "…"}`,
      note: o.note?.trim() || null,
      warnings: (o.warnings ?? []).map((w) =>
        w.kind === "gitlink" ? `${w.path} is a worktree's pointer to ${w.gitdir}: it carries no history.` : `Changed while packing: ${w.message}`,
      ),
      recipients: o.recipients.map((r) => recipientLine(r, o, viewer, names, viewerName)),
    });
  }
  return out;
}

/** The thread in one list: messages and offer status rows by `at`. An offer's own "offered"
    notice is left out when its status row is there: the row says the same and stays current. */
export type ThreadItem = ({ kind: "message" } & ThreadRow) | ({ kind: "offer" } & OfferRow);

export function threadItems(
  thread: Pick<LinkThread, "messages" | "offers">,
  viewer: LinkMemberRef | null,
  names: Names,
  viewerName = "This session",
): ThreadItem[] {
  const offers = offerRows(thread.offers ?? [], viewer, names, viewerName);
  const ids = new Set(offers.map((o) => o.id));
  const notice = new Map(thread.messages.map((m) => [m.id, m.offer]));
  const messages = threadRows(thread, viewer, names, viewerName).filter((m) => {
    const o = notice.get(m.id);
    return !(o && o.event === "offered" && ids.has(o.id));
  });
  const items: ThreadItem[] = [...messages.map((m) => ({ kind: "message" as const, ...m })), ...offers.map((o) => ({ kind: "offer" as const, ...o }))];
  return items.sort((a, b) => a.at - b.at);
}
