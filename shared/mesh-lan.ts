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
  /** role "dial": its relay is on the internet (behind its accept process). */
  internet?: true;
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
    /** "lan": Sova's own listener, local-network addresses only. "internet": the accept process
        listens, on Sova's word (§mesh.lan/accept-process). */
    exposure: RelayExposure;
    /** Listening now: only while it accepts at least one pairing (and, on the internet, while the
        accept process runs). */
    listening: boolean;
    boundPort?: number;
    counts?: { open: number; banned: number; bans: number };
  };
  /** This host's accept process, for an internet relay. */
  acceptor: AcceptorStatus;
  pairings: LanPairingStatus[];
}

export type RelayExposure = "lan" | "internet";

/** "not configured": SOVA_RELAY_HANDOFF is unset, or its directory isn't Sova's own. */
export type AcceptorState = "running" | "not running" | "wrong version" | "not configured";

export interface AcceptorStatus {
  state: AcceptorState;
  /** Set when it ever vouched for a host the connection didn't prove (until Sova restarts). */
  mismatchAt?: number;
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
  /** role "dial": the relay is on the internet; only then may `host` be public. */
  internet?: boolean;
  grant?: string;
}

/** PUT /api/mesh/lan/relay: this host as a relay (null: not one). */
export type LanRelayPut = { host: string; port: number; exposure?: RelayExposure } | null;

// ─── Relay addresses ────────────────────────────────────────────────────────────────────────────
// A LAN relay listens, and a dial-out host dials, only on a loopback, private or link-local address
// (§mesh.lan/pairing): Sova's own listener never takes a public address. An internet relay's public
// handshake runs in the separate accept process, which binds any one unicast address
// (relayBindAddress), and only a pairing marked as on the internet dials one. Pure, so the server
// and the page judge an address the same way.

export type AddressScope = "loopback" | "private" | "link-local" | "public";

interface ParsedIp {
  /** 4 or 16 bytes; a v4-mapped IPv6 address comes back as its IPv4 address. */
  bytes: number[];
  /** The address as Sova keeps it: dotted IPv4, or IPv6 in lower case (with its zone, if any). */
  text: string;
}

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return null; // no leading zeros: "010" is 8 to some parsers
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseV6(s: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    const parts = h.split(":");
    for (const [i, p] of parts.entries()) {
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = parseV4(p);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<number>(Math.max(0, missing)).fill(0), ...tail];
  return all.flatMap((g) => [g >> 8, g & 0xff]);
}

/** An IP literal, or null (a name, or anything malformed). IPv6 may be bracketed and carry a zone. */
export function parseIp(input: string): ParsedIp | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const v4 = parseV4(s);
  if (v4) return { bytes: v4, text: v4.join(".") };
  const zoneAt = s.indexOf("%");
  const zone = zoneAt < 0 ? "" : s.slice(zoneAt + 1);
  if (zoneAt >= 0 && !/^[0-9a-z._-]{1,32}$/.test(zone)) return null;
  const v6 = parseV6(zoneAt < 0 ? s : s.slice(0, zoneAt));
  if (!v6) return null;
  // ::ffff:a.b.c.d is an IPv4 address to every socket API: judge (and keep) it as one.
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    if (zone) return null;
    const mapped = v6.slice(12);
    return { bytes: mapped, text: mapped.join(".") };
  }
  return { bytes: v6, text: s };
}

/** Where an address is reachable from: only "public" can be routed to from the internet. */
export function addressScope(bytes: readonly number[]): AddressScope {
  if (bytes.length === 4) {
    const [a = 0, b = 0] = bytes;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 169 && b === 254) return "link-local";
    return "public"; // 0/8 (every interface) and 100.64/10 (carrier NAT, the tailnet) included
  }
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "loopback";
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return "private"; // fc00::/7
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return "link-local"; // fe80::/10
  return "public"; // :: (every interface) and global unicast included
}

/** Why `host` can't be a relay address (this host's listener, or a relay a dial-out host dials), or
    the address as Sova keeps it. Only an IP literal that is loopback, private or link-local passes:
    never every interface in any spelling, never a public address. */
export function relayAddress(host: string): { address: string } | { error: string } {
  const ip = parseIp(host);
  if (!ip) return { error: "not an IP address" };
  if (ip.bytes.every((b) => b === 0)) return { error: "every interface, never one address" };
  if (addressScope(ip.bytes) === "public") return { error: "a public address; only a relay reached from the internet (through its accept process) may use one" };
  if (ip.text.includes("%") && addressScope(ip.bytes) !== "link-local") return { error: "a zone belongs only to a link-local address" };
  return { address: ip.text };
}

/** Multicast (224/4, ff00::/8) or the IPv4 limited broadcast: never one host's address. */
function isGroupAddress(bytes: readonly number[]): boolean {
  if (bytes.length === 4) return ((bytes[0] ?? 0) & 0xf0) === 0xe0 || bytes.every((b) => b === 255);
  return bytes[0] === 0xff;
}

/** Why `host` can't be an internet relay's address (where its accept process binds, or where a
    pairing marked as on the internet dials), or the address as Sova keeps it: any one unicast IP
    literal, public or private, never every interface, a multicast or a broadcast address. */
export function relayBindAddress(host: string): { address: string } | { error: string } {
  const ip = parseIp(host);
  if (!ip) return { error: "not an IP address" };
  if (ip.bytes.every((b) => b === 0)) return { error: "every interface, never one address" };
  if (isGroupAddress(ip.bytes)) return { error: "a multicast or broadcast address, never one host's" };
  if (ip.text.includes("%") && addressScope(ip.bytes) !== "link-local") return { error: "a zone belongs only to a link-local address" };
  return { address: ip.text };
}
