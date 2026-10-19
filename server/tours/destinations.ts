import { BlockList, isIP } from "node:net";
import { holdsShareLink } from "../link-tokens";
import { isTourOrigin, type TourEdition, type TourSize } from "../../shared/tour";

const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(ip, bits, "ipv6");
export type TourDestinations = Record<string, Record<string, Partial<Record<TourSize, string>>>>;
export const isPublicTourAddress = (host: string): boolean => { const ip = isIP(host); return !!ip && !blocked.check(host, ip === 4 ? "ipv4" : "ipv6") && (ip === 4 || /^[23]/.test(host)); };
/** Owner-chat callback only. An origin approval never makes a loopback address phone-usable. */
export function ownerTourDestinations(e: TourEdition, approved: (origin: string) => boolean): TourDestinations {
  if (e.source.kind !== "site" || !isTourOrigin(e.source.origin) || !approved(e.source.origin)) return {};
  const u = new URL(e.source.origin), host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ip = isIP(host);
  if ((ip && !isPublicTourAddress(host)) || (!ip && (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host)))) return {};
  // Viewing must never resolve a name or fetch the recorded app. Only a contained child can attest it.
  if (!ip && !e.provenance.publicOrigins?.includes(e.source.origin)) return {};
  const out: TourDestinations = {};
  for (const step of e.manifest.steps) for (const view of step.views) {
    if (view.kind !== "page" || !view.route) continue;
    const url = new URL(view.route, u.origin);
    // Fragments may hold credentials (including opaque auth callbacks); do not guess their meaning.
    if (url.origin !== u.origin || url.hash || [...url.searchParams.keys()].some(k => /(?:token|password|secret|auth|key|session|code|credential)/i.test(k)) || holdsShareLink(url.href)) continue;
    const sizes: Partial<Record<TourSize, string>> = {};
    for (const size of ["desktop", "phone"] as const) if (view.captures[size]) sizes[size] = url.href;
    (out[step.id] ??= {})[view.id] = sizes;
  }
  return out;
}
