import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MB } from "../shared/baton";
import type { ProjectFileRow, ProjectFileStatus } from "../shared/project-files";
import { projectOverseerPaths } from "./project-overseer-store";
import { stateRoot } from "./state-root";

/**
 * Files people sent a project (§app/file-intake). The bytes are host-local, one folder per file:
 * `<stateRoot>/project-files/<projectId>/<fileId>/<name>` (folders 0700, files 0600, O_EXCL),
 * streamed to `.part` with a SHA-256, then linked into place. A staged upload's folder also holds
 * `.meta.json` until a message sends it; then its `received` line goes into the ledger,
 * `files.jsonl` in the project's overseer folder (appended only; the newest status wins), and the
 * file is linked into its gathering session's own view, `<projectId>/sessions/<sessionId>/<name>`:
 * the one folder `inspect_files` may read (server/baton-inspect.ts).
 */

export const FILE_ID_RE = /^f_[A-Za-z0-9_-]{16}$/;
const PROJECT_RE = /^[a-z0-9_]{1,40}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** A staged file no message sent is removed after this. */
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
export const FILES_PER_PERSON = 20;
export const BYTES_PER_PERSON = 200 * MB;
export const FILE_UPLOADS_PER_MINUTE = 10;
/** Room over the largest file setting the edge lets a request body have. */
export const FILE_BODY_SLACK = 64 * 1024;
export const NAME_MAX = 120;

export const filesRoot = () => join(stateRoot(), "project-files");

/** A refusal the routes answer as `{error, code}` with its status. */
export class FileRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429 | 507,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The host budget: env overrides only, never a setting. */
export function filesBudget(): { maxBytes: number; freeFloor: number } {
  const mb = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d) * MB;
  return { maxBytes: mb(process.env.SOVA_PROJECT_FILES_MAX_MB, 10 * 1024), freeFloor: mb(process.env.SOVA_PROJECT_FILES_FREE_MB, 2048) };
}

const projectRoot = (projectId: string): string => {
  if (!PROJECT_RE.test(projectId)) throw new FileRefusal(404, "not-found", "Unknown project.");
  return join(filesRoot(), projectId);
};
const fileDir = (projectId: string, id: string): string => {
  if (!FILE_ID_RE.test(id)) throw new FileRefusal(404, "not-found", "No such file.");
  return join(projectRoot(projectId), id);
};
/** The gathering session's own view: links to the files received in it, nothing else. */
export const sessionView = (projectId: string, sessionId: string): string => {
  if (!SESSION_RE.test(sessionId)) throw new Error("Bad session id");
  return join(projectRoot(projectId), "sessions", sessionId);
};
/** The ledger: in the project's overseer folder. `ledgerAt` lets tests point it elsewhere. */
let ledgerAt: ((projectId: string) => string) | null = null;
export const ledgerPath = (projectId: string): string => (ledgerAt ? ledgerAt(projectId) : join(projectOverseerPaths(projectId).dir, "files.jsonl"));
/** Tests: where the ledger lives (null: the project's overseer folder). */
export function setLedgerPathForTests(f: ((projectId: string) => string) | null): void {
  ledgerAt = f;
}

// ---- names and kinds --------------------------------------------------------------------------------

/**
 * The name a file is kept under: its last path segment, no control characters, no leading dots or
 * spaces, at most NAME_MAX characters keeping its extension; `file` when nothing is left. Pure.
 */
export function sanitizeName(raw: string): string {
  let n = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").trim();
  n = n.replace(/^[.\s]+/, "").trim();
  if (n.length > NAME_MAX) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    n = `${n.slice(0, NAME_MAX - ext.length).trimEnd()}${ext}`;
  }
  return n || "file";
}

/** `name`, or `name (2).ext`, `name (3).ext`, … : the first not in `taken`. Pure. */
export function dedupeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n)) return n;
  }
}

