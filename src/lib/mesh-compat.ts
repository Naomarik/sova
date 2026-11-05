// One reading of another host (§mesh/compatibility), on the page's side: every screen that shows a
// host (Mesh page, host menu, session rows, session heads, New Session's Host choice, workspace
// panes) takes its state, its word and what it allows from here. The numbers are the ones bundled
// into this page, never its server's (§mesh.compatibility/judged-by-the-page). Pure: no DOM, no Solid.

import { behindOn, hostState, WIRE_AREAS, type AreaId, type HostState, type WireAreas } from "../../shared/wire-areas";
import type { PeerStateView } from "../../shared/mesh-access";

/** What a host is here: one of the four states, or what it keeps when it has none of them. */
export type HostReading = HostState | "hidden" | "refused" | "down";

/** The fields of a peer the reading uses. */
export interface PeerAreas {
  state: PeerStateView;
  areas?: WireAreas;
}

/**
 * A host's reading from this page. A host that keeps its sessions from this one reads `hidden`
 * whatever its numbers: nothing of it can be opened, so its version costs nothing more.
 */
export function hostReading(p: PeerAreas, sessionsHidden = false, own: WireAreas = WIRE_AREAS): HostReading {
  if (sessionsHidden || p.state === "hidden") return "hidden";
  return hostState(own, p) ?? (p.state === "refused" ? "refused" : "down");
}

/** Whether a session on a host with this reading can be sent to, stopped or created. */
export const canSend = (r: HostReading): boolean => r === "works";

/** Whether a host's session opens and stays live with sending off: the notice in place of the composer. */
export const readsWithoutSending = (r: HostReading): r is "read-only" | "display" => r === "read-only" || r === "display";

/** The area whose numbers put a host in that state, which is the one that names the host behind. */
const LOST_AREA: Record<"read-only" | "display", AreaId> = { "read-only": "composer", display: "transcript" };

/** The name of the side behind on what a host's state lost, or null when it can't be said. */
export function behindName(
  r: "read-only" | "display",
  p: PeerAreas,
  names: { self: string; peer: string },
  own: WireAreas = WIRE_AREAS,
): string | null {
  if (!p.areas) return null;
  const side = behindOn(LOST_AREA[r], own, p.areas);
  return side === null ? null : side === "theirs" ? names.peer : names.self;
}

/** The notice's title and body in place of the composer (§mesh.compatibility/read-only). */
export function sendingOffWords(host: string, behind: string | null): { title: string; body: string } {
  return {
    title: `Nothing can be sent to ${host} from this page, Stop included.`,
    body: `You can still read and watch.${behind ? ` ${behind} is behind.` : ""}`,
  };
}

/** The warning bar's title and body over the chat (§mesh.compatibility/display-warning). */
export function displayWarningWords(behind: string | null): { title: string; body: string } {
  return {
    title: "This chat may not show correctly.",
    body: behind ? `${behind} is behind, so its messages may be drawn wrong here.` : "Its messages may be drawn wrong here.",
  };
}

/** The sentence saying what a host's reduced state costs: titles, the Mesh page, New Session. */
export function stateCost(r: "read-only" | "display" | "update", name: string): string {
  switch (r) {
    case "read-only":
      return `${name} is read only from this page: you can read and watch its chats, and nothing can be sent there, Stop included.`;
    case "display":
      return `${name}'s chats may not show correctly on this page, and nothing can be sent there, Stop included.`;
    default:
      return `${name} runs another version of Sova. Update one of them.`;
  }
}

/** The Update needed page in place of a session (§mesh.compatibility/update-needed). */
export function updateNeededWords(name: string): { title: string; body: string } {
  return {
    title: `${name} runs another version of Sova.`,
    body: "This session lives there, so it opens once the two match. Nothing here changed.",
  };
}
