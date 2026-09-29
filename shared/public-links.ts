import type { MeshHello } from "./protocol";

/**
 * Wire types for public share links (§mesh.public): how a host's `/h/` and `/i/` links become
 * reachable from the internet, either on this host (it is the gateway, behind a TLS front) or
 * through a peer that is (the routed host registers its link hashes with that gateway). Imported
 * by the server and the operator app, so it imports nothing at runtime.
 *
 * Never add these to shared/protocol.ts: `MeshHello.protocol` is sha256 of that file, and any edit
 * there marks every older host skewed. The hello advertisement below is an optional intersection.
 *
 * Files (host-local, never committed):
 *   <stateRoot>/public-links.json   PublicLinksFile: 0600, atomic, strict parse, separate from peers.json
 *                                   (a host that is its own gateway works with the mesh off)
 *
 * Operator routes (main listener only; refused, like links-routes' `local()`, when the request
 * carries a peer (`meshPeer`) or X-Forwarded-Host):
 * GET  /api/public-links          -> PublicLinksInfo
 * PUT  /api/public-links          body PublicLinksPatch -> PublicLinksInfo | 400 { error }
 * POST /api/public-links/verify   -> VerifyResult (fetches <publicUrl>/h/<random> and expects the
 *                                    gateway's own 404 signature; follows no redirect; https only)
 *
 * Peer routes (peer listener; the caller is its verified StableID, and the address the gateway
 * dials back ALWAYS comes from peers.json, never from a body):
 * GET  /api/peer/share-gateway/info   -> GatewayInfo | 404 { error: "not-gateway" } (this host is no gateway)
 * PUT  /api/peer/share-gateway/links  body RegistrySnapshot (≤ SNAPSHOT_MAX_BYTES, refused before
 *                                     parsing when larger) -> RegistryAck
 */

/** The share port: the gateway binds it on 127.0.0.1 (its TLS front proxies to it), a routed host
    binds its ingress on its tailnet addresses. */
export const SHARE_PORT_DEFAULT = 4802;

// ---- the setting --------------------------------------------------------------------------------

/** How a gateway's public HTTPS reaches its 127.0.0.1 share port. Sova never writes the front's
    config; it shows the step for the one chosen. */
export type ShareFront = "vhost" | "caddy" | "funnel" | "cloudflared";

export interface ShareGatewaySetting {
  /** https://share.example.com, no path, no trailing slash. */
  publicUrl: string;
  front: ShareFront;
  /** The share port on 127.0.0.1; SHARE_PORT_DEFAULT by default. */
  sharePort: number;
  /** Which peers may register their links here: every peer, or these StableIDs. */
  acceptFrom: "all" | string[];
}

/** `off`: no public links. `self`: this host is the gateway (`gateway` set). `{ via }`: links
    go public through the peer with this Tailscale StableID in peers.json. The StableID, not the
    peer's id: a peer id can be renamed on this host, and the ingress gate needs the node anyway. */
export type ShareRoute = "off" | "self" | { via: { nodeId: string } };

/** <stateRoot>/public-links.json. */
export interface PublicLinksFile {
  version: 1;
  route: ShareRoute;
  /** This host as a gateway. Kept while `route` is not "self", so switching back restores it. */
  gateway?: ShareGatewaySetting;
  /** A routed host's ingress port on its tailnet addresses; SHARE_PORT_DEFAULT by default. */
  ingressPort?: number;
  /** Server-written only: the via gateway's publicUrl as last learnt (hello or ack). */
  lastKnownUrl?: string;
  /** Server-written only: when Verify last passed, ms epoch. */
  verifiedAt?: number;
}

/** The fields PUT /api/public-links may change; the server-written ones are never accepted. */
export type PublicLinksPatch = Partial<Pick<PublicLinksFile, "route" | "gateway" | "ingressPort">>;

/**
 * Where links minted on this host point, as shareState() (server/share/listener.ts) resolves it. Order: the
 * SOVA_SHARE_PUBLIC_URL pin (`env`) → this host's own gateway setting (`setting`) → the via
 * gateway (`gateway`: live from its hello, else lastKnownUrl) → the bound address (`bound`) → null.
 * `off`: nothing reachable from outside. `configured`: an address, not yet verified.
 * `verified`: Verify (or the gateway's ack) passed. `unreachable`: the last check failed.
 */
