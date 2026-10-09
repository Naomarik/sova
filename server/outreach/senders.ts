import type { SenderEntry, SenderStatus } from "../../shared/outreach";
import { meshPeers } from "../mesh";
import { readOutreach } from "./settings";
import { defaultTarget, LOCAL_ID, numberEntryId, peerEntryId, targetOf, targetsInUse, type SenderTarget } from "./targets";
import { peerSenderStatus, probeLocal, whatsapp } from "./whatsapp";

/**
 * The senders this host can use (§app.outreach/sender-list): this host's own, always; each number
 * added on this host; then each peer whose sender answers this host through its relay, all asked at
 * once. A peer that doesn't is left out, unless this host uses it (the default, or an organization's
 * pick): then it is listed with why. Each entry has an id; the default is `chosen`.
 */

export interface SenderListIo {
  peers: () => { nodeId: string; label: string }[];
  /** A status through the relay, or why the peer has none for this host. */
  peerStatus: (nodeId: string) => Promise<{ status: SenderStatus } | { why: string }>;
  /** The status of the sender on a socket of this host's, for one not in use. */
  localStatus: (path: string) => Promise<SenderStatus>;
  /** A sender in use, as the rest of Sova reads it (noted in the health). */
  usedStatus: (t: SenderTarget) => Promise<SenderStatus>;
}

const defaultIo: SenderListIo = {
  peers: () => meshPeers().map((p) => ({ nodeId: p.nodeId, label: p.label })),
  peerStatus: (nodeId) => peerSenderStatus(nodeId),
  localStatus: probeLocal,
  usedStatus: (t) => whatsapp.status(t),
};

export { LOCAL_ID as localEntryId, peerEntryId };

export async function listSenders(io: SenderListIo = defaultIo): Promise<SenderEntry[]> {
  const file = readOutreach();
  const peers = io.peers;
  const used = new Map(targetsInUse(file, peers).map((t) => [t.id, t]));
  const defId = defaultTarget(file, peers)?.id ?? null;
  const localIds = [LOCAL_ID, ...(file.numbers ?? []).map((n) => numberEntryId(n.id))];
  const statusOfLocal = (id: string) => {
    const t = used.get(id) ?? targetOf(id, file, peers)!;
    return used.has(id) ? io.usedStatus(t) : io.localStatus(t.socket!);
  };
  const [locals, remote] = await Promise.all([
    Promise.all(localIds.map(async (id) => ({ t: targetOf(id, file, peers)!, status: await statusOfLocal(id) }))),
    Promise.all(
      peers().map(async (p) => {
        const id = peerEntryId(p.nodeId);
        const t = used.get(id);
        if (t) return { p, status: await io.usedStatus(t) };
        const r = await io.peerStatus(p.nodeId);
        return "status" in r ? { p, status: r.status } : null;
      }),
    ),
  ]);
  const out: SenderEntry[] = locals.map(({ t, status }) => ({
    id: t.id,
    where: "local",
    ...(t.id !== LOCAL_ID ? { socket: t.socket! } : {}),
    label: t.label,
    status,
    chosen: t.id === defId,
  }));
  for (const x of remote) {
    if (!x) continue;
    const id = peerEntryId(x.p.nodeId);
    out.push({ id, where: "peer", nodeId: x.p.nodeId, label: targetOf(id, file, peers)!.label, status: x.status, chosen: id === defId });
  }
  // A peer this host uses that is no longer one of its peers: still listed, so the choice stays visible.
  for (const t of used.values()) {
    if (!("via" in t.route) || out.some((e) => e.id === t.id)) continue;
    out.push({ id: t.id, where: "peer", nodeId: t.route.via.nodeId, label: t.label, status: await io.usedStatus(t), chosen: t.id === defId });
  }
  return out;
}
