import { appendFileSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { SessionShareVisit } from "../shared/session-share";
import { stateRoot } from "./state-root";
import { readVisitorLogging } from "./visitor-logging";
import { PREVIEW_VISITS_FILE } from "./visits";

/**
 * Who opened this host's links, with their address (§mesh.public/visitor-log): while the host's
 * Log visitors switch is on, `<stateRoot>/visitor-identity.jsonl` (0600, host-local, never synced or
 * committed) gets `{id, at, ip, ua, lang?, referer?, path?}`, `id` the visit's id in its visit log
 * (server/visits.ts). A `/h/`, `/i/` or `/s/` visit gets one line per address and user agent (per
 * process); a preview visit one per page load. Never a token, a preview label, a hash, Host,
 * cookies or Authorization. Read only by the Shares page (server/shares-overview.ts). Lines older
 * than RETENTION_MS are pruned here and in preview-visits.jsonl. Writing never fails a request.
 */

export const IDENTITY_FILE = "visitor-identity.jsonl";
export const RETENTION_MS = 120 * 24 * 60 * 60_000;
const UA_MAX = 512;
const SHORT_MAX = 128;
/** Page lines per preview visit, at most (per process). */
const PAGES_MAX = 200;

export interface IdentityLine {
  id: string;
  at: string;
  ip: string;
  ua: string;
  lang?: string;
  referer?: string;
  path?: string;
}

const fileOf = (): string => join(stateRoot(), IDENTITY_FILE);

// ---- the client address of a share request ---------------------------------------------------------

/** The client address the share edge computed for a request (§mesh.public/forwarded-for), set by its
    in-process dispatch so the share routes can read it off `c.env.incoming`. */
const clients = new WeakMap<IncomingMessage, string>();
export const noteShareClient = (req: IncomingMessage, client: string): void => void clients.set(req, client);
export const shareClientOf = (req: IncomingMessage): string | undefined => clients.get(req);

// ---- writing ----------------------------------------------------------------------------------------

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const cut = (v: string | undefined, max: number): string | undefined => (v ? v.slice(0, max) : undefined);

/** Already written this process: `id|ip|ua` for a share link's visit; page lines per preview visit. */
const seen = new Set<string>();
const pages = new Map<string, number>();

export interface VisitorSeen {
  ip: string;
  ua?: string | null;
  lang?: string | null;
  /** A preview's off-site Referer: its origin only (a path or query can hold someone's token). */
  referer?: string | null;
  /** A preview page load: its path, without the query. */
  path?: string | null;
}

/** Append one identity line for visit `id`, when the switch is on. `perPage`: a preview page load
    (one line each); otherwise once per address and user agent. Never throws. */
export function noteVisitor(id: string | null, v: VisitorSeen, perPage = false, now = Date.now()): void {
  if (!id) return;
  try {
    if (!readVisitorLogging().logVisitors) return;
    const ua = cut(v.ua ?? undefined, UA_MAX) ?? "";
    if (perPage) {
      const n = pages.get(id) ?? 0;
      if (n >= PAGES_MAX) return;
      pages.set(id, n + 1);
    } else {
      const k = `${id}|${v.ip}|${ua}`;
      if (seen.has(k)) return;
      seen.add(k);
    }
    const lang = cut(v.lang ?? undefined, SHORT_MAX);
    const referer = cut(v.referer ?? undefined, SHORT_MAX);
    const path = cut(v.path?.split("?")[0], SHORT_MAX * 4);
    const line: IdentityLine = { id, at: new Date(now).toISOString(), ip: v.ip, ua, ...(lang ? { lang } : {}), ...(referer ? { referer } : {}), ...(path ? { path } : {}) };
    appendFileSync(fileOf(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[visits] identity line failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A `/h/`, `/i/` or `/s/` visit (recordOpen's id) from a share route: its client, user agent and
    language, off the Node request in the route's `c.env` (none when the app is called without one). */
export function noteShareVisit(id: string | null, env: unknown): void {
  const req = (env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (!id || !req) return;
  noteVisitor(id, { ip: shareClientOf(req) ?? req.socket?.remoteAddress ?? "", ua: one(req.headers["user-agent"]), lang: one(req.headers["accept-language"]) });
}

/** A Referer's origin when it is off the preview zone (any `*.<zone>` host carries a label); else undefined. */
export function offSiteReferer(referer: string | undefined, publicOrigin: string): string | undefined {
  if (!referer) return undefined;
  try {
    const r = new URL(referer);
    const host = new URL(publicOrigin).hostname.toLowerCase();
    const zone = host.slice(host.indexOf(".") + 1);
    const h = r.hostname.toLowerCase();
    if (h === host || h === zone || h.endsWith(`.${zone}`) || (r.protocol !== "http:" && r.protocol !== "https:")) return undefined;
    return r.origin;
  } catch {
    return undefined;
  }
}

// ---- reading ----------------------------------------------------------------------------------------

let cached: { stamp: string; byId: Map<string, IdentityLine[]> } | null = null;

/** Every identity line by visit id, in file order; re-read when the file changed. */
export function readIdentity(): Map<string, IdentityLine[]> {
  let stamp = "";
  try {
    const s = statSync(fileOf());
    stamp = `${fileOf()}:${s.size}:${s.mtimeMs}`;
  } catch {
    return new Map();
  }
  if (cached?.stamp === stamp) return cached.byId;
  const byId = new Map<string, IdentityLine[]>();
  for (const l of readFileSync(fileOf(), "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l) as IdentityLine;
      if (typeof v?.id !== "string" || typeof v.ip !== "string") continue;
      const list = byId.get(v.id) ?? [];
      list.push(v);
      byId.set(v.id, list);
    } catch {
      // a torn line: skip
    }
  }
  cached = { stamp, byId };
  return byId;
}

const uniq = (xs: (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/** A visit with what the identity file holds for it (nothing when it holds nothing). */
export function withIdentity(v: SessionShareVisit, byId: Map<string, IdentityLine[]>): SessionShareVisit {
  const lines = v.id ? byId.get(v.id) : undefined;
  if (!lines?.length) return v;
  const paths = lines.flatMap((l) => (l.path ? [l.path] : []));
  const lang = lines.find((l) => l.lang)?.lang;
  const referer = lines.find((l) => l.referer)?.referer;
  return { ...v, ip: uniq(lines.map((l) => l.ip)), ua: uniq(lines.map((l) => l.ua)), ...(lang ? { lang } : {}), ...(referer ? { referer } : {}), ...(paths.length ? { pages: paths } : {}) };
}

// ---- retention --------------------------------------------------------------------------------------

/** Rewrite a JSONL file without the lines whose `at` is older than the cutoff (atomic, 0600). Returns
    how many were dropped. */
function pruneFile(file: string, cutoff: number): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(l) as { at?: string }).at ?? "");
    } catch {
      // a torn line: dropped with the old ones
    }
    if (Number.isFinite(at) && at >= cutoff) kept.push(l);
    else dropped++;
  }
  if (!dropped) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return dropped;
}

/** Drop identity and preview-visit lines older than RETENTION_MS (startup and daily). */
export function pruneVisitorLogs(now = Date.now()): number {
  const cutoff = now - RETENTION_MS;
  return pruneFile(fileOf(), cutoff) + pruneFile(join(stateRoot(), PREVIEW_VISITS_FILE), cutoff);
}

/** Forget what this process wrote and read (tests). */
export function resetVisitorIdentity(): void {
  seen.clear();
  pages.clear();
  cached = null;
}