export interface ShareState {
  state: "off" | "configured" | "verified" | "unreachable";
  source: "env" | "setting" | "gateway" | "bound";
  publicUrl: string | null;
  /** The via peer's id in peers.json (looked up from its nodeId at read time), for a routed host. */
  via?: string;
  /** The linkWarning text (LINK_WARNINGS, the gateway named) when a minted link may not open
      from outside; absent when verified. */
  warning?: string;
  warningCode?: LinkWarningCode;
}

/** Why a minted link may not open from outside. `off`: no public links. `unverified`: an address
    Verify has not passed. `unreachable`: the via gateway can't be reached. `unconfirmed`: the
    gateway did not ack the mint within MINT_ACK_TIMEOUT_MS (the outbox keeps sending).
    A failed publication (the push errored) is `unconfirmed` too, never shown as confirmed.
    `not-accepted`: the gateway answers but does not accept this host's links. `sleeps`: this host
    is a laptop or phone, so its links don't open while it is asleep. */
export type LinkWarningCode = "off" | "unverified" | "unreachable" | "unconfirmed" | "not-accepted" | "sleeps";

/** The warnings' text (§design.copy-deck/public-links), verbatim; `{gateway}` is the via peer's label. */
export const LINK_WARNINGS: Readonly<Record<LinkWarningCode, string>> = {
  off: "This link can't be opened from outside yet. Turn on public links in Settings → Public links.",
  unverified: "This link may not open from outside yet. Verify the address in Settings → Public links.",
  unreachable: "{gateway} can't be reached, so this link won't open until it's back.",
  unconfirmed: "This link isn't public yet. We'll keep sending it to {gateway}, and it opens once {gateway} confirms.",
  "not-accepted": "{gateway} doesn't accept links from this host yet. Add this host in {gateway}'s Settings → Public links.",
  sleeps: "This link opens only while this host is awake.",
};

/** The front picker's labels (§design.copy-deck/public-links). */
export const FRONT_LABELS: Readonly<Record<ShareFront, string>> = {
  vhost: "Your web server",
  caddy: "Caddy on this host",
  funnel: "Tailscale Funnel",
  cloudflared: "Cloudflare Tunnel",
};

/** The steps to put the chosen front in place, generated for this host's setting; Sova shows
    them and never runs them. `root`: the step needs root on the gateway. */
export interface FrontGuide {
  front: ShareFront;
  steps: { label: string; text: string; root: boolean }[];
  notes?: string[];
}

/** GET and PUT /api/public-links. */
export interface PublicLinksInfo {
  file: PublicLinksFile;
  share: ShareState;
  /** The SOVA_SHARE_* variables set in the environment, which win over the setting. */
  pinnedByEnv: string[];
  /** For `route: "self"` with a gateway setting: the chosen front's steps. */
  front?: FrontGuide;
}

/** POST /api/public-links/verify. */
export interface VerifyResult {
  ok: boolean;
  /** The HTTP status the check got, when it got one. */
  status?: number;
  error?: string;
}

// ---- hello --------------------------------------------------------------------------------------

/** A gateway's hello carries this; an older host omits it and every reader treats it as optional.
    Discovery only: whether the gateway accepts a given host is GatewayInfo.accepting, asked by
    that host (the hello is served and cached without a caller). */
export interface ShareGatewayHello {
  shareGateway?: { publicUrl: string };
}
export type MeshHelloPublic = MeshHello & ShareGatewayHello;

// ---- registry (routed host → gateway) -----------------------------------------------------------

/** GET /api/peer/share-gateway/info, for the calling peer: whether its links are accepted here,
    and `seq`, the last snapshot stored for it, or null. */
export interface GatewayInfo {
  publicUrl: string;
  accepting: boolean;
  seq: number | null;
}

/** A link's kind, which binds the routes its row may serve: `h` hand-off (/h/, /api/h/, /ws/h),
    `i` owner page (/i/, /api/i/), `x` reserved for exposures (phase 2; never a share route). */
export type RegistryLinkKind = "h" | "i" | "x";

export interface RegistryLink {
  /** Lowercase 64-hex sha256 of the token: the gateway never sees a token. */
  h: string;
  /** Expiry, ms epoch. */
  exp: number;
  kind: RegistryLinkKind;
}

