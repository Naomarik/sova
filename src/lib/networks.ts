// The Access page's Networks card and its "QR points at" picker, pure: names, the confirmation's words,
// the retype rule, and which pairing link the QR draws. DOM- and Solid-free, so it tests without a page.
import type { DetectedNetwork, NetworkKind, RangeCheck, TrustedNetwork } from "../../shared/networks";

/** A range with more addresses than this asks you to type it again before it is trusted. */
export const RETYPE_ABOVE = 65_536;

const KIND_NAME: Record<NetworkKind, string> = {
  tailscale: "Tailscale",
  wireguard: "WireGuard",
  zerotier: "ZeroTier",
  netbird: "NetBird",
  nebula: "Nebula",
  vpn: "VPN",
  wifi: "Wi-Fi",
  wired: "Wired network",
  lan: "Wi-Fi or wired",
};

export const kindName = (kind: NetworkKind | undefined): string => (kind ? KIND_NAME[kind] : "Range");

/** A listed network's title: what it is, then its interface ("WireGuard · wg0"). */
export function networkTitle(n: { kind?: NetworkKind; iface?: string; address?: string | null }): string {
  const base = n.iface ? `${kindName(n.kind)} · ${n.iface}` : kindName(n.kind);
  // One interface may carry an IPv4 and an IPv6 network: each is its own row, so say which.
  return n.address?.includes(":") ? `${base} · IPv6` : base;
}

/** Its line under the title: this computer's address on it, and the range it accepts from. */
export function networkMeta(n: { address: string | null; range: string | null; vpn?: boolean }, trusted: boolean): string {
  const parts = [n.address ? `This computer: ${n.address}` : "Not connected right now"];
  if (n.range) parts.push(trusted ? `accepts from: ${n.range}` : n.range);
  else parts.push("range unknown: add it below");
  if (n.vpn === false) parts.push("not a VPN");
  return parts.join(" · ");
}

/** A count of addresses as the page says it: digits with commas; past 2^53, a power of 2. */
export function countLabel(count: number | undefined, label?: string): string {
  if (label) return label;
  if (count === undefined || !Number.isFinite(count)) return "an unknown number of";
  if (count > Number.MAX_SAFE_INTEGER) return `2^${Math.round(Math.log2(count))}`;
  return count.toLocaleString("en-US");
}

export function needsRetype(check: Pick<RangeCheck, "count" | "needsRetype">): boolean {
  return check.needsRetype ?? (check.count ?? 0) > RETYPE_ABOVE;
}

/** The retyped range matches when it is the same range, spaces aside. */
export function retypeMatches(range: string, typed: string): boolean {
  return typed.replace(/\s+/g, "").toLowerCase() === range.toLowerCase();
}

/** What the confirmation says, in order: the size and what it allows, then each warning that changes the choice. */
export interface ConfirmWords {
  title: string;
  body: string;
  /** Where Sova will answer for it, when the check knows. */
  where?: string;
  /** The stronger warning for a network that isn't a VPN (Wi-Fi, wired). */
  notVpn?: string;
  /** The server's own warning about the range (larger than its network, not behind a VPN). */
  warning?: string;
  /** Asked when the range is past RETYPE_ABOVE. */
  retype?: string;
}

export const NOT_VPN_WARNING =
  "This isn't a VPN. Sova's traffic there is plain HTTP that anyone on the network can read, including the sign-in, which never expires. Trust only a network you control, such as your home's, never a café's or an office's.";

export function confirmWords(check: RangeCheck & { range: string }): ConfirmWords {
  const count = countLabel(check.count, check.countLabel);
  const words: ConfirmWords = {
    title: `Trust ${check.range}?`,
    body: `${count} ${check.count === 1 ? "address" : "addresses"}. Devices there can open Sova's sign-in screen. Each one still needs a pairing code once.`,
  };
  if (check.address) words.where = `Sova will answer at ${check.address}${check.iface ? `, on ${networkTitle(check)}` : ""}.`;
  if (check.vpn === false) words.notVpn = NOT_VPN_WARNING;
  if (check.warning) words.warning = check.warning;
  if (needsRetype(check)) words.retype = `That's more than ${RETYPE_ABOVE.toLocaleString("en-US")} addresses. Type ${check.range} to trust it.`;
  return words;
}