/** A label for what a file is, from its first bytes (and, for text, its name). Never a refusal. Pure. */
export function sniffKind(head: Buffer, name: string, whole?: Buffer): string {
  const at = (s: string, off = 0) => head.length >= off + s.length && head.toString("latin1", off, off + s.length) === s;
  if (at("PK\x03\x04") || at("PK\x05\x06")) return "zip archive";
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip archive";
  if (at("ustar", 257)) return "tar archive";
  if (at("%PDF-")) return "PDF document";
  if (at("\x89PNG\r\n\x1a\n")) return "PNG image";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "JPEG image";
  if (at("GIF87a") || at("GIF89a")) return "GIF image";
  if (at("RIFF") && at("WEBP", 8)) return "WebP image";
  if (at("7z\xbc\xaf\x27\x1c")) return "7z archive";
  if (at("\xfd7zXZ\x00")) return "xz archive";
  if (at("BZh")) return "bzip2 archive";
  if (at("SQLite format 3\x00")) return "SQLite database";
  if (head.includes(0)) return "binary file";
  // A head cut at 64 KB may end inside a character: those last bytes don't count.
  const text = (head.length >= 64 * 1024 ? head.subarray(0, head.length - 4) : head).toString("utf8");
  if (text.includes("\ufffd")) return "binary file";
  const t = text.trimStart();
  if ((t.startsWith("{") || t.startsWith("[")) && whole) {
    try {
      JSON.parse(whole.toString("utf8"));
      return "JSON";
    } catch {
      // not whole JSON: text
    }
  }
  if (/\.jsonl$/i.test(name) && t.startsWith("{")) return "JSON lines";
  if (/\.csv$/i.test(name)) return "CSV text";
  return "text";
}

/** "1.1 MB", "340 KB", "12 bytes". Pure. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

// ---- the ledger ----------------------------------------------------------------------------------

/** A received file as the ledger folds it. */
export interface FileRecord {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: string;
  sha256: string;
  personId: string;
  sessionId: string;
  at: string;
  status: ProjectFileStatus | "deleted";
  note?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Every file the ledger knows, oldest first, its newest status applied; malformed lines are skipped. */
export function readLedger(projectId: string, path = ledgerPath(projectId)): FileRecord[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = new Map<string, FileRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object" || !isStr(d.id) || !FILE_ID_RE.test(d.id)) continue;
    if (d.status === "received") {
      if (out.has(d.id) || !isStr(d.name) || typeof d.size !== "number" || !isStr(d.personId) || !isStr(d.sessionId) || !isStr(d.at)) continue;
      out.set(d.id, {
        id: d.id,
        name: d.name,
        size: d.size,
        type: isStr(d.type) ? d.type : "application/octet-stream",
        kind: isStr(d.kind) ? d.kind : "file",
        sha256: isStr(d.sha256) ? d.sha256 : "",
        personId: d.personId,
        sessionId: d.sessionId,
        at: d.at,
        status: "received",
      });
      continue;
    }
    const rec = out.get(d.id);
    if (!rec || rec.status === "deleted") continue;
    if (d.status === "confirmed" || d.status === "deleted") {
      rec.status = d.status;
      if (isStr(d.note)) rec.note = d.note;
    }
  }
  return [...out.values()];
}

