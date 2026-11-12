import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SHARE_PORT_DEFAULT, type AdvertisedGateway, type BrokenLinks, type PublicLinksCandidate, type PublicLinksFile, type PublicLinksInfo, type PublicLinksReading, type PublicLinksTunnelInfo, type RoutedHost, type VerifyResult, type VisitorLogging } from "../shared/public-links";
import { advertisedGateways } from "./mesh/hello";
import { meshApi } from "./mesh/index";
import { localRequest } from "./mesh/proxy";
import { tokenFor, type LinkTokenKind } from "./link-tokens";
import { yourClickRefusal } from "./page-only";
import { patchPublicLinks, pinnedByEnv, planPublicLinksPatch, readPublicLinks, readPublicLinksSetting, readTunnelConsent, writeServerFields } from "./public-links";
import { candidateUrl, dropCandidate, noteCandidateFailure, readCandidate, saveCandidate, type StoredCandidate } from "./share/candidate";
import { linkByHash } from "./session-shares";
import { accountGuide, frontGuide, verifyPreviewUrl, verifyPublicUrl } from "./share/front";
import { previewAddress } from "./share/preview-address";
import { gatewayProtocol, refreshGateway } from "./share/gateway-client";
import { linkUrl, noteVerify, shareListenerSettled, shareState, withCandidate } from "./share/listener";
import { liveLinks } from "./share/registry-push";
import { routedHosts } from "./share/registry";
import { mountCloudflaredDownload } from "./share/tunnel/download";
import { publicLinksChanged } from "./share/setting-events";
import { hasAccountToken, mountAccountRoutes } from "./share/tunnel/account-token";
import { cloudflaredInfo, resolveCloudflared } from "./share/tunnel/binary";
import { brokenLinks } from "./share/tunnel/handouts";
import { checkTunnel, ensureTunnel, restartTunnel, runningTunnels, stopTunnel, tunnelStatus } from "./share/tunnel/manager";
import { mountTunnelRoutes } from "./share/tunnel/routes";
import { shareWanted } from "./share/tunnel/wiring";
import { parseVisitorLogging, readVisitorLogging, writeVisitorLogging } from "./visitor-logging";

/**
 * Settings → Public links (§mesh.public/setting): GET and PUT /api/public-links and POST
 * /api/public-links/verify (shared/public-links.ts). Main listener only: a request from the peer
 * listener (`meshPeer`) or relayed by a peer's proxy (X-Sova-Relayed) gets the plain 404, like the mesh
 * links' local acts. Works with the mesh off. GET and PUT /api/visitor-logging, the host's two
 * visitor switches (§mesh.public/visitor-log), answer the same way.
 */

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const local = localRequest;
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };
/** How long a PUT that routes this host through a gateway waits for that gateway's first answer
    (§mesh.public/via-answer), so the reply shows its address rather than `off`. */
export const VIA_ANSWER_WAIT_MS = 3000;

/** Where GET and PUT learn the gateway's routed hosts (server/share/registry.ts) and the peers
    advertising a gateway (server/mesh/hello.ts); tests pass their own. */
export interface PublicLinksSources {
  routed: () => Promise<RoutedHost[] | null>;
  gateways: () => Promise<AdvertisedGateway[]>;
  /** The longest a via PUT waits for the gateway's answer; absent: VIA_ANSWER_WAIT_MS. */
  viaAnswerWait?: () => Promise<void>;
  /** A candidate's outside check; absent: verifyPublicUrl (tests pass their own, never a fetch). */
  verify?: (url: string) => Promise<VerifyResult>;
}
const SOURCES: PublicLinksSources = {
  routed: () => routedHosts(),
  // The mesh's own peers: none while it is off, a copied folder's included (server/mesh/index.ts).
  gateways: () => advertisedGateways(() => meshApi.config()?.peers ?? []),
};

const SHARE = { kind: "share" } as const;
const BROKEN_TITLES: Record<"h" | "i" | "s" | "t", string> = { h: "Hand-off link", i: "Owner link", s: "Session share", t: "Tour link" };

