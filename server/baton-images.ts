import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PHOTO_TYPES, type BatonPhotoSettings, type BatonSession } from "../shared/baton";
import { findTmpImagePaths } from "../shared/tmp-paths";
import { sessionAttachmentsDir, sniffImageMime } from "./attachments";
import { batonById, sessionPathOf } from "./baton";
import { readBatonSettings } from "./baton-settings";
import { getModelRuntime, heldChat } from "./chat-manager";
import { stateRoot } from "./state-root";
import { readActiveBranch } from "./transcript";
import { loadDefaults } from "./web-defaults";

/**
 * A person's photos in a gathering chat (§app.baton/images): the host-local staging area a photo
 * waits in between its upload and the message that sends it, the metadata backstop, the host
 * budget, and whether a session can take photos at all (photos on, and its model sees images).
 *
 * Staged photos live under `<stateRoot>/baton-uploads/<sessionId>/` (0700; files 0600, written
 * O_EXCL): `<id>.<ext>` and its sidecar `<id>.json`. Never in the workspace repo. A sent photo's
 * bytes then live inline in the session file, as image content.
 */

type ImageType = (typeof PHOTO_TYPES)[number];
export interface SdkImage {
  type: "image";
  data: string;
  mimeType: string;
}

export const uploadsRoot = () => join(stateRoot(), "baton-uploads");
const EXT: Record<ImageType, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const ID_RE = /^im_[A-Za-z0-9_-]{16}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** A staged photo is kept this long unless it is sent first. */
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_PER_MINUTE = 20;
/** Room over the largest photo setting the edge lets a request body have (it never knows this host's setting). */
export const UPLOAD_BODY_SLACK = 64 * 1024;

/** The host budget (§app.baton/images): env overrides only, never a setting. */
export function hostBudget(): { maxBytes: number; freeFloor: number } {
  const mb = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d) * 1024 * 1024;
  return { maxBytes: mb(process.env.SOVA_BATON_UPLOADS_MAX_MB, 500), freeFloor: mb(process.env.SOVA_BATON_UPLOADS_FREE_MB, 2048) };
}

/** A refusal the routes answer as `{error, code}` with its status. */
export class PhotoRefusal extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 429 | 507,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isPhotoType = (v: string): v is ImageType => (PHOTO_TYPES as readonly string[]).includes(v);

// ---- metadata -------------------------------------------------------------------------------------

/**
 * The image without the metadata segments that can carry a location, a device or text: JPEG APP1
 * (Exif, XMP), APP13 (IPTC) and comments; PNG eXIf and text chunks; WebP EXIF and XMP chunks (the
 * RIFF size and the VP8X flags fixed). GIF passes as it is. Null when the file doesn't parse as
 * its type (the caller refuses it). Everything else is copied byte for byte, so it still decodes.
 */
export function stripImageMetadata(buf: Buffer, mime: string): Buffer | null {
  if (mime === "image/jpeg") return stripJpeg(buf);
  if (mime === "image/png") return stripPng(buf);
  if (mime === "image/webp") return stripWebp(buf);
  if (mime === "image/gif") return buf;
  return null;
}

function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    // Fill bytes before a marker.
    while (m === 0xff && i + 2 < b.length) {
      i++;
      m = b[i + 1];
    }
    if (m === undefined) return null;
    // Standalone markers: TEM, RST0-7, EOI.
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (m === 0xd9) {
      out.push(b.subarray(i, i + 2));
      break;
    }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const seg = b.subarray(i, i + 2 + len);
    // Start of scan: the entropy-coded data and everything after it pass as they are.
    if (m === 0xda) {
      out.push(b.subarray(i));
      break;
    }
    if (m !== 0xe1 && m !== 0xed && m !== 0xfe) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);
