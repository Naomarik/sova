import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionShareVisit } from "../shared/session-share";
import type { LinkRecord } from "./baton-links";
import { stateRoot } from "./state-root";

/**
 * The visit log (§app.baton/visits): each time a person opened one of their links, in the org's
 * workspace repo as `visits.jsonl` (append-only, committed with the org's other changes, so it moves
 * with the org). What is written: the link's identity WITHOUT its capability (session, hand-off,
 * person, offer), times, a random per-tab id the page made (`tab`, grants nothing) and a coarse
 * device family. NEVER an address, a raw user agent, a token or a token's hash.
 *
 * - A visit starts at the share page's first successful `GET /api/h/<token>`. The static shell
 *   (`GET /h/<token>`) is not a visit: link previewers fetch only that, and a known previewer's fetch
 *   is recorded as a `preview` line instead.
 * - Reloads, socket reconnects and server restarts continue the visit: same link and same `tab`
 *   (`?v=`), or, with a new or no tab, the link's last visit from the same device seen under
 *   VISIT_WINDOW_MS ago. A socket never starts a visit, it only continues one.
 * - Last seen: at most one `seen` line per visit per SEEN_EVERY_MS, one when its last socket closes,
 *   and one for every visit with an open socket at graceful shutdown (flushOpenVisits).
 * - A request on a turned-off link (410): a `refused` line, once per link per window.
 * - At most VISITS_PER_DAY new visits, previews and refusals per link per UTC day; then one
 *   `capped` line that day. A continued visit is never capped.
 *
 * Continuation state is folded from the file (re-folded whenever the file changed under us), so it
 * survives a restart and a move. Logging never fails a request: callers catch.
 *
 * Each link kind names its own log (§app.session-share/visits): an org's links log to its workspace
 * `visits.jsonl`; session share links (`via: "session"`, no org) to the host-local
 * `<stateRoot>/session-share-visits.jsonl`, never synced or committed, with the share and recipient
 * ids instead of a person. The rules above are the same for both. Preview links (`via: "preview"`,
 * §mesh.public/visitor-log) log to the host-local `<stateRoot>/preview-visits.jsonl`, by the same
 * rules, only while the host logs visitors; the proxy's cookie is the tab. That file (and the
 * identity side file, server/visitor-identity.ts) is pruned after 120 days; the others never are.
 */

export const VISITS_FILE = "visits.jsonl";
export const SESSION_VISITS_FILE = "session-share-visits.jsonl";
export const PREVIEW_VISITS_FILE = "preview-visits.jsonl";
export const VISIT_WINDOW_MS = 10 * 60_000;
export const SEEN_EVERY_MS = 5 * 60_000;
export const VISITS_PER_DAY = 20;

/** The page's per-tab id: 16 random bytes, base64url. Anything else is ignored (no tab). */
export const TAB_RE = /^[A-Za-z0-9_-]{22}$/;

/** handoff: a hand-off link (/h/); owner: the org's Owner page (/i/, §app.owner-page/link);
    session: a session share link (/s/, §app/session-share); preview: a preview link
    (§mesh.public/visitor-log). */
export type Via = "handoff" | "owner" | "session" | "preview";

/** A hand-off link's key carries its session and hand-off; an owner link's, its generation; a
    session share link's, its share and recipient (and no person). */
interface LinkKey {
  personId?: string;
  via: Via;
  sessionId?: string;
  n?: number;
  offerId?: string;
  gen?: number;
  shareId?: string;
  recipientId?: string;
  previewId?: string;
}

/** A session share link: its share and recipient. */
export interface SessionVisitLink {
  via: "session";
  shareId: string;
  recipientId: string;
}

/** A preview link (a sibling is its own preview). */
export interface PreviewVisitLink {
  via: "preview";
  previewId: string;
}

/** What a visit is recorded against: a hand-off link's record, an owner link's, a session share link or a preview. */
export type VisitLink =
  | Pick<LinkRecord, "orgId" | "sessionId" | "n" | "personId" | "offerId">
  | { orgId: string; personId: string; via: "owner"; gen: number }
  | SessionVisitLink
  | PreviewVisitLink;

export type VisitLine =
  | (LinkKey & { kind: "visit"; id: string; at: string; tab?: string; device: string; bot?: true })
  /** Later activity of a visit; `tab` binds another tab to it (a second tab inside the window). */
  | { kind: "seen"; id: string; at: string; tab?: string }
  | (LinkKey & { kind: "preview"; id: string; at: string; device: string })
  | (LinkKey & { kind: "refused"; id: string; at: string; status: 410; device: string; bot?: true })
  | (LinkKey & { kind: "capped"; id: string; at: string });

