import {
  ANYONE_LABEL,
  RECIPIENT_LABEL_MAX,
  type SessionShare,
  type SessionShareActivity,
  type SessionShareAddRecipient,
  type SessionShareCreate,
  type SessionShareDays,
  type SessionShareMinted,
  type SessionSharePatch,
  type SessionSharePresence,
  type SessionSharePreview,
  type SessionShareRecipient,
  type SessionShareView,
  type SessionShareVisit,
  type SharesOverview,
} from "../../shared/session-share";
import { hostUrl } from "./mesh";

// Session share links (§app/session-share): the operator app's calls and words. Every call names
// the host that holds the session (null: this one), reached through /peer/<id>/api/… like the
// pane's other host-scoped reads.

/** The Shares page (§app.session-share/shares-page). */
export const SHARES_HREF = "#/shares";
export const isSharesHash = (hash: string): boolean => hash === SHARES_HREF || hash === `${SHARES_HREF}/`;

// ---- words --------------------------------------------------------------------------------------

export const daysWord = (d: number) => (d === 1 ? "1 day" : `${d} days`);

/** A presence in words: the dot never carries it alone. `away` says nothing (the opened line does). */
export function presenceWord(p: SessionSharePresence | undefined): string | null {
  return p === "viewing" ? "Viewing now" : p === "open" ? "Open in a tab" : null;
}

/** "Opened 3× · last 2h ago", or "Not opened yet". */
export function openedLine(opened: number, lastAt: string | undefined, rel: (iso: string) => string): string {
  if (opened === 0 || !lastAt) return "Not opened yet";
  return `Opened ${opened}× · last ${rel(lastAt)}`;
}

/** "Expires in 29 days" / "Expires tomorrow" / "Expires in 5 hours" / "Expired". */
export function expiresWord(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "Expired";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "Expires within the hour";
  if (h < 24) return `Expires in ${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round(h / 24);
  return d <= 1 ? "Expires tomorrow" : `Expires in ${d} days`;
}

/** Labels a sheet may send: trimmed, non-empty, capped, deduplicated case-insensitively, never the
    anyone row's fixed label (that row is its own switch). */
export function cleanLabels(raw: readonly string[]): string[] {
  const seen = new Set<string>([ANYONE_LABEL.toLowerCase()]);
  const out: string[] = [];
  for (const r of raw) {
    const l = r.trim().slice(0, RECIPIENT_LABEL_MAX);
    const k = l.toLowerCase();
    if (!l || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

const VISIT_WORD: Record<SessionShareVisit["kind"], string> = { visit: "Opened", preview: "Link preview", refused: "Refused", capped: "More opens that day, not listed" };

/** One visit line: "Opened · iPhone · 2h ago · 4 min". `rel` formats a past time. */
export function visitLine(v: SessionShareVisit, rel: (iso: string) => string): string {
  const mins = v.lastSeenAt ? Math.round((Date.parse(v.lastSeenAt) - Date.parse(v.at)) / 60_000) : 0;
  const long = v.kind === "visit" && mins >= 1 ? ` · ${mins} min` : "";
  return `${VISIT_WORD[v.kind]} · ${v.device}${v.bot ? " (automated)" : ""} · ${rel(v.at)}${long}`;
}

/** A share's live links, and whether any recipient is looking now. */
export const liveRecipients = (s: SessionShare): SessionShareRecipient[] => s.recipients.filter((r) => r.state === "live");
export const viewingCount = (s: SessionShare): number => s.recipients.filter((r) => r.presence === "viewing").length;
/** A share still serving at least one link. */
export const shareLive = (s: SessionShare): boolean => !s.stoppedAt && !s.missing && liveRecipients(s).length > 0;

/** The line under a share's title: what the recipients see. */
export function modeLine(s: Pick<SessionShare, "mode" | "cutAt">, abs: (iso: string) => string): string {
  if (s.mode === "live") return "Follows live";
  return s.cutAt ? `Snapshot up to ${abs(s.cutAt)}` : "Snapshot";
}

// ---- the reviewed snapshot ----

/** A 409 from a mint or update whose previewed cut is no longer in the session file. */
export const isStalePreview = (x: unknown): boolean => x instanceof ShareApiError && x.status === 409 && x.code === "stale-preview";
export const STALE_PREVIEW = "The session changed. Preview it again.";

/** Where the images of a preview stand: every index loaded, some failed, or some still loading. */
export interface ThumbState {
  total: number;
  loaded: ReadonlySet<number>;
  failed: ReadonlySet<number>;
}
export function thumbsLine(t: ThumbState): string | null {
  if (t.total === 0) return null;
  if (t.failed.size > 0) return `${t.failed.size} of ${t.total} ${t.total === 1 ? "image" : "images"} didn't load, so nothing can be shared until ${t.failed.size === 1 ? "it does" : "they do"}.`;
  if (t.loaded.size < t.total) return `Loading images · ${t.loaded.size} of ${t.total}`;
  return null;
}

/**
 * Why a share can't be created yet, or null: the title and recipients, and a preview on screen
 * with every image it shares actually loaded (§app.session-share/sheet). The preview is what the
 * snapshot will be; nothing is minted before the operator could see each image.
 */
