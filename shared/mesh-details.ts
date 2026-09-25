import type { PeerState, SyncStatus } from "./protocol";

// Per-host details and rename (server/mesh/details.ts). Their own file, outside
// protocol.ts on purpose: its hash is the mesh's compatibility fingerprint, and hosts on different
// builds must keep talking while they update one at a time. A host on an older build answers
// these peer routes with the plain 404 of an unknown route, and the page says so.
//
// Peer listener (whois-gated like every /api/peer/* route; 404 elsewhere):
// GET  /api/peer/details          -> HostDetails   (what this host says about itself)
// POST /api/peer/rename  {label}  -> {label}   (the caller asks this host to call itself `label`;
//                                    it then tells its own peers, like a rename made here)
// POST /api/peer/label   HostLabel -> {ok:true}   (the caller now calls itself `label`, named at
//                                    `labelAt` by its own clock: its entry here takes it unless the
//                                    entry already holds a newer one; the caller is the gate's peer,
//                                    never a body field)
//
// Main listener (the page's; 404 while the mesh is off, like any unknown /api route):
// GET  /api/mesh/details          -> MeshDetails
// PUT  /api/mesh/label   HostRename -> HostRenameResult   (400 bad label, 404 unknown host,
//                                    409 malformed peers.json, 502 the host didn't take it, 501 it
//                                    runs an older build without rename)

/** What a host reports about itself. Counts and figures only: no paths, no secrets, no login names. */
export interface HostDetails {
  /** The details format version. */
  details: 1;
  id: string;
  label: string;
  /** ms epoch. */
  now: number;
  identity: {
    hostname: string;
    /** MagicDNS name, when tailscaled (or SOVA_SELF_DNS) says. */
    dnsName?: string;
    /** Tailnet IPs. */
    addresses: string[];
    /** process.platform: linux, darwin, android, … */
    platform: string;
    osRelease: string;
    arch: string;
    device: "phone" | "laptop" | "desktop" | "server" | "unknown";
    /** The machine's model name, when the OS says. */
    model?: string;
  };
  versions: {
    /** Sova's package version. */
    sova: string;
    /** The commit it was built from, when known. */
    commit?: string;
    pi: string;
    node: string;
    /** First 16 hex of sha256(shared/protocol.ts), as in MeshHello. */
    protocol: string;
  };
  uptime: {
    /** Seconds this Sova process has run. */
    process: number;
    /** Seconds since the machine booted; null when the OS won't say. */
    machine: number | null;
  };
  resources: {
    cores: number;
    /** 1, 5 and 15 minute load averages; absent where the OS hides them (Android). */
    load?: [number, number, number];
    /** Bytes. */
    memory: { total: number; available: number };
    /** Bytes free and total on the disk holding Sova's data. */
    disk?: { free: number; total: number };
    /** Percent 0–100. */
    battery?: { percent: number; charging: boolean };
    /** Why a phone has no battery reading: the Termux:API app isn't answering. */
    batteryHint?: "termux-api";
  };
  activity: {
    /** Session files on this host. */
    sessions: number;
    /** Sessions with a turn running now (this server's and any TUI's on this machine). */
    turnsRunning: number;
    /** Subagent workers working now. */
    workers: number;
  };
  sync: {
    categories: SyncStatus[];
    /** Logins this host holds live, and keys held back by a conflict. */
    logins?: { count: number; conflicts: number };
  };
  /** Its browser-facing address, when set (MeshSettings.serveUrl). */
  serveUrl?: string;
}

/** Why a host has no details: down, refused, another protocol, or an older build without the route. */
export type HostUnavailable = "down" | "refused" | "skewed" | "update";

export interface MeshHostDetails {
  id: string;
  label: string;
  /** The host serving this page. */
  self: boolean;
  state: PeerState | "self";
  details?: HostDetails;
  unavailable?: HostUnavailable;
  error?: string;
  /** Round trip of a hello from this host, ms. */
  latencyMs?: number;
  /** Last answer seen (ms epoch) since this server started; null when never. */
  lastSeen: number | null;
  /** When its current state (up or not) began, as seen by this server; null when unknown. */
  stateSince: number | null;
  /** When this host paired it (ms epoch); null: paired before dates were recorded. Absent for self. */
  pairedAt?: number | null;
  /** In this host's front door: 1-based position, null when left out. */
  frontDoor: { position: number | null; excluded: boolean };
  /** Its own https address, or none (a phone): open it through this host instead. */
  open: { kind: "direct"; url: string } | { kind: "through" };
}

export interface MeshDetails {
  /** This host first, then peers.json order. */
  hosts: MeshHostDetails[];
}

export interface HostRename {
  /** A host id: this host's own, or a peer's. */
  id: string;
  label: string;
}

/** How each peer took the news; a host that was down converges at its next hello. */
export interface HostTold {
  id: string;
  ok: boolean;
  error?: string;
}

/** POST /api/peer/label. */
export interface HostLabel {
  label: string;
  /** When the host named itself (its clock, ms epoch). */
  labelAt: number;
}

export interface HostRenameResult {
  label: string;
  told: HostTold[];
}
