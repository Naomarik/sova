import { MINT_ACK_TIMEOUT_MS, type PublicLinksFile, type RegistryLinkKind, type TunnelStatus } from "../../../shared/public-links";
import { quickTunnelAllowed, readPublicLinks } from "../../public-links";
import { bindForTunnel, releaseTunnelBind } from "../listener";
import { onShareLinksChanged, setMintWait, type ShareLinksChange } from "../links-events";
import { liveLinks } from "../registry-push";
import { checkShareTunnel, shareTunnelStatus } from "../share-state";
import { onPublicLinksChanged } from "../setting-events";
import { readCandidateToken } from "./account-token";
import { onCloudflaredChanged } from "./binary";
import { readCandidate } from "../candidate";
import { noteHandouts } from "./handouts";
import { adoptTunnels, configureTunnels, ensureTunnel, onTunnelChanged, recordedTargetPort, runningTunnels, stopTunnel, tunnelStatus } from "./manager";

/**
 * The share tunnel's wiring (§mesh.tunnel/lifetime): what starts and stops the one Cloudflare tunnel
 * that carries every `/h/ /i/ /s/ /t/` link, and what tells open pages. No timer asks anything:
 *
 * - **Start, lazily.** A mint of an h/i/s/t link under Free (after Turn On) starts the share tunnel,
 *   and the mint waits up to 20 s for it (setMintWait), so the first share answers a full link. A
 *   save of the Account route starts its tunnel at once.
 * - **Stop when nothing is shared.** At a revoke, at the last live link's expiry (one unref'd
 *   one-shot timer, set to the latest live link's expiry), at Sova's start, and when the route
 *   leaves Free and Account. An Account tunnel runs while the route is Account, links or not.
 * - **Tell pages.** Every tunnel change, a setting save and a cloudflared download publish the page
 *   event (`public_links_changed`), so a page re-reads GET /api/public-links.
 *
 * The listener binds for a tunnel only through tunnel-core's shareTarget (bindForTunnel), and lets
 * go once no tunnel is left.
 */

const SHARE = { kind: "share" } as const;
const SHARE_KINDS: ReadonlySet<RegistryLinkKind> = new Set(["h", "i", "s", "t"]);
/** How long a mint waits for a Free share tunnel to come up (§mesh.tunnel/lifetime). */
export const QUICK_MINT_WAIT_MS = 20_000;

export interface TunnelWiringOptions {
  env?: NodeJS.ProcessEnv;
  /** The page event (server/index.ts: publishFeed). */
  publish?: () => void;
  now?: () => number;
}

let env: NodeJS.ProcessEnv = process.env;
let publish: () => void = () => {};
let now: () => number = () => Date.now();
let unsubscribe: (() => void)[] = [];
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const route = (file: PublicLinksFile = readPublicLinks(env)) => file.route;

/** The live h/i/s/t links (not revoked, not expired), latest expiry first. */
export const liveShareLinks = (at = now()) => liveLinks(at).filter((l) => SHARE_KINDS.has(l.kind));

/** Whether the share tunnel should run (tunnel-core's shareWanted): Account always; Free after
    Turn On while a live h/i/s/t link exists. */
export function shareWanted(file: PublicLinksFile = readPublicLinks(env)): boolean {
  if (file.route === "account") return !!file.account;
  if (file.route === "quick") return quickTunnelAllowed(env) && liveShareLinks().length > 0;
  return false;
}

/** Whether a Free share tunnel is not up yet but a mint would start it: the mint's wait is then 20 s. */
export function mintWait(): number {
  if (route() !== "quick" || !quickTunnelAllowed(env)) return MINT_ACK_TIMEOUT_MS;
  return tunnelStatus(SHARE).state === "up" ? MINT_ACK_TIMEOUT_MS : QUICK_MINT_WAIT_MS;
}

