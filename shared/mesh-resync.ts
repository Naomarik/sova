import type { PeerState } from "./protocol";

// Mesh version resync (§mesh.peers/resync): this host deploys the exact build it booted from to a
// peer that is behind it. Types of this host's own /api/mesh/resync* routes (main listener only,
// never on the peer listener) and of one optional hello field. They stay out of protocol.ts on
// purpose: its hash is the mesh's compatibility fingerprint, and a field added there would make
// every host "skewed" against every older one.

/** A hello from a build that records its boot commit also carries it; an older host omits it and
    every reader treats it as optional (the details' versions.commit is the fallback). */
export interface MeshBuildHello {
  /** The 40-hex commit this host booted from. */
  commit?: string;
}

/** Where a peer's commit sits against this host's boot commit, by this checkout's history. */
export type ResyncRelation =
  /** The peer's commit is an ancestor of ours: it is behind, and may be resynced. */
  | "behind"
  /** Ours is an ancestor of the peer's: it is newer. Never downgraded from here. */
  | "ahead"
  | "same"
  /** Neither contains the other. */
  | "diverged"
  /** A commit is missing, or this checkout doesn't have the peer's. */
  | "unknown";

/** A recipe's kind: which script deploys to it (scripts/mesh-vps/deploy.sh, scripts/mesh-termux/deploy.sh). */
export type ResyncKind = "vps" | "termux";

export type ResyncJobState =
  /** The deploy script is running. */
  | "running"
  /** It finished; waiting for the peer's hello to carry this host's protocol. */
  | "waiting"
  | "done"
  | "failed";

export interface ResyncJob {
  state: ResyncJobState;
  /** The commit being deployed (this host's boot commit). */
  commit: string;
  startedAt: number;
  endedAt?: number;
  /** Why it failed, in a sentence. */
  error?: string;
  /** The last lines of the script's output (capped). */
  tail: string;
}

/** This host's own build, as recorded at boot. */
export interface ResyncSelf {
  id: string;
  label: string;
  /** The commit this host booted from; absent when neither BUILD_COMMIT nor .git named one. */
  commit?: string;
  /** Why this host's build can't be named (a dirty tree, a protocol that doesn't match the commit,
      no commit); absent when it can. While set, nothing can be resynced from here. */
  blocked?: string;
  /** What is wrong with mesh-resync.json (a bad file, or entries left out); absent when nothing is. */
  recipesError?: string;
}

export interface ResyncHost {
  id: string;
  label: string;
  state: PeerState;
  /** The peer's commit: from its hello, else its details; absent when it says none. */
  commit?: string;
  relation: ResyncRelation;
  /** Commits between the two, when one contains the other. */
  distance?: number;
  /** The recipe for it in this host's mesh-resync.json; null when there is none. */
  recipe: ResyncKind | null;
  /** Why the recipe can't run as it stands (e.g. the script's local.env is missing). */
  recipeProblem?: string;
  /** What runs on it now (from its details), for the warning. */
  activity?: { turnsRunning: number; workers: number };
  /** The last resync job for it since this server started. */
  job?: ResyncJob;
}

/** GET /api/mesh/resync. */
export interface MeshResync {
  self: ResyncSelf;
  hosts: ResyncHost[];
}

/** POST /api/mesh/resync/:id: the commit the confirm sheet showed; refused unless it is still
    this host's boot commit. */
export interface ResyncStart {
  commit: string;
}
