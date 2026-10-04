import type { MeshInfo, MeshPeersUpdate, MeshSessions, PeerState, PeerStatus } from "./protocol";

// Per-peer grants (§mesh.peers/grants): what each peer may see and do on THIS host, decided on this
// host's own Mesh page and enforced at its peer listener. Types of this host's own /api/mesh/access
// route (main listener only, never on the peer listener and never proxied host to host) and of the
// caller-side "hidden" state. They stay out of protocol.ts on purpose: its hash is the mesh's
// compatibility fingerprint, and a field added there would make every host "skewed" against every
// older one.

/** What a peer may do here. Each is checked on the serving host; direction is per host. */
export type MeshCap =
  /** hello, details, and this host's name and Browser access tells. */
  | "presence"
  /** The session list, transcripts, /ws/chat and /ws/watch, creating and driving sessions, files,
      models and modes: shell-level, so in effect everything else too. */
  | "sessions"
  /** /api/peer/links/*. */
  | "links"
  /** /ws/watch?feed=llm: this host's LLM calls in flight. */
  | "llm"
  | "sync.settings"
  | "sync.themes"
  | "sync.extensions"
  /** pi auth.json logins (each one also by `logins`), and the Claude login pool with them. */
  | "sync.logins"
  /** The outreach relay (§app.outreach/sender-route). */
  | "outreach"
  /** The share-gateway registry (§mesh/public). */
  | "share"
  /** Renaming this host, its Browser access, settings and every other write. */
  | "admin";

export const MESH_CAPS: readonly MeshCap[] = [
  "presence",
  "sessions",
  "links",
  "llm",
  "sync.settings",
  "sync.themes",
  "sync.extensions",
  "sync.logins",
  "outreach",
  "share",
  "admin",
];

export type MeshPreset = "full" | "sessions" | "presence" | "none";

export const MESH_PRESETS: readonly MeshPreset[] = ["full", "sessions", "presence", "none"];

/** One peer's grant as mesh-access.json stores it. */
export interface MeshGrant {
  preset: MeshPreset;
  /** Switches on top of the preset; an absent cap is the preset's. */
  caps?: Partial<Record<MeshCap, boolean>>;
  /** The logins (`<store>:<provider>` keys, e.g. "pi:zai") that go to this peer while sync.logins is
      granted. Absent = every login (the `full` preset's meaning, today's behaviour). */
  logins?: string[];
}

/** `<state root>/mesh-access.json`. Keyed by the peer's node identity (peers.json `nodeId`). */
export interface MeshAccessFile {
  version: 1;
  peers: Record<string, MeshGrant>;
}

/** One peer as GET /api/mesh/access shows it. */
export interface MeshAccessPeer {
  id: string;
  label: string;
  nodeId: string;
  /** The stored grant; absent = not listed, which is `full`. A dial-out pairing is never absent
      here: unlisted, it reads as `presence`, what it has (§mesh.lan/pairing). */
  grant?: MeshGrant;
  /** What the peer may do now, every cap spelled out (the file's error makes every one false). */
  effective: Record<MeshCap, boolean>;
  /** The logins it receives now: "all", or the chosen keys. */
  logins: "all" | string[];
  /** What this host can see on that peer, learned from its answers (never a peer's claim): caps it
      denied this host since this server started, and when it last did. */
  theirs?: { denied: MeshCap[]; at: number };
}

/** GET /api/mesh/access (main listener only; 404 to a peer or a relayed browser). */
export interface MeshAccessView {
  /** False when no mesh-access.json exists: every peer is `full`. */
  exists: boolean;
  /** Why the file can't be used; while set, every peer gets hello only (fail closed). */
  error?: string;
  peers: MeshAccessPeer[];
  /** The logins this host could share (keys), for the per-login switches; empty while logins don't sync. */
  logins: Array<{ key: string; provider: string; kind?: "oauth" | "api_key" }>;
}

/** PUT /api/mesh/access {peer, grant}: one peer's grant (by peer id); grant null removes it (= full),
    or for a dial-out pairing sets presence. */
export interface MeshAccessPut {
  peer: string;
  grant: MeshGrant | null;
}

/** PUT /api/mesh/peers may name the preset of a peer it pairs (by peer id). A peer it pairs that is
    named here gets that grant; one not named gets none (= full, as before grants). The pairing form
    always names one, `presence` unless the user picks more. */
export interface MeshPeersPut extends MeshPeersUpdate {
  grants?: Record<string, MeshPreset>;
}

/** The marker value of X-Sova-Mesh on a grant's refusal; "refused" keeps meaning "not a peer". */
export const DENIED = "denied";

/** A host whose answer was `denied` reads as hidden: reachable, not down, nothing of it shown. */
export type MeshAccessState = "hidden";

/** A peer's state as this host's own page reads it: protocol's, or `hidden`. */
export type PeerStateView = PeerState | MeshAccessState;

/** PeerStatus as GET /api/mesh sends it to this host's page. */
export type PeerStatusView = Omit<PeerStatus, "state"> & { state: PeerStateView };

/** GET /api/mesh as this host's page reads it. */
export interface MeshInfoView extends Omit<MeshInfo, "peers"> {
  peers: PeerStatusView[];
}

/** GET /api/mesh/sessions as this host's page reads it: a row may also be `hidden`. */
export interface MeshSessionsView {
  peers: Array<Omit<MeshSessions["peers"][number], "state"> & { state: PeerStateView }>;
}

/** Each preset's caps (before switches). */
export function presetCaps(preset: MeshPreset): Record<MeshCap, boolean> {
  const on = (list: readonly MeshCap[]) => Object.fromEntries(MESH_CAPS.map((c) => [c, list.includes(c)])) as Record<MeshCap, boolean>;
  switch (preset) {
    case "full":
      return on(MESH_CAPS);
    case "sessions":
      return on(["presence", "sessions", "links", "llm"]);
    case "presence":
      return on(["presence"]);
    case "none":
      return on([]);
  }
}

/** A grant's effective caps: the preset, then its switches. */
export function grantCaps(grant: MeshGrant): Record<MeshCap, boolean> {
  const caps = presetCaps(grant.preset);
  for (const c of MESH_CAPS) if (typeof grant.caps?.[c] === "boolean") caps[c] = grant.caps[c]!;
  return caps;
}
