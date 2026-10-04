import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREVIEW_LABEL_RE } from "../shared/public-links";
import { stateRoot } from "./state-root";
import { sessionsChanged } from "./list-generation";

/**
 * What else a preview has (§mesh.public/preview): `<stateRoot>/preview-kept.json`, beside
 * preview-links.json, whose keys never change (an older Sova reads that file strictly, so a new key
 * there would serve no preview after a rollback). Per preview id: its link (the secret: kept for
 * this host's operator and the project overseer, §app.project-overseer/previews), its target, the
 * coding session and branch it shows, its purpose. 0600, written atomically, host-local, never
 * synced or committed.
 *
 * Read tolerantly: a file that can't be read keeps nothing (no link, no folder served) and every
 * preview still opens; an entry that breaks a rule is left out alone. Never logged.
 *
 * A person's own link to a preview (a sibling, §app.outreach/links) is kept from its send on in a map
 * of its own, `siblingLinks` (sibling id -> link), never as a `previews` entry: a sibling has no target
 * of its own, and every reader of `previews` relies on each entry having one. It is the operator's,
 * for the Sent to line only (§mesh.public/preview-card); no tool or model reads it.
 */

export const PREVIEW_KEPT_FILE = "preview-kept.json";

/** `instance`: a running copy's endpoint (§app.project-services/share); `serve`: a static copy's serve id, which must hold the port for the link to dial. */
export type KeptTarget = { kind: "port" } | { kind: "static"; folder: string } | { kind: "instance"; instance: string; endpoint: string; generation?: number; serve?: string };

export interface KeptPreview {
  /** The link, `<scheme>://<label>.<zone>/`. */
  url?: string;
  target: KeptTarget;
  sessionId?: string;
  branch?: string;
  purpose?: string;
}

interface KeptFile {
  version: 1;
  previews: Record<string, KeptPreview>;
  /** A person's own link by sibling id: absent while none is kept (an older Sova writes none, and ignores it). */
  siblingLinks?: Record<string, string>;
}

export const previewKeptFile = (): string => join(stateRoot(), PREVIEW_KEPT_FILE);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PREVIEW_ID = /^pv_[A-Za-z0-9_-]{16}$/;
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const ENDPOINT = /^[a-z][a-z0-9-]{0,30}\.[a-z][a-z0-9-]{0,30}$/;
const SERVE = /^[A-Za-z0-9_.-]{1,200}$/;
const optStr = (v: unknown, max: number): v is string | undefined => v === undefined || (typeof v === "string" && v.length <= max);

/** A kept link: http(s), its host's first label a preview label. */
function isLink(v: string): boolean {
  if (v.length > 512) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return PREVIEW_LABEL_RE.test(u.hostname.split(".")[0] ?? "");
  } catch {
    return false;
  }
}

/** One entry checked, or null. */
function entryOf(v: unknown): KeptPreview | null {
  if (!isObj(v) || !isObj(v.target)) return null;
  const t = v.target;
  let target: KeptTarget;
  if (t.kind === "port") target = { kind: "port" };
  else if (t.kind === "static" && typeof t.folder === "string" && t.folder.startsWith("/") && t.folder.length <= 4096) target = { kind: "static", folder: t.folder };
  else if (t.kind === "instance" && typeof t.instance === "string" && REF.test(t.instance) && typeof t.endpoint === "string" && ENDPOINT.test(t.endpoint)) {
    if (t.generation !== undefined && !(typeof t.generation === "number" && Number.isInteger(t.generation) && t.generation >= 0)) return null;
    if (t.serve !== undefined && (typeof t.serve !== "string" || !SERVE.test(t.serve))) return null;
    target = {
      kind: "instance",
      instance: t.instance,
      endpoint: t.endpoint,
      ...(typeof t.generation === "number" ? { generation: t.generation } : {}),
      ...(typeof t.serve === "string" ? { serve: t.serve } : {}),
    };
  } else return null;
  if (!optStr(v.url, 512) || !optStr(v.branch, 256) || !optStr(v.purpose, 400)) return null;
  if (v.sessionId !== undefined && (typeof v.sessionId !== "string" || !REF.test(v.sessionId))) return null;
  if (typeof v.url === "string" && !isLink(v.url)) return null;
  return {
    target,
    ...(typeof v.url === "string" ? { url: v.url } : {}),
    ...(typeof v.sessionId === "string" ? { sessionId: v.sessionId } : {}),
    ...(typeof v.branch === "string" ? { branch: v.branch } : {}),
    ...(typeof v.purpose === "string" ? { purpose: v.purpose } : {}),
  };
}

let cached: { path: string; stamp: string; file: KeptFile } | null = null;
const stampOf = (file: string): string => {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
};

