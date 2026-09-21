import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkTmpImage } from "./attachments";

/**
 * Persistent composer drafts, keyed by session id (GET/PUT /api/sessions/draft). A draft on a
 * session with no user message yet is also what keeps that session in the list
 * (SessionSummary.draftPreview): without one, a never-sent new session is a hidden husk.
 * Pending images ride along as `attachments`: files already uploaded into the session's
 * attachments folder (server/attachments.ts), so a reload keeps the screenshot with the text.
 */
const FILE = join(getAgentDir(), "pi-web", "drafts.json");
const PREVIEW_MAX = 80; // the sidebar title cap (sessions-index TITLE_MAX)
/** Same as a transcript row's cap (MAX_ATTACHMENTS_PER_ROW): more could never show after the send. */
export const MAX_DRAFT_ATTACHMENTS = 8;

/** One pending image: the upload's own result (POST /api/upload?draft=). */
export interface DraftAttachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Draft {
  text: string;
  /** ISO time of the last write. */
  updatedAt: string;
  /** Absent on disk when there are none. */
  attachments?: DraftAttachment[];
}

/** A display label for a chip: the client's own name when it looks like one (that is what the
    composer showed the user), else the file's name on disk. Never a path, never unbounded, never
    control characters — the label is only ever rendered, but it comes from the browser. */
function labelOf(raw: unknown, path: string): string {
  const fallback = basename(path);
  if (typeof raw !== "string") return fallback;
  const t = raw.replace(/\s+/g, " ").trim();
  return t && t.length <= 120 && !t.includes("/") && !/[\u0000-\u001f\u007f]/.test(t) ? t : fallback;
}

/** Keep only well-formed entries whose path passes the image check at write time (in /tmp or an
    attachments folder, a regular image file ≤ 20MB), deduplicated, capped; the rest are dropped
    silently, so one stale chip never costs the user the draft. mimeType and size come from the
    file itself, never from the client; `name` keeps the client's label (see labelOf). */
export function cleanAttachments(raw: unknown): DraftAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftAttachment[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length >= MAX_DRAFT_ATTACHMENTS) break;
    const e = a as Partial<DraftAttachment> | null;
    if (!e || typeof e !== "object" || typeof e.path !== "string" || seen.has(e.path)) continue;
    const check = checkTmpImage(e.path);
    if (!check.ok) continue;
    seen.add(e.path);
    out.push({ path: e.path, name: labelOf(e.name, e.path), mimeType: check.mimeType, size: check.size });
  }
  return out;
}

/** Shape-only filter for what is read back from disk (no fs: listings read every draft). */
function wellFormed(raw: unknown): DraftAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is DraftAttachment => !!a && typeof a.path === "string" && typeof a.name === "string" && typeof a.mimeType === "string" && typeof a.size === "number")
    .slice(0, MAX_DRAFT_ATTACHMENTS)
    .map(({ path, name, mimeType, size }) => ({ path, name, mimeType, size }));
}

function load(): Record<string, Draft> {
  // No prototype: an id is a file-name fragment, and "__proto__" must stay a plain key.
  const out: Record<string, Draft> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    const drafts: unknown = v?.drafts;
    if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return out;
    // Keep only well-formed entries: one bad value must not cost the user every other draft.
    for (const [id, d] of Object.entries(drafts as Record<string, unknown>)) {
      const e = d as Partial<Draft> | null;
      if (!e || typeof e.text !== "string" || typeof e.updatedAt !== "string") continue;
      const attachments = wellFormed(e.attachments);
      out[id] = { text: e.text, updatedAt: e.updatedAt, ...(attachments.length ? { attachments } : {}) };
    }
  } catch {
    // missing or corrupt: start empty
  }
  return out;
}

let drafts = load();

/** Atomic (tmp + rename), then the in-memory map is refreshed to what was written. */
function save(next: Record<string, Draft>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, drafts: next }));
  renameSync(tmp, FILE);
  drafts = next;
}

/** Every stored draft. Reads the file, so a listing sees another server instance's writes. */
export function readDrafts(): Record<string, Draft> {
  drafts = load();
  return drafts;
}

export function getDraft(id: string): Draft | null {
  drafts = load();
  return drafts[id] ?? null;
}

/** GET /api/sessions/draft's body: nulls and [] when none. An image whose file is gone (deleted,
    or /tmp cleaned) is no longer part of the draft, so it is left out. */
export function draftForClient(id: string): { text: string | null; attachments: DraftAttachment[]; updatedAt: string | null } {
  const d = getDraft(id);
  const attachments = (d?.attachments ?? []).filter((a) => checkTmpImage(a.path).ok);
  return { text: d?.text ?? null, attachments, updatedAt: d?.updatedAt ?? null };
}

/**
 * Store one session's draft; blank text with no (valid) attachments deletes it (a cleared
 * composer leaves nothing behind). Attachments go through cleanAttachments. Same rules as
 * web-sessions.ts: re-read the file and change only this id, so drafts written by another
 * server instance survive. A removed attachment's file is not deleted here: the client deletes
 * a chip's file itself (DELETE /api/attachment), and a sent draft's files must stay, since the
 * prompt names them and the transcript renders them.
 */
export function setDraft(id: string, text: string, rawAttachments?: unknown): void {
  const next = load();
  const attachments = cleanAttachments(rawAttachments);
  if (text.trim() || attachments.length) next[id] = { text, updatedAt: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) };
  else if (id in next) delete next[id];
  else {
    drafts = next; // absent already: nothing to write
    return;
  }
  save(next);
}

/** Drop the drafts of deleted sessions; same write rules as setDraft. */
export function dropDrafts(ids: string[]): void {
  const next = load();
  let changed = false;
  for (const id of ids) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) save(next);
  else drafts = next;
}

/** The sidebar line for a draft: its first non-empty line, capped like a session title; an
    images-only draft reads "1 image" / "N images". */
export function draftPreview(text: string, attachments: readonly unknown[] = []): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = line.replace(/\s+/g, " ").trim();
  if (!t && attachments.length) return attachments.length === 1 ? "1 image" : `${attachments.length} images`;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}
