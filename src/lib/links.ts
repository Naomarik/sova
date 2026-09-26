// The Agents tab's "Remotely linked agents" (§mesh.links/agents-pane): pure decisions only —
// which host a member's URLs go to, the sections, the state chip, the thread's rows — so
// LinkedAgents.tsx just renders them.

import type { LinkInboxRecord, LinkMemberRef, LinkThread, LinkedAgentInfo } from "../../shared/mesh-links";
import type { MeshInfo } from "../../shared/protocol";
import type { Tone } from "../components/ui";

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

/** What makes the open thread worth fetching again: anything the row says about new traffic. */
export const threadSignature = (row: Pick<LinkedAgentInfo, "unread" | "lastActivity" | "state">): string =>
  `${row.unread}:${row.lastActivity ?? ""}:${row.state}`;
