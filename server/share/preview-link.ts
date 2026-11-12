import { LINK_WARNINGS, PREVIEW_TUNNELS_MAX, type TunnelState, type TunnelStatus } from "../../shared/public-links";
import { PREVIEW_TOO_MANY_TUNNELS } from "../../shared/preview-links";
import { setKeptLinkResolver } from "../preview-kept";
import { findPreview, listPreviews, PreviewRefused } from "../preview-links";
import { quickTunnelAllowed, quickTunnelEnabled, readTunnelConsent } from "../public-links";
import { previewAddress, previewOrigin } from "./preview-address";
import { OPEN_PREFIX } from "./preview-tunnel";
import { assertSharingOn } from "./sharing-off";
import { checkTunnel, configureTunnels, ensureTunnel, runningTunnels, stopTunnel, tunnelStatus } from "./tunnel/manager";

/**
 * Where a preview minted here is published, and its link (§mesh.public/preview, /preview-tunnels): the one
 * door every preview mint goes through (the operator's New Preview, an outreach send's sibling, a running
 * copy's share, an owner-bound version, the project overseer's start).
 *
 * `wildcard`: today's preview address, the label in the host (`<label>.<zone>`). `tunnel` (Cloudflare Free,
 * and Account without a preview address): the app's own Free tunnel, one per port, the label in the link
 * (`https://<tunnel host>/_sova/open/<label>/`). In tunnel mode the tunnel is started before anything is
 * minted, and a mint that can't have one is refused with nothing made: a seventh tunnel
 * (`too-many-tunnels`), Turn On not pressed (`quick-turn-on`), no cloudflared (`quick-setup`), or a tunnel
 * that didn't come up (`tunnel-down`).
 */

export type PreviewHome = { mode: "wildcard"; url: string } | { mode: "tunnel"; origin: string; port: number };

/** How long a mint waits for its app's tunnel to have an address. */
export const PREVIEW_TUNNEL_WAIT_MS = 20_000;

const LIVE: ReadonlySet<TunnelState> = new Set(["starting", "up", "degraded"]);
const HAS_ADDRESS: ReadonlySet<TunnelState> = new Set(["up", "degraded"]);

const warning = (code: string, fallback: string): string => (LINK_WARNINGS as Readonly<Record<string, string>>)[code] ?? fallback;
const TURN_ON = () => warning("quick-turn-on", warning("quick-consent", "This link isn't public yet. Turn on public links in Settings → Public links."));
const SETUP = () => warning("quick-setup", "Links can't open from outside until Cloudflare's tunnel program is on this computer.");
const DOWN = () => warning("tunnel-down", "The public address is down, so this link won't open until it's back.");

/** Ports whose tunnel a mint is starting now: counted toward the cap, so two mints can't both take the sixth place. */
const starting = new Set<number>();

const previewKey = (port: number) => ({ kind: "preview" as const, port });

/** The preview tunnels counting toward the cap now (starting, up or degraded), by port. Memory only. */
export function livePreviewTunnelPorts(): Set<number> {
  const out = new Set<number>(starting);
  for (const s of runningTunnels()) if (s.key.kind === "preview" && LIVE.has(s.state)) out.add(s.key.port);
  return out;
}

/** Why a preview of `port` can't be minted now, checked without starting anything; null when it may be. */
export function previewRefusal(port: number | null): PreviewRefused | null {
  const a = previewAddress();
  if (a.mode !== "tunnel") return a.url ? null : new PreviewRefused(a.reason ?? "no-address", a.message ?? "No preview address is set.");
  if (!quickTunnelEnabled()) return new PreviewRefused("tunnel-down", DOWN());
  if (readTunnelConsent() === null) return new PreviewRefused("quick-turn-on", TURN_ON());
  const live = livePreviewTunnelPorts();
  if ((port === null || !live.has(port)) && live.size >= PREVIEW_TUNNELS_MAX) return new PreviewRefused("too-many-tunnels", PREVIEW_TOO_MANY_TUNNELS);
  return null;
}

/** Where a preview of `port` is published now. Tunnel mode starts (or joins) its app's tunnel and waits for its
    address. Throws PreviewRefused (nothing made), or SharingOffError while sharing is off. */