let warned = "";
function read(): KeptFile {
  const path = previewKeptFile();
  const stamp = stampOf(path);
  if (cached?.path === path && cached.stamp === stamp) return cached.file;
  const out: KeptFile = { version: 1, previews: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isObj(raw) || raw.version !== 1 || !isObj(raw.previews)) throw new Error("document shape");
      for (const [id, v] of Object.entries(raw.previews)) {
        const e = PREVIEW_ID.test(id) ? entryOf(v) : null;
        if (e) out.previews[id] = e;
      }
      // The people's links: a map that breaks its shape keeps none of them, and costs the previews nothing.
      if (isObj(raw.siblingLinks)) {
        const links: Record<string, string> = {};
        for (const [id, v] of Object.entries(raw.siblingLinks)) if (PREVIEW_ID.test(id) && typeof v === "string" && isLink(v)) links[id] = v;
        if (Object.keys(links).length) out.siblingLinks = links;
      }
    } catch (err) {
      // Never quotes the file: it holds links.
      const why = err instanceof SyntaxError ? "not JSON" : err instanceof Error ? err.message : "unreadable";
      if (why !== warned) {
        warned = why;
        console.warn(`[preview] ${PREVIEW_KEPT_FILE} is unreadable (${why}); no link is kept and no folder is served until it is fixed or removed`);
      }
    }
  }
  cached = { path, stamp, file: out };
  return out;
}

function write(file: KeptFile): void {
  cached = null;
  const path = previewKeptFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  sessionsChanged(); // a kept link changes what rows redact
}

/** What is kept for one preview, or null (one made before this file, or a broken entry). */
export function keptPreview(id: string): KeptPreview | null {
  return read().previews[id] ?? null;
}

/** Every kept entry, by preview id. */
export function keptPreviews(): Record<string, KeptPreview> {
  return { ...read().previews };
}

/** Keep one preview's facts (its link included): written at its mint. */
export function keepPreview(id: string, kept: KeptPreview): void {
  if (!PREVIEW_ID.test(id)) throw new Error("bad preview id");
  const file = read();
  write({ ...file, previews: { ...file.previews, [id]: kept } });
}

/** Keep a person's own link to a preview (sibling `id`), made by its send (§app.outreach/links). */
export function keepSiblingLink(id: string, url: string): void {
  if (!PREVIEW_ID.test(id)) throw new Error("bad preview id");
  if (!isLink(url)) throw new Error("not a preview link");
  const file = read();
  write({ ...file, siblingLinks: { ...file.siblingLinks, [id]: url } });
}

/** A person's kept link (sibling `id`), or null: one sent before links were kept, or one dropped. */
export function keptSiblingLink(id: string): string | null {
  return read().siblingLinks?.[id] ?? null;
}

/** Drop the people's links `keep` refuses (a sibling turned off, expired or gone). Writes only when one goes. */
export function dropSiblingLinks(keep: (id: string) => boolean): string[] {
  const file = read();
  const links = file.siblingLinks ?? {};
  const gone = Object.keys(links).filter((id) => !keep(id));
  if (!gone.length) return [];
  const rest = Object.fromEntries(Object.entries(links).filter(([id]) => !gone.includes(id)));
  write({ version: 1, previews: file.previews, ...(Object.keys(rest).length ? { siblingLinks: rest } : {}) });
  return gone;
}

/** Every kept link's label (the secret part), for the redactions and the leak checks. */
export function keptLabels(): string[] {
  const out: string[] = [];
  const file = read();
  for (const url of [...Object.values(file.previews).map((k) => k.url), ...Object.values(file.siblingLinks ?? {})]) {
    if (!url) continue;
    try {
      const label = new URL(url).hostname.split(".")[0] ?? "";
      if (PREVIEW_LABEL_RE.test(label)) out.push(label);
    } catch {
      // not a URL: not kept
    }
  }
  return out;
}

/** What stands in for a kept link in text that must never carry one. */
export const PREVIEW_LINK_REDACTED = "[preview link]";

/** `text` with every kept link (and every bare label of one) replaced. Pure over `labels`. */
export function redactPreviewLinks(text: string, labels: readonly string[] = keptLabels()): string {
  let out = text;
  for (const label of labels) {
    if (!out.includes(label)) continue;
    // The whole link when it is one (scheme, host, any path), else the label alone.
    out = out.replace(new RegExp(`(?:https?://)?${label}(?:\\.[A-Za-z0-9.-]+)?(?::\\d+)?(?:/[^\\s)\\]>"']*)?`, "g"), PREVIEW_LINK_REDACTED);
  }
  return out;
}

/** Whether `text` holds a kept link (its label). Pure over `labels`. */
export const holdsPreviewLink = (text: string, labels: readonly string[] = keptLabels()): boolean => labels.some((l) => text.includes(l));

/** `v` with every kept link in any of its strings replaced (a copy only when one is there). Pure over `labels`. */
export function redactPreviewLinksDeep<T>(v: T, labels: readonly string[] = keptLabels()): T {
  if (!labels.length) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return holdsPreviewLink(x, labels) ? redactPreviewLinks(x, labels) : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return holdsPreviewLink(JSON.stringify(v) ?? "", labels) ? (walk(v) as T) : v;
}
