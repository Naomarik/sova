// The Mesh page's dial-out pairings (§mesh.lan/pairing): what each pairing's state reads as, and
// whether the pairing form can be sent. Pure; the card is components/MeshPairings.tsx.

import { type AcceptorState, type LanChannelStatus, type LanPairingStatus, type LanStatus, parseIp, type RelayExposure, relayAddress, relayBindAddress } from "../../shared/mesh-lan";

export type { LanPairingStatus, LanStatus, RelayExposure };

export interface PairingState {
  tone: "success" | "warn" | "info" | "neutral";
  word: string;
  /** Why it isn't connected and when it tries again, when that is known. */
  detail?: string;
}

const secondsUntil = (at: number, now: number) => Math.max(1, Math.round((at - now) / 1000));

/** One word for both channels: connected only when both are. */
export function pairingState(p: LanPairingStatus, now: number): PairingState {
  const { answer, ask } = p.channels;
  if (answer.state === "connected" && ask.state === "connected") return { tone: "success", word: "Connected" };
  const waiting = [answer, ask].find((c): c is Extract<LanChannelStatus, { state: "waiting" }> => c.state === "waiting");
  if (waiting) {
    // An internet relay that keeps timing out: the network this host is on may drop its port.
    const blocked = p.internet && waiting.reason === "timed out" ? ` The network this host is on may block port ${p.port}.` : "";
    return { tone: "warn", word: "Reconnecting", detail: `${capital(waiting.reason)}. Next try in ${secondsUntil(waiting.retryAt, now)} s.${blocked}` };
  }
  if (answer.state === "connecting" || ask.state === "connecting") return { tone: "info", word: "Connecting" };
  if (answer.state === "connected" || ask.state === "connected") return { tone: "warn", word: "Half connected" };
  return p.role === "accept" ? { tone: "neutral", word: "Not connected", detail: "It hasn't dialed in yet." } : { tone: "neutral", word: "Not connected" };
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** What the pairing is to this host, as its row's chip says it. */
export const roleWord = (p: Pick<LanPairingStatus, "role">): string => (p.role === "dial" ? "Relay" : "Dial-out host");

/** The relay line under this host's fingerprint. */
export function relayLine(s: LanStatus): string {
  const r = s.relay;
  if (!r) return "This host isn't a relay.";
  const where = `${r.host.includes(":") ? `[${r.host}]` : r.host}:${r.boundPort ?? r.port}`;
  const from = r.exposure === "internet" ? " from the internet" : "";
  if (r.listening) return `Listening${from} on ${where} for ${countWord(s.pairings.filter((p) => p.role === "accept").length, "dial-out host")}.`;
  if (!s.pairings.some((p) => p.role === "accept")) return `Set to ${where}${from}. It listens only while a dial-out host is paired.`;
  if (r.exposure === "internet" && s.acceptor.state !== "running") return `Set to ${where}${from}, and not listening: ${acceptorReason(s.acceptor.state)}`;
  return `Set to ${where}${from}, and not listening yet.`;
}

/** Why "The internet" can't be chosen now, or null when it can (the accept process runs). */
export function acceptorReason(state: AcceptorState): string | null {
  if (state === "running") return null;
  if (state === "wrong version") return "the accept process is an older version. It restarts itself in a few seconds.";
  if (state === "not running") return "the accept process isn't running. See SUDO.md §5 on the server.";
  return "this host has no accept process. An admin sets it up once (SUDO.md §5).";
}

/** The accept process's line while this host relays on the internet. */
export function acceptorLine(s: LanStatus): string | null {
  if (s.relay?.exposure !== "internet") return null;
  if (s.acceptor.state !== "running") return `Accept process: ${s.acceptor.state}.`;
  const c = s.relay.counts;
  return c ? `Accept process: running · ${c.open} open · ${c.banned} banned now · ${c.bans} bans so far.` : "Accept process: running.";
}

const countWord = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A fingerprint as typed or pasted: 32 hex digits, with any dashes or spaces. Null if it isn't one. */
export function parseFingerprint(input: string): string | null {
  const hex = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(hex) ? hex : null;
}

export interface PairingDraft {
  role: "dial" | "accept";
  fingerprint: string;
  id: string;
  label: string;
  host: string;
  port: string;
  /** role "dial": the relay is on the internet. */
  internet: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Why the pairing form can't be sent yet, or null. `taken`: ids already used here. */
export function pairingProblem(d: PairingDraft, taken: readonly string[], own?: string): string | null {
  const fp = parseFingerprint(d.fingerprint);
  if (!fp) return "Paste the other host's fingerprint: 32 letters and digits, as its Mesh page shows them.";
  if (own && parseFingerprint(own) === fp) return "That's this host's own fingerprint. Paste the other host's.";
  const id = d.id.trim();
  if (!ID_RE.test(id)) return "Use up to 32 lowercase letters, digits and dashes for the name, starting with a letter or digit.";
  if (taken.includes(id)) return `A host named ${id} is already in the list.`;
  if (d.role === "dial") {
    if (!d.host.trim()) return "Enter the relay's address, as this host reaches it.";
    if (parseIp(d.host)) {
      // The server's rule (peers.ts checkLan), judged the same way.
      if (d.internet && "error" in relayBindAddress(d.host)) return "Use one address of the relay, not every address, a multicast or a broadcast one.";
      if (!d.internet && "error" in relayAddress(d.host)) return "Use the relay's local-network address, or check “This relay is on the internet”.";
    }
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter the relay's port, 1–65535.";
  }
  return null;
}

/** The relay form's problem, or null. */
export function relayProblem(host: string, port: string, exposure: RelayExposure = "lan", acceptor: AcceptorState = "running"): string | null {
  const h = host.trim();
  if (!h) return "Enter one address of this host for dial-out hosts to reach.";
  // The server's rule (peers.ts checkRelay), judged the same way.
  const ip = parseIp(h);
  if (!ip) return "Enter an IP address of this host.";
  if (ip.bytes.every((b) => b === 0)) return "Use one address of this host, not every address.";
  if (exposure === "internet") {
    if ("error" in relayBindAddress(h)) return "Use one address of this host, not a multicast or broadcast one.";
  } else if ("error" in relayAddress(h)) {
    return "Use a local-network address (10.x, 172.16–31.x, 192.168.x, 169.254.x, fc00::/7, fe80::/10 or loopback), or choose “The internet”.";
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Enter a port, 1–65535.";
  const why = exposure === "internet" ? acceptorReason(acceptor) : null;
  if (why) return `Can't relay on the internet yet: ${why}`;
  return null;
}

/** A warning for an internet relay on 443, which the public share front may hold. */
export const portWarning = (exposure: RelayExposure, port: string): string | null =>
  exposure === "internet" && Number(port) === 443 ? "Port 443 may already belong to this host's public share front. Use 4803 unless you know it is free." : null;
