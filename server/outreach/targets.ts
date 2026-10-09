import { ENTRY_ID, routeEntryId, type OutreachFile, type SenderRoute } from "../../shared/outreach";
import { meshPeers } from "../mesh";
import { localSocket, readOutreach } from "./settings";

/**
 * Which sender a send goes through (§app.outreach/sender-list, /org-sender): every sender this host
 * can use is an entry with an id (`local`, `local:<name>`, `peer:<StableID>`). The default is the
 * file's `sender`; an organization's pick is `orgs[orgId]`. A pick is resolved when the send runs and
 * only that sender is used: nothing here ever offers another one because the picked one is down.
 */

export interface SenderTarget {
  id: string;
  route: Exclude<SenderRoute, "off">;
  /** A sender on this host: its socket. */
  socket?: string;
  /** The operator's label, else This host, the added number's name, or the peer's name. */
  label: string;
}

export const LOCAL_ID = "local";
export const numberEntryId = (name: string) => `local:${name}`;
export const peerEntryId = (nodeId: string) => `peer:${nodeId}`;

type Peers = () => { nodeId: string; label: string }[];
const livePeers: Peers = () => meshPeers().map((p) => ({ nodeId: p.nodeId, label: p.label }));

/** The label an entry shows: the operator's, else its own name. */
export function labelOf(id: string, file: OutreachFile = readOutreach(), peers: Peers = livePeers): string {
  const own = file.labels?.[id];
  if (own) return own;
  if (id === LOCAL_ID) return "This host";
  if (id.startsWith("local:")) return id.slice("local:".length);
  const nodeId = id.slice("peer:".length);
  return peers().find((p) => p.nodeId === nodeId)?.label ?? nodeId;
}

/**
 * The sender an entry id names now, or null when no sender this host can use has that id (an added
 * number removed, a peer no longer this host's). `keepPeer`: a peer the file itself names (the
 * default) stays resolvable while it is gone, so its sends fail as unreachable rather than vanish.
 */
export function targetOf(id: string, file: OutreachFile = readOutreach(), peers: Peers = livePeers, keepPeer = false): SenderTarget | null {
  if (!ENTRY_ID.test(id)) return null;
  const label = labelOf(id, file, peers);
  if (id === LOCAL_ID) {
    // This host's own: the default's socket when it is the default, else where a sender listens by default.
    const route: SenderTarget["route"] = typeof file.sender === "object" && "local" in file.sender ? file.sender : { local: {} };
    return { id, route, socket: localSocket(route)!, label };
  }
  if (id.startsWith("local:")) {
    const name = id.slice("local:".length);
    const n = file.numbers?.find((x) => x.id === name);
    return n ? { id, route: { number: { id: name } }, socket: n.socket, label } : null;
  }
  const nodeId = id.slice("peer:".length);
  if (!keepPeer && !peers().some((p) => p.nodeId === nodeId)) return null;
  return { id, route: { via: { nodeId } }, label };
}

/** The default sender, or null while outreach is off. */
export function defaultTarget(file: OutreachFile = readOutreach(), peers: Peers = livePeers): SenderTarget | null {
  const id = routeEntryId(file.sender);
  return id ? targetOf(id, file, peers, true) : null;
}

/**
 * An organization's sender: its own pick, else the default. A pick no longer on the list falls back
 * to the default, and `gone` names it so the organization's settings can say so. Off: no sender.
 */
export function orgTarget(orgId: string, file: OutreachFile = readOutreach(), peers: Peers = livePeers): { target: SenderTarget | null; gone?: string } {
  const def = defaultTarget(file, peers);
  if (!def) return { target: null };
  const pick = file.orgs?.[orgId];
  if (!pick) return { target: def };
  const t = pick === def.id ? def : targetOf(pick, file, peers);
  return t ? { target: t } : { target: def, gone: pick };
}

/** Every sender in use (§app.outreach/sender-health): the default, each organization's pick, and each added number. */
export function targetsInUse(file: OutreachFile = readOutreach(), peers: Peers = livePeers): SenderTarget[] {
  const def = defaultTarget(file, peers);
  if (!def) return [];
  const out = new Map<string, SenderTarget>([[def.id, def]]);
  for (const pick of Object.values(file.orgs ?? {})) {
    const t = out.has(pick) ? null : targetOf(pick, file, peers);
    if (t) out.set(t.id, t);
  }
  for (const n of file.numbers ?? []) {
    const id = numberEntryId(n.id);
    if (!out.has(id)) out.set(id, targetOf(id, file, peers)!);
  }
  return [...out.values()];
}
