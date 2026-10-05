import type { MeshHello } from "./protocol";
import { FRAME_HOST_NAME } from "./vis-frame-host";

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
 * GET  /api/peer/share-gateway/info[?kinds=1[&preview=1]] -> GatewayInfo | 404 { error: "not-gateway" }
 *                                     (this host is no gateway). `kinds` is answered only when asked
 *                                     with `?kinds=1`, and `previewUrl` only with `preview=1` too: an
 *                                     older routed host parses the info strictly and would refuse a
 *                                     key it doesn't know.
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
  /** The preview address (§mesh.public/preview-address): `https://*.<host>`, one wildcard label
      over a host of at least two labels. Absent: no preview links through this gateway. */
  previewUrl?: string;
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
  /** While this host should bind its share listener and can't (§mesh.public/listener-failure):
      where, and why in one sentence. `port` is null when SOVA_SHARE_PORT isn't a port. The other
      fields stay as they were. */
  listener?: ShareListenerFailure;
}

export interface ShareListenerFailure {
  host: string;
  port: number | null;
  reason: string;
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
  /** Where preview links minted here point (§mesh.public/preview-address). */
  preview?: PreviewAddress;
  /** For `route: "self"` with a gateway setting: the chosen front's steps. */
  front?: FrontGuide;
  /** Only when `route` is "self": the hosts that registered links here, or that `acceptFrom`
      lists. `peer`: its id in peers.json, null when it is no longer there. `links`: its live
      registered links. `up`: its hello answered just now. `lastPushAt`: when its last snapshot was
      stored (ms epoch). `accepted`: `acceptFrom` accepts it now. */
  routed?: RoutedHost[];
  /** The peers whose hello advertises a share gateway (discovery; acceptance is GatewayInfo). */
  gateways?: AdvertisedGateway[];
}

export interface RoutedHost {
  nodeId: string;
  peer: string | null;
  links: number;
  up: boolean;
  lastPushAt: number | null;
  accepted: boolean;
}

export interface AdvertisedGateway {
  nodeId: string;
  peer: string;
  publicUrl: string;
}

/** POST /api/public-links/verify. */
export interface VerifyResult {
  ok: boolean;
  /** The HTTP status the check got, when it got one. */
  status?: number;
  error?: string;
  /** With a preview address: the check of a random preview host (§mesh.public/preview-address). */
  preview?: { ok: boolean; status?: number; error?: string };
}

/** GET and PUT /api/visitor-logging (main listener only), `<stateRoot>/visitor-logging.json`
    with `version: 1` (§mesh.public/visitor-log). Both off by default; not in PublicLinksFile,
    whose strict parse an older build would fail on. */