function stripPng(b: Buffer): Buffer | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  while (i < b.length) {
    if (i + 12 > b.length) return null;
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunks: Buffer[] = [];
  let i = 12;
  while (i < b.length) {
    if (i + 8 > b.length) return null;
    const type = b.toString("latin1", i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) return null;
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      // VP8X flags: bit 3 EXIF, bit 2 XMP. Their chunks are gone.
      if (type === "VP8X" && len >= 1) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

// ---- rate and budget ------------------------------------------------------------------------------

const perMinute = new Map<string, number[]>();
const perDay = new Map<string, number[]>();

/** Count an upload for `key` (a link's token hash); a refusal when it is over either window. */
export function countUpload(key: string, perConversation: number, now = Date.now()): void {
  const prune = (m: Map<string, number[]>, window: number) => {
    for (const [k, v] of m) if (k !== key && !v.some((t) => now - t < window)) m.delete(k);
    return (m.get(key) ?? []).filter((t) => now - t < window);
  };
  const minute = prune(perMinute, 60_000);
  const day = prune(perDay, 86_400_000);
  if (minute.length >= UPLOADS_PER_MINUTE) {
    perMinute.set(key, minute);
    throw new PhotoRefusal(429, "rate-limited", "Too many photos. Wait a minute.");
  }
  if (day.length >= 3 * perConversation) {
    perDay.set(key, day);
    throw new PhotoRefusal(429, "rate-limited", "Too many photos today on this link.");
  }
  minute.push(now);
  day.push(now);
  perMinute.set(key, minute);
  perDay.set(key, day);
}

/** Forget the upload windows (tests). */
export function resetUploadWindows(): void {
  perMinute.clear();
  perDay.clear();
}

/** Bytes the staging area holds now. */
export function stagingBytes(root = uploadsRoot()): number {
  let total = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    try {
      for (const f of readdirSync(join(root, d))) total += statSync(join(root, d, f)).size;
    } catch {
      // gone meanwhile
    }
  }
  return total;
}

function freeBytes(): number {
  try {
    const at = existsSync(uploadsRoot()) ? uploadsRoot() : stateRoot();
    const s = statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Refuse (507) when `incoming` more bytes would pass the host budget or the free-disk floor. */
export function assertBudget(incoming: number, budget = hostBudget(), free = freeBytes(), held = stagingBytes()): void {
  if (held + incoming > budget.maxBytes || free - incoming < budget.freeFloor) throw new PhotoRefusal(507, "no-room", "Photos can't be taken right now.");
}

// ---- staging --------------------------------------------------------------------------------------

interface Sidecar {
  sessionId: string;
  personId: string;
  at: number;
  size: number;
  mime: ImageType;
}

const sessionDir = (sessionId: string): string => {
  if (!SESSION_RE.test(sessionId)) throw new Error("Bad session id");
  return join(uploadsRoot(), sessionId);
};

export interface StageInput {
  sessionId: string;
  personId: string;
  /** The declared type (Content-Type). */
  mime: string;
  body: AsyncIterable<Uint8Array> | null;
  /** This host's largest photo. */
  maxBytes: number;
  now?: number;
}

/**
 * Stream an upload into the staging area: counted while it streams (413 past `maxBytes`, nothing
 * left behind), its magic bytes checked against the declared type (400), its metadata stripped,
 * then kept as `<id>.<ext>` with its sidecar. Returns the id.
 */
export async function stagePhoto(input: StageInput): Promise<{ id: string; size: number; mime: ImageType }> {
  ensureSweep();
  if (!isPhotoType(input.mime)) throw new PhotoRefusal(400, "bad-type", "This photo's format can't be sent.");
  if (!input.body) throw new PhotoRefusal(400, "bad-request", "No photo was sent.");
  const dir = sessionDir(input.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `im_${randomBytes(12).toString("base64url")}`;
  const part = join(dir, `.${id}.part`);
  const fh = await open(part, "wx", 0o600);
  let size = 0;
  let ok = false;
  try {
    for await (const chunk of input.body) {
      size += chunk.length;
      if (size > input.maxBytes) throw new PhotoRefusal(413, "too-large", `Over ${Math.round(input.maxBytes / (1024 * 1024))} MB.`);
      await fh.write(chunk);
    }
    ok = true;
  } finally {
    await fh.close();
    if (!ok) await unlink(part).catch(() => {});
  }
  try {
    const raw = await readFile(part);
    if (sniffImageMime(raw) !== input.mime) throw new PhotoRefusal(400, "bad-type", "This photo's format can't be sent.");
    const clean = stripImageMetadata(raw, input.mime);
    if (!clean) throw new PhotoRefusal(400, "bad-type", "This photo's format can't be sent.");
    writeFileSync(join(dir, `${id}${EXT[input.mime]}`), clean, { flag: "wx", mode: 0o600 });
    const side: Sidecar = { sessionId: input.sessionId, personId: input.personId, at: input.now ?? Date.now(), size: clean.length, mime: input.mime };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(side), { flag: "wx", mode: 0o600 });
    return { id, size: clean.length, mime: input.mime };
  } finally {
    await unlink(part).catch(() => {});
  }
}

function readSidecar(dir: string, id: string): Sidecar | null {
  try {
    const s = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as Sidecar;
    return typeof s?.sessionId === "string" && typeof s.personId === "string" && typeof s.at === "number" && isPhotoType(String(s.mime)) ? s : null;
  } catch {
    return null;
  }
}

/**
 * The staged photos `ids` of this person in this session, as image content, in order. Any id that
 * is not theirs, not here or too old is a 409 `photo-expired` (the page uploads it again); a
 * repeated id is a 400. Nothing is removed: `dropStaged` does that once the runtime took them.
 */
export function takeStaged(sessionId: string, personId: string, ids: readonly unknown[], now = Date.now()): SdkImage[] {
  if (new Set(ids).size !== ids.length) throw new PhotoRefusal(400, "bad-request", "A photo is listed twice.");
  const dir = sessionDir(sessionId);
  return ids.map((id) => {
    const side = typeof id === "string" && ID_RE.test(id) ? readSidecar(dir, id) : null;
    if (!side || side.sessionId !== sessionId || side.personId !== personId || now - side.at > STAGED_TTL_MS)
      throw new PhotoRefusal(409, "photo-expired", "A photo needs to be uploaded again.");
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, `${id as string}${EXT[side.mime]}`));
    } catch {
      throw new PhotoRefusal(409, "photo-expired", "A photo needs to be uploaded again.");
    }
    return { type: "image" as const, data: bytes.toString("base64"), mimeType: side.mime };
  });
}

