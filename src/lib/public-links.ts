import { createMemo, createSignal } from "solid-js";
import { check, firstIssue, problemOf, type FieldCheck } from "../../shared/form-rules";
import { INGRESS_PORT_RULE, PREVIEW_URL_RULE, PUBLIC_URL_RULE, SHARE_PORT_RULE } from "../../shared/public-links-limits";
import {
  FRONT_LABELS,
  SHARE_PORT_DEFAULT,
  type PublicLinksFile,
  type PublicLinksInfo,
  type PublicLinksPatch,
  type ShareFront,
  type ShareGatewaySetting,
  type CloudflareAccountSetting,
  type CloudflaredInfo,
  type SetupChatOption,
  type ShareState,
  type VerifyResult,
  type VisitorLogging,
} from "../../shared/public-links";
import type { SessionSummary } from "../../shared/protocol";
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

export const getPublicLinks = () => call<PublicLinksInfo>("/api/public-links");
export const putPublicLinks = (patch: PublicLinksPatch) =>
  call<PublicLinksInfo>("/api/public-links", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
export const verifyPublicLinks = () => call<VerifyResult>("/api/public-links/verify", { method: "POST" });

const post = <T>(url: string, body: unknown = {}, method = "POST") =>
  call<T>(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Turn On (q11): the operator's one click before the first public Free tunnel. Page-only on the server. */
export const turnOnPublicLinks = () => post<PublicLinksInfo>("/api/public-links/turn-on");
/** Try Again on a stopped or failed share tunnel. */
export const startShareTunnel = () => post<PublicLinksInfo>("/api/public-links/tunnel/start");
/** Download cloudflared once, checksum-verified (page-only); answers when it is in place. */
export const downloadCloudflared = () => post<{ ok: true; cloudflared: CloudflaredInfo }>("/api/public-links/cloudflared/download");
/** Cloudflare Account's connector token: stored 0600, never echoed back. */
export const putAccountToken = (token: string) => post<{ hasToken: boolean }>("/api/public-links/account-token", { token }, "PUT");
export const deleteAccountToken = () => call<{ hasToken: boolean }>("/api/public-links/account-token", { method: "DELETE" });
/** Set Up With a Chat: a new chat seeded with the option's setup steps; it never saves a setting. */
export const startSetupChat = (option: SetupChatOption) => post<SessionSummary>("/api/public-links/setup-chat", { option });
/** A link's full URL just left Sova by a Copy click (route quick only): for the broken-links notice. */
export const noteHandedOut = (urls: string[]) =>
  post<{ ok: true }>("/api/public-links/handed-out", { links: urls.map((url) => ({ url })) }).catch(() => null);

// ---- what the app knows now ---------------------------------------------------------------------

const [info, setInfo] = createSignal<PublicLinksInfo | null>(null);
/** The last GET or PUT answer, for the Mesh card's chip; null until one (or on a server without the route). */
export const publicLinksInfo = info;

/** Read the setting into `publicLinksInfo` (and the Settings draft's saved side). A server without
    the route (older, or M1 not landed) reads as nothing. Read at the app's start, after a feed gap,
    and on the page event `public_links_changed`: never on a timer. */
export async function loadPublicLinks(): Promise<PublicLinksInfo | null> {
  try {
    const next = await getPublicLinks();
    noteInfo(next);
    // An open Settings panel follows it; a closed one has no draft to keep.
    store.refreshSaved(next.file);
    return next;
  } catch {
    return null;
  }
}

/** Sharing is off on this computer (§mesh.public/sharing-off): every Share button and the home page's
    Shares card are hidden. Only this computer's own: a peer's session keeps its own setting. */
const sharingOffNow = createMemo(() => !!info()?.sharingOff);
export const sharingOffHere = (host?: string | null): boolean => !host && sharingOffNow();

/** Route Free: a Copy click is a link leaving Sova, which the broken-links notice judges by
    (§mesh.public/broken-links). Anything else: nothing to report. */
export function copiedLink(url: string | null | undefined, host?: string | null): void {
  if (!url || host || info()?.file.route !== "quick") return;
  void noteHandedOut([url]);
}

// ---- the draft -----------------------------------------------------------------------------------

export type RouteChoice = "off" | "quick" | "account" | "self" | "via";

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
  /** The gateway's preview address (§mesh.public/preview-address), as typed; "" for none. */
  previewUrl: string;
  /** Cloudflare Account's address and preview address, as typed (§mesh.tunnel/account). */
  accountUrl: string;
  accountPreviewUrl: string;
  /** A connector token pasted since the last save; "" for none. Never read back from the server. */
  accountToken: string;
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
  previewUrl: f.gateway?.previewUrl ?? "",
  accountUrl: f.account?.publicUrl ?? "",
  accountPreviewUrl: f.account?.previewUrl ?? "",
  accountToken: "",
});