function appendLedger(projectId: string, line: Record<string, unknown>): void {
  const path = ledgerPath(projectId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ v: 1, ...line })}\n`);
}

/** The project's files not deleted. */
export const liveFiles = (projectId: string): FileRecord[] => readLedger(projectId).filter((r) => r.status !== "deleted");

/** One live file of the project, or null. */
export function fileOf(projectId: string, id: string): FileRecord | null {
  return liveFiles(projectId).find((r) => r.id === id) ?? null;
}

/** Where a received file's bytes are on this host (they may not be: a restored org's ledger). */
export const bytesPath = (projectId: string, rec: Pick<FileRecord, "id" | "name">): string => join(fileDir(projectId, rec.id), rec.name);
export const bytesHere = (projectId: string, rec: Pick<FileRecord, "id" | "name">): boolean => {
  try {
    return statSync(bytesPath(projectId, rec)).isFile();
  } catch {
    return false;
  }
};

// ---- staging ---------------------------------------------------------------------------------------

/** The hidden sidecar of a staged upload. */
interface Staged {
  v: 1;
  id: string;
  name: string;
  size: number;
  type: string;
  kind: string;
  sha256: string;
  personId: string;
  sessionId: string;
  at: number;
}

function readStaged(projectId: string, id: string): Staged | null {
  try {
    const s = JSON.parse(readFileSync(join(fileDir(projectId, id), ".meta.json"), "utf8")) as Staged;
    return s && s.id === id && isStr(s.name) && typeof s.size === "number" && isStr(s.personId) && isStr(s.sessionId) && typeof s.at === "number" ? s : null;
  } catch {
    return null;
  }
}

/** Every staged upload of the project (folders with a sidecar and no ledger line). */
function stagedOf(projectId: string, known: ReadonlySet<string>): Staged[] {
  let names: string[] = [];
  try {
    names = readdirSync(projectRoot(projectId));
  } catch {
    return [];
  }
  return names.filter((n) => FILE_ID_RE.test(n) && !known.has(n)).flatMap((n) => readStaged(projectId, n) ?? []);
}

/** Names being written now, per session: two uploads at once never take the same name. */
const reserved = new Map<string, Set<string>>();

/** Bytes the files area holds (session views are links to the same files: not counted). */
export function filesBytes(root = filesRoot()): number {
  let total = 0;
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (depth === 1 && n === "sessions") continue;
      // A .part is an upload still streaming: its reservation counts it (reserveUpload).
      if (n === ".part") continue;
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (depth < 3) walk(p, depth + 1);
        } else total += st.size;
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(root, 0);
  return total;
}

function freeBytes(): number {
  try {
    const at = existsSync(filesRoot()) ? filesRoot() : stateRoot();
    const s = statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// ---- uploads in flight ------------------------------------------------------------------------------
// An upload's sidecar is written only once its bytes are in, so the checks below also count what is
// still streaming: each upload reserves its declared size and one file slot for its session and
// person, and its size in the host-wide total, until stageFile ends (success, refusal or abort).

const inflight = new Map<string, { files: number; bytes: number }>();
let inflightTotal = 0;
const inflightKey = (projectId: string, sessionId: string, personId: string) => `${projectId}/${sessionId}/${personId}`;

/** What this person has in flight in this session (tests, and the room check). */
export const inflightFor = (projectId: string, sessionId: string, personId: string): { files: number; bytes: number } => ({
  ...(inflight.get(inflightKey(projectId, sessionId, personId)) ?? { files: 0, bytes: 0 }),
});
/** Bytes in flight on this host. */
export const inflightBytes = (): number => inflightTotal;

/**
 * Check the person's room and the host budget for `bytes` more, counting every upload in flight,
 * and reserve them in the same synchronous step (so parallel uploads can't all pass). Returns the
 * release, which is idempotent.
 */
export function reserveUpload(projectId: string, sessionId: string, personId: string, bytes: number): () => void {
  assertPersonRoom(projectId, sessionId, personId, bytes);
  assertFilesBudget(bytes);
  const key = inflightKey(projectId, sessionId, personId);
  const cur = inflight.get(key) ?? { files: 0, bytes: 0 };
  inflight.set(key, { files: cur.files + 1, bytes: cur.bytes + bytes });
  inflightTotal += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = inflight.get(key);
    if (now) {
      const next = { files: now.files - 1, bytes: now.bytes - bytes };
      if (next.files <= 0) inflight.delete(key);
      else inflight.set(key, next);
    }
    inflightTotal = Math.max(0, inflightTotal - bytes);
  };
}

/** Refuse (507) when `incoming` more bytes would pass the host budget or the free-disk floor, uploads in flight included. */
export function assertFilesBudget(incoming: number, budget = filesBudget(), free = freeBytes(), held = filesBytes()): void {
  const pending = inflightTotal;
  if (held + pending + incoming > budget.maxBytes || free - pending - incoming < budget.freeFloor) throw new FileRefusal(507, "no-room", "Files can't be taken right now.");
}

/** What this person has in this session, staged, received and in flight: refused past 20 files or 200 MB. */
export function assertPersonRoom(projectId: string, sessionId: string, personId: string, incoming: number): void {
  const ledger = readLedger(projectId);
  const mine = [
    ...ledger.filter((r) => r.status !== "deleted" && r.sessionId === sessionId && r.personId === personId),
    ...stagedOf(projectId, new Set(ledger.map((r) => r.id))).filter((s) => s.sessionId === sessionId && s.personId === personId),
  ];
  const flying = inflight.get(inflightKey(projectId, sessionId, personId)) ?? { files: 0, bytes: 0 };
  const bytes = mine.reduce((n, r) => n + r.size, 0) + flying.bytes;
  if (mine.length + flying.files >= FILES_PER_PERSON || bytes + incoming > BYTES_PER_PERSON) throw new FileRefusal(409, "file-limit", "You've sent the most files this conversation takes.");
}

const perMinute = new Map<string, number[]>();
/** Count an upload for `key` (a link's token hash); 429 past FILE_UPLOADS_PER_MINUTE. */
export function countFileUpload(key: string, now = Date.now()): void {
  for (const [k, v] of perMinute) if (k !== key && !v.some((t) => now - t < 60_000)) perMinute.delete(k);
  const recent = (perMinute.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= FILE_UPLOADS_PER_MINUTE) {
    perMinute.set(key, recent);
    throw new FileRefusal(429, "rate-limited", "Too many files. Wait a minute.");
  }
  recent.push(now);
  perMinute.set(key, recent);
}
export const resetFileUploadWindow = (): void => perMinute.clear();

export interface StageFileInput {
  projectId: string;
  sessionId: string;
  personId: string;
  /** The name the page sent (already decoded); sanitized here. */
  name: string;
  /** The declared type, or "". */
  type: string;
  body: AsyncIterable<Uint8Array> | null;
  /** This host's largest file. */
  maxBytes: number;
  now?: number;
  /** The upload's reservation (reserveUpload): released when this ends, whatever the outcome. */
  release?: () => void;
}

const mkdir700 = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });

/**
 * Stream an upload into its own folder: counted while it streams (413 past `maxBytes`, nothing left
 * behind), hashed, linked into place under its kept name, labelled, its sidecar written.
 */
export async function stageFile(input: StageFileInput): Promise<{ id: string; name: string; size: number; kind: string }> {
  try {
    return await stageFileOnce(input);
  } finally {
    // Its sidecar (or nothing) is on disk now: the reservation goes, on success, refusal or abort.
    input.release?.();
  }
}

async function stageFileOnce(input: StageFileInput): Promise<{ id: string; name: string; size: number; kind: string }> {
  ensureFilesSweep();
  if (!input.body) throw new FileRefusal(400, "bad-request", "No file was sent.");
  if (!SESSION_RE.test(input.sessionId)) throw new FileRefusal(404, "not-found", "Unknown conversation.");
  const ledger = readLedger(input.projectId);
  const sessionKey = `${input.projectId}/${input.sessionId}`;
  const held = reserved.get(sessionKey) ?? new Set<string>();
  const taken = new Set<string>([
    ...ledger.filter((r) => r.sessionId === input.sessionId && r.status !== "deleted").map((r) => r.name),
    ...stagedOf(input.projectId, new Set(ledger.map((r) => r.id))).filter((s) => s.sessionId === input.sessionId).map((s) => s.name),
    ...held,
  ]);
  const name = dedupeName(sanitizeName(input.name), taken);
  held.add(name);
  reserved.set(sessionKey, held);
  const id = `f_${randomBytes(12).toString("base64url")}`;
  const dir = fileDir(input.projectId, id);
  mkdir700(dirname(dir));
  mkdirSync(dir, { mode: 0o700 });
  const part = join(dir, ".part");
  const hash = createHash("sha256");
  let size = 0;
  let ok = false;
  try {
    const fh = await open(part, "wx", 0o600);
    try {
      for await (const chunk of input.body) {
        size += chunk.length;
        if (size > input.maxBytes) throw new FileRefusal(413, "too-large", `Over ${Math.round(input.maxBytes / MB)} MB.`);
        hash.update(chunk);
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }
    const final = join(dir, name);
    linkSync(part, final);
    await unlink(part);
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    const fd = openSync(final, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const t = head.toString("utf8").trimStart();
    const kind = sniffKind(head, name, (t.startsWith("{") || t.startsWith("[")) && size <= 32 * MB ? readFileSync(final) : undefined);
    const type = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.type) ? input.type.toLowerCase() : "application/octet-stream";
    const side: Staged = { v: 1, id, name, size, type, kind, sha256: hash.digest("hex"), personId: input.personId, sessionId: input.sessionId, at: input.now ?? Date.now() };
    writeFileSync(join(dir, ".meta.json"), JSON.stringify(side), { flag: "wx", mode: 0o600 });
    ok = true;
    return { id, name, size, kind };
  } finally {
    held.delete(name);
    if (!held.size) reserved.delete(sessionKey);
    if (!ok) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The staged files `ids` of this person in this session, in order, for a message that sends them.
 * Any id that is not theirs, not staged here or too old is a 409 `file-expired` (the page uploads it
 * again); a repeated id is a 400. Nothing changes: `receiveFiles` does that once the runtime took
 * the message.
 */
export function takeStagedFiles(projectId: string, sessionId: string, personId: string, ids: readonly string[], now = Date.now()): FileRecord[] {
  if (new Set(ids).size !== ids.length) throw new FileRefusal(400, "bad-request", "A file is listed twice.");
  const known = new Set(readLedger(projectId).map((r) => r.id));
  return ids.map((id) => {
    const s = FILE_ID_RE.test(id) && !known.has(id) ? readStaged(projectId, id) : null;
    if (!s || s.sessionId !== sessionId || s.personId !== personId || now - s.at > STAGED_TTL_MS || !existsSync(join(fileDir(projectId, id), s.name)))
      throw new FileRefusal(409, "file-expired", "A file needs to be uploaded again.");
    return { id, name: s.name, size: s.size, type: s.type, kind: s.kind, sha256: s.sha256, personId, sessionId, at: new Date(now).toISOString(), status: "received" as const };
  });
}

/** The message carrying them was taken: each file's `received` line, its link in the session's view. */
export function receiveFiles(projectId: string, files: readonly FileRecord[]): void {
  for (const f of files) {
    appendLedger(projectId, { id: f.id, name: f.name, size: f.size, type: f.type, kind: f.kind, sha256: f.sha256, personId: f.personId, sessionId: f.sessionId, at: f.at, status: "received" });
    try {
      const view = sessionView(projectId, f.sessionId);
      mkdir700(view);
      linkSync(bytesPath(projectId, f), join(view, f.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") console.warn(`[project-files] linking ${f.id} into its session's view failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      unlinkSync(join(fileDir(projectId, f.id), ".meta.json"));
    } catch {
      // already gone
    }
  }
}