// ---- the device family -------------------------------------------------------------------------------

const PREVIEWERS: [RegExp, string][] = [
  // iMessage announces itself as both Facebook's and Twitter's crawler.
  [/facebookexternalhit.*Twitterbot|Facebot.*Twitterbot/i, "iMessage"],
  [/Slackbot|Slack-ImgProxy/i, "Slack"],
  [/WhatsApp/i, "WhatsApp"],
  [/facebookexternalhit|Facebot/i, "Facebook"],
  [/TelegramBot/i, "Telegram"],
  [/Discordbot/i, "Discord"],
  [/LinkedInBot/i, "LinkedIn"],
  [/Twitterbot/i, "X"],
  [/SkypeUriPreview|MicrosoftPreview/i, "Microsoft Teams"],
  [/Viber/i, "Viber"],
  [/Mattermost/i, "Mattermost"],
  [/redditbot/i, "Reddit"],
  [/Pinterest/i, "Pinterest"],
  [/Google-PageRenderer|Googlebot/i, "Google"],
  [/Embedly|Iframely|vkShare|Applebot|Bingbot|BingPreview/i, "Link preview"],
];
// `node`: Node's built-in fetch sends exactly that (anchored, so no browser, which starts "Mozilla").
const SCRIPTS = /^(curl|Wget|python-requests|python-urllib|Go-http-client|node-fetch|node(?:\/|$)|axios|okhttp|Java\/|libwww|HTTPie|undici)/i;
const SCANNERS = /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Proofpoint|Mimecast|Barracuda|SafeLinks|ms-office|Microsoft Office|\b(bot|crawler|spider|scanner)\b|bot\/|preview/i;

export interface Device {
  /** Shown as is: "Safari · iPhone", "Slack", "Security scanner". */
  device: string;
  /** person: a browser; preview: a link previewer (not a visit); bot: a scanner or script. */
  kind: "person" | "preview" | "bot";
}

/** A user agent reduced to a coarse family. The raw string goes nowhere else. */
export function classify(ua: string | undefined | null): Device {
  const s = (ua ?? "").trim();
  if (!s) return { device: "Browser", kind: "person" };
  for (const [re, name] of PREVIEWERS) if (re.test(s)) return { device: name, kind: "preview" };
  if (SCRIPTS.test(s)) return { device: "Script", kind: "bot" };
  if (SCANNERS.test(s)) return { device: "Security scanner", kind: "bot" };
  const os = /iPhone|iPod/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Windows/.test(s)
            ? "Windows"
            : /Macintosh|Mac OS X/.test(s)
              ? "Mac"
              : /Linux/.test(s)
                ? "Linux"
                : "";
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(s)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(s)
            ? "Chrome"
            : /Safari\//.test(s) && /Version\//.test(s)
              ? "Safari"
              : "";
  if (!os && !browser) return { device: "Browser", kind: "person" };
  return { device: [browser || "Browser", os].filter(Boolean).join(" · "), kind: "person" };
}

// ---- the fold --------------------------------------------------------------------------------------

interface VisitState {
  id: string;
  key: string;
  tabs: Set<string>;
  device: string;
  bot: boolean;
  at: number;
  /** Newest activity, written or not. */
  lastSeen: number;
  /** Newest activity written to the file (the visit line or a seen line). */
  lastWritten: number;
  sockets: number;
}

interface OrgLog {
  file: string;
  /** Size and mtime of the file as this process last left it: anything else re-folds. */
  size: number;
  mtimeMs: number;
  lines: VisitLine[];
  visits: Map<string, VisitState>;
  /** Per link key: visit ids, oldest first. */
  byLink: Map<string, string[]>;
  /** Per link key: the last refused line's time. */
  refusedAt: Map<string, number>;
  /** Per link key: the last preview line's time per service. */
  previewAt: Map<string, number>;
  /** Per link key: the day ("YYYY-MM-DD") a capped line was written for. */
  cappedDay: Map<string, string>;
  /** Per link key: new visits, previews and refusals recorded on `day` (the cap). */
  dayCount: Map<string, { day: string; n: number }>;
}

