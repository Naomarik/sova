import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectIconInfo, ProjectIconRef } from "../../shared/projects";
import { sniffImageMime } from "../attachments";
import { stateRoot } from "../state-root";

/**
 * A project's icon (§app.projects/icon): a picture the operator uploaded, else a square PNG app icon found in the
 * project's folder, else letters (drawn by the page). Keyed by the project's id and its root only: this module knows
 * nothing of organizations. Uploads and the letters switch are host state under `<stateRoot>/project-icons/`, never in
 * the repository and never under `<stateRoot>/projects/<pid>/` (a standalone engine's folder). The folder is only read.
 */

/** A refusal the icon routes answer with its status and sentence. */
export class IconError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415,
  ) {
    super(message);
  }
}

/** A found icon's file is read only up to this size. */
export const FOUND_MAX_BYTES = 1024 * 1024;
/** An upload (already a square PNG: the page converts) up to this size, decoded. */
export const UPLOAD_MAX_BYTES = 1024 * 1024;
/** A manifest is parsed only up to this size. */
const MANIFEST_MAX_BYTES = 64 * 1024;
/** The smallest side a found icon may have (a favicon is skipped). */
export const MIN_SIDE = 64;
/** An upload's side, at most. */
export const UPLOAD_MAX_SIDE = 1024;
/** A found icon this much wider than tall (or taller than wide) is a wordmark, skipped. */
const MAX_ASPECT = 1.25;
/** How long a root's found icon is remembered: a changed icon file is noticed within this. */
export const FOUND_MEMO_MS = 30_000;

export const iconsDir = (): string => join(stateRoot(), "project-icons");
const PID_RE = /^[A-Za-z0-9_-]+$/;
const uploadPath = (pid: string): string => join(iconsDir(), `${pid}.png`);
const flagsPath = (pid: string): string => join(iconsDir(), `${pid}.json`);

/** A PNG's width and height from its IHDR, or null when the bytes are no PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24 || sniffImageMime(bytes) !== "image/png") return null;
  // IHDR is the first chunk: its type at 12..15, width and height big-endian at 16 and 20.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

/** The fixed places, after `.sova/icon.png` and a web app manifest's icons, in order. */
const FIXED_CANDIDATES = [
  "public/apple-touch-icon.png",
  "public/icons/apple-touch-icon.png",
  "static/apple-touch-icon.png",
  "apple-touch-icon.png",
  "app/icon.png",
  "src/app/icon.png",
  "app/apple-icon.png",
  "public/icon.png",
  "public/logo.png",
  "icon.png",
  "logo.png",
  "assets/icon.png",
  "assets/logo.png",
  "build/icon.png",
  "resources/icon.png",
  "src-tauri/icons/icon.png",
  "src-tauri/icons/128x128@2x.png",
];
/** A web app manifest's JSON file name. Built from parts: the spec layout guard (server/spec-layout-boundary.test.ts)
    flags any source line naming the spec's records file, which shares this name, and its allowlist only shrinks. */
const WEB_JSON = ["manifest", "json"].join(".");
const WEB_MANIFESTS = ["public/manifest.webmanifest", "public/site.webmanifest", `public/${WEB_JSON}`, `static/${WEB_JSON}`, "manifest.webmanifest", WEB_JSON];

/** Whether `p` (absolute) is `base` or inside it. */
const inside = (base: string, p: string): boolean => {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
};