export async function previewHome(port: number, by?: string): Promise<PreviewHome> {
  assertSharingOn();
  const a = previewAddress();
  if (a.mode !== "tunnel") {
    if (!a.url) throw new PreviewRefused(a.reason ?? "no-address", a.message ?? "No preview address is set.");
    return { mode: "wildcard", url: a.url };
  }
  const refused = previewRefusal(port);
  if (refused) throw refused;
  const fresh = !livePreviewTunnelPorts().has(port);
  if (fresh) starting.add(port);
  let s: TunnelStatus;
  try {
    s = await ensureTunnel(previewKey(port), { waitMs: PREVIEW_TUNNEL_WAIT_MS, ...(by ? { by } : {}) });
  } finally {
    if (fresh) starting.delete(port);
  }
  if (s.state === "needs-cloudflared") throw new PreviewRefused("quick-setup", SETUP());
  if (!HAS_ADDRESS.has(s.state) || !s.origin) throw new PreviewRefused("tunnel-down", s.reason ? `${DOWN()} (${s.reason})` : DOWN());
  return { mode: "tunnel", origin: s.origin, port };
}

/** A preview's link under its home. Pure. */
export function previewLinkOf(home: PreviewHome, label: string): string {
  if (home.mode === "wildcard") return `${previewOrigin(home.url, label)}/`;
  return `${home.origin}${OPEN_PREFIX}${label}/`;
}

/** A Free preview's link from its label, at its tunnel's current address; null while it has none (or the label is no preview). Memory reads only. */
export function previewLinkNow(label: string): string | null {
  const r = findPreview(label);
  if (!r) return null;
  const s = tunnelStatus(previewKey(r.port));
  return s.origin && HAS_ADDRESS.has(s.state) ? `${s.origin}${OPEN_PREFIX}${label}/` : null;
}

/** What a preview's tunnel shows on the Previews card, or undefined off tunnel mode with none recorded. */
export function previewTunnelView(port: number): { state: TunnelState; origin: string | null; reason?: string } | undefined {
  const s = tunnelStatus(previewKey(port));
  if (previewAddress().mode !== "tunnel" && s.state === "stopped") return undefined;
  return { state: s.state, origin: s.origin, ...(s.reason ? { reason: s.reason } : {}) };
}

/** Whether `port`'s preview tunnel is still wanted (the manager restarts a wanted one from its end): previews
    are on Free tunnels now, Free tunnels may start (Turn On pressed, not switched off), and an active preview
    names the port. */
export function previewPortWanted(port: number, now = Date.now()): boolean {
  if (previewAddress().mode !== "tunnel" || !quickTunnelAllowed()) return false;
  return listPreviews({}, now).some((v) => v.port === port && v.state === "active");
}

/** Stop every preview tunnel no active preview names (a Turn Off, an expiry, Sova's start). Nothing to do, nothing read, when none runs. */
export async function stopEndedPreviewTunnels(now = Date.now()): Promise<number[]> {
  const ports = runningTunnels().flatMap((s) => (s.key.kind === "preview" && s.state !== "stopped" ? [s.key.port] : []));
  if (!ports.length) return [];
  const active = new Set(listPreviews({}, now).flatMap((v) => (v.state === "active" ? [v.port] : [])));
  const ended = ports.filter((p) => !active.has(p) && !starting.has(p));
  for (const port of ended) await stopTunnel(previewKey(port), "no active preview").catch(() => {});
  return ended;
}

/** The on-demand check of every preview tunnel (the Previews card opened): at most once a minute each, loopback only. */
export async function checkPreviewTunnels(): Promise<void> {
  const keys = runningTunnels().flatMap((s) => (s.key.kind === "preview" && s.state !== "stopped" ? [s.key] : []));
  await Promise.all(keys.map((k) => checkTunnel(k).catch(() => null)));
}

let wired = false;
/** Plug previews into the tunnel manager and kept links (once, at load): which ports are wanted, and kept Free links built on read. */
export function wirePreviewTunnels(): void {
  if (wired) return;
  wired = true;
  configureTunnels({ previewWanted: (port: number) => previewPortWanted(port) });
  setKeptLinkResolver(previewLinkNow);
}
wirePreviewTunnels();