/**
 * PUT /api/peer/share-gateway/links: the routed host's WHOLE live set (links past their `exp` left
 * out). `seq` is monotonic per host and persisted: a seq ≤ the stored one changes nothing.
 *
 * The gateway, in one transaction: validates the whole body (validateSnapshot; any failure is
 * `bad-snapshot` and nothing changes), splits its rows into accepted and colliding ones, and
 * replaces the caller's rows with the accepted ones at once. The first claimant keeps a hash; the
 * gateway's own links are always first, so a row colliding with a local hash is dropped too, and
 * routing "local first" agrees with it. The caller is `mesh.requestPeer`, never a body field.
 */
export interface RegistrySnapshot {
  v: 1;
  /** A nonnegative safe integer. */
  seq: number;
  links: RegistryLink[];
  /** dist-share/assets names this host can serve; no name twice. */
  assets: string[];
  /** An integer, 1–65535. */
  ingressPort: number;
}

/** `seq` is the seq now STORED for the caller (also when a stale snapshot was ignored), and
    `collisions` the stored snapshot's colliding hashes (a retry with an equal seq reports the same
    ones). A mint is confirmed only when `seq` ≥ the seq that carried it and its hash is not in
    `collisions`; anything else leaves it `unconfirmed`. */
export type RegistryAck =
  | { ok: true; seq: number; publicUrl: string; collisions?: string[] }
  | { ok: false; error: "not-gateway" | "not-accepted" | "bad-snapshot" };

/** A mint waits this long for the gateway's ack; after it the link is returned with a warning
    and the snapshot stays in the outbox. */
export const MINT_ACK_TIMEOUT_MS = 3000;
/** The largest snapshot body a gateway reads. */
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

/** A snapshot is valid only when every rule holds; one failure rejects it whole (`bad-snapshot`).
    Also: exactly the RegistrySnapshot keys (an unknown key fails), `v` 1, `seq` a nonnegative
    safe integer, `ingressPort` an integer 1–65535, `kind` in the enum, `exp` finite and in the
    future, no `h` and no asset twice. maxLinks and SNAPSHOT_MAX_BYTES are independent ceilings:
    not every snapshot of maxLinks rows fits the byte cap. */
export const REGISTRY_LIMITS = {
  maxLinks: 20_000,
  maxAssets: 64,
  /** exp ≤ now + this: the longest link life (90 d) plus a day of clock slack. */
  maxExpiryAheadMs: 91 * 86_400_000,
  hash: /^[0-9a-f]{64}$/,
  /** And never containing "..". */
  asset: /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/,
} as const;

/** A hashed asset another host serves: the gateway forwards at most this many bytes, counted
    while streaming (never buffered first), follows no redirect, and answers with the type for the
    extension (never the peer's) and `nosniff`; any other extension is refused. Its own dist-share
    wins. The name rule is a safe-filename rule, not content authentication: a peer serving bytes
    on the share origin is an accepted residual risk. */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
};

// ---- gateway → routed host ingress --------------------------------------------------------------

/** Set on every hop by the gateway, after stripping: one X-Forwarded-For (the client address it
    computed), `https`, and the host of the configured publicUrl (never the incoming Host). */
export const INGRESS_SET_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"] as const;
/** Removed from every hop by the gateway before it sets its own, matched case-insensitively,
    besides hop-by-hop headers and any header named in Connection. A trailing "*" is a prefix. */
export const INGRESS_STRIP_HEADERS = ["forwarded", "x-forwarded-*", "x-real-ip", "tailscale-*", "x-sova-*"] as const;

// ---- offline ------------------------------------------------------------------------------------

/** A known hash whose host is down or refused (or a hop that failed with 502/504): the page shell
    is a static 503 (no names, no token), `/api/h|i/…` is 503 `OfflineBody` (never buffered or
    replayed), a `/ws/h` upgrade is 503, an asset with no source is 503. An unknown hash stays 404. */
export const OFFLINE_RETRY_AFTER_S = 60;
/** The offline page shell's text (§design.copy-deck/public-links): static, no names, no token. */
export const OFFLINE_PAGE = {
  title: "Not available right now",
  heading: "This page can't be opened right now.",
  body: "The computer it lives on is offline. Try again in a minute.",
} as const;
export interface OfflineBody {
  error: "offline";
  retryAfter: number;
}
/** The close code of a live `/ws/h` hop whose host went away; the page reconnects with backoff. */
export const HOP_LOST_CLOSE = 4503;
export const RECONNECT_BACKOFF_MS = { first: 5000, max: 60_000 } as const;