export function createBlocked(f: { title: string; recipients: number; max: number; preview: "loading" | "failed" | "ready"; thumbs: ThumbState }): string | null {
  if (!f.title.trim()) return "Give the share a title.";
  if (f.recipients === 0) return "Add a person, or turn on Anyone with the link.";
  if (f.recipients > f.max) return `At most ${f.max} links per share.`;
  if (f.preview === "failed") return "The conversation couldn't be read, so nothing can be shared yet.";
  if (f.preview === "loading") return "Reading the conversation first.";
  return imagesBlocked(f.thumbs);
}

/** Why a reviewed snapshot can't go out yet because of its images, or null once each one loaded. */
export function imagesBlocked(t: ThumbState): string | null {
  if (t.failed.size > 0) return "An image didn't load. Retry it first: every image is shown before anything is shared.";
  if (t.loaded.size < t.total) return "Loading the images first: every image is shown before anything is shared.";
  return null;
}

// ---- API ----------------------------------------------------------------------------------------

export class ShareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(host: string | null, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(hostUrl(host, url), init?.body ? { ...init, headers: { "Content-Type": "application/json" } } : init);
  } catch {
    throw new ShareApiError("The Sova server isn't reachable.", 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const b = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof b.error === "string") message = b.error;
      if (typeof b.code === "string") code = b.code;
    } catch {
      // not JSON: keep the status line
    }
    throw new ShareApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

const send = <T>(host: string | null, method: "POST" | "PATCH", url: string, body: unknown = {}) =>
  call<T>(host, url, { method, body: JSON.stringify(body) });
const base = "/api/session-shares";
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
const rec = (id: string, r: string) => `${one(id)}/recipients/${encodeURIComponent(r)}`;
const q = (sessionId: string) => `session=${encodeURIComponent(sessionId)}`;

/** The shares of one session, newest first. */
export const listSessionShares = (host: string | null, sessionId: string) => call<SessionShare[]>(host, `${base}?${q(sessionId)}`);
/** What a recipient would see, before any link exists. The first read (no `cut`) fixes the cut;
    its earlier pages pass it, so every page and image is of that one snapshot (409 stale-preview
    once the cut is gone from the file). */
export const previewNew = (host: string | null, sessionId: string, opts: { cut?: string; before?: number } = {}) =>
  call<SessionSharePreview>(
    host,
    `${base}/preview?${q(sessionId)}${opts.cut === undefined ? "" : `&cut=${encodeURIComponent(opts.cut)}`}${opts.before === undefined ? "" : `&before=${opts.before}`}`,
  );
/** Image `n` of the preview built at `cut`. */
export const previewNewImage = (host: string | null, sessionId: string, cut: string, n: number) =>
  hostUrl(host, `${base}/preview/img/${n}?${q(sessionId)}&cut=${encodeURIComponent(cut)}`);
/** What this share's recipients see now. */
export const previewShare = (host: string | null, shareId: string, before?: number) =>
  call<SessionShareView>(host, `${one(shareId)}/preview${before === undefined ? "" : `?before=${before}`}`);
export const previewShareImage = (host: string | null, shareId: string, n: number) => hostUrl(host, `${one(shareId)}/preview/img/${n}`);

export const createShare = (host: string | null, input: SessionShareCreate) => send<SessionShareMinted>(host, "POST", base, input);
export const patchShare = (host: string | null, id: string, patch: SessionSharePatch) => send<SessionShare>(host, "PATCH", one(id), patch);
export const addRecipient = (host: string | null, id: string, who: SessionShareAddRecipient) => send<SessionShareMinted>(host, "POST", `${one(id)}/recipients`, who);
export const relinkRecipient = (host: string | null, id: string, r: string) => send<SessionShareMinted>(host, "POST", `${rec(id, r)}/relink`);
export const revokeRecipient = (host: string | null, id: string, r: string) => send<SessionShare>(host, "POST", `${rec(id, r)}/revoke`);
/** Update to Now: the snapshot moves to `cut`, the previewed one (else the current leaf). */
export const updateShare = (host: string | null, id: string, cut?: string) => send<SessionShare>(host, "POST", `${one(id)}/update`, cut === undefined ? {} : { cut });
export const extendShare = (host: string | null, id: string, days: SessionShareDays) => send<SessionShare>(host, "POST", `${one(id)}/extend`, { days });
export const stopShare = (host: string | null, id: string) => send<SessionShare>(host, "POST", `${one(id)}/stop`);
export const shareActivity = (host: string | null, id: string) => call<SessionShareActivity>(host, `${one(id)}/activity`);
/** Every live public link one host serves: its session shares and its org links. */
export const sharesOverview = (host: string | null) => call<SharesOverview>(host, "/api/shares-overview");
/** Turn Off Link for an org link, through the routes that already exist for it. */
export const revokeHandoff = (host: string | null, sessionId: string) => send<unknown>(host, "POST", `/api/baton/${encodeURIComponent(sessionId)}/revoke`);
export const revokeOwnerLink = (host: string | null, orgId: string) => send<unknown>(host, "POST", `/api/orgs/${encodeURIComponent(orgId)}/owner/revoke`);
