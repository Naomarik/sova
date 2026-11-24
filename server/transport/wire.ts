// What the two devices of a transport say to each other (§app/transport). The source decides every
// step and drives it: it offers the chat, asks how far the destination is, says when the package is
// ready, and sends the one commit. The destination pulls the package with the ticket and answers.
// Every route but the package's is a `sessions` route there; the package's is the ticket's own.
import type { TransportState } from "./store";

/** The offer's header: the click that started it, as the source minted it over the offer's body (asked back once). */
export const PROOF_HEADER = "x-sova-click-proof";
/** Its header on the package pull: the one-time ticket (never in a URL, never logged). */
export const TICKET_HEADER = "x-sova-transport-ticket";

export const peerPath = {
  offer: "/api/peer/transport/offer",
  status: (tid: string) => `/api/peer/transport/${tid}`,
  ready: (tid: string) => `/api/peer/transport/${tid}/ready`,
  commit: (tid: string) => `/api/peer/transport/${tid}/commit`,
  cancel: (tid: string) => `/api/peer/transport/${tid}/cancel`,
  retry: (tid: string) => `/api/peer/transport/${tid}/retry`,
  needs: (tid: string) => `/api/peer/transport/${tid}/needs`,
  moveBack: (tid: string) => `/api/peer/transport/${tid}/move-back`,
  package: (tid: string) => `/api/peer/transport/${tid}/package`,
};

export interface OfferTree {
  name: string;
  branch: string | null;
  /** The repository's own checkout (not a linked worktree): it is built whole there. */
  main: boolean;
  /** Where it goes there, relative to the folder's parent ("" for the chat's own tree: the folder). */
  rel: string;
}

export interface OfferBody {
  v: 1;
  tid: string;
  ticket: string;
  mode: "move" | "copy";
  chat: { id: string; title: string };
  /** The folder on that device the chat's own tree (or its folder) goes to: absolute. */
  folder: string;
  /** The repository's main folder there, relative to the folder's parent, when the chat's tree is a linked worktree. */
  repoRel: string | null;
  /** The repository's remotes (no credentials) and its first commits. */
  project: { remotes: string[]; roots: string[] };
  trees: OfferTree[];
  sourceLabel: string;
  model?: string;
}

export interface StatusBody {
  tid: string;
  state: TransportState | "unknown";
  steps: Record<string, string>;
  /** Commits the repository there has (the package leaves them out). */
  haves?: string[];
  needsYou?: string;
  received?: number;
  /** The chat's id there once published. */
  arrivedId?: string;
  renamed?: { from: string; to: string }[];
  /** The chat there has had a turn since it arrived (Move Back is gone). */
  turned?: boolean;
}

export interface ReadyBody {
  sha256: string;
  size: number;
}