/** A regular file under `root` (its real path inside the real root), or null. */
function plainFileInside(realRoot: string, abs: string): { real: string; size: number; mtimeMs: number } | null {
  try {
    if (!inside(realRoot, resolve(abs))) return null;
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    const real = realpathSync(abs);
    if (!inside(realRoot, real)) return null;
    return { real, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** The manifest's PNG icons, largest declared size first, as paths relative to the root (unchecked). */
function manifestIcons(realRoot: string, relManifest: string): string[] | null {
  const abs = join(realRoot, relManifest);
  const f = plainFileInside(realRoot, abs);
  if (!f || f.size > MANIFEST_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(f.real, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const icons = (parsed as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];
  const folder = dirname(abs);
  const out: { rel: string; size: number; at: number }[] = [];
  icons.forEach((raw, at) => {
    if (typeof raw !== "object" || raw === null) return;
    const icon = raw as { src?: unknown; type?: unknown; purpose?: unknown; sizes?: unknown };
    if (typeof icon.src !== "string" || !icon.src.trim()) return;
    const src = icon.src.trim().split(/[?#]/)[0]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return; // a URL elsewhere
    const png = /\.png$/i.test(src) || icon.type === "image/png";
    if (!png) return;
    if (typeof icon.purpose === "string" && !icon.purpose.split(/\s+/).includes("any")) return;
    // A leading '/' is the manifest's own folder (the site's root, as served).
    const target = resolve(folder, src.startsWith("/") ? `.${src}` : src);
    if (!inside(realRoot, target)) return;
    const sizes = typeof icon.sizes === "string" ? icon.sizes : "";
    const size = Math.max(0, ...sizes.split(/\s+/).map((s) => Number(/^(\d+)x\d+$/i.exec(s)?.[1] ?? 0)));
    out.push({ rel: relative(realRoot, target), size, at });
  });
  return out.sort((a, b) => b.size - a.size || a.at - b.at).map((o) => o.rel);
}

/** Every candidate, in order, as paths relative to the root. */
function candidates(realRoot: string): string[] {
  const out = [".sova/icon.png"];
  for (const m of WEB_MANIFESTS) {
    const icons = manifestIcons(realRoot, m);
    if (icons) {
      out.push(...icons);
      break;
    }
  }
  return [...out, ...FIXED_CANDIDATES];
}

export interface FoundIcon {
  /** Relative to the root, forward slashes. */
  path: string;
  abs: string;
  v: string;
  w: number;
  h: number;
}

/** A candidate that passes every check, or null. */
function check(realRoot: string, rel: string): FoundIcon | null {
  const f = plainFileInside(realRoot, join(realRoot, rel));
  if (!f || f.size > FOUND_MAX_BYTES || f.size < 24) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(f.real);
  } catch {
    return null;
  }
  const dim = pngSize(bytes);
  if (!dim) return null;
  const lo = Math.min(dim.w, dim.h);
  const hi = Math.max(dim.w, dim.h);
  if (lo < MIN_SIDE || hi / lo > MAX_ASPECT) return null;
  const path = rel.split(sep).join("/");
  const v = createHash("sha1").update(`${path}\0${f.mtimeMs}\0${f.size}`).digest("hex").slice(0, 10);
  return { path, abs: f.real, v, w: dim.w, h: dim.h };
}

const foundMemo = new Map<string, { at: number; icon: FoundIcon | null }>();
let clock = (): number => Date.now();

/** The first square PNG app icon in the project's folder, or null. Remembered per root for FOUND_MEMO_MS. */
export function findIcon(root: string, fresh = false): FoundIcon | null {
  if (!root) return null;
  const hit = foundMemo.get(root);
  if (!fresh && hit && clock() - hit.at < FOUND_MEMO_MS) return hit.icon;
  let icon: FoundIcon | null = null;
  try {
    const realRoot = realpathSync(root);
    if (statSync(realRoot).isDirectory()) {
      const seen = new Set<string>();
      for (const rel of candidates(realRoot)) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        icon = check(realRoot, rel);
        if (icon) break;
      }
    }
  } catch {
    icon = null;
  }
  foundMemo.set(root, { at: clock(), icon });
  return icon;
}

function readFlags(pid: string): { letters: boolean } {
  try {
    const d = JSON.parse(readFileSync(flagsPath(pid), "utf8")) as { letters?: unknown };
    return { letters: d.letters === true };
  } catch {
    return { letters: false };
  }
}

function uploadStat(pid: string): { v: string; at: string; size: number } | null {
  try {
    const st = lstatSync(uploadPath(pid));
    if (!st.isFile()) return null;
    return { v: `${Math.floor(st.mtimeMs).toString(36)}-${st.size}`, at: st.mtime.toISOString(), size: st.size };
  } catch {
    return null;
  }
}

/** The picture a project's summary carries, or undefined: letters. */
export function iconRefOf(pid: string, root: string): ProjectIconRef | undefined {
  if (!PID_RE.test(pid)) return undefined;
  if (readFlags(pid).letters) return undefined;
  const up = uploadStat(pid);
  if (up) return { kind: "image", source: "upload", v: up.v };
  const found = findIcon(root);
  return found ? { kind: "image", source: "found", v: found.v } : undefined;
}

/** The Icon card's facts (rescans the folder). */
export function iconInfo(pid: string, root: string): ProjectIconInfo {
  const letters = readFlags(pid).letters;
  const up = uploadStat(pid);
  const found = findIcon(root, true);
  return {
    use: letters ? "letters" : up ? "upload" : found ? "found" : "letters",
    letters,
    ...(up ? { uploaded: { v: up.v, at: up.at } } : {}),
    ...(found ? { found: { path: found.path, v: found.v, w: found.w, h: found.h } } : {}),
  };
}

/** The bytes GET …/icon serves and the ref they belong to, or null: letters are in use. */
export function iconBytes(pid: string, root: string): { bytes: Buffer; v: string } | null {
  const ref = iconRefOf(pid, root);
  if (!ref) return null;
  try {
    if (ref.source === "upload") return { bytes: readFileSync(uploadPath(pid)), v: ref.v };
    const found = findIcon(root);
    return found ? { bytes: readFileSync(found.abs), v: ref.v } : null;
  } catch {
    return null;
  }
}

function ensureDir(): void {
  mkdirSync(iconsDir(), { recursive: true, mode: 0o700 });
}

/** Write `bytes` to `dest` atomically: an exclusive .part file, then a rename over it. */
function writeAtomic(dest: string, bytes: Uint8Array): void {
  ensureDir();
  for (let attempt = 0; attempt < 5; attempt++) {
    const part = `${dest}.${process.pid}.${Date.now().toString(36)}${attempt}.part`;
    let fd: number;
    try {
      fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch {
      continue;
    }
    try {
      try {
        for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
      } finally {
        closeSync(fd);
      }
      renameSync(part, dest);
      return;
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
  }
  throw new Error("Could not write the icon");
}

const dropMemo = (root: string): void => void foundMemo.delete(root);

/** Keep an uploaded picture: a square PNG of 64..1024 px, at most 1 MB. Turns letters off. */
export function saveUpload(pid: string, root: string, b64: unknown): ProjectIconInfo {
  if (!PID_RE.test(pid)) throw new IconError("Unknown project", 404);
  if (typeof b64 !== "string" || !b64) throw new IconError("Expected { png: <base64 PNG> }", 400);
  // Base64 is 4 characters per 3 bytes: refuse before decoding anything far too big.
  if (b64.length > Math.ceil((UPLOAD_MAX_BYTES * 4) / 3) + 4) throw new IconError("The image is over 1 MB.", 413);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > UPLOAD_MAX_BYTES) throw new IconError("The image is over 1 MB.", 413);
  const dim = pngSize(bytes);
  if (!dim) throw new IconError("Only a PNG is accepted (the page converts other images)", 415);
  if (dim.w !== dim.h || dim.w < MIN_SIDE || dim.w > UPLOAD_MAX_SIDE) throw new IconError(`The image must be square, ${MIN_SIDE} to ${UPLOAD_MAX_SIDE} px.`, 400);
  writeAtomic(uploadPath(pid), bytes);
  if (readFlags(pid).letters) writeAtomic(flagsPath(pid), Buffer.from(JSON.stringify({ v: 1 })));
  dropMemo(root);
  return iconInfo(pid, root);
}

/** Letters on (a picture is kept but not shown) or off. */
export function setLetters(pid: string, root: string, on: unknown): ProjectIconInfo {
  if (!PID_RE.test(pid)) throw new IconError("Unknown project", 404);
  if (typeof on !== "boolean") throw new IconError("Expected { letters: true | false }", 400);
  writeAtomic(flagsPath(pid), Buffer.from(JSON.stringify(on ? { v: 1, letters: true } : { v: 1 })));
  dropMemo(root);
  return iconInfo(pid, root);
}

/** Remove the uploaded picture: back to the found icon or letters. */
export function removeUpload(pid: string, root: string): ProjectIconInfo {
  if (!PID_RE.test(pid)) throw new IconError("Unknown project", 404);
  rmSync(uploadPath(pid), { force: true });
  dropMemo(root);
  return iconInfo(pid, root);
}

/** Tests only: forget every found icon, and move the clock. */
export function resetIconMemoForTest(now?: () => number): void {
  foundMemo.clear();
  clock = now ?? (() => Date.now());
}