/** Remove staged photos (sent, or given up on). */
export function dropStaged(sessionId: string, ids: readonly string[]): void {
  let dir: string;
  try {
    dir = sessionDir(sessionId);
  } catch {
    return;
  }
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const side = readSidecar(dir, id);
    for (const f of [`${id}.json`, ...(side ? [`${id}${EXT[side.mime]}`] : Object.values(EXT).map((e) => `${id}${e}`))]) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // already gone
      }
    }
  }
}

/**
 * The sweep: staged photos older than 24 hours, leftover parts older than an hour, and every
 * photo of a session that is closed, done or no longer registered here, go. Empty folders go too.
 */
export function sweepUploads(now = Date.now(), root = uploadsRoot(), open = (sessionId: string) => {
  const s = batonById(sessionId)?.row.state;
  return s === "open" || s === "needs-you";
}): number {
  let removed = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    const dir = join(root, d);
    if (!open(d)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      const full = join(dir, f);
      try {
        const st = statSync(full);
        const old = f.endsWith(".part") ? now - st.mtimeMs > 60 * 60 * 1000 : now - st.mtimeMs > STAGED_TTL_MS;
        if (old) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        // gone meanwhile
      }
    }
    try {
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
  }
  return removed;
}

let sweeper: NodeJS.Timeout | null = null;
/** Start the ten-minute sweep once per process (it runs once at start too). */
export function ensureSweep(): void {
  if (sweeper) return;
  const run = () => {
    try {
      sweepUploads();
    } catch (err) {
      console.warn(`[baton-images] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  sweeper = setInterval(run, 10 * 60 * 1000);
  sweeper.unref();
  setTimeout(run, 0).unref();
}

// ---- can this session take photos? ----------------------------------------------------------------

type Entry = Record<string, any>;

/** The last model the branch recorded, as "provider/id". */
export function branchModelRef(branch: readonly Entry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") return `${e.provider}/${e.modelId}`;
    if (e?.type === "message" && e.message?.role === "assistant" && typeof e.message.provider === "string" && typeof e.message.model === "string")
      return `${e.message.provider}/${e.message.model}`;
  }
  return null;
}

/**
 * Whether the session's current model sees images (its `input` lists "image"): the open runtime's
 * model, else the one its file last recorded, else the row's or the new-session default. Unknown
 * is no.
 */
export async function sessionSeesImages(row: BatonSession, dir: string, branch?: readonly Entry[]): Promise<boolean> {
  const path = sessionPathOf(dir, row);
  const held = heldChat(path);
  const model = held?.session.model;
  if (model) return Array.isArray(model.input) && model.input.includes("image");
  const b = branch ?? ((await readActiveBranch(path).catch(() => [])) as Entry[]);
  const ref = branchModelRef(b) ?? row.model ?? loadDefaults().model ?? null;
  if (!ref) return false;
  const slash = ref.indexOf("/");
  if (slash <= 0) return false;
  try {
    const m = (await getModelRuntime()).getModel(ref.slice(0, slash), ref.slice(slash + 1));
    return !!m && Array.isArray(m.input) && m.input.includes("image");
  } catch {
    return false;
  }
}

/** What a writing link may send now: the photo limits, or null (photos off, or a model without vision). */
export async function photosFor(row: BatonSession, dir: string, settings: BatonPhotoSettings = readBatonSettings().photos, branch?: readonly Entry[]): Promise<BatonPhotoSettings | null> {
  if (!settings.enabled) return null;
  return (await sessionSeesImages(row, dir, branch)) ? settings : null;
}

/** The photos the conversation holds: image blocks in its user messages. */
export function photoCount(branch: readonly Entry[]): number {
  let n = 0;
  for (const e of branch)
    if (e?.type === "message" && e.message?.role === "user" && Array.isArray(e.message.content)) n += e.message.content.filter((b: any) => b?.type === "image").length;
  return n;
}

// ---- the operator's own images in a baton session ---------------------------------------------------

/**
 * The operator's composer names an attached image by its path in the session's attachments folder
 * (§chat/images). A gathering model has no `read` tool, and the path would reach the share page as
 * text, so each such path (directly in THIS session's folder, one of the four types by its bytes)
 * becomes image content and leaves the text; a line left empty goes too. Every other path stays text.
 */
export function inlineOperatorImages(sessionId: string, text: string): { text: string; images: SdkImage[] } {
  const own = sessionAttachmentsDir(sessionId);
  const found = own ? findTmpImagePaths(text) : [];
  if (!found.length) return { text, images: [] };
  let root: string;
  try {
    root = realpathSync(own!);
  } catch {
    return { text, images: [] };
  }
  const images: SdkImage[] = [];
  const cut: { start: number; end: number }[] = [];
  for (const m of found) {
    try {
      const real = realpathSync(m.path);
      if (dirname(real) !== root) continue;
      const bytes = readFileSync(real);
      const mime = sniffImageMime(bytes);
      if (!mime || !isPhotoType(mime)) continue;
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
      cut.push(m);
    } catch {
      // gone or unreadable: the path stays text
    }
  }
  if (!cut.length) return { text, images: [] };
  // Each taken path becomes a marker; a line that held only markers goes, the rest keep their text.
  const MARK = "\u0000";
  let marked = "";
  let at = 0;
  for (const c of cut) {
    marked += text.slice(at, c.start) + MARK;
    at = c.end;
  }
  marked += text.slice(at);
  const kept = marked.split("\n").flatMap((l) => (l.includes(MARK) && !l.split(MARK).join("").trim() ? [] : [l.split(MARK).join("")]));
  return { text: kept.join("\n").trim(), images };
}