/** A trusted range's state, as a chip word and its tone. */
export function trustState(t: TrustedNetwork | undefined): { word: string; tone: "success" | "warn" | "" } {
  if (!t) return { word: "Not trusted", tone: "" };
  return t.listening ? { word: "Trusted", tone: "success" } : { word: "Trusted · waiting", tone: "warn" };
}

/** Why a trusted range isn't answering yet. */
export function waitingReason(t: TrustedNetwork): string | undefined {
  if (t.listening) return undefined;
  return t.error ?? (t.address ? `Sova can't answer at ${t.address} yet. It tries again every 15 seconds.` : "Waiting for this network to connect.");
}

/** The rows the card lists: each detected network with its trusted range, then the typed ranges no
    detected network carries. */
export interface NetworkRow {
  key: string;
  title: string;
  meta: string;
  /** The range Trust… and Stop Trusting act on; null when the page has to ask for one. */
  range: string | null;
  trusted?: TrustedNetwork;
  vpn: boolean;
}

export function networkRows(networks: DetectedNetwork[], trusted: TrustedNetwork[], opts: { tailscaleReady?: boolean } = {}): NetworkRow[] {
  const used = new Set<string>();
  const rows: NetworkRow[] = [];
  const vpnFirst = [...networks].sort((a, b) => Number(b.vpn) - Number(a.vpn));
  for (const n of vpnFirst) {
    const t = trusted.find((x) => (n.range !== null && x.range === n.range) || (x.iface !== undefined && x.iface === n.iface));
    // With Tailscale's HTTPS address ready, its own row above stands for it; a plain-address row stays only once trusted.
    if (!t && n.kind === "tailscale" && opts.tailscaleReady) continue;
    if (t) used.add(t.range);
    rows.push({
      key: `if:${n.id}`,
      title: networkTitle(n),
      meta: networkMeta({ address: n.address, range: t?.range ?? n.range, vpn: n.vpn }, !!t),
      range: t?.range ?? n.range,
      trusted: t,
      vpn: n.vpn,
    });
  }
  for (const t of trusted) {
    if (used.has(t.range)) continue;
    rows.push({
      key: `range:${t.range}`,
      title: t.label ?? (t.iface ? networkTitle(t) : `Range · ${t.range}`),
      meta: networkMeta({ address: t.address, range: t.range }, true),
      range: t.range,
      trusted: t,
      vpn: true,
    });
  }
  return rows;
}

// ---- the "QR points at" picker ----

export interface PairLink {
  label: string;
  url: string;
  kind?: "tailscale" | "trusted" | "here";
  secure?: boolean;
}

/** A link another device could open: http(s), and not an address only this computer answers at. */
export function reachableLink(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return ["http:", "https:"].includes(protocol) && !/^(localhost|.*\.localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(hostname);
  } catch {
    return false;
  }
}

/** The address a link points at, the part a pick is remembered by (the code after it changes). */
export function linkOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The picker's choices: every link a phone could open, in the server's order (Tailscale first). */
export const pickerLinks = (links: PairLink[]): PairLink[] => links.filter((l) => reachableLink(l.url));

/** The link the QR draws: the last pick while it is still offered, else the first. */
export function pickedLink(choices: PairLink[], remembered: string | null): PairLink | undefined {
  return (remembered ? choices.find((l) => linkOrigin(l.url) === remembered) : undefined) ?? choices[0];
}

/** Whether the link is a secure context on the phone: an https address (Tailscale's). */
export function linkSecure(link: PairLink): boolean {
  if (link.secure !== undefined) return link.secure;
  try {
    return new URL(link.url).protocol === "https:";
  } catch {
    return false;
  }
}

export const INSECURE_MISSES =
  "At this address your phone gets no notifications, can't install Sova as an app, has no voice input, and some Copy buttons don't work. Only the Tailscale address has those.";
export const SAME_NETWORK =
  "This QR opens only on a device connected to the same network. A privacy VPN such as Mullvad doesn't connect your devices to each other, so it won't work there.";

/** What the page says under the QR for the picked link: nothing for Tailscale's https address. */
export function pickNotes(link: PairLink | undefined): string[] {
  if (!link || link.kind === "tailscale" || linkSecure(link)) return [];
  return link.kind === "here" ? [INSECURE_MISSES] : [INSECURE_MISSES, SAME_NETWORK];
}

export const QR_PICK_KEY = "sova.access.qrPick";
