import { BlockList, isIP } from "node:net";
import { canonicalIp } from "../share/security";

// Address ranges for trusted networks (§app.access/networks): parsing a typed range, the private
// ranges a network may be trusted on, sizes, and the source check a trusted listener runs.
// Pure: no socket, no file.

/** A parsed range, normalized to its network address (10.8.0.7/24 → 10.8.0.0/24). */
export interface Cidr {
  family: 4 | 6;
  /** The network address as text, canonical. */
  network: string;
  prefix: number;
  /** The network address as a big integer (v4: 32 bits, v6: 128 bits). */
  value: bigint;
}

const BITS = { 4: 32, 6: 128 } as const;

function v4ToBig(ip: string): bigint {
  return ip.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function bigToV4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
}

function v6ToBig(ip: string): bigint {
  // Expand "::" and any embedded v4 tail into eight 16-bit groups.
  let text = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4ToBig(v4[1]!);
    text = `${text.slice(0, -v4[1]!.length)}${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

function bigToV6(n: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Through URL for the canonical compressed form.
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}

/** An address as a big integer, or null when it isn't an IP literal. A v4-mapped v6 address is its v4. */
export function ipValue(raw: string): { family: 4 | 6; value: bigint } | null {
  const ip = canonicalIp(raw.trim().replace(/%.*$/, ""));
  if (!ip) return null;
  const family = isIP(ip);
  if (family === 4) return { family: 4, value: v4ToBig(ip) };
  if (family === 6) return { family: 6, value: v6ToBig(ip) };
  return null;
}

const mask = (family: 4 | 6, prefix: number): bigint => {
  const bits = BigInt(BITS[family]);
  const all = (1n << bits) - 1n;
  return prefix === 0 ? 0n : (all >> (bits - BigInt(prefix))) << (bits - BigInt(prefix));
};

/** `10.8.0.0/24`, `fd00::/8`, or a bare address (a single host: /32, /128). Null when unparsable. */
export function parseCidr(text: string): Cidr | null {
  const t = text.trim();
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const ip = ipValue(m[1]!.replace(/^\[|\]$/g, ""));
  if (!ip) return null;
  const prefix = m[2] === undefined ? BITS[ip.family] : Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > BITS[ip.family]) return null;
  const value = ip.value & mask(ip.family, prefix);
  return { family: ip.family, prefix, value, network: ip.family === 4 ? bigToV4(value) : bigToV6(value) };
}

/** The range as text, normalized: `10.8.0.0/24`. */
export const cidrText = (c: Cidr): string => `${c.network}/${c.prefix}`;

/** Normalize a range's text, or null when unparsable. */
export function normalizeRange(text: string): string | null {
  const c = parseCidr(text);
  return c ? cidrText(c) : null;
}

/** How many addresses the range holds (a v6 range can be astronomically large). */
export const cidrSize = (c: Cidr): bigint => 1n << BigInt(BITS[c.family] - c.prefix);

/** The size as a number the page can show; capped at Number.MAX_SAFE_INTEGER. */
export const sizeNumber = (c: Cidr): number => {
  const n = cidrSize(c);
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
};

/** Whether `inner` lies wholly inside `outer`. */
export function cidrWithin(inner: Cidr, outer: Cidr): boolean {
  return inner.family === outer.family && inner.prefix >= outer.prefix && (inner.value & mask(outer.family, outer.prefix)) === outer.value;
}

/** Whether an address lies inside the range. */
export function cidrContains(c: Cidr, address: string): boolean {
  const ip = ipValue(address);
  return !!ip && ip.family === c.family && (ip.value & mask(c.family, c.prefix)) === c.value;
}

/** Whether two ranges share any address. */
export const cidrOverlaps = (a: Cidr, b: Cidr): boolean => cidrWithin(a, b) || cidrWithin(b, a);

/** The network an interface address with its prefix sits on (os.networkInterfaces' `cidr`). */
export const networkOf = (address: string, prefix: number): Cidr | null => parseCidr(`${address}/${prefix}`);

/** A range's first usable host address (the network address itself for /31, /32, /127, /128). */
export function firstHost(c: Cidr): string {
  const hostBits = BITS[c.family] - c.prefix;
  const v = hostBits >= 2 ? c.value + 1n : c.value;
  return c.family === 4 ? bigToV4(v) : bigToV6(v);
}

/** The ranges a network may be trusted on: private (RFC 1918), carrier-grade NAT (Tailscale, Headscale,
    NetBird) and IPv6 unique-local. Anything else is public and refused outright. */
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fd00::/8"] as const;
const PRIVATE = PRIVATE_RANGES.map((r) => parseCidr(r)!);

/** Above this many addresses the confirmation shows the count and asks for the range typed again. */
export const RETYPE_ABOVE = 65_536;

export type RangeRefusal = "unparsable" | "public";

/** Why a typed range can't be trusted, or null when it can: it must parse and lie wholly inside one private range. */
export function rangeRefusal(text: string): RangeRefusal | null {
  const c = parseCidr(text);
  if (!c) return "unparsable";
  return PRIVATE.some((p) => cidrWithin(c, p)) ? null : "public";
}

export const REFUSAL_WORDS: Record<RangeRefusal, string> = {
  unparsable: "That isn't a range. Type one such as 10.8.0.0/24.",
  public: "Only private ranges can be trusted: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 or fd00::/8.",
};

/** Whether the confirmation must ask for the range typed again. */
export const needsRetype = (c: Cidr): boolean => cidrSize(c) > BigInt(RETYPE_ABOVE);

/** The source check of a trusted listener: an address inside any of the ranges, judged on the
    socket's own address (v4-mapped v6 counts as its v4), never a forwarded header. */
export interface SourceCheck {
  allows(address: string | undefined): boolean;
}

export function sourceCheck(ranges: readonly string[]): SourceCheck {
  const list = new BlockList();
  let any = false;
  for (const r of ranges) {
    const c = parseCidr(r);
    if (!c) continue;
    list.addSubnet(c.network, c.prefix, c.family === 4 ? "ipv4" : "ipv6");
    any = true;
  }
  return {
    allows(address) {
      if (!any || !address) return false;
      const ip = canonicalIp(address.replace(/%.*$/, ""));
      if (!ip) return false;
      return list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
    },
  };
}
