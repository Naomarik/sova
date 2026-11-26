// The Access page's networks (trusted networks, §app.access/networks): what GET /api/auth/networks answers
// and the bodies of its acts. Local-only routes; trusting needs the operator's own click in the page.

/** `lan`: Wi-Fi or wired, where Sova can't tell which (macOS). */
export type NetworkKind = "tailscale" | "wireguard" | "zerotier" | "netbird" | "nebula" | "vpn" | "wifi" | "wired" | "lan";

/** One of this computer's networks, as detection found it (Docker, VM and bridge networks are left out). */
export interface DetectedNetwork {
  /** Stable key: the interface name. */
  id: string;
  kind: NetworkKind;
  iface: string;
  /** This computer's address on it. */
  address: string;
  /** Its range in CIDR; null for a point-to-point address with no route found (the page asks for one). */
  range: string | null;
  /** False for Wi-Fi and wired networks. */
  vpn: boolean;
  /** A trusted range covers it. */
  trusted: boolean;
}

/** A range the operator trusted: Sova listens at its address and accepts only sources inside it. */
export interface TrustedNetwork {
  range: string;
  /** The local address Sova listens at for it; null while its network is down. */
  address: string | null;
  port: number | null;
  /** The listener is bound right now. */
  listening: boolean;
  iface?: string;
  kind?: NetworkKind;
  /** What it was trusted as, e.g. "WireGuard · wg0"; absent for a typed range on no listed network. */
  label?: string;
  /** Why it isn't listening, in a sentence. */
  error?: string;
}

export interface NetworksView {
  /** Sova was started on every network (HOST=0.0.0.0 or ::): nothing to trust per network. */
  wildcard: boolean;
  /** The Tailscale row, as the pairing links know it; null when there is no Tailscale. */
  tailscale: { ready: boolean; url?: string } | null;
  /** VPNs first, then Wi-Fi and wired. */
  networks: DetectedNetwork[];
  trusted: TrustedNetwork[];
}

/** POST /api/auth/networks/check {range}: no side effects. */
export interface RangeCheck {
  ok: boolean;
  /** The canonical CIDR. */
  range?: string;
  count?: number;
  /** For counts a number can't carry (IPv6). */
  countLabel?: string;
  /** The local address the OS routes the range through. */
  address?: string;
  iface?: string;
  kind?: NetworkKind;
  vpn?: boolean;
  /** Size of the network the range sits on. */
  networkCount?: number;
  /** More than 65,536 addresses: the trust call must carry the range typed again. */
  needsRetype?: boolean;
  /** A sentence: larger than its network, not behind any VPN. */
  warning?: string;
  /** Why it is refused (public or invalid), when ok is false. */
  error?: string;
}

/** POST /api/auth/networks/trust. */
export interface TrustBody {
  range: string;
  /** The range typed again, when the check said needsRetype. */
  confirm?: string;
}

/** POST /api/auth/networks/untrust: cuts that range's connections at once. */
export interface UntrustBody {
  range: string;
}

/** One address the pairing QR can point at (POST /api/auth/pair's `links`), in order: Tailscale, each
    listening trusted network, then the address the page is open at. The same code works at every one. */
export interface PairLink {
  label: string;
  /** The link with the code in its hash (`…/#c=<code>`). */
  url: string;
  kind: "tailscale" | "trusted" | "here";
  /** An https link: notifications, installing as an app and voice work there. */
  secure: boolean;
  /** For a trusted network's link, its range. */
  range?: string;
}

/** POST /api/auth/pair. */
export interface PairAnswer {
  code: string;
  expiresAt: string;
  links: PairLink[];
}
