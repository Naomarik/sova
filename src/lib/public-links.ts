import { createSignal } from "solid-js";
import {
  FRONT_LABELS,
  SHARE_PORT_DEFAULT,
  type PublicLinksFile,
  type PublicLinksInfo,
  type PublicLinksPatch,
  type ShareFront,
  type ShareGatewaySetting,
  type ShareState,
  type VerifyResult,
} from "../../shared/public-links";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Public links (§mesh.public/setting): the API client, the unsaved edits
 * (settings-draft.ts: module state, held on close, forgotten once closed), and the words the panel
 * and the Mesh card show for the setting's state. Main listener only, so these never go through a
 * peer: plain fetches, not api.ts's peer-routed `request`.
 */

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("The Sova server isn't reachable.");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const getPublicLinks = () => call<PublicLinksInfoRouted>("/api/public-links");
export const putPublicLinks = (patch: PublicLinksPatch) =>
  call<PublicLinksInfoRouted>("/api/public-links", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
export const verifyPublicLinks = () => call<VerifyResult>("/api/public-links/verify", { method: "POST" });

// ---- the routed half's fields (M6b) --------------------------------------------------------------

/** A host that routes its links through this gateway, as GET /api/public-links reports it
    (`routed`, only for route "self"). Interim: the operator approved these two optional
    PublicLinksInfo fields; M5 adds them to shared/public-links.ts and M1 serves them, and these
    local copies go away then. */
export interface RoutedHost {
  nodeId: string;
  /** Its id in peers.json, or null when it isn't a peer here. */
  peer: string | null;
  /** Live links it has registered here. */
  links: number;
  up: boolean;
  /** When its last snapshot arrived, ms epoch. */
  lastPushAt: number | null;
  /** Whether acceptFrom lets its links in. */
  accepted: boolean;
}
/** A peer whose hello advertises a gateway: one "Through {gateway}" choice. */
export interface GatewayChoice {
  nodeId: string;
  peer: string;
  publicUrl: string;
}
export type PublicLinksInfoRouted = PublicLinksInfo & { routed?: RoutedHost[]; gateways?: GatewayChoice[] };

// ---- what the app knows now ---------------------------------------------------------------------

const [info, setInfo] = createSignal<PublicLinksInfoRouted | null>(null);
/** The last GET or PUT answer, for the Mesh card's chip; null until one (or on a server without the route). */
export const publicLinksInfo = info;

/** Read the setting into `publicLinksInfo`. A server without the route (older, or M1 not landed) reads as nothing. */
export async function loadPublicLinks(): Promise<PublicLinksInfoRouted | null> {
  try {
    const next = await getPublicLinks();
    setInfo(next);
    return next;
  } catch {
    return null;
  }
}

// ---- the draft -----------------------------------------------------------------------------------

export type RouteChoice = "off" | "self" | "via";

export interface PublicLinksDraft {
  route: RouteChoice;
  /** The via gateway's StableID; "" when none is picked. */
  viaNodeId: string;
  /** As typed. */
  publicUrl: string;
  front: ShareFront;
  /** As typed. */
  sharePort: string;
  /** Which peers may register their links here: every peer, or these StableIDs. */
  acceptFrom: "all" | string[];
  /** A routed host's ingress port, as typed. */
  ingressPort: string;
}

const routeOf = (f: PublicLinksFile): RouteChoice => (typeof f.route === "string" ? f.route : "via");

export const publicLinksDraftOf = (f: PublicLinksFile): PublicLinksDraft => ({
  route: routeOf(f),
  viaNodeId: typeof f.route === "object" ? f.route.via.nodeId : "",
  publicUrl: f.gateway?.publicUrl ?? "",
  front: f.gateway?.front ?? "vhost",
  sharePort: String(f.gateway?.sharePort ?? SHARE_PORT_DEFAULT),
  acceptFrom: f.gateway?.acceptFrom === undefined || f.gateway.acceptFrom === "all" ? "all" : [...f.gateway.acceptFrom],
  ingressPort: String(f.ingressPort ?? SHARE_PORT_DEFAULT),
});

const sameAccept = (a: "all" | readonly string[], b: "all" | readonly string[]): boolean =>
  a === "all" || b === "all" ? a === b : a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** A typed port: a whole number 1–65535, or null. */
export function parsePort(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** A typed public address as the setting stores it: trimmed, without a trailing slash. */
export const normalizeUrl = (s: string): string => s.trim().replace(/\/+$/, "");

/** Why the public address can't be saved, one sentence, or null. */
export function urlIssue(s: string): string | null {
  const u = normalizeUrl(s);
  if (!u) return "Enter the public address.";
  if (!/^https:\/\//i.test(u)) return "The public address must start with https://.";
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "Enter the public address as https://share.example.com.";
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password)
    return "The public address is a host only, with no path.";
  return null;
}

/** Why the draft can't be saved (the field's own words), or null. Only the gateway choice has fields. */
export function draftIssue(d: PublicLinksDraft, pinned: readonly string[] = []): { field: "publicUrl" | "sharePort" | "via" | "ingressPort"; text: string } | null {
  if (d.route === "via" && !d.viaNodeId) return { field: "via", text: "Pick the gateway." };
  if (d.route === "via" && parsePort(d.ingressPort) === null)
    return { field: "ingressPort", text: "The ingress port is a whole number from 1 to 65535." };
  if (d.route !== "self") return null;
  if (!pinned.includes("SOVA_SHARE_PUBLIC_URL")) {
    const u = urlIssue(d.publicUrl);
    if (u) return { field: "publicUrl", text: u };
  }
  if (!pinned.includes("SOVA_SHARE_PORT") && parsePort(d.sharePort) === null)
    return { field: "sharePort", text: "The local port is a whole number from 1 to 65535." };
  return null;
}

/**
 * What a save sends: the route when it changed, and the whole gateway setting when any of its
 * fields did (the server keeps it while the route is not "self", so switching back restores it).
 * The ingress port goes when a routed host changed it. Empty when nothing changed.
 */
export function publicLinksChanges(d: PublicLinksDraft, f: PublicLinksFile): PublicLinksPatch {
  const out: PublicLinksPatch = {};
  const was = f.route;
  const route: PublicLinksFile["route"] = d.route === "via" ? { via: { nodeId: d.viaNodeId } } : d.route;
  const sameRoute = typeof route === "string" || typeof was === "string" ? route === was : route.via.nodeId === was.via.nodeId;
  if (!sameRoute) out.route = route;
  if (d.route === "self") {
    const gateway: ShareGatewaySetting = {
      publicUrl: normalizeUrl(d.publicUrl),
      front: d.front,
      sharePort: parsePort(d.sharePort) ?? SHARE_PORT_DEFAULT,
      acceptFrom: d.acceptFrom === "all" ? "all" : [...d.acceptFrom],
    };
    const g = f.gateway;
    if (!g || g.publicUrl !== gateway.publicUrl || g.front !== gateway.front || g.sharePort !== gateway.sharePort || !sameAccept(g.acceptFrom, gateway.acceptFrom))
      out.gateway = gateway;
  }
  if (d.route === "via") {
    const port = parsePort(d.ingressPort) ?? SHARE_PORT_DEFAULT;
    if (port !== (f.ingressPort ?? SHARE_PORT_DEFAULT)) out.ingressPort = port;
  }
  return out;
}

export const samePublicLinks = (d: PublicLinksDraft, f: PublicLinksFile): boolean => Object.keys(publicLinksChanges(d, f)).length === 0;

/** The env pins the last answer reported; the fields they decide can't be edited. */
let pins: readonly string[] = [];

const store = createDraftStore<PublicLinksDraft, PublicLinksFile, PublicLinksInfoRouted>({
  tab: "public-links",
  label: "Public links",
  toDraft: publicLinksDraftOf,
  same: samePublicLinks,
  problem: (d) => {
    const issue = draftIssue(d, pins);
    return issue ? `Public links: ${issue.text}` : null;
  },
  write: async (d, f) => {
    const next = await putPublicLinks(publicLinksChanges(d, f));
    setInfo(next);
    pins = next.pinnedByEnv;
    return { saved: next.file, result: next };
  },
});

/** A GET answer arrived: the draft store and the card's chip follow it. */
export function acceptPublicLinksInfo(next: PublicLinksInfoRouted): void {
  pins = next.pinnedByEnv;
  setInfo(next);
  store.setSaved(next.file);
}

export const publicLinksDraft = store.draft;
export const publicLinksSaved = store.saved;
export const setPublicLinksDraft = store.setDraft;
export const setPublicLinksSaved = store.setSaved;
export const publicLinksSaving = store.saving;
export const publicLinksSaveError = store.error;
export const publicLinksDirty = store.dirty;
export const resetPublicLinksDraft = store.reset;

// ---- words ----------------------------------------------------------------------------------------

/** The state chip (§design.copy-deck/public-links): a word and its tone. */
export function stateChip(s: ShareState): { word: string; tone?: "success" | "warn" | "error" } {
  switch (s.state) {
    case "off":
      return { word: "Off" };
    case "configured":
      return { word: "Not verified", tone: "warn" };
    case "verified":
      return { word: "Verified", tone: "success" };
    case "unreachable":
      return { word: "Unreachable", tone: "error" };
  }
}

/** Where the effective address comes from, as the Address row says it. */
export function sourceLabel(s: ShareState, pinned: readonly string[]): string {
  switch (s.source) {
    case "env":
      return `Set by environment (${pinned.find((v) => v === "SOVA_SHARE_PUBLIC_URL") ?? pinned[0] ?? "SOVA_SHARE_PUBLIC_URL"})`;
    case "setting":
      return "From this setting";
    case "gateway":
      return `From ${s.via ?? "the gateway"}`;
    case "bound":
      return "Bound address";
  }
}

/** The Mesh card's chip, or null when this host has no public links. */
export function meshChipText(i: PublicLinksInfoRouted | null): string | null {
  if (!i) return null;
  const r = i.file.route;
  if (r === "self") return "Public links: gateway";
  if (typeof r === "object") return `Public links: through ${i.share.via ?? r.via.nodeId}`;
  return null;
}

export const FRONTS = Object.keys(FRONT_LABELS) as ShareFront[];

/** The env variable pinning a field, when one does. */
export const PIN_OF = { publicUrl: "SOVA_SHARE_PUBLIC_URL", sharePort: "SOVA_SHARE_PORT" } as const;
