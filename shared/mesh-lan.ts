// Dial-out pairings (§mesh/lan): the Mesh page's view and its writes. Separate from protocol.ts, so
// hosts that never see a pairing are never "skewed" by this feature. Nothing here carries a key;
// pins travel as fingerprints (8 groups of 4 hex digits), which are not secret.

/** A channel's state on this host. "waiting" carries why the last try failed and when the next is. */
export type LanChannelStatus =
  | { state: "connected"; since: number }
  | { state: "connecting" }
  | { state: "waiting"; reason: string; retryAt: number }
  | { state: "not connected" };

export interface LanPairingStatus {
  /** The peer's id in peers.json (its /peer/<id>/). */
  id: string;
  label: string;
  /** "dial": this host dials it (it is this host's relay). "accept": it dials this host. */
  role: "dial" | "accept";
  fingerprint: string;
  /** role "dial": where its relay listens. */
  host?: string;
  port?: number;
  /** answer: the relay asks, the dial-out host answers. ask: the dial-out host asks. */
  channels: { answer: LanChannelStatus; ask: LanChannelStatus };
  /** Its connections keep replacing each other: two machines may hold its key. */
  cloneSuspected?: true;
}

export interface LanStatus {
  /** This host's own pin, once its key exists (absent until the user asks for it). */
  fingerprint?: string;
  /** This host as a relay, when set. */
  relay?: {
    host: string;
    port: number;
    exposure: "lan" | "internet";
    /** Listening now: only while it accepts at least one pairing. */
    listening: boolean;
    boundPort?: number;
    counts?: { open: number; banned: number; bans: number };
  };
  pairings: LanPairingStatus[];
}

/** POST /api/mesh/lan/pairings: add a pairing. `grant` defaults to "presence". */
export interface LanPairingAdd {
  id: string;
  label?: string;
  role: "dial" | "accept";
  /** The other host's pin, as shown on its page (any case, dashes or spaces allowed). */
  pin: string;
  host?: string;
  port?: number;
  grant?: string;
}

/** PUT /api/mesh/lan/relay: this host as a relay (null: not one). */
export type LanRelayPut = { host: string; port: number; exposure?: "lan" | "internet" } | null;
