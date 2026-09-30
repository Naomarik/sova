import type { PreviewAddress } from "./public-links";

/**
 * Preview links (§mesh.public/preview): the operator's REST contract. A preview publishes one web
 * app on a loopback port of this host at the root of an origin of its own, `<label>.<zone>`.
 * Imported by the server and the operator app, so it imports nothing at runtime.
 *
 * Operator routes (main listener only; refused like the other local acts when the request carries a
 * peer or X-Forwarded-Host):
 * GET  /api/previews[?orgId&projectId]   -> PreviewList
 * POST /api/previews                     body PreviewMint -> PreviewMinted | 400 PreviewError
 * POST /api/previews/<id>/off            -> PreviewView (revoked) | 404
 * POST /api/previews/<id>/extend         body { days } -> PreviewView | 400 | 404
 */

export type PreviewState = "active" | "off" | "expired";

export interface PreviewView {
  /** pv_… */
  id: string;
  orgId: string;
  projectId: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** `operator` (`session:<id>` is reserved for one a session asked for and the operator approved). */
  createdBy: string;
  state: PreviewState;
  /** Something accepts connections on the port now (either loopback). Only on active ones. */
  running?: boolean;
}

export interface PreviewList {
  previews: PreviewView[];
  address: PreviewAddress;
}

export interface PreviewMint {
  orgId: string;
  projectId: string;
  port: number;
  /** 1 by default, at most PREVIEW_DAYS_MAX. */
  days?: number;
}

/** The link is in this answer only: its label is never stored. */
export interface PreviewMinted {
  preview: PreviewView;
  url: string;
  /** A routed host whose gateway didn't confirm the row in time. */
  linkWarning?: string;
}

export type PreviewErrorCode = "bad-port" | "forbidden-port" | "bad-days" | "bad-project" | "no-address" | "gateway-old" | "unavailable";

export interface PreviewError {
  error: string;
  code: PreviewErrorCode;
}

/** The New Preview form's warning (§mesh.public/preview-card); `{n}` is the port. */
export const PREVIEW_WARNING = "Anyone with this link can use the app on port {n} as if they were on this computer, including its logins, admin pages and anything it can change.";
/** A mint refused for an old gateway; `{gateway}` is its label. */
export const PREVIEW_GATEWAY_OLD = "{gateway} needs updating before it can carry preview links.";
export const PREVIEW_NO_ADDRESS = "No preview address is set. Set one in Settings → Public links on the gateway.";