export interface VisitorLogging {
  /** Record each visitor's address, user agent, language and pages, host-local. */
  logVisitors: boolean;
  /** The preview proxy sends the app `X-Forwarded-For` and `X-Forwarded-Proto`. */
  forwardIp: boolean;
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
    and `seq`, the last snapshot stored for it, or null. `kinds`: the registry row kinds this
    gateway accepts in a snapshot (`x` is accepted but never routed), only when asked
    (`?kinds=1`). A gateway that omits it (an older one) accepts `h`, `i` and `x` only, and a
    routed host sends it no `s` row: one unknown kind rejects the whole snapshot, so none of that
    update (new h and i links included) would land. A routed host believes `kinds` only from the
    exact target (generation and entry) that stated it, until a refusal, a restart or a change. */
export interface GatewayInfo {
  publicUrl: string;
  accepting: boolean;
  seq: number | null;
  kinds?: RegistryLinkKind[];
  /** Only when asked with `?kinds=1&preview=1`, and only while a preview address is set. */
  previewUrl?: string;
}

/** A link's kind, which binds the routes its row may serve: `h` hand-off (/h/, /api/h/, /ws/h),
    `i` owner page (/i/, /api/i/), `s` session share (/s/, /api/s/, /ws/s, §app/session-share),
    `x` reserved for exposures (phase 2; never a share route), `p` a preview link (its own host
    `<label>.<zone>`, every path on it, §mesh.public/preview). */
export type RegistryLinkKind = "h" | "i" | "s" | "x" | "p";
/** Every kind this build's gateway accepts, in GatewayInfo.kinds. */
export const REGISTRY_LINK_KINDS: readonly RegistryLinkKind[] = ["h", "i", "s", "x", "p"];

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
/** Assets typed by their exact name, never by extension: the frame host (shared/vis-frame-host.ts),
    the one HTML asset, passed with its own headers. Any other `.html` name is never fetched. */
export const ASSET_NAME_TYPES: Readonly<Record<string, string>> = {
  [FRAME_HOST_NAME]: "text/html; charset=utf-8",
};

// ---- gateway → routed host ingress --------------------------------------------------------------

/** Set on every hop by the gateway, after stripping: one X-Forwarded-For (the client address it
    computed), `https`, and the host of the configured publicUrl (never the incoming Host). */
export const INGRESS_SET_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"] as const;
/** Removed from every hop by the gateway before it sets its own, matched case-insensitively,
    besides hop-by-hop headers and any header named in Connection. A trailing "*" is a prefix.
    `cf-connecting-ip` and `true-client-ip` are CDN client-address headers nothing reads; they go too. */
export const INGRESS_STRIP_HEADERS = ["forwarded", "x-forwarded-*", "x-real-ip", "cf-connecting-ip", "true-client-ip", "tailscale-*", "x-sova-*"] as const;

// ---- offline ------------------------------------------------------------------------------------

/** A known hash whose host is down or refused (or a hop that failed with 502/504): the page shell
    is a static 503 (no names, no token), `/api/h|i|s/…` is 503 `OfflineBody` (never buffered or
    replayed), a `/ws/h` or `/ws/s` upgrade is 503, an asset with no source is 503. An unknown hash
    stays 404. */
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
/** The close code of a live `/ws/h` or `/ws/s` hop whose host went away; the page reconnects with backoff. */
export const HOP_LOST_CLOSE = 4503;
export const RECONNECT_BACKOFF_MS = { first: 5000, max: 60_000 } as const;

// ---- preview links (§mesh.public/preview) -------------------------------------------------------

/** A preview's label, its secret: 32 random bytes as 52 lowercase base32 characters (a DNS label
    holds at most 63). The registry row's `h` is the SHA-256 of it. */
export const PREVIEW_LABEL_RE = /^[a-z2-7]{52}$/;
/** Set by a gateway on a preview hop, after it stripped every incoming x-sova-* header: the label
    of the preview host it matched. A routed host's ingress reads it only on an admitted connection. */
export const PREVIEW_HEADER = "x-sova-preview";
/** A preview address as written: `https://*.<host>` (a pin may be http), host of two labels or more. */
export const PREVIEW_URL_RE = /^(https?):\/\/\*\.((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}))?$/;

/** A preview host's limits (§mesh.public/preview-limits); the share host keeps its own. */
export const PREVIEW_LIMITS = {
  requestsPerMinute: 1200,
  bodyMaxBytes: 25 * 1024 * 1024,
  headersMs: 60_000,
  httpPerPreview: 64,
  wsPerPreview: 16,
  httpTotal: 256,
  wsTotal: 256,
} as const;
/** Ports a preview never publishes, whatever this host binds: Sova's own defaults. */
export const FORBIDDEN_PREVIEW_PORTS: readonly number[] = [4800, 4801, 4802, 4810];
export const PREVIEW_DAYS_DEFAULT = 1;
export const PREVIEW_DAYS_MAX = 30;
/** The not-running page reloads itself this often (and says so in Retry-After). */
export const PREVIEW_RETRY_S = 10;

/** The static answers of a preview host (§mesh.public/preview-offline): no host, port or token. */
export const PREVIEW_PAGES = {
  notRunning: { title: "Not running", text: "This preview isn't running right now. It will open here once the app is started again." },
  gone: { title: "Link turned off", text: "This preview link is no longer active." },
  unknown: { title: "Not found", text: "This preview link isn't active." },
  slow: { title: "No answer", text: "The app took too long to answer." },
} as const;

/** Where preview links minted here point: the address, `*.<zone>` form, and where it came from;
    null with `reason` when none can be minted. */
export interface PreviewAddress {
  url: string | null;
  source: "env" | "setting" | "gateway" | null;
  reason?: "no-address" | "gateway-old";
  /** `reason`'s sentence, the gateway named. */
  message?: string;
}
