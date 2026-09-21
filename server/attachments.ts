import { randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TmpAttachment } from "../shared/protocol";
import { ATTACHMENT_TAIL, findTmpImagePaths, isPiClipboardName, SESSION_ID, TMP_IMAGE_PATH } from "../shared/tmp-paths";

// Image paths named in transcript text (pi's TUI pastes a clipboard image by writing it to /tmp
// and inserting the path as text; replies, tool output and subagent reports then quote it). We
// show them as attachments and serve their bytes through GET /api/attachment, but only for image
// files sitting directly in /tmp, or in a session's folder under the attachments root.

const TMP_DIR = "/tmp";

/** pi-web's durable attachments: a composer-draft upload lands in `<root>/<session id>/`, so a
    reload keeps it with the draft text (server/drafts.ts), and the path the prompt names stays
    readable after the send (the transcript renders it; /tmp gets cleaned). Per call, not at
    load: PI_CODING_AGENT_DIR is read by getAgentDir each time, which the tests rely on. */
export const attachmentsRoot = () => join(getAgentDir(), "pi-web", "attachments");

/** One session's folder. The id must be a plain id (no separators or dots), or null. */
export function sessionAttachmentsDir(sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? join(attachmentsRoot(), sessionId) : null;
}
const SESSION_ID_RE = new RegExp(`^${SESSION_ID}$`);
/** Same cap as a prompt's images (MAX_IMAGE_BYTES in chat-manager). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Upload rejections map to HTTP statuses. */
export class UploadError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 500, message: string) {
    super(message);
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Magic bytes: the body must really be the image it claims to be. */
function sniffImageMime(b: Uint8Array): string | null {
  const eq = (offset: number, ...bytes: number[]) => bytes.every((x, i) => b[offset + i] === x);
  if (b.length >= 8 && eq(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && eq(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 12 && eq(0, 0x52, 0x49, 0x46, 0x46) && eq(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 6 && eq(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  return null;
}

export interface SavedUpload {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Store a web-uploaded image the way pi's TUI stores a clipboard paste: a fresh file directly
    in /tmp, referenced by path in the prompt text (the model reads it with the read tool).
    With `dir` (a session's attachments folder, created here) it lands there instead.
    Magic bytes must match the declared type; the exclusive .part write + hardlink rename can
    neither clobber an existing file nor follow a pre-planted symlink, and a .part name never
    matches the served patterns. */
export function saveUploadedImage(bytes: Uint8Array, declaredMime: string, dir: string = TMP_DIR): SavedUpload {
  if (!Object.prototype.hasOwnProperty.call(EXT_BY_MIME, declaredMime)) throw new UploadError(415, `Unsupported image type: ${declaredMime || "(none)"}`);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new UploadError(413, "Image exceeds the 20MB limit");
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) throw new UploadError(400, "Not an image (magic bytes don't match an image format)");
  if (sniffed !== declaredMime) throw new UploadError(400, `Body is ${sniffed}, Content-Type said ${declaredMime}`);
  const ext = EXT_BY_MIME[sniffed]!;
  if (dir !== TMP_DIR) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new UploadError(500, "Could not create the attachments folder");
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `pi-web-${randomUUID()}${ext}`;
    const part = join(dir, `.${name}.part`);
    const finalPath = join(dir, name);
    try {
      const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
      } finally {
        closeSync(fd);
      }
      linkSync(part, finalPath); // EEXIST instead of clobbering
      rmSync(part, { force: true });
      return { path: finalPath, name, mimeType: sniffed, size: bytes.length };
    } catch (err) {
      rmSync(part, { force: true });
      if (err instanceof UploadError) throw err;
      // uuid collision or leftover .part with this exact name: retry with a new one
    }
  }
  throw new UploadError(500, "Could not allocate an upload name");
}

/** At most this many units per row; later paths stay plain text. Bounds the stat calls too. */
export const MAX_ATTACHMENTS_PER_ROW = 8;
/** Placeholder for a removed path and its surrounding blanks (NUL never occurs in typed text). */
const GAP = "\u0000";
const GAP_EDGE_RE = /^\u0000+|\u0000+$/gm;
const GAP_RUN_RE = /\u0000+/g;

export type TmpImageCheck =
  | { ok: true; realPath: string; mimeType: string; size: number }
  | { ok: false; status: 400 | 403 | 404; error: string; size?: number };

let tmpReal: string | undefined;

/** The attachments root as given and as resolved (~/.pi/agent may be a symlink): a path may be
    written either way. Resolved per call, like attachmentsRoot. null = no root on disk yet. */
function roots(): { root: string; real: string | null } {
  const root = attachmentsRoot();
  try {
    return { root, real: realpathSync(root) };
  } catch {
    return { root, real: null };
  }
}

/** `p` minus a leading `<root>/`, or null. */
const under = (p: string, root: string | null) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null);

/**
 * Whether `p` names an image file we may serve: shaped `/tmp/<name>.<image ext>` or
 * `<attachments root>/<session id>/<name>.<image ext>` (no other subdirs, no "." or ".."
 * segments: neither an id nor a name may contain a "/" or start with a "."), and after resolving
 * symlinks still a regular image file directly in /tmp, or in a session folder directly under
 * the resolved root, at most 20MB. 400 = bad shape, 404 = missing, 403 = resolves elsewhere or
 * too large.
 */
export function checkTmpImage(p: unknown): TmpImageCheck {
  if (typeof p !== "string" || p.length > 1024) return badShape();
  const inTmp = p.length <= 255 && TMP_IMAGE_PATH.test(p);
  let r: { root: string; real: string | null } | null = null;
  if (!inTmp) {
    r = roots();
    const tail = under(p, r.root) ?? under(p, r.real);
    if (tail === null || !ATTACHMENT_TAIL.test(tail) || basename(p).length > 255) return badShape();
  }
  let real: string;
  try {
    real = realpathSync(p);
    if (inTmp) tmpReal ??= realpathSync(TMP_DIR);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }
  const mimeType = MIME_BY_EXT[extname(real).toLowerCase()];
  // The resolved file must sit exactly one session folder below the resolved root: a symlinked
  // file or session folder pointing anywhere else is refused, whatever the literal path said.
  const inside = inTmp ? dirname(real) === tmpReal : r!.real !== null && dirname(dirname(real)) === r!.real;
  if (!inside || !mimeType) return { ok: false, status: 403, error: inTmp ? "Not an image in /tmp" : "Not an image in the attachments folder" };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }
  if (!st.isFile()) return { ok: false, status: 404, error: "File not found" };
  if (st.size > MAX_ATTACHMENT_BYTES) return { ok: false, status: 403, error: "Image exceeds the 20MB limit", size: st.size };
  return { ok: true, realPath: real, mimeType, size: st.size };
}

function badShape(): TmpImageCheck {
  return { ok: false, status: 400, error: "path must be /tmp/<name> or <attachments>/<session id>/<name>, .png|jpg|jpeg|webp|gif" };
}

/**
 * DELETE /api/attachment: remove one file, only under the attachments root (a composer chip's
 * remove button; /tmp belongs to the TUI's clipboard pastes, never ours to delete). The shape
 * rules are checkTmpImage's; the file itself is lstat'ed, not followed, so a symlink is removed
 * as a link and its target is never touched.
 */
export function deleteAttachment(p: unknown): { ok: true } | { ok: false; status: 400 | 403 | 404; error: string } {
  if (typeof p !== "string" || !p) return { ok: false, status: 400, error: "Missing ?path=" };
  const r = roots();
  const tail = under(p, r.root) ?? under(p, r.real);
  if (tail === null || !ATTACHMENT_TAIL.test(tail)) return { ok: false, status: 403, error: "Only files in the attachments folder can be deleted" };
  const dir = dirname(p);
  let st;
  try {
    // The session folder must really be one directly under the root (no symlinked folder).
    if (r.real === null || dirname(realpathSync(dir)) !== r.real || lstatSync(dir).isSymbolicLink()) {
      return { ok: false, status: 403, error: "Only files in the attachments folder can be deleted" };
    }
    st = lstatSync(p);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }
  if (st.isDirectory()) return { ok: false, status: 403, error: "Not a file" };
  rmSync(p, { force: true });
  return { ok: true };
}

/** Best-effort: a deleted session's attachments folder goes with it (cleanupSessions). */
export function removeSessionAttachments(sessionId: string): void {
  const dir = sessionAttachmentsDir(sessionId);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // left behind: harmless, and never served for a session that no longer exists in the list
  }
}

/**
 * Read a checked image. Opened without following symlinks and re-checked on the open handle, so
 * swapping the file for a link after checkTmpImage can't widen what we serve. null = gone/changed.
 */
export async function readTmpImage(realPath: string): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_ATTACHMENT_BYTES) return null;
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/**
 * Find image paths (in /tmp or an attachments folder) in a row's text (outside markdown code; the first
 * MAX_ATTACHMENTS_PER_ROW distinct ones). With `strip` (user rows), paths pi inserted for a
 * pasted image are removed from the display text, since the unit stands in for them; paths the
 * user typed stay. Otherwise the text is returned as-is. `text` is undefined when nothing is left.
 */
export function inlineTmpImages(text: string, strip = false): { text?: string; attachments?: TmpAttachment[] } {
  const found = new Map<string, TmpAttachment>();
  const cut: { start: number; end: number }[] = [];
  for (const m of findTmpImagePaths(text)) {
    if (!found.has(m.path)) {
      if (found.size >= MAX_ATTACHMENTS_PER_ROW) continue;
      const check = checkTmpImage(m.path);
      found.set(m.path, {
        path: m.path,
        name: basename(m.path),
        mimeType: MIME_BY_EXT[extname(m.path).toLowerCase()]!,
        ...(check.size !== undefined ? { size: check.size } : {}),
        available: check.ok,
      });
    }
    if (strip && isPiClipboardName(basename(m.path))) cut.push(m);
  }
  if (found.size === 0) return { text };
  let shown = text;
  if (cut.length > 0) {
    // Right to left so earlier offsets stay valid; each cut takes its blanks with it.
    for (const { start, end } of cut.reverse()) {
      let a = start;
      let b = end;
      while (a > 0 && (shown[a - 1] === " " || shown[a - 1] === "\t")) a--;
      while (b < shown.length && (shown[b] === " " || shown[b] === "\t")) b++;
      shown = shown.slice(0, a) + GAP + shown.slice(b);
    }
    // Keep one space between words the paths sat between; nothing at a line's edge.
    shown = shown.replace(GAP_EDGE_RE, "").replace(GAP_RUN_RE, " ").trim();
  }
  return { text: shown || undefined, attachments: [...found.values()] };
}