/** The transcript line a received file adds to the person's message (§app.baton/files). */
export const fileLine = (sender: string, f: Pick<FileRecord, "id" | "name" | "size" | "kind">): string => `[${sender} sent ${f.name} (${sizeWords(f.size)}, ${f.kind}) · file ${f.id}]`;
/** A line `fileLine` wrote: its id. */
export const FILE_LINE_RE = /^\[.+ · file (f_[A-Za-z0-9_-]{16})\]$/;

/** The model's confirm_file: a live file of this session gets a `confirmed` line. */
export function confirmFile(projectId: string, sessionId: string, id: string, note?: string, now = Date.now()): FileRecord {
  const rec = fileOf(projectId, id);
  if (!rec || rec.sessionId !== sessionId) throw new FileRefusal(404, "not-found", `No file ${id} in this conversation.`);
  const n = typeof note === "string" ? note.trim().slice(0, 500) : "";
  appendLedger(projectId, { id, status: "confirmed", at: new Date(now).toISOString(), by: "model", ...(n ? { note: n } : {}) });
  return { ...rec, status: "confirmed", ...(n ? { note: n } : {}) };
}

/** The operator's delete: the `deleted` line, then the bytes and the view's link go. */
export function deleteFile(projectId: string, id: string, by: "operator" | "overseer", now = Date.now()): FileRecord {
  const rec = fileOf(projectId, id);
  if (!rec) throw new FileRefusal(404, "not-found", "No such file.");
  appendLedger(projectId, { id, status: "deleted", at: new Date(now).toISOString(), by });
  rmSync(fileDir(projectId, id), { recursive: true, force: true });
  try {
    const link = join(sessionView(projectId, rec.sessionId), rec.name);
    if (existsSync(link)) unlinkSync(link);
  } catch {
    // no view
  }
  return { ...rec, status: "deleted" };
}

