import type { PreviewAddress } from "./public-links";

/**
 * Preview links (§mesh.public/preview): the operator's REST contract. A preview publishes one web
 * app on a loopback port of this host at the root of an origin of its own, `<label>.<zone>`: an
 * app a coding session already serves on a port, or a folder Sova serves itself
 * (§mesh.public/preview-serve). Imported by the server and the operator app, so it imports nothing
 * at runtime.
 *
 * Operator routes (main listener only; refused like the other local acts when the request carries a
 * peer or X-Forwarded-Host):
 * GET  /api/previews[?projectId]         -> PreviewList
 * GET  /api/projects/:pid/previews      -> PreviewList
 * POST /api/previews                     body PreviewMint -> PreviewMinted | 400 PreviewError
 * POST /api/previews/<id>/off            -> PreviewView (revoked) | 404
 * POST /api/previews/<id>/extend         body { days } -> PreviewView | 400 | 404
 *
 * The link of a preview made from now on is kept host-local (`preview-kept.json`, 0600) and is in
 * these answers only: the operator's. The project overseer never sees it (its tool results land in its
 * session file, in the org's workspace repo): it has PreviewHandoff, and a preview reaches a person by
 * its id, the link resolved server-side (§app.project-overseer/previews).
 */

export type PreviewState = "active" | "off" | "expired";

/** What a preview shows: an app on a port, or a folder Sova serves (`folder` relative to its
    coding session's worktree, "." for the worktree itself). */
export type PreviewTarget = { kind: "port"; port: number } | { kind: "static"; folder: string };

export interface PreviewView {
  /** pv_… */
  id: string;
  projectId: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** `operator`, or `session:<id>`: the project overseer's conversation that made it. */
  createdBy: string;
  /** A person's own link to preview `siblingOf`, sent to them on WhatsApp (§app.outreach/links). */
  siblingOf?: string;
  /** The roster person it was sent to, and their name as the list shows it ("sent to {name}"). */
  sentTo?: string;
  sentToName?: string;
  /** An active sibling's person's own link, when kept (from its send on): in the two GET lists only, for the
      Sent to line's Copy (§mesh.public/preview-card). Never in `url`, the mint's answer or any tool's output. */
  sentLink?: string;
  state: PreviewState;
  /** Something accepts connections on the port now (either loopback); for a folder, Sova serves it now. Only on active ones. */
  running?: boolean;
  /** The list's own fields (GET /api/previews); a preview made before them reads as a port, with no link kept. */
  target?: PreviewTarget;
  /** The kept link; null when none is kept (a preview made before links were kept: shown once). */
  url?: string | null;
  purpose?: string | null;
  /** Its coding session: recorded at the mint, or matched now by the listener's worktree (`sessionFrom`). */
  sessionId?: string | null;
  branch?: string | null;
  sessionFrom?: "recorded" | "worktree";
  /** The coding session's title as the project page lists it, and its file on this host. */
  sessionTitle?: string | null;
  sessionPath?: string | null;
  /** A running copy's share link (§app.project-services/share): the instance and its endpoint (`<service>.<port>`). */
  instance?: string;
  endpoint?: string;
  /** A copy link's copy as the engine's status reads it now: its endpoint's service `running`, `starting` or `stopped`
      (§mesh.public/preview-card: the operator may Start a stopped one; a visit never starts anything). Absent when the copy is gone. */
  copy?: { state: PreviewCopyState; slot: number };
}

export type PreviewCopyState = "running" | "starting" | "stopped";

export interface PreviewList {
  previews: PreviewView[];
  address: PreviewAddress;
}

export interface PreviewMint {
  projectId: string;
  /** Exactly one of `port` and `folder`. */
  port?: number;
  /** A folder inside `sessionId`'s worktree (relative to it, or absolute): Sova serves it. */
  folder?: string;
  /** The project's coding session it shows (needed with `folder`). */
  sessionId?: string;
  /** One line, at most PREVIEW_PURPOSE_MAX characters. */
  purpose?: string;
  /** 1 by default, at most PREVIEW_DAYS_MAX. */
  days?: number;
}

/** The link is in this answer, and kept for this host's operator and the project's overseer. */
export interface PreviewMinted {
  preview: PreviewView;
  url: string;
  /** A routed host whose gateway didn't confirm the row in time. */
  linkWarning?: string;
}

export type PreviewErrorCode =
  | "bad-port"
  | "forbidden-port"
  | "bad-days"
  | "bad-project"
  | "bad-target"
  | "bad-session"
  | "bad-purpose"
  | "not-listening"
  | "not-in-worktree"
  | "no-address"
  | "gateway-old"
  | "unavailable"
  /** The port belongs to a copy whose project declares production-derived data (§app.project-services/share). */
  | "sensitive";

export interface PreviewError {
  error: string;
  code: PreviewErrorCode;
}

/**
 * The one shape a preview leaves Sova's tools in (§app.project-overseer/previews): `sova_previews`
 * and `sova_preview` put it in their results' `details`. It never carries the link: a tool result is
 * part of the overseer's session file, which the org's workspace repo commits and may push. A tool
 * that sends a preview to a person (sova_send_to_person) takes its `id` and gives them their own link to
 * it, made on the server. `linkKept` says whether the operator has its link (false for a preview made
 * before links were kept, which can still be sent by its id); `purpose`, `sessionId` and `branch` are null when unknown; `running` is null unless it is
 * active. Fixed: fields are only ever added, under a new `v`.
 */
export interface PreviewHandoff {
  v: 1;
  id: string;
  linkKept: boolean;
  purpose: string | null;
  expiresAt: string;
  projectId: string;
  sessionId: string | null;
  branch: string | null;
  target: PreviewTarget;
  state: PreviewState;
  running: boolean | null;
  /** `operator`, or `session:<overseer conversation id>`. */
  createdBy: string;
}

export const PREVIEW_PURPOSE_MAX = 200;

/** The New Preview form's warning (§mesh.public/preview-card); `{n}` is the port. */
export const PREVIEW_WARNING = "Anyone with this link can use the app on port {n} as if they were on this computer, including its logins, admin pages and anything it can change.";
/** A mint refused for an old gateway; `{gateway}` is its label. */
export const PREVIEW_GATEWAY_OLD = "{gateway} needs updating before it can carry preview links.";
export const PREVIEW_NO_ADDRESS = "No preview address is set. Set one in Settings → Public links on the gateway.";
/** In place of the link of a preview made before links were kept (§mesh.public/preview-card). */
export const PREVIEW_NOT_KEPT = "Link shown only when it was made.";