/** The share tunnel's live links handed out before its current address began (§mesh.public/broken-links). */
function shareBroken(epoch: number | null): BrokenLinks | undefined {
  const live = liveLinks(Date.now()).filter((l) => l.kind === "h" || l.kind === "i" || l.kind === "s" || l.kind === "t");
  return brokenLinks(live, epoch, (l) => {
    const kind = l.kind as "h" | "i" | "s" | "t";
    const token = tokenFor(l.h, kind as LinkTokenKind);
    const shared = kind === "s" ? linkByHash(l.h) : null;
    const title = shared ? `${shared.share.title || BROKEN_TITLES.s} · ${shared.link.label}` : BROKEN_TITLES[kind];
    return { kind, id: l.h, title, kept: token !== null, ...(token ? { url: linkUrl(kind, token) } : {}) };
  });
}

/** The tunnels' part of the answer, under Free or Account or while a tunnel runs: the on-demand
    check of the share tunnel (at most once a minute, loopback only, §mesh.tunnel/lifetime), the
    preview tunnels, cloudflared (looked for once per server lifetime) and the broken links. */
async function tunnelInfo(file: PublicLinksFile): Promise<PublicLinksTunnelInfo | undefined> {
  const routeRuns = file.route === "quick" || file.route === "account";
  const previews = runningTunnels().filter((t) => t.key.kind === "preview");
  if (!routeRuns && !previews.length) return undefined;
  const share = routeRuns ? await checkTunnel(SHARE).catch(() => tunnelStatus(SHARE)) : null;
  if (routeRuns) await resolveCloudflared().catch(() => null);
  const cloudflared = cloudflaredInfo() ?? { found: false, source: null, version: null, canDownload: false, install: "" };
  const broken = share ? shareBroken(share.epoch) : undefined;
  return { share, previews, cloudflared, ...(broken ? { broken } : {}) };
}

// ---- a new address waits for its Verify (§mesh.public/where-links-open) ---------------------------

const CANDIDATE = { kind: "candidate" } as const;

/** Whether the current route works: Free's tunnel up, or any other route's address verified (its
    Verify passed, or the via gateway confirmed). Off, a broken setting, an unverified address, a Free
    tunnel not up: nothing to keep, so a new setup takes over at once. Memory and one file read. */
export function routeWorks(file: PublicLinksFile): boolean {
  if (file.route === "off") return false;
  if (file.route === "quick") return tunnelStatus(SHARE).state === "up";
  return shareState(process.env, file).state === "verified";
}

/** Whether a PUT's next setting waits as a candidate rather than switching: it moves to Account or
    to this host as the gateway, at an address other than today's, while today's route works. Pure
    over its inputs. */
export function waitsForVerify(next: PublicLinksFile, current: PublicLinksFile, works: boolean): boolean {
  if (next.route !== "account" && next.route !== "self") return false;
  if (next.route === current.route && candidateUrl(next) === candidateUrl(current)) return false;
  return works && candidateUrl(next) !== null;
}

/** The candidate as the page sees it. */
function candidateView(c: StoredCandidate): PublicLinksCandidate {
  const f = c.file;
  const previewUrl = f.route === "account" ? f.account?.previewUrl : f.gateway?.previewUrl;
  return {
    route: f.route as "account" | "self",
    publicUrl: candidateUrl(f)!,
    ...(previewUrl ? { previewUrl } : {}),
    ...(f.route === "self" && f.gateway ? { front: f.gateway.front } : {}),
    savedAt: c.savedAt,
    ...(c.failure ? { failure: c.failure } : {}),
  };
}

/** Drop a waiting candidate, and its tunnel if one runs. */
async function cancelCandidate(): Promise<void> {
  if (!readCandidate()) return;
  dropCandidate();
  if (tunnelStatus(CANDIDATE).state !== "stopped") await stopTunnel(CANDIDATE, "candidate dropped").catch(() => undefined);
}

/**
 * Verify a waiting candidate: run its address for the check only (an Account candidate's own tunnel,
 * beside the current one; a gateway's port on the share listener when nothing else is bound; its
 * host let through the Host gate), check it from outside, and only on a pass make it the route.
 * A failure keeps today's route and the candidate, with the reason. Runs only on a call.
 */
