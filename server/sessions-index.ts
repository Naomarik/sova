import { statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionSummary } from "../shared/protocol";
import { type LiveRecord, readLive, readOwnLiveRecords, workerCountsOf } from "./live";
import { LIVE_DIR, SESSIONS_DIR } from "./paths";
import { isWebSession } from "./web-sessions";
import { isArchived, setArchived } from "./archived-sessions";
import { isSessionBusy } from "./chat-manager";

type BaseSummary = Omit<SessionSummary, "live" | "workers" | "origin" | "archived" | "busy">;

const CHUNK = 16 * 1024;
const MAX_HEAD = 256 * 1024;
const MAX_TAIL = 256 * 1024;
const TITLE_MAX = 80;

const cache = new Map<string, { mtimeMs: number; size: number; summary: BaseSummary }>();

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const b of content) if (b?.type === "text" && typeof b.text === "string") return b.text;
  }
  return "";
}

/** Best-effort title from a user message line cut off by the read cap (huge pastes). */
function titleFromPartial(line: string): string | null {
  if (!/"type":"message"/.test(line) || !/"role":"user"/.test(line)) return null;
  const m = /"(?:content|text)":"((?:[^"\\]|\\.){1,400})/.exec(line);
  if (!m?.[1]) return null;
  let s = m[1];
  // drop a dangling escape so JSON.parse can decode the fragment
  for (let i = 0; i < 6; i++) {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      s = s.slice(0, -1);
    }
  }
  return null;
}

/** "provider/model" of a model_change or assistant message entry, else null. */
function modelOf(e: any): string | null {
  if (e?.type === "model_change" && e.provider && e.modelId) return `${e.provider}/${e.modelId}`;
  const msg = e?.type === "message" ? e.message : null;
  if (msg?.role === "assistant" && msg.provider && msg.model) return `${msg.provider}/${msg.model}`;
  return null;
}

const NL = 0x0a;

/**
 * The latest model in the file: scans backwards from EOF in 16KB chunks (cap 256KB) and returns
 * the model of the line closest to EOF that is a model_change or an assistant message with one.
 * Lines cut off by the cap or torn by a writer mid-append are skipped. Not branch-aware (the file
 * end wins), unlike the transcript's per-message resolution. null when the window has none.
 */
async function readTailModel(path: string, size: number): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const floor = Math.max(0, size - MAX_TAIL);
    let end = size;
    let carry = Buffer.alloc(0); // bytes after the first newline seen so far: a line's start is still unread
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
      if (bytesRead < chunk.length) return null; // truncated under us: the next request retries
      end = start;
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // Complete lines are those after a newline in this buffer (or all of it at BOF).
      let stop = buf.length;
      for (;;) {
        const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
        if (i < 0 && start > 0) break; // line start not read yet: carry it into the next chunk
        const line = buf.subarray(i + 1, stop);
        if (line.includes('"model_change"') || line.includes('"assistant"')) {
          try {
            const m = modelOf(JSON.parse(line.toString("utf-8")));
            if (m) return m;
          } catch {
            // torn trailing line or not JSON: skip
          }
        }
        if (i < 0) return null;
        stop = i;
      }
      carry = buf.subarray(0, stop);
    }
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Read only the head of a session file: header, first model_change, first user message.
 * Reads 16KB chunks and stops as soon as the first user message is seen (cap 256KB).
 * The model here is only the fallback for when readTailModel finds none near EOF.
 */
async function readHead(path: string): Promise<{ header: any; title: string | null; model: string | null } | null> {
  const fh = await open(path, "r");
  try {
    let header: any = null;
    let title: string | null = null;
    let model: string | null = null;
    let pending = "";
    let pos = 0;
    const buf = Buffer.alloc(CHUNK);
    const decoder = new TextDecoder("utf-8");
    while (pos < MAX_HEAD) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      pending += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (!header) {
          if (e?.type !== "session") return null; // not a pi session
          header = e;
          continue;
        }
        if (e.type === "model_change" && !model && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
        if (e.type === "message") {
          const msg = e.message ?? {};
          if (!model && msg.role === "assistant" && msg.provider && msg.model) model = `${msg.provider}/${msg.model}`;
          if (msg.role === "user" && title === null) title = oneLine(userText(msg.content));
        }
        if (title !== null && model) return { header, title, model };
      }
      // Stop at the first user message even without a model: model_change precedes it.
      if (title !== null) return { header, title, model };
    }
    if (pending.trim() && title === null) {
      if (pos < MAX_HEAD) {
        // EOF: final line without trailing newline (or a writer mid-append)
        try {
          const e = JSON.parse(pending);
          if (!header && e?.type === "session") header = e;
          else if (header && e?.type === "message" && e.message?.role === "user") title = oneLine(userText(e.message.content));
        } catch {
          // partial line: ignore
        }
      } else if (header) {
        const t = titleFromPartial(pending);
        if (t !== null) title = oneLine(t);
      }
    }
    return header ? { header, title, model } : null;
  } finally {
    await fh.close();
  }
}

