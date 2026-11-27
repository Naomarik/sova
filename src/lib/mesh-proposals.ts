import { createSignal } from "solid-js";
import type { MeshPreset } from "../../shared/mesh-access";
import type { MeshProposal, MeshProposalsFeed } from "../../shared/mesh-proposals";
import { PRESET_HINT, PRESET_LABEL } from "./mesh-access";

/**
 * An extension's mesh proposals that wait for the person (§mesh.lan/proposals): what the session feed pushes, and
 * the words Sova's own dialog shows. Nothing here asks the server on its own: the feed sends every waiting proposal
 * on each change, and on connect only while any wait, so a Sova no extension asks shows and fetches nothing.
 */

const [waiting, setWaiting] = createSignal<MeshProposal[]>([]);
export { waiting as waitingMeshProposals };

/** The feed's frame: the whole waiting list. */
export function noteMeshProposals(frame: MeshProposalsFeed): void {
  setWaiting(Array.isArray(frame.proposals) ? frame.proposals.filter((p) => p.state === "waiting") : []);
}

/** The feed (re)opened: a list from before is stale; the server sends the current one when any wait. */
export const clearMeshProposals = (): void => {
  setWaiting([]);
};

/** One proposal answered here: gone from this page at once (the feed's frame follows for every page). */
export const dropMeshProposal = (id: string): void => {
  setWaiting((w) => w.filter((p) => p.id !== id));
};

/** The sentence said for a full-access grant, in every dialog that gives one. */
export const FULL_ACCESS_SENTENCE =
  "In effect this is full access to this computer: that computer can read and drive every chat here, and through them run commands as you.";

/** The dialog's words for one proposal. Pure. */
export function proposalText(p: MeshProposal): {
  title: string;
  action: string;
  rows: Array<{ label: string; value: string; mono?: boolean }>;
  grant: { label: string; hint: string } | null;
  full: boolean;
} {
  const name = p.label && p.label !== p.peer ? `${p.label} (${p.peer})` : (p.peer ?? "");
  const grantOf = (g: MeshPreset | undefined) => (g ? { label: PRESET_LABEL[g], hint: PRESET_HINT[g] } : null);
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [{ label: "Computer", value: name }];
  if (p.kind === "pair") {
    rows.push(
      p.role === "dial"
        ? { label: "Connection", value: `This computer dials it at ${p.host}:${p.port}` }
        : { label: "Connection", value: "It dials this computer" },
    );
    if (p.relay) rows.push({ label: "Listens at", value: `This computer will listen for computers that dial it at ${p.relay.host}:${p.relay.port}` });
    if (p.fingerprint) rows.push({ label: "Fingerprint", value: p.fingerprint, mono: true });
    return { title: `${p.extension.title} asks to link a computer`, action: "Link Computer", rows, grant: grantOf(p.grant), full: p.fullAccess };
  }
  if (p.from) rows.push({ label: "Now", value: PRESET_LABEL[p.from] });
  return { title: `${p.extension.title} asks to give ${p.label ?? p.peer} more access`, action: "Give Access", rows, grant: grantOf(p.grant), full: p.fullAccess };
}

/** The person's answer. Only Sova's own page passes (§app.access/your-click). */
export async function answerMeshProposal(id: string, answer: "confirm" | "decline"): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/mesh/proposals/${encodeURIComponent(id)}/${answer}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch {
    throw new Error("The Sova server isn't reachable.");
  }
  if (res.ok) return;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Non-JSON error body: keep the status line.
  }
  throw new Error(message);
}
