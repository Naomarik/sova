import type { IncomingMessage } from "node:http";
import { PREVIEW_HEADER, PREVIEW_LABEL_RE, type PreviewAddress, type PublicLinksFile } from "../../shared/public-links";
import { PREVIEW_GATEWAY_OLD, PREVIEW_NO_ADDRESS } from "../../shared/preview-links";
import { previewPin, readPublicLinks } from "../public-links";
import { viaGatewayPeer, viaGatewayStatus } from "./gateway-client";
import { gatewayPreviewUrl } from "./registry";

/**
 * The preview address (§mesh.public/preview-address): where preview links minted here point, how a
 * preview host is recognized, and each preview's public origin. The address is `<scheme>://*.<zone>`;
 * a preview's origin is `<scheme>://<label>.<zone>`.
 */

/** Where previews minted here point. First match: the SOVA_SHARE_PREVIEW_URL pin, this host's own
    gateway setting, the via gateway's stated address (only once it listed kind `p`); else none,
    with why (`gateway-old`: the via gateway answered without `p`). */
export function previewAddress(env: NodeJS.ProcessEnv = process.env, file: PublicLinksFile = readPublicLinks()): PreviewAddress {
  const pin = previewPin(env);
  if (pin) return { url: pin, source: "env" };
  if (file.route === "self" && file.gateway) {
    return file.gateway.previewUrl ? { url: file.gateway.previewUrl, source: "setting" } : { url: null, source: null, reason: "no-address", message: PREVIEW_NO_ADDRESS };
  }
  if (typeof file.route === "object") {
    const status = viaGatewayStatus();
    if (status?.kinds && !status.kinds.includes("p")) {
      const name = status.label || viaGatewayPeer()?.label || "The gateway";
      const text = PREVIEW_GATEWAY_OLD.replaceAll("{gateway}", name);
      return { url: null, source: null, reason: "gateway-old", message: text.charAt(0).toUpperCase() + text.slice(1) };
    }
    if (status?.kinds?.includes("p") && status.previewUrl) return { url: status.previewUrl, source: "gateway" };
  }
  return { url: null, source: null, reason: "no-address", message: PREVIEW_NO_ADDRESS };
}

/** A preview address split: scheme and the zone's host (with its port, if any). */
export function zoneOf(url: string): { scheme: "http" | "https"; zone: string } | null {
  const m = /^(https?):\/\/\*\.(.+)$/.exec(url);
  return m ? { scheme: m[1] as "http" | "https", zone: m[2]! } : null;
}

/** A preview's public origin under an address. */
export function previewOrigin(url: string, label: string): string | null {
  const z = zoneOf(url);
  return z ? `${z.scheme}://${label}.${z.zone}` : null;
}

/** The label of the preview a Host header names under `url`'s zone, or null: exactly
    `<label>.<zone>` (case-insensitive), the scheme's default port allowed, a well-formed label. */
export function previewLabelOfHost(host: string | undefined, url: string | null): string | null {
  if (!host || !url) return null;
  const z = zoneOf(url);
  if (!z) return null;
  let h = host.trim().toLowerCase();
  const dflt = z.scheme === "https" ? ":443" : ":80";
  if (h.endsWith(dflt) && !z.zone.includes(":")) h = h.slice(0, -dflt.length);
  const suffix = `.${z.zone}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return PREVIEW_LABEL_RE.test(label) ? label : null;
}

/** The gateway's share listener: the preview a request is for, by its Host under the zone this
    gateway serves; null for the share host. */
export function gatewayPreviewMatch(req: IncomingMessage): string | null {
  return previewLabelOfHost(req.headers.host, gatewayPreviewUrl());
}

/** A routed host's ingress: the preview its admitted gateway named, never the Host. */
export function ingressPreviewMatch(req: IncomingMessage): string | null {
  const v = req.headers[PREVIEW_HEADER];
  return typeof v === "string" && PREVIEW_LABEL_RE.test(v) ? v : null;
}

/** The public origin of a preview minted here, or null with no address. */
export function localPreviewOrigin(label: string): string | null {
  const a = previewAddress();
  return a.url ? previewOrigin(a.url, label) : null;
}