/** Folded logs by log key: `org:<id>`, SESSION_LOG or PREVIEW_LOG. */
const logs = new Map<string, OrgLog>();
const SESSION_LOG = "session";
const PREVIEW_LOG = "preview";
const logKeyOf = (link: VisitLink): string => ("orgId" in link ? `org:${link.orgId}` : link.via === "preview" ? PREVIEW_LOG : SESSION_LOG);
/** An org's workspace folder, where its log lives: orgs.ts names it when it loads (a preview's or a session's log needs none). */
let orgDir: (orgId: string) => string = (orgId) => {
  throw new Error(`No organization ${orgId} here`);
};
export const setOrgVisitsDir = (dirOf: (orgId: string) => string): void => void (orgDir = dirOf);
const fileOf = (logKey: string): string =>
  logKey === SESSION_LOG ? join(stateRoot(), SESSION_VISITS_FILE) : logKey === PREVIEW_LOG ? join(stateRoot(), PREVIEW_VISITS_FILE) : join(orgDir(logKey.slice(4)), VISITS_FILE);

const keyOf = (k: LinkKey): string =>
  k.via === "session"
    ? `session|${k.shareId ?? ""}|${k.recipientId ?? ""}`
    : k.via === "preview"
      ? `preview|${k.previewId ?? ""}`
      : `${k.via}|${k.sessionId ?? ""}|${k.n ?? ""}|${k.personId}|${k.offerId ?? ""}|${k.gen ?? ""}`;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(text: string): VisitLine[] {
  const out: VisitLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isObj(v) && typeof v.kind === "string" && typeof v.id === "string" && typeof v.at === "string") out.push(v as unknown as VisitLine);
    } catch {
      // a torn line: skip
    }
  }
  return out;
}

function apply(log: OrgLog, l: VisitLine): void {
  const t = Date.parse(l.at) || 0;
  if (l.kind === "visit" || l.kind === "preview" || l.kind === "refused") {
    const key = keyOf(l);
    const c = log.dayCount.get(key);
    if (c?.day === dayOf(t)) c.n++;
    else log.dayCount.set(key, { day: dayOf(t), n: 1 });
  }
  if (l.kind === "visit") {
    const key = keyOf(l);
    log.visits.set(l.id, { id: l.id, key, tabs: new Set(l.tab ? [l.tab] : []), device: l.device, bot: !!l.bot, at: t, lastSeen: t, lastWritten: t, sockets: 0 });
    const ids = log.byLink.get(key) ?? [];
    ids.push(l.id);
    log.byLink.set(key, ids);
  } else if (l.kind === "seen") {
    const v = log.visits.get(l.id);
    if (!v) return;
    if (l.tab) v.tabs.add(l.tab);
    v.lastSeen = Math.max(v.lastSeen, t);
    v.lastWritten = Math.max(v.lastWritten, t);
  } else if (l.kind === "refused") log.refusedAt.set(keyOf(l), Math.max(log.refusedAt.get(keyOf(l)) ?? 0, t));
  else if (l.kind === "preview") log.previewAt.set(`${keyOf(l)}|${l.device}`, Math.max(log.previewAt.get(`${keyOf(l)}|${l.device}`) ?? 0, t));
  else if (l.kind === "capped") log.cappedDay.set(keyOf(l), dayOf(t));
}

function stat(file: string): { size: number; mtimeMs: number } {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

/** A folded log (`org:<id>` or SESSION_LOG), re-read when the file isn't as this process left it.
    Open-socket counts and unwritten last-seen times carry over a re-fold. */
function logOf(logKey: string): OrgLog {
  const file = fileOf(logKey);
  const s = stat(file);
  const had = logs.get(logKey);
  if (had && had.file === file && had.size === s.size && had.mtimeMs === s.mtimeMs) return had;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // none yet
  }
  const log: OrgLog = { file, ...s, lines: [], visits: new Map(), byLink: new Map(), refusedAt: new Map(), previewAt: new Map(), cappedDay: new Map(), dayCount: new Map() };
  log.lines = parse(text);
  for (const l of log.lines) apply(log, l);
  if (had)
    for (const [id, v] of had.visits) {
      const now = log.visits.get(id);
      if (!now) continue;
      now.sockets = v.sockets;
      now.lastSeen = Math.max(now.lastSeen, v.lastSeen);
    }
  logs.set(logKey, log);
  return log;
}