/** Start the share tunnel if the route wants one now. Never throws; answers its status, or null. */
async function ensureShare(by: string, waitMs?: number): Promise<TunnelStatus | null> {
  try {
    return await ensureTunnel(SHARE, { by, ...(waitMs !== undefined ? { waitMs } : {}) });
  } catch (err) {
    console.warn(`[tunnels] share tunnel not started: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Make the share address ready for a link sent without a new mint (a kept link): under Free (after
    Turn On) or Account, start the share tunnel if needed and wait for it as a mint would. */
export async function readyShareAddress(): Promise<void> {
  // Up already (as links read it): only the on-demand check, which reads the cache inside its
  // window and starts nothing; a tunnel it finds gone or down reads so for the send.
  if (shareTunnelStatus().state === "up") {
    await checkShareTunnel().catch(() => null);
    return;
  }
  const r = route();
  if (r === "account" || (r === "quick" && quickTunnelAllowed(env))) await ensureShare("send", r === "quick" ? QUICK_MINT_WAIT_MS : undefined);
}

/** Stop the share tunnel when it isn't wanted, and let the listener go once no tunnel is left. */
async function settle(why: string): Promise<void> {
  const file = readPublicLinks(env);
  const s = tunnelStatus(SHARE);
  if (!shareWanted(file) && s.state !== "stopped") await stopTunnel(SHARE, why).catch(() => undefined);
  // Previews' tunnels land on the same listener: it stays while any tunnel is left.
  if (!runningTunnels().length && !shareWanted(file)) await releaseTunnelBind(file).catch(() => null);
}

/** One one-shot timer at the latest live link's expiry: then nothing is shared any more. */
function armExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (route() !== "quick" || tunnelStatus(SHARE).state === "stopped") return;
  const latest = liveShareLinks()[0];
  if (!latest) return;
  const t = setTimeout(() => {
    expiryTimer = null;
    void settle("its last link expired").then(armExpiry);
  }, Math.max(0, Math.min(latest.exp - now() + 1000, 2 ** 31 - 1)));
  t.unref?.();
  expiryTimer = t;
}

/** A link change (links-events): a mint under Free or Account starts the tunnel (the mint waits for
    it); a revoke may leave nothing shared. Its answer carries no warning: the address's own does. */
async function onLinks(change: ShareLinksChange): Promise<void> {
  if (!SHARE_KINDS.has(change.kind)) return;
  const r = route();
  if (change.cause === "mint" && (r === "account" || (r === "quick" && quickTunnelAllowed(env)))) {
    const s = await ensureShare("mint", r === "quick" ? QUICK_MINT_WAIT_MS : undefined);
    // The mint's answer will carry the full URL: the link has left Sova at this address.
    if (r === "quick" && s?.state === "up" && s.origin && change.hashes?.length) noteHandouts(change.hashes, now(), new Set(liveLinks(now()).map((l) => l.h)));
    armExpiry();
    return;
  }
  if (change.cause === "revoke") await settle("no live link is left");
  armExpiry();
}

/** The route changed: Account starts at once; leaving Free and Account stops the tunnel. */
async function onSetting(file: PublicLinksFile): Promise<void> {
  if (file.route === "account" && file.account) await ensureShare("setting");
  else if (file.route === "quick" && shareWanted(file)) await ensureShare("setting");
  else await settle("the route changed");
  armExpiry();
  publish();
}

/**
 * Wire the share tunnel (server/index.ts, after startShareRuntime): the manager's deps, the mint's
 * wait, the listeners, then adopt what a previous server left running and stop what isn't wanted.
 */
export async function startTunnelWiring(opts: TunnelWiringOptions = {}): Promise<void> {
  stopTunnelWiring();
  env = opts.env ?? process.env;
  publish = opts.publish ?? (() => {});
  now = opts.now ?? (() => Date.now());
  configureTunnels({
    shareTarget: (recorded) => bindForTunnel(recorded, readPublicLinks(env)),
    shareWanted: () => shareWanted(),
    shareMode: () => (route() === "account" ? "account" : "quick"),
    // An Account candidate's tunnel runs only for its Verify (public-links-routes.ts), never by itself.
    candidateAccount: () => {
      const c = readCandidate();
      // The token pasted for it, else the saved one.
      const token = c?.file.route === "account" ? readCandidateToken() : null;
      return c && token && c.file.account ? { token, publicUrl: c.file.account.publicUrl } : null;
    },
    candidateWanted: () => false,
  });
  setMintWait(mintWait);
  unsubscribe = [
    onShareLinksChanged(onLinks),
    onPublicLinksChanged(onSetting),
    onTunnelChanged(() => {
      armExpiry();
      publish();
    }),
    onCloudflaredChanged(() => publish()),
  ];
  // A tunnel that survived points at a port: bind exactly that one before adopting it.
  const recorded = recordedTargetPort(SHARE);
  const file = readPublicLinks(env);
  if (recorded !== null && (file.route === "quick" || file.route === "account")) await bindForTunnel(recorded, file).catch(() => null);
  await adoptTunnels().catch((err) => console.warn(`[tunnels] adopt failed: ${err instanceof Error ? err.message : String(err)}`));
  await settle("nothing is shared");
  if (file.route === "account" && file.account) await ensureShare("start");
  armExpiry();
}

export function stopTunnelWiring(): void {
  for (const u of unsubscribe) u();
  unsubscribe = [];
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  setMintWait(null);
}