/** The project's files as the Files card and sova_files list them, newest first. */
export function fileRows(projectId: string, sender: (r: FileRecord) => string, gathering: (sessionId: string) => string | null): ProjectFileRow[] {
  return liveFiles(projectId)
    .reverse()
    .map((r) => {
      const title = gathering(r.sessionId);
      return {
        id: r.id,
        name: r.name,
        size: r.size,
        kind: r.kind,
        sender: sender(r),
        gathering: title === null ? null : { sessionId: r.sessionId, title },
        at: r.at,
        status: r.status === "confirmed" ? "confirmed" : "received",
        here: bytesHere(projectId, r),
      };
    });
}

// ---- the sweep ----------------------------------------------------------------------------------

/**
 * Staged uploads older than 24 hours, or whose session is no longer open, and a folder left with
 * no sidecar and no ledger line (a crash mid-upload) after an hour, go. Received files are never
 * swept.
 */
export function sweepFiles(now = Date.now(), open: (sessionId: string) => boolean = () => true, root = filesRoot()): number {
  let removed = 0;
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return 0;
  }
  for (const pid of projects) {
    if (!PROJECT_RE.test(pid)) continue;
    let known: Set<string>;
    try {
      known = new Set(readLedger(pid).map((r) => r.id));
    } catch {
      continue; // the project isn't registered here now: leave it
    }
    let names: string[] = [];
    try {
      names = readdirSync(join(root, pid));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!FILE_ID_RE.test(n) || known.has(n)) continue;
      const dir = join(root, pid, n);
      const s = readStaged(pid, n);
      let old = false;
      if (s) old = now - s.at > STAGED_TTL_MS || !open(s.sessionId);
      else
        try {
          old = now - statSync(dir).mtimeMs > 60 * 60 * 1000;
        } catch {
          old = false;
        }
      if (old) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

let sessionOpen: (sessionId: string) => boolean = () => true;
/** The baton layer says which sessions are open (set once by server/baton-files.ts). */
export function setFilesSessionOpen(f: (sessionId: string) => boolean): void {
  sessionOpen = f;
}

let sweeper: NodeJS.Timeout | null = null;
/** Start the ten-minute sweep once per process (it runs once at start too). */
export function ensureFilesSweep(): void {
  if (sweeper) return;
  const run = () => {
    try {
      sweepFiles(Date.now(), sessionOpen);
    } catch (err) {
      console.warn(`[project-files] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  sweeper = setInterval(run, 10 * 60 * 1000);
  sweeper.unref();
  setTimeout(run, 0).unref();
}