function append(logKey: string, log: OrgLog, line: VisitLine): void {
  // The session and preview logs are host-local state: owner-only, like the share store.
  appendFileSync(log.file, `${JSON.stringify(line)}\n`, logKey.startsWith("org:") ? undefined : { mode: 0o600 });
  log.lines.push(line);
  apply(log, line);
  const s = stat(log.file);
  log.size = s.size;
  log.mtimeMs = s.mtimeMs;
  logs.set(logKey, log);
}

const newId = (): string => `v_${randomBytes(6).toString("base64url")}`;

const linkKeyOf = (link: VisitLink): LinkKey =>
  "via" in link
    ? link.via === "session"
      ? { via: "session", shareId: link.shareId, recipientId: link.recipientId }
      : link.via === "preview"
        ? { via: "preview", previewId: link.previewId }
        : { personId: link.personId, via: "owner", gen: link.gen }
    : {
        personId: link.personId,
        via: "handoff",
        sessionId: link.sessionId,
        n: link.n,
        ...(link.offerId ? { offerId: link.offerId } : {}),
      };

const iso = (ms: number): string => new Date(ms).toISOString();

/** The visit a request continues: the same tab's, else the link's newest visit from the same
    device (and of the same class) seen inside the window. */
function continued(log: OrgLog, key: string, tab: string | undefined, dev: Device, now: number): VisitState | null {
  const ids = log.byLink.get(key) ?? [];
  if (tab)
    for (let i = ids.length - 1; i >= 0; i--) {
      const v = log.visits.get(ids[i]!);
      if (v?.tabs.has(tab)) return v;
    }
  let best: VisitState | null = null;
  for (const id of ids) {
    const v = log.visits.get(id);
    if (!v || now - v.lastSeen >= VISIT_WINDOW_MS || v.device !== dev.device || v.bot !== (dev.kind === "bot")) continue;
    if (!best || v.lastSeen > best.lastSeen) best = v;
  }
  return best;
}

/** Note activity on a visit; writes a seen line when the throttle allows (or `force`). */
function touch(logKey: string, log: OrgLog, v: VisitState, now: number, bindTab: string | undefined, force = false): void {
  v.lastSeen = Math.max(v.lastSeen, now);
  const newTab = !!bindTab && !v.tabs.has(bindTab);
  if (newTab || (force && v.lastSeen > v.lastWritten) || now - v.lastWritten >= SEEN_EVERY_MS)
    append(logKey, log, { kind: "seen", id: v.id, at: iso(v.lastSeen), ...(newTab ? { tab: bindTab } : {}) });
}

export interface OpenInput {
  /** The page's `?v=`; ignored unless it has TAB_RE's shape. */
  tab?: string | null;
  userAgent?: string | null;
  now?: number;
}

const tabOf = (t: string | null | undefined): string | undefined => (t && TAB_RE.test(t) ? t : undefined);

/**
 * `GET /api/h/<token>` answered 200: start a visit, or continue one. Returns the visit id, or null
 * when nothing was recorded (a previewer, or the day's cap).
 */
export function recordOpen(link: VisitLink, input: OpenInput = {}): string | null {
  const now = input.now ?? Date.now();
  const dev = classify(input.userAgent);
  const k = linkKeyOf(link);
  const key = keyOf(k);
  const lk = logKeyOf(link);
  const log = logOf(lk);
  if (dev.kind === "preview") {
    recordPreviewIn(lk, log, k, dev, now);
    return null;
  }
  const tab = tabOf(input.tab);
  const hit = continued(log, key, tab, dev, now);
  if (hit) {
    touch(lk, log, hit, now, tab);
    return hit.id;
  }
  if (capped(lk, log, k, now)) return null;
  const id = newId();
  append(lk, log, { kind: "visit", id, at: iso(now), ...k, ...(tab ? { tab } : {}), device: dev.device, ...(dev.kind === "bot" ? { bot: true as const } : {}) });
  return id;
}

/** The link reached today's cap: true, and the day's one `capped` line is written. A continued
    visit is never capped (callers check this only for new lines). */
function capped(logKey: string, log: OrgLog, k: LinkKey, now: number): boolean {
  const key = keyOf(k);
  const today = dayOf(now);
  const c = log.dayCount.get(key);
  if (!c || c.day !== today || c.n < VISITS_PER_DAY) return false;
  if (log.cappedDay.get(key) !== today) append(logKey, log, { kind: "capped", id: newId(), at: iso(now), ...k });
  return true;
}

