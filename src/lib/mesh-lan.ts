// The Mesh page's dial-out pairings (§mesh.lan/pairing): what each pairing's state reads as, and
// whether the pairing form can be sent. Pure; the card is components/MeshPairings.tsx.

import { type LanChannelStatus, type LanPairingStatus, type LanStatus, parseIp, relayAddress } from "../../shared/mesh-lan";

export type { LanPairingStatus, LanStatus };

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
  if (waiting) return { tone: "warn", word: "Reconnecting", detail: `${capital(waiting.reason)}. Next try in ${secondsUntil(waiting.retryAt, now)} s.` };
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
  if (r.listening) return `Listening on ${where} for ${countWord(s.pairings.filter((p) => p.role === "accept").length, "dial-out host")}.`;
  return s.pairings.some((p) => p.role === "accept") ? `Set to ${where}, and not listening yet.` : `Set to ${where}. It listens only while a dial-out host is paired.`;
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
    if (parseIp(d.host) && "error" in relayAddress(d.host)) return "Use the relay's local-network address. A relay on the internet isn't available yet.";
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter the relay's port, 1–65535.";
  }
  return null;
}

/** The relay form's problem, or null. */
export function relayProblem(host: string, port: string): string | null {
  const h = host.trim();
  if (!h) return "Enter one address of this host for dial-out hosts to reach.";
  // The server's rule (peers.ts checkRelay), judged the same way.
  const ip = parseIp(h);
  if (!ip) return "Enter an IP address of this host.";
  if (ip.bytes.every((b) => b === 0)) return "Use one address of this host, not every address.";
  if ("error" in relayAddress(h)) return "Use a local-network address (10.x, 172.16–31.x, 192.168.x, 169.254.x, fc00::/7, fe80::/10 or loopback). A relay on the internet isn't available yet.";
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Enter a port, 1–65535.";
  return null;
}
