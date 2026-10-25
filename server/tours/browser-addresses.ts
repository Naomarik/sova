import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { TourCaptureFailure } from "./targets";

export const TOUR_PRIVATE_NAME_FAILURE = "This site name points at this computer or a private network; use the managed running copy or its literal address.";
const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(ip, bits, "ipv6");
export function isPublicRecordingAddress(address: string): boolean {
  const ip = isIP(address);
  return !!ip && !blocked.check(address, ip === 4 ? "ipv4" : "ipv6") && (ip === 4 || /^[23]/i.test(address));
}
type Resolver = (host: string) => Promise<readonly { address: string }[]>;
const hostOf = (origin: string) => new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
const named = (host: string) => host !== "localhost" && !isIP(host);

/**
 * Instantiate only inside the confined recording child. No viewing/host-side lookup.
 * `proxied` (the chat's sandbox is on): the child has no network of its own and its only peer is the
 * proxy relay, so it neither resolves names nor reads peer addresses; the attempt's proxy resolves
 * allowlisted names only and refuses every non-public answer. Nothing is attested in that mode.
 */
export class TourBrowserAddresses {
  private readonly checked = new Map<string, Promise<void>>();
  private readonly publicOrigins = new Set<string>();
  constructor(private readonly resolve: Resolver = host => lookup(host, { all: true, verbatim: true }), private readonly proxied = false) {}
  private refuse(origin: string): never {
    throw new TourCaptureFailure({ message: TOUR_PRIVATE_NAME_FAILURE, blockedOrigin: origin, guidance: "Use the managed running copy or its literal address, with exact-origin consent and the chat's sandbox." });
  }
  async beforeContact(origin: string): Promise<void> {
    const existing = this.checked.get(origin);
    if (existing) return existing;
    if (this.checked.size >= 64) throw new Error("The tour exceeds its distinct-origin limit.");
    const check = this.check(origin);
    this.checked.set(origin, check);
    return check;
  }
  private async check(origin: string): Promise<void> {
    const host = hostOf(origin);
    if (this.proxied) return;
    if (!named(host)) { if (isPublicRecordingAddress(host)) this.publicOrigins.add(origin); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: readonly { address: string }[];
    try {
      addresses = await Promise.race([this.resolve(host), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 5000); timer.unref(); })]);
    } catch {
      throw new TourCaptureFailure({ message: "This site name could not be resolved safely inside the recording sandbox.", blockedOrigin: origin, guidance: "Check this chat's network policy or use a permitted literal address. Recording never asks the host to resolve the name outside confinement." });
    } finally { if (timer) clearTimeout(timer); }
    if (!addresses.length || addresses.some(({ address }) => !isPublicRecordingAddress(address))) this.refuse(origin);
    this.publicOrigins.add(origin);
  }
  /** A browser's actual peer, when exposed, must not contradict the DNS preflight. */
  response(origin: string, address: string | undefined): void {
    if (this.proxied) return;
    if (named(hostOf(origin)) && address !== undefined && !isPublicRecordingAddress(address)) this.refuse(origin);
  }
  attestations(): string[] { return [...this.publicOrigins].sort(); }
}