async function listSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  let top;
  try {
    top = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  await Promise.all(
    top.map(async (d) => {
      const p = join(SESSIONS_DIR, d.name);
      if (d.isFile() && d.name.endsWith(".jsonl")) files.push(p);
      else if (d.isDirectory() && p !== LIVE_DIR) {
        try {
          // real files only: symlinks could alias another session or point outside
          for (const f of await readdir(p, { withFileTypes: true }))
            if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(p, f.name));
        } catch {
          // unreadable dir: skip
        }
      }
    }),
  );
  return files;
}

async function summarize(path: string): Promise<BaseSummary | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  try {
    const head = await readHead(path);
    if (!head || typeof head.header.id !== "string") return null;
    const h = head.header;
    const model = (await readTailModel(path, st.size)) ?? head.model;
    const summary: BaseSummary = {
      id: h.id,
      path,
      cwd: typeof h.cwd === "string" ? h.cwd : "",
      title: head.title || "Untitled",
      createdAt: typeof h.timestamp === "string" ? h.timestamp : new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
      lastActiveAt: new Date(st.mtimeMs).toISOString(),
      model,
    };
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary });
    return summary;
  } catch {
    return null;
  }
}

function liveField(l: LiveRecord | undefined): SessionSummary["live"] {
  return l ? { pid: l.pid, status: l.status, ...(l.workers ? { workers: l.workers } : {}) } : null;
}

/** All sessions, newest activity first, with fresh live presence merged in. */
export async function listSessions(): Promise<SessionSummary[]> {
  const files = await listSessionFiles();
  const live = readLive();
  const own = readOwnLiveRecords();
  const results = await Promise.all(files.map(summarize));
  const present = new Set(files);
  for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
  const out: SessionSummary[] = [];
  for (const s of results) {
    if (!s) continue;
    const l = live.get(s.path);
    const ownRec = own.get(s.path);
    out.push({
      ...s,
      live: liveField(l),
      workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
      origin: isWebSession(s.id) ? "web" : "external",
      archived: isArchived(s.id),
      busy: isSessionBusy(s.path),
    });
  }
  out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return out;
}

export async function getSessionSummary(path: string): Promise<SessionSummary | null> {
  const s = await summarize(path);
  if (!s) return null;
  const l = readLive().get(path);
  const ownRec = readOwnLiveRecords().get(path);
  return {
    ...s,
    live: liveField(l),
    workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
    origin: isWebSession(s.id) ? "web" : "external",
    archived: isArchived(s.id),
    busy: isSessionBusy(s.path),
  };
}

export type ArchiveResult =
  | { ok: true; summary: SessionSummary }
  | { ok: false; status: 404 | 409; error: string };

/**
 * POST /api/sessions/archive: set or clear the manual archive mark of a web-spawned session.
 * Only pi-web's own id list changes; the session file is never touched. Archiving a session
 * that's live in a TUI is refused (it would stay on top anyway); unarchiving always works.
 */
export async function archiveSession(path: string, archived: boolean): Promise<ArchiveResult> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (archived && s.live) {
    return { ok: false, status: 409, error: "This session is open in a TUI, so it stays on top while live. Nothing was archived." };
  }
  if (archived && s.origin !== "web") {
    return { ok: false, status: 409, error: "Only sessions started in pi-web can be archived. This one is already in the archive." };
  }
  if (s.archived !== archived) setArchived(s.id, archived);
  return { ok: true, summary: { ...s, archived } };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Distinct existing cwds from the index, most recently used first. */
export async function listCwds(): Promise<string[]> {
  const seen = new Set<string>();
  for (const s of await listSessions()) if (s.cwd && !seen.has(s.cwd) && isDir(s.cwd)) seen.add(s.cwd);
  return [...seen];
}