const sameAccept = (a: "all" | readonly string[], b: "all" | readonly string[]): boolean =>
  a === "all" || b === "all" ? a === b : a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** A typed port's number, or null when its rule refuses it. */
export function parsePort(s: string): number | null {
  const r = check(SHARE_PORT_RULE, s);
  return r.ok ? r.value : null;
}

/** A typed public address as the setting stores it: trimmed, without a trailing slash. */
export const normalizeUrl = (s: string): string => s.trim().replace(/\/+$/, "");

/** Why the public address can't be saved, one sentence, or null. */
export const urlIssue = (s: string): string | null => problemOf(PUBLIC_URL_RULE, s);

/** A typed preview address as the setting stores it: trimmed, lowercase, no trailing slash. */
export const normalizePreviewUrl = (s: string): string => s.trim().toLowerCase().replace(/\/+$/, "");

export type PublicLinksField = "publicUrl" | "sharePort" | "via" | "ingressPort" | "previewUrl" | "accountUrl" | "accountPreviewUrl" | "accountToken";

/** The route's boxes in page order (the ones an env pin decides are left out). Only the gateway choice and a routed host have fields. */
export function publicLinksFields(d: PublicLinksDraft, pinned: readonly string[] = [], hasToken = false): (FieldCheck<PublicLinksField> | { message: string | null; at: PublicLinksField })[] {
  if (d.route === "account")
    return [
      { rule: PUBLIC_URL_RULE, value: d.accountUrl, at: "accountUrl" },
      { rule: PREVIEW_URL_RULE, value: d.accountPreviewUrl, at: "accountPreviewUrl" },
      { message: hasToken || d.accountToken.trim() ? null : "Paste the tunnel's token first.", at: "accountToken" },
    ];
  if (d.route === "via") return [{ message: d.viaNodeId ? null : "Pick the gateway.", at: "via" }, { rule: INGRESS_PORT_RULE, value: d.ingressPort, at: "ingressPort" }];
  if (d.route !== "self") return [];
  const open = (env: string, f: FieldCheck<PublicLinksField>) => (pinned.includes(env) ? [] : [f]);
  return [
    ...open("SOVA_SHARE_PUBLIC_URL", { rule: PUBLIC_URL_RULE, value: d.publicUrl, at: "publicUrl" }),
    ...open("SOVA_SHARE_PORT", { rule: SHARE_PORT_RULE, value: d.sharePort, at: "sharePort" }),
    ...open("SOVA_SHARE_PREVIEW_URL", { rule: PREVIEW_URL_RULE, value: d.previewUrl ?? "", at: "previewUrl" }),
  ];
}

/** Why the draft can't be saved (the field's own words) and where, or null. */
export function draftIssue(d: PublicLinksDraft, pinned: readonly string[] = [], hasToken = false): { field: PublicLinksField; text: string } | null {
  const bad = firstIssue(publicLinksFields(d, pinned, hasToken));
  return bad && { field: bad.at!, text: bad.message };
}

/**
 * What a save sends: the route when it changed, and the whole gateway setting when any of its
 * fields did (the server keeps it while the route is not "self", so switching back restores it).
 * The ingress port goes when a routed host changed it. Empty when nothing changed.
 */