async function verifyCandidate(c: StoredCandidate, check: (url: string) => Promise<VerifyResult> = verifyPublicUrl): Promise<VerifyResult> {
  const url = candidateUrl(c.file)!;
  const host = new URL(url).hostname;
  const port = c.file.route === "self" ? (c.file.gateway?.sharePort ?? SHARE_PORT_DEFAULT) : null;
  const result = await withCandidate({ host, port }, async (): Promise<VerifyResult> => {
    if (c.file.route === "account") {
      const t = await ensureTunnel(CANDIDATE, { by: "operator" }).catch((err) => ({ state: "failed", reason: err instanceof Error ? err.message : String(err) }) as const);
      if (t.state !== "up" && t.state !== "degraded") return { ok: false, error: t.reason ?? "The Account tunnel didn't connect." };
    }
    const r: VerifyResult = await check(url);
    const preview = c.file.route === "self" ? c.file.gateway?.previewUrl : undefined;
    if (preview?.startsWith("https://")) r.preview = await verifyPreviewUrl(preview);
    return r;
  });
  if (c.file.route === "account") await stopTunnel(CANDIDATE, result.ok ? "verified" : "verify failed").catch(() => undefined);
  if (!result.ok) {
    noteCandidateFailure(result.error ?? "The new address didn't answer from outside.");
    return result;
  }
  // Passed: it becomes the route, over the setting as it is now.
  const r = patchPublicLinks(c.patch);
  dropCandidate();
  if ("error" in r) return { ok: false, error: r.error };
  noteVerify(url, true);
  writeServerFields({ verifiedAt: Date.now() });
  publicLinksChanged(r.file);
  await shareListenerSettled();
  // Account's tunnel takes over from Free's (its address is fixed: only a reconnect).
  if (r.file.route === "account") await restartTunnel(SHARE, "Account verified").catch(() => undefined);
  return result;
}

/** The answer of GET and PUT: `routed` only while this host is the gateway (route "self"),
    `gateways` always (none while the mesh is off); the setting's flags (implicit, broken, sharing
    off), Turn On, the Account token's presence and the tunnels (§mesh.public/setting). */
export async function publicLinksInfo(file: PublicLinksFile = readPublicLinks(), sources: PublicLinksSources = SOURCES, reading: PublicLinksReading = readPublicLinksSetting()): Promise<PublicLinksInfo> {
  const self = file.route === "self" && !!file.gateway;
  // Only on a routed host whose current gateway answered its info (§mesh.public/share-protocol).
  const protocol = typeof file.route === "object" ? gatewayProtocol() : null;
  const waiting = readCandidate();
  const [routed, gateways, tunnel] = await Promise.all([self ? sources.routed().catch(() => null) : null, sources.gateways().catch(() => []), tunnelInfo(file)]);
  const account = file.route === "account" ? accountGuide({ sharePort: file.gateway?.sharePort ?? SHARE_PORT_DEFAULT, ...(file.account ? { publicUrl: file.account.publicUrl, ...(file.account.previewUrl ? { previewUrl: file.account.previewUrl } : {}) } : {}) }) : null;
  return {
    file,
    share: shareState(process.env, file),
    pinnedByEnv: pinnedByEnv(),
    preview: previewAddress(process.env, file),
    ...(self && file.gateway ? { front: frontGuide(file.gateway) } : account ? { front: account } : {}),
    ...(self && routed ? { routed } : {}),
    gateways,
    ...(protocol ? { gatewayProtocol: protocol } : {}),
    ...(reading.implicit ? { implicit: true } : {}),
    ...(reading.broken ? { broken: true } : {}),
    ...(reading.sharingOff ? { sharingOff: true } : {}),
    ...(file.route === "quick" ? { consentAt: readTunnelConsent() } : {}),
    account: { hasToken: hasAccountToken() },
    ...(tunnel ? { tunnel } : {}),
    ...(waiting ? { candidate: candidateView(waiting) } : {}),
  };
}

