import type { SenderEntry, SenderStatus } from "../../shared/outreach";
import { meshPeers } from "../mesh";
import { localSocket, readOutreach } from "./settings";
import { peerSenderStatus, probeLocal, whatsapp } from "./whatsapp";

/**
 * The senders this host can use (§app.outreach/sender-list): this host's own, always, then each peer
 * whose sender answers this host through its relay, all asked at once. A peer that doesn't is left
 * out, unless the saved setting sends through it: then it is listed with why. Each entry has an id,
 * so a later list of several numbers keeps the same shape.
 */

export interface SenderListIo {
  peers: () => { nodeId: string; label: string }[];
  /** A status through the relay, or why the peer has none for this host. */
  peerStatus: (nodeId: string) => Promise<{ status: SenderStatus } | { why: string }>;
  /** The status of the sender on this host's socket. */
  localStatus: (path: string) => Promise<SenderStatus>;
  /** The setting's own sender, as the rest of Sova reads it (noted in the health). */
  chosenStatus: () => Promise<SenderStatus>;
}

const defaultIo: SenderListIo = {
  peers: () => meshPeers().map((p) => ({ nodeId: p.nodeId, label: p.label })),
  peerStatus: (nodeId) => peerSenderStatus(nodeId),
  localStatus: probeLocal,
  chosenStatus: () => whatsapp.status(),
};

export const localEntryId = "local";
export const peerEntryId = (nodeId: string) => `peer:${nodeId}`;

export async function listSenders(io: SenderListIo = defaultIo): Promise<SenderEntry[]> {
  const route = readOutreach().sender;
  const chosenLocal = typeof route === "object" && "local" in route;
  const chosenVia = typeof route === "object" && "via" in route ? route.via.nodeId : null;
  // This host's own: the setting's socket when it is local, else where a sender listens by default.
  const socket = localSocket(chosenLocal ? route : { local: {} })!;
  const [local, peers] = await Promise.all([
    chosenLocal ? io.chosenStatus() : io.localStatus(socket),
    Promise.all(
      io.peers().map(async (p) => {
        if (p.nodeId === chosenVia) return { p, status: await io.chosenStatus() };
        const r = await io.peerStatus(p.nodeId);
        return "status" in r ? { p, status: r.status } : null;
      }),
    ),
  ]);
  const out: SenderEntry[] = [{ id: localEntryId, where: "local", label: "This host", status: local, chosen: chosenLocal }];
  for (const x of peers) if (x) out.push({ id: peerEntryId(x.p.nodeId), where: "peer", nodeId: x.p.nodeId, label: x.p.label, status: x.status, chosen: x.p.nodeId === chosenVia });
  // The saved peer is no longer one of this host's peers: still listed, so the choice stays visible.
  if (chosenVia && !out.some((e) => e.nodeId === chosenVia)) {
    out.push({ id: peerEntryId(chosenVia), where: "peer", nodeId: chosenVia, label: chosenVia, status: await io.chosenStatus(), chosen: true });
  }
  return out;
}