function recordPreviewIn(logKey: string, log: OrgLog, k: LinkKey, dev: Device, now: number): void {
  const pk = `${keyOf(k)}|${dev.device}`;
  if (now - (log.previewAt.get(pk) ?? 0) < VISIT_WINDOW_MS || capped(logKey, log, k, now)) return;
  append(logKey, log, { kind: "preview", id: newId(), at: iso(now), ...k, device: dev.device });
}

/** The static shell was fetched: a `preview` line when the user agent is a known link previewer,
    nothing otherwise (a browser's shell fetch proves nothing; its API call is the visit). */
export function recordShellFetch(link: VisitLink, userAgent: string | null | undefined, now = Date.now()): boolean {
  const dev = classify(userAgent);
  if (dev.kind !== "preview") return false;
  recordPreviewIn(logKeyOf(link), logOf(logKeyOf(link)), linkKeyOf(link), dev, now);
  return true;
}

/** Someone opened a link that no longer works (410): once per link per window. */
export function recordRefused(link: VisitLink, userAgent?: string | null, now = Date.now()): boolean {
  const dev = classify(userAgent);
  if (dev.kind === "preview") return false;
  const k = linkKeyOf(link);
  const lk = logKeyOf(link);
  const log = logOf(lk);
  if (now - (log.refusedAt.get(keyOf(k)) ?? 0) < VISIT_WINDOW_MS || capped(lk, log, k, now)) return false;
  append(lk, log, { kind: "refused", id: newId(), at: iso(now), ...k, status: 410, device: dev.device, ...(dev.kind === "bot" ? { bot: true as const } : {}) });
  return true;
}

/** A share socket opened: it continues the link's visit (never starts one). Returns a handle for
    socketClosed, or null when there is no visit to continue. */
export function socketOpened(link: VisitLink, input: OpenInput = {}): VisitHandle | null {
  const now = input.now ?? Date.now();
  const dev = classify(input.userAgent);
  if (dev.kind === "preview") return null;
  const lk = logKeyOf(link);
  const log = logOf(lk);
  const tab = tabOf(input.tab);
  const v = continued(log, keyOf(linkKeyOf(link)), tab, dev, now);
  if (!v) return null;
  v.sockets++;
  touch(lk, log, v, now, tab);
  return { log: lk, id: v.id };
}

/** An open socket's visit, for socketClosed. Opaque to callers. */
export interface VisitHandle {
  log: string;
  id: string;
}

/** Its socket closed: the visit's last seen is written now. */
export function socketClosed(handle: VisitHandle, now = Date.now()): void {
  const log = logOf(handle.log);
  const v = log.visits.get(handle.id);
  if (!v) return;
  v.sockets = Math.max(0, v.sockets - 1);
  touch(handle.log, log, v, now, undefined, true);
}

/**
 * Every visit with an open socket is seen now (a ticker every SEEN_EVERY_MS, and graceful
 * shutdown, before the workspace commit). Returns how many seen lines it wrote.
 */
export function flushOpenVisits(now = Date.now()): number {
  let wrote = 0;
  for (const logKey of [...logs.keys()]) {
    let log: OrgLog;
    try {
      log = logOf(logKey);
    } catch {
      logs.delete(logKey); // detached
      continue;
    }
    for (const v of log.visits.values()) {
      if (v.sockets <= 0 && v.lastSeen <= v.lastWritten) continue;
      if (v.sockets > 0) v.lastSeen = Math.max(v.lastSeen, now);
      const before = log.lines.length;
      touch(logKey, log, v, now, undefined, true);
      wrote += log.lines.length - before;
    }
  }
  return wrote;
}

