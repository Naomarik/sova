// An extension proposes a change to this computer's dial-out pairings; Sova's own dialog asks the
// person before anything that gives a computer more (§mesh.lan/proposals). Kept out of protocol.ts
// for the same reason as mesh-lan.ts: hosts that never see a proposal are never "skewed" by it.
// Nothing here carries a key; fingerprints are not secret.

import type { MeshPreset } from "./mesh-access";

export type MeshProposalKind = "key" | "pair" | "grant" | "unpair";
export type MeshProposalState = "waiting" | "applied" | "declined" | "withdrawn" | "expired" | "failed";

/** One proposal, as the extension that made it and the page read it. */
export interface MeshProposal {
  /** `mp_…` */
  id: string;
  extension: { id: string; title: string };
  kind: MeshProposalKind;
  state: MeshProposalState;
  createdAt: number;
  decidedAt?: number;
  /** While waiting: when it reads `expired`. */
  expiresAt?: number;
  /** state `failed`: why it couldn't be applied. */
  error?: string;
  /** The link's id in peers.json (`pair`, `grant`, `unpair`). */
  peer?: string;
  label?: string;
  /** The extension's own one line, shown quoted in the dialog. */
  why?: string;
  role?: "dial" | "accept";
  /** The other computer's pin, as people compare it (8 groups of 4). */
  fingerprint?: string;
  /** role `dial`: where the other computer listens. */
  host?: string;
  port?: number;
  /** role `accept`: where this computer will listen, when the proposal sets that. */
  relay?: { host: string; port: number };
  grant?: MeshPreset;
  /** kind `grant`: the link's preset before. */
  from?: MeshPreset;
  /** It waits for the person's click. */
  widens: boolean;
  /** Its grant is in effect full access to this computer (`sessions`, `full`). */
  fullAccess: boolean;
}

/** `POST /api/mesh/proposals`: what an extension's program may send. */
export type MeshProposalBody =
  | { kind: "key" }
  | { kind: "pair"; role: "dial" | "accept"; peer: string; label?: string; fingerprint: string; host?: string; port?: number; grant: MeshPreset; relay?: { host: string; port: number }; why?: string }
  | { kind: "grant"; peer: string; grant: MeshPreset; why?: string }
  | { kind: "unpair"; peer: string; why?: string };

/** The session feed's frame: every proposal that waits, on each change, and on connect only while any wait. */
export interface MeshProposalsFeed {
  type: "mesh_proposals";
  proposals: MeshProposal[];
}

/** The presets that are in effect full access to a computer: a chat there runs commands as its owner. */
export const FULL_ACCESS_PRESETS: readonly MeshPreset[] = ["full", "sessions"];

export const WHY_MAX = 200;
export const PROPOSAL_TTL_MS = 15 * 60_000;
export const DECIDED_KEEP_MS = 60 * 60_000;
export const WAITING_MAX = 10;
