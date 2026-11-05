/**
 * Settings → Public links' typed boxes, checked by the form (src/lib/public-links.ts) and by
 * `PUT /api/public-links` (server/public-links.ts) with the same rules and words (shared/form-rules.ts).
 */
import type { CustomRule, WholeRule } from "./form-rules";

export const SHARE_PORT_RULE: WholeRule = { kind: "whole", label: "The local port", min: 1, max: 65535 };
export const INGRESS_PORT_RULE: WholeRule = { kind: "whole", label: "The ingress port", min: 1, max: 65535 };

/** The gateway's public address: https://, a host only (one trailing slash forgiven). */
export const PUBLIC_URL_RULE: CustomRule = {
  kind: "custom",
  label: "The public address",
  issue(t) {
    const u = t.replace(/\/+$/, "");
    if (!u) return "Enter the public address.";
    if (!/^https:\/\//i.test(u)) return "The public address must start with https://.";
    try {
      const p = new URL(u);
      return p.pathname !== "/" || p.search || p.hash || p.username || p.password ? "The public address is a host only, with no path." : null;
    } catch {
      return "Enter the public address as https://share.example.com.";
    }
  },
};

/** The preview address (§mesh.public/preview-address): one * label over a domain, no path; "" is none. */
export const PREVIEW_URL_RULE: CustomRule = {
  kind: "custom",
  label: "The preview address",
  issue(t) {
    const u = t.toLowerCase().replace(/\/+$/, "");
    return !u || /^https:\/\/\*\.((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})?$/.test(u)
      ? null
      : "Enter the preview address as https://*.example.com: one * label over your domain, no path.";
  },
};