setInterval(() => {
  try {
    flushOpenVisits();
  } catch (err) {
    console.warn(`[visits] flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}, SEEN_EVERY_MS).unref();

// ---- reading -----------------------------------------------------------------------------------------

export interface FoldedVisit {
  id: string;
  kind: "visit" | "preview" | "refused" | "capped";
  at: string;
  lastSeenAt?: string;
  /** "" and 0 for an Owner page visit (`via` "owner"). */
  sessionId: string;
  n: number;
  offerId?: string;
  via?: "owner";
  /** An Owner page visit: the owner link's generation. */
  gen?: number;
  device: string;
  bot?: boolean;
}

/** One person's log, folded: one row per visit (with its last seen), preview, refusal or cap; newest first. */
export function readVisits(orgId: string, personId: string): FoldedVisit[] {
  const log = logOf(`org:${orgId}`);
  const out: FoldedVisit[] = [];
  for (const l of log.lines) {
    if (l.kind === "seen" || l.personId !== personId) continue;
    const base = { id: l.id, kind: l.kind, at: l.at, sessionId: l.sessionId ?? "", n: l.n ?? 0, ...(l.offerId ? { offerId: l.offerId } : {}), ...(l.via === "owner" ? { via: "owner" as const, ...(typeof l.gen === "number" ? { gen: l.gen } : {}) } : {}) };
    if (l.kind === "visit") {
      const v = log.visits.get(l.id);
      const last = v ? Math.max(v.lastSeen, v.lastWritten) : 0;
      out.push({ ...base, device: l.device, ...(l.bot ? { bot: true } : {}), ...(v && last > v.at ? { lastSeenAt: iso(last) } : {}) });
    } else if (l.kind === "capped") out.push({ ...base, device: "" });
    else out.push({ ...base, device: l.device, ...(l.kind === "refused" && l.bot ? { bot: true } : {}) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Per person, the start of their newest visit by a person (not a scanner): the People card's line. */
export function lastVisits(orgId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of logOf(`org:${orgId}`).lines) if (l.kind === "visit" && !l.bot && l.personId && (!out[l.personId] || l.at > out[l.personId]!)) out[l.personId] = l.at;
  return out;
}

/** Per folded log, the sessions a person opened a link of, and how many lines that was read from. */
const openedBy = new WeakMap<OrgLog, { lines: number; ids: Set<string> }>();

/**
 * The baton sessions of an org that a person (never a link previewer or a scanner) opened a hand-off
 * link of: the session list's `opened` (§app.organizations/org-sessions). Read off the folded log,
 * again only when it has grown.
 */
export function openedSessions(orgId: string): ReadonlySet<string> {
  const log = logOf(`org:${orgId}`);
  const had = openedBy.get(log);
  if (had && had.lines === log.lines.length) return had.ids;
  const ids = new Set<string>();
  for (const l of log.lines) if (l.kind === "visit" && !l.bot && l.via !== "owner" && l.sessionId) ids.add(l.sessionId);
  openedBy.set(log, { lines: log.lines.length, ids });
  return ids;
}

/**
 * One session share recipient's log, folded like readVisits: one row per visit (with its last
 * seen), preview, refusal or cap; newest first. Device families only.
 */
export function readSessionVisits(shareId: string, recipientId: string): SessionShareVisit[] {
  return readHostLog(SESSION_LOG, (l) => l.via === "session" && l.shareId === shareId && l.recipientId === recipientId);
}

/** One preview's log (§mesh.public/visitor-log), folded like readSessionVisits. */
export function readPreviewVisits(previewId: string): SessionShareVisit[] {
  return readHostLog(PREVIEW_LOG, (l) => l.via === "preview" && l.previewId === previewId);
}

function readHostLog(logKey: string, match: (l: LinkKey) => boolean): SessionShareVisit[] {
  const log = logOf(logKey);
  const out: SessionShareVisit[] = [];
  for (const l of log.lines) {
    if (l.kind === "seen" || !match(l)) continue;
    if (l.kind === "visit") {
      const v = log.visits.get(l.id);
      const last = v ? Math.max(v.lastSeen, v.lastWritten) : 0;
      out.push({ id: l.id, kind: "visit", at: l.at, device: l.device, ...(l.bot ? { bot: true as const } : {}), ...(v && last > v.at ? { lastSeenAt: iso(last) } : {}) });
    } else if (l.kind === "capped") out.push({ id: l.id, kind: "capped", at: l.at, device: "" });
    else out.push({ id: l.id, kind: l.kind, at: l.at, device: l.device, ...(l.kind === "refused" && l.bot ? { bot: true as const } : {}) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What a recipient row shows: visits by a person (not previews, scanners or refused opens), and
    the newest one's last activity. */
export function visitSummary(visits: readonly SessionShareVisit[]): { opened: number; lastAt?: string } {
  let opened = 0;
  let lastAt: string | undefined;
  for (const v of visits) {
    if (v.kind !== "visit" || v.bot) continue;
    opened++;
    const at = v.lastSeenAt ?? v.at;
    if (!lastAt || at > lastAt) lastAt = at;
  }
  return { opened, ...(lastAt ? { lastAt } : {}) };
}

/** Forget every folded log (tests: a fresh process). */
export function resetVisitState(): void {
  logs.clear();
}