export function mountPublicLinks(app: Hono, sources: PublicLinksSources = SOURCES): void {
  app.get("/api/public-links", async (c) => (local(c) ? c.json(await publicLinksInfo(readPublicLinks(), sources), 200, NO_STORE) : notFound(c)));

  app.put("/api/public-links", small, async (c) => {
    if (!local(c)) return notFound(c);
    // Where every link points, and Off, stay the user's (§mesh.public/sharing-off): a chat, the
    // Overseer, an extension and a peer are refused; the operator's own token script passes.
    const refused = yourClickRefusal(c, "publicLinks", { tokenScriptPasses: true });
    if (refused) return refused;
    const body = await c.req.json().catch(() => undefined);
    if ((body as { route?: unknown } | undefined)?.route === "account" && !hasAccountToken()) return c.json({ error: "Paste the tunnel's token first." }, 400);
    const plan = planPublicLinksPatch(body);
    if ("error" in plan) return c.json({ error: plan.error }, 400);
    // Links keep opening where they open now until a new address is saved and verified: a move to
    // Account or to this host as the gateway waits as a candidate while today's route works.
    const current = readPublicLinks();
    if (waitsForVerify(plan.file, current, routeWorks(current))) {
      await cancelCandidate();
      saveCandidate(body as Record<string, unknown>, plan.file);
      return c.json(await publicLinksInfo(current, sources), 200, NO_STORE);
    }
    // A route chosen outright replaces a waiting candidate.
    if (body && typeof body === "object" && "route" in body) await cancelCandidate();
    const r = patchPublicLinks(body);
    if ("error" in r) return c.json({ error: r.error }, 400);
    publicLinksChanged(r.file);
    // The answer carries the bind as it came out (§mesh.public/listener-failure).
    await shareListenerSettled();
    if (typeof r.file.route === "object") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = sources.viaAnswerWait?.() ?? new Promise<void>((res) => (timer = setTimeout(res, VIA_ANSWER_WAIT_MS)));
      await Promise.race([refreshGateway().catch(() => null), waited]);
      clearTimeout(timer);
    }
    // The reading as written, read again: the patch answers the effective file, whose flags (implicit) it can't carry.
    return c.json(await publicLinksInfo(r.file, sources, readPublicLinksSetting()), 200, NO_STORE);
  });

  app.delete("/api/public-links/candidate", async (c) => {
    if (!local(c)) return notFound(c);
    const refused = yourClickRefusal(c, "publicLinks", { tokenScriptPasses: true });
    if (refused) return refused;
    await cancelCandidate();
    return c.json(await publicLinksInfo(readPublicLinks(), sources), 200, NO_STORE);
  });

  mountTunnelRoutes(app, { info: () => publicLinksInfo(readPublicLinks(), sources), wanted: () => shareWanted() });
  mountAccountRoutes(app);

  app.get("/api/visitor-logging", (c) => (local(c) ? c.json(readVisitorLogging() satisfies VisitorLogging, 200, NO_STORE) : notFound(c)));
  app.put("/api/visitor-logging", small, async (c) => {
    if (!local(c)) return notFound(c);
    const next = parseVisitorLogging(await c.req.json().catch(() => undefined));
    if (!next) return c.json({ error: "Expected { logVisitors, forwardIp }, both true or false." }, 400);
    return c.json(writeVisitorLogging(next) satisfies VisitorLogging, 200, NO_STORE);
  });

  // Checks the effective address as it is now; a pass is kept (verifiedAt), a failure reads as
  // unreachable until a later check passes.
  app.post("/api/public-links/verify", async (c) => {
    if (!local(c)) return notFound(c);
    // A new address waiting for its check is what Verify checks (and, on a pass, switches to).
    const waiting = readCandidate();
    if (waiting) return c.json((await verifyCandidate(waiting, sources.verify)) satisfies VerifyResult, 200, NO_STORE);
    const url = shareState().publicUrl;
    if (!url) return c.json({ ok: false, error: "No public address is set." } satisfies VerifyResult, 200, NO_STORE);
    const result: VerifyResult = await verifyPublicUrl(url);
    // A gateway with a preview address checks a random preview host too (§mesh.public/preview-address).
    const preview = previewAddress();
    if (readPublicLinks().route === "self" && preview.url?.startsWith("https://")) result.preview = await verifyPreviewUrl(preview.url);
    noteVerify(url, result.ok);
    if (shareState().publicUrl === url) writeServerFields({ verifiedAt: result.ok ? Date.now() : null });
    return c.json(result satisfies VerifyResult, 200, NO_STORE);
  });

  // The one-click cloudflared download, your click only (§mesh.tunnel/cloudflared).
  mountCloudflaredDownload(app);
}