export function publicLinksChanges(d: PublicLinksDraft, f: PublicLinksFile, opts: { broken?: boolean } = {}): PublicLinksPatch {
  const out: PublicLinksPatch = {};
  const was = f.route;
  const route: PublicLinksFile["route"] = d.route === "via" ? { via: { nodeId: d.viaNodeId } } : d.route;
  const sameRoute = typeof route === "string" || typeof was === "string" ? route === was : route.via.nodeId === was.via.nodeId;
  // An unreadable setting is replaced by the first save, whatever it picks.
  if (!sameRoute || opts.broken) out.route = route;
  if (d.route === "account") {
    const account: CloudflareAccountSetting = { publicUrl: normalizeUrl(d.accountUrl) };
    const preview = normalizePreviewUrl(d.accountPreviewUrl);
    if (preview) account.previewUrl = preview;
    if (f.account?.publicUrl !== account.publicUrl || (f.account?.previewUrl ?? "") !== (account.previewUrl ?? "") || out.route) out.account = account;
  }
  if (d.route === "self") {
    const gateway: ShareGatewaySetting = {
      publicUrl: normalizeUrl(d.publicUrl),
      front: d.front,
      sharePort: parsePort(d.sharePort) ?? SHARE_PORT_DEFAULT,
      acceptFrom: d.acceptFrom === "all" ? "all" : [...d.acceptFrom],
    };
    const preview = normalizePreviewUrl(d.previewUrl ?? "");
    if (preview) gateway.previewUrl = preview;
    const g = f.gateway;
    if (
      !g ||
      g.publicUrl !== gateway.publicUrl ||
      g.front !== gateway.front ||
      g.sharePort !== gateway.sharePort ||
      !sameAccept(g.acceptFrom, gateway.acceptFrom) ||
      (g.previewUrl ?? "") !== (gateway.previewUrl ?? "")
    )
      out.gateway = gateway;
  }
  if (d.route === "via") {
    const port = parsePort(d.ingressPort) ?? SHARE_PORT_DEFAULT;
    if (port !== (f.ingressPort ?? SHARE_PORT_DEFAULT)) out.ingressPort = port;
  }
  return out;
}

export const samePublicLinks = (d: PublicLinksDraft, f: PublicLinksFile, opts: { broken?: boolean } = {}): boolean =>
  !d.accountToken.trim() && Object.keys(publicLinksChanges(d, f, opts)).length === 0;

/** The env pins the last answer reported; the fields they decide can't be edited. */
let pins: readonly string[] = [];
/** The last answer's facts the draft's checks and save depend on. */
let savedBroken = false;
let savedHasToken = false;

const store = createDraftStore<PublicLinksDraft, PublicLinksFile, PublicLinksInfo>({
  tab: "public-links",
  label: "Public links",
  toDraft: publicLinksDraftOf,
  same: (d, f) => samePublicLinks(d, f, { broken: savedBroken }),
  fields: (d) => publicLinksFields(d, pins, savedHasToken),
  write: async (d, f) => {
    // The token first: the Account route is refused without one (§mesh.tunnel/account).
    if (d.accountToken.trim()) savedHasToken = (await putAccountToken(d.accountToken.trim())).hasToken;
    const changes = publicLinksChanges(d, f, { broken: savedBroken });
    const next = Object.keys(changes).length ? await putPublicLinks(changes) : await getPublicLinks();
    noteInfo(next);
    return { saved: next.file, result: next };
  },
});

function noteInfo(next: PublicLinksInfo): void {
  pins = next.pinnedByEnv;
  savedBroken = !!next.broken;
  savedHasToken = !!next.account?.hasToken;
  setInfo(next);
}

/** A GET answer arrived: the draft store and the card's chip follow it. */
export function acceptPublicLinksInfo(next: PublicLinksInfo): void {
  noteInfo(next);
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

// ---- visitor logging (§mesh.public/visitor-log) -------------------------------------------------

export const getVisitorLogging = () => call<VisitorLogging>("/api/visitor-logging");
const putVisitorLogging = (v: VisitorLogging) =>
  call<VisitorLogging>("/api/visitor-logging", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });

/** The two switches, staged like the panel's other fields and written by Save Changes. */
const visitorStore = createDraftStore<VisitorLogging, VisitorLogging>({
  tab: "public-links",
  label: "Visitor logging",
  toDraft: (v) => ({ ...v }),
  same: (a, b) => a.logVisitors === b.logVisitors && a.forwardIp === b.forwardIp,
  write: async (d) => {
    const saved = await putVisitorLogging(d);
    return { saved, result: saved };
  },
});

export const visitorLoggingDraft = visitorStore.draft;
export const setVisitorLoggingDraft = visitorStore.setDraft;
export const setVisitorLoggingSaved = visitorStore.setSaved;
export const visitorLoggingSaving = visitorStore.saving;
export const visitorLoggingSaveError = visitorStore.error;

// ---- words ----------------------------------------------------------------------------------------

/** The state chip (§design.copy-deck/public-links): a word and its tone. A share port that won't
    open wins over every state (§mesh.public/listener-failure). */
export function stateChip(s: ShareState, flags: { broken?: boolean } = {}): { word: string; tone?: "success" | "warn" | "error" | "info" } {
  if (s.listener) return { word: "Not listening", tone: "error" };
  if (flags.broken || s.warningCode === "broken") return { word: "Can't read setting", tone: "error" };
  // Free's own words (§mesh.public/panel), from the warning the share state carries.
  switch (s.warningCode) {
    case "quick-starting":
      return { word: "Starting", tone: "info" };
    case "quick-turn-on":
      return { word: "Not turned on", tone: "warn" };
    case "quick-setup":
      return { word: "Needs cloudflared", tone: "warn" };
    case "tunnel-down":
      return { word: "Tunnel down", tone: "error" };
  }
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
    case "quick":
      return "Cloudflare Free tunnel";
    case "account":
      return "Cloudflare Account";
  }
}

/** The Mesh card's chip, or null when this host has no public links. */
export function meshChipText(i: PublicLinksInfo | null): string | null {
  if (!i) return null;
  const r = i.file.route;
  if (r === "self") return "Public links: gateway";
  if (typeof r === "object") return `Public links: through ${i.share.via ?? r.via.nodeId}`;
  if (r === "quick" || r === "account") return "Public links: Cloudflare";
  return null;
}

export const FRONTS = Object.keys(FRONT_LABELS) as ShareFront[];

/** The env variable pinning a field, when one does. */
export const PIN_OF = { publicUrl: "SOVA_SHARE_PUBLIC_URL", sharePort: "SOVA_SHARE_PORT", previewUrl: "SOVA_SHARE_PREVIEW_URL" } as const;

/** Your own web server's two fronts (§mesh.public/panel); Funnel and You run it are their own options. */
export const WEB_SERVER_FRONTS: readonly ShareFront[] = ["vhost", "caddy"];

/** The via gateway is behind this host's share protocol (§mesh.public/panel): it answered its info
    and stated no share-protocol number, or a lower one. Absent `gatewayProtocol`: not routed, or not
    asked yet: nothing to say. */
export function gatewayBehind(i: Pick<PublicLinksInfo, "gatewayProtocol"> | null | undefined): boolean {
  const g = i?.gatewayProtocol;
  return !!g && (g.theirs === null || g.theirs < g.ours);
}

/** The "Gateway behind" banner's words (§design.copy-deck/public-links). */
export const gatewayBehindText = (gateway: string): { title: string; body: string } => ({
  title: `${gateway} runs an older version of public links.`,
  body: `Some pages of this host's links may not open until ${gateway} is updated.`,
});

/** The banner's Resync for the gateway's peer, as the host menu offers it (§mesh.peers/resync):
    null when the host menu has no word about that peer (no resync answer, or the peer isn't in
    it); `reason` set when it can't resync it now (the host menu's reason, else what it says under
    the host). */
export function gatewayResync(view: { line: string | null; button: { reason?: string } | null } | null): { reason?: string } | null {
  if (!view) return null;
  if (view.button) return view.button;
  return view.line ? { reason: view.line } : null;
}
