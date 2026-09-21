import { statSync } from "node:fs";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionSummary } from "../shared/protocol";
import { type LiveRecord, readLive, readOwnLiveRecords, workerCountsOf } from "./live";
import { LIVE_DIR, resolveSessionPath, sessionPathShape, SESSIONS_DIR } from "./paths";
import { isWebSession, removeWebSession } from "./web-sessions";
import { parseWakeNudge } from "../shared/wake";
import { RECENT_WRITE_MS } from "./write-guard";
import { isArchived, setArchived } from "./archived-sessions";
import { dropGroupAssignments, readAssignments } from "./session-groups";
import { draftPreview, dropDrafts, readDrafts } from "./drafts";
import { removeSessionAttachments } from "./attachments";
import { disposeHeldChat, getModelRuntime, isSessionBusy } from "./chat-manager";
import { contextWindow } from "./models";
import { loadTargets, remoteOfCwd, type Target } from "./targets";

type BaseSummary = Omit<SessionSummary, "live" | "workers" | "origin" | "archived" | "busy">;

const CHUNK = 16 * 1024;
const MAX_HEAD = 256 * 1024;
const MAX_TAIL = 256 * 1024;
const TITLE_MAX = 80;
const SUMMARY_MAX = 200;

/** A window lookup for "provider/model", from the caller's ModelRuntime. Optional everywhere:
 *  without one every summary reports `window: null` (getSessionSummary must stay runtime-free —
 *  tests call it directly). */
export type WindowResolver = (ref: string) => number | null;

/** Cached per (mtime, size). `contextModel` is the ref the window is looked up under; it is kept
 *  beside the summary because the window depends on the caller's runtime, not on the file. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: BaseSummary;
  contextModel: string | null;
}

const cache = new Map<string, CacheEntry>();

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The outline's "now" line, whitespace-collapsed and capped for the sidebar's summary row. */
function summaryLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
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
 * The topic-outline's latest snapshot, scanned backwards from EOF exactly like readTailModel:
 * the last `topic-outline` custom entry's rolling "now" line, when it was generated, and how many
 * topics that same entry carried. This is the sidebar's summary row; the live record's broadcast
 * may be newer (outlineOverlay). The count comes from the ACCEPTED entry (the one whose "now"
 * reads), so it always describes the snapshot shown next to it.
 * null when the window has none (topic-outline off, older sessions, or a very long tail).
 */
async function readTailOutline(path: string, size: number): Promise<{ now: string; generatedAt: number; topics: number } | null> {
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
        if (line.includes('"topic-outline"')) {
          try {
            const e = JSON.parse(line.toString("utf-8"));
            const data = e?.type === "custom" && e?.customType === "topic-outline" ? e.data : null;
            if (data && typeof data.now === "string") {
              const now = summaryLine(data.now);
              // An empty "now" (drafting/none) is no summary: keep scanning for one that reads.
              if (now)
                return {
                  now,
                  generatedAt: typeof data.generatedAt === "number" && Number.isFinite(data.generatedAt) ? data.generatedAt : 0,
                  topics: Array.isArray(data.topics) ? data.topics.length : 0,
                };
            }
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

/** Context fill read off the tail: tokens, plus the model of the assistant message that spent
 *  them ("provider/model") when it carried one. */
interface TailContext {
  tokens: number;
  model: string | null;
}

/**
 * contextForBranch's rule (server/transcript.ts) applied to ONE raw entry, walking backwards:
 * "stale" for a compaction (the fill before it no longer describes the context), a TailContext
 * for an assistant message carrying a usage object (missing keys count as 0), null to keep
 * scanning. A non-object `usage`, and pi 0.86.0's top-level `type:"usage"` entries, are skipped.
 */
function contextOf(e: any): TailContext | "stale" | null {
  if (e?.type === "compaction") return "stale";
  const msg = e?.type === "message" ? e.message : null;
  if (!msg) return null;
  if (msg.role === "compactionSummary") return "stale";
  if (msg.role !== "assistant") return null;
  const u = msg.usage;
  if (!u || typeof u !== "object") return null;
  const tokens = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
  return { tokens, model: msg.provider && msg.model ? `${msg.provider}/${msg.model}` : null };
}

/**
 * The context fill at the file's LAST assistant reply, scanned backwards from EOF exactly like
 * readTailModel (16KB chunks, cap 256KB, torn/capped lines skipped). Same rule as the head's
 * contextForBranch, but on the raw file tail instead of the active branch: the first compaction
 * met walking back from EOF means there is no number (null), otherwise the first assistant
 * message with a usage object gives input + cacheRead + cacheWrite. null when the window has
 * neither. Not branch-aware — on a rewound session the tail can be a reply the head never sees.
 */
async function readTailContext(path: string, size: number): Promise<TailContext | null> {
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
        if (line.includes('"assistant"') || line.includes("compaction")) {
          try {
            const hit = contextOf(JSON.parse(line.toString("utf-8")));
            if (hit === "stale") return null;
            if (hit) return hit;
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
          if (msg.role === "user" && title === null && !parseWakeNudge(userText(msg.content))) title = oneLine(userText(msg.content));
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
          else if (header && e?.type === "message" && e.message?.role === "user" && !parseWakeNudge(userText(e.message.content)))
            title = oneLine(userText(e.message.content));
        } catch {
          // partial line: ignore
        }
      } else if (header) {
        const t = titleFromPartial(pending);
        if (t !== null && !parseWakeNudge(t)) title = oneLine(t);
      }
    }
    return header ? { header, title, model } : null;
  } finally {
    await fh.close();
  }
}

/**
 * The header's `parentSession` — the file a branched session was forked from (SessionHeader,
 * `SessionHeader.parentSession` in dist/core/session-manager.d.ts) — as the canonical path AND
 * the session id the group store
 * keys on, and only while that file is still there: a fork marker that points at a deleted
 * transcript is worse than none. sessionPathShape is what keeps this safe as well as honest: it
 * is pure string work — no syscall — and it only ever yields a .jsonl inside the (always local)
 * sessions dir, so the one ASYNC stat below can never touch a session's cwd, which for a mounted
 * target is a fuse path that would freeze the event loop. It is also the same construction the
 * listing uses (SESSIONS_DIR + name), so `parent` is byte-identical to that session's own `path`.
 * Part of the cached summary, so a parent deleted after this session's last write keeps showing
 * until this file is touched again.
 */
async function existingParent(raw: unknown): Promise<{ parent: string; parentId: string } | null> {
  const path = sessionPathShape(typeof raw === "string" ? raw : null);
  if (!path) return null;
  const there = await stat(path).then(
    () => true,
    () => false,
  );
  return there ? { parent: path, parentId: idOf(path) } : null;
}

export async function listSessionFiles(): Promise<string[]> {
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

/**
 * The cached summary with its context window resolved for THIS caller. The tokens come from the
 * file (and are cached with it); the window comes from the model catalog, so a summary first
 * cached by a runtime-less call still gets its window as soon as a resolver shows up.
 * The ref is the assistant message's own provider/model, else the summary's tail model — which
 * means that after a model switch the window is the CURRENT model's, i.e. the one the next reply
 * will actually use, not the one that produced these tokens.
 */
function withWindow(entry: CacheEntry, resolveWindow?: WindowResolver): BaseSummary {
  const ctx = entry.summary.context;
  if (!ctx || !resolveWindow) return entry.summary;
  const ref = entry.contextModel ?? entry.summary.model;
  const window = ref ? resolveWindow(ref) : null;
  return window === ctx.window ? entry.summary : { ...entry.summary, context: { tokens: ctx.tokens, window } };
}

async function summarize(path: string, resolveWindow?: WindowResolver, registry?: readonly Target[]): Promise<BaseSummary | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return withWindow(hit, resolveWindow);
  try {
    const head = await readHead(path);
    if (!head || typeof head.header.id !== "string") return null;
    const h = head.header;
    const model = (await readTailModel(path, st.size)) ?? head.model;
    const outline = await readTailOutline(path, st.size);
    const ctx = await readTailContext(path, st.size);
    const cwd = typeof h.cwd === "string" ? h.cwd : "";
    const parent = await existingParent(h.parentSession);
    // a remote session's cwd is its target placeholder, or a directory inside its mount point;
    // the registry (one read per listing, not one per session) resolves mount-point cwds
    const remote = remoteOfCwd(cwd, registry);
    const summary: BaseSummary = {
      id: h.id,
      path,
      cwd,
      title: head.title || "Untitled",
      createdAt: typeof h.timestamp === "string" ? h.timestamp : new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
      lastActiveAt: new Date(st.mtimeMs).toISOString(),
      model,
      ...(outline ? { outlineNow: outline.now, outlineAt: outline.generatedAt, outlineTopics: outline.topics } : {}),
      ...(ctx ? { context: { tokens: ctx.tokens, window: null } } : {}),
      ...(parent ?? {}),
      ...(remote ? { target: remote.target, remoteCwd: remote.remoteCwd } : {}),
      ...(remote?.mounted ? { mounted: true } : {}),
    };
    const entry: CacheEntry = { mtimeMs: st.mtimeMs, size: st.size, summary, contextModel: ctx?.model ?? null };
    cache.set(path, entry);
    return withWindow(entry, resolveWindow);
  } catch {
    return null;
  }
}

function liveField(l: LiveRecord | undefined): SessionSummary["live"] {
  return l ? { pid: l.pid, status: l.status, ...(l.workers ? { workers: l.workers } : {}) } : null;
}

/** The live record's outline broadcast can be newer than the file's last `topic-outline` entry
 *  (insights' overlayOutline, reduced to the summary line + topic count): prefer it when it's at
 *  least as new. The broadcast's `topics` is an array of heading strings, so its length is the
 *  count; a broadcast without that array leaves the file's count alone. */
function outlineOverlay(s: BaseSummary, l: LiveRecord | undefined): { outlineNow?: string; outlineAt?: number; outlineTopics?: number } {
  const outline = l?.outline;
  if (!outline || typeof outline !== "object") return {};
  const o = outline as { now?: unknown; generatedAt?: unknown; topics?: unknown };
  if (typeof o.now !== "string" || !o.now.trim()) return {};
  const at = typeof o.generatedAt === "number" && Number.isFinite(o.generatedAt) ? o.generatedAt : 0;
  if (s.outlineAt !== undefined && at < s.outlineAt) return {};
  const now = summaryLine(o.now);
  if (!now) return {};
  return {
    outlineNow: now,
    outlineAt: Math.max(at, s.outlineAt ?? 0),
    ...(Array.isArray(o.topics) ? { outlineTopics: o.topics.filter((t) => typeof t === "string").length } : {}),
  };
}

/** All sessions, newest activity first, with fresh live presence merged in. */
export async function listSessions(): Promise<SessionSummary[]> {
  const files = await listSessionFiles();
  const live = readLive();
  const own = readOwnLiveRecords();
  const resolveWindow = await windowResolver();
  const drafts = readDrafts();
  const groups = readAssignments();
  // An assignment whose session file is gone — deleted by hand, or by a TUI — can never match a row
  // again, so pi-web's own bookkeeping is pruned on the way past. Archive cleanup prunes the ids it
  // deletes; this catches every other writer, and only writes when something is actually dead.
  // Keyed on file existence, never on a summary succeeding: an unreadable file keeps its group.
  const liveIds = new Set(files.map(idOf));
  dropGroupAssignments(Object.keys(groups).filter((id) => !liveIds.has(id)));
  const registry = loadTargets().targets; // one read for every summary's mount-point match
  const results = await Promise.all(files.map((f) => summarize(f, resolveWindow, registry)));
  const present = new Set(files);
  for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
  const out: SessionSummary[] = [];
  for (const s of results) {
    if (!s) continue;
    // Empty husks — no user message anywhere in the file — are never listed, so abandoned
    // new-session stubs don't clutter the archive (spec/02-session-list.md §2 "Archive cleanup"). Hidden
    // only when the whole file was read: a first user message beyond the head cap never hides
    // a session. cleanupSessions("husks") still finds and deletes them by path.
    // Exception: a husk with a stored composer draft (text or images) is a new session the user
    // is writing in, not an abandoned stub, so it is listed as a draft row (draftPreview).
    let preview: string | undefined;
    if (s.title === "Untitled") {
      const st2 = await stat(s.path).catch(() => null);
      if (st2 && (await isZeroInput(s.path, st2.size))) {
        const draft = drafts[s.id];
        if (!draft || (!draft.text.trim() && !draft.attachments?.length)) continue;
        preview = draftPreview(draft.text, draft.attachments);
      }
    }
    const l = live.get(s.path);
    const ownRec = own.get(s.path);
    out.push({
      ...s,
      ...outlineOverlay(s, l),
      live: liveField(l),
      workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
      origin: isWebSession(s.id) ? "web" : "external",
      archived: isArchived(s.id),
      ...(groups[s.id] !== undefined ? { groupId: groups[s.id] } : {}),
      busy: isSessionBusy(s.path),
      ...(preview !== undefined ? { draftPreview: preview } : {}),
    });
  }
  out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return out;
}

/**
 * The model runtime as a window lookup, resolved ONCE per listing call. Best-effort: with no
 * auth configured (or in a test's throwaway agent dir) ModelRuntime.create() can fail, and then
 * every context gauge simply reports `window: null` instead of failing the listing.
 */
async function windowResolver(): Promise<WindowResolver | undefined> {
  try {
    const runtime = await getModelRuntime();
    return (ref) => contextWindow(ref, runtime);
  } catch {
    return undefined;
  }
}

/** One summary. `resolveWindow` is optional on purpose: without it the context gauge has no
 *  window (tests and any caller that must not spin up a ModelRuntime). */
export async function getSessionSummary(path: string, resolveWindow?: WindowResolver): Promise<SessionSummary | null> {
  const s = await summarize(path, resolveWindow, loadTargets().targets);
  if (!s) return null;
  const l = readLive().get(path);
  const ownRec = readOwnLiveRecords().get(path);
  const groupId = readAssignments()[s.id];
  return {
    ...s,
    ...outlineOverlay(s, l),
    live: liveField(l),
    workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
    origin: isWebSession(s.id) ? "web" : "external",
    archived: isArchived(s.id),
    ...(groupId !== undefined ? { groupId } : {}),
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
  const s = await getSessionSummary(path, await windowResolver());
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (archived && s.live) {
    return { ok: false, status: 409, error: "This session is open in a TUI, so it stays on top while live. Nothing was archived." };
  }
  if (archived && s.origin !== "web") {
    return { ok: false, status: 409, error: "Only sessions started in pi-web can be archived. This one is already in the archive." };
  }
  if (archived && isSessionBusy(s.path)) {
    return { ok: false, status: 409, error: "The agent is mid-turn; abort or wait before archiving." };
  }
  if (s.archived !== archived) setArchived(s.id, archived);
  // Archiving is the close gesture: shut the held runtime down (running subagents die with it).
  // There is no idle timer anymore — a runtime lives until this, a reload, or server shutdown.
  if (archived) await disposeHeldChat(s.path, "Session archived; its runtime was closed.");
  return { ok: true, summary: { ...s, archived } };
}

/**
 * Session id → path, from the listing cache this server already keeps — no disk access at all.
 * Warm after any listing (the sidebar refreshes constantly); empty on a cold start, which is why
 * the one caller falls back to a real walk only for ids it cannot find here, rather than paying
 * for a directory scan on every press of Send (spec/14-workspaces.md §14 "The pre-check reads
 * the group, not the disk").
 */
export function indexedSessionPaths(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, entry] of cache) out.set(entry.summary.id, path);
  return out;
}

/** The session id of a session file: the uuidv7 after the last "_" of its name. */
export function idOf(path: string): string {
  return basename(path, ".jsonl").split("_").pop() ?? "";
}

/**
 * True when the file is an empty husk: all of it was read and it holds no user message
 * (readHead stops at the first one). Never guessed from a head-capped read of a big file,
 * so a session whose first user message sits beyond MAX_HEAD is never treated as empty.
 */
export async function isZeroInput(path: string, size: number): Promise<boolean> {
  if (size > MAX_HEAD) return false;
  const head = await readHead(path);
  return head !== null && head.title === null;
}

export type CleanupRequest =
  | { mode: "age"; minAgeDays: number; dryRun: boolean }
  | { mode: "husks"; dryRun: boolean }
  | { mode: "paths"; paths: string[]; dryRun: boolean };

export interface CleanupResult {
  /** Files deleted; 0 on a dry run (deletedIds then holds the candidates). */
  deletedCount: number;
  deletedIds: string[];
  skipped: { live: number; busy: number; recent: number; failed: number };
  /** paths mode only: every path refused with why — nothing deleted for it, and not counted in
   *  skipped, which stays the live/busy/recent/failed vocabulary. */
  refused?: { path: string; reason: string }[];
}

/**
 * POST /api/sessions/cleanup: permanently deletes transcript files from disk — sessions older
 * than minAgeDays (by last write), empty husks, or (mode "paths") the named session files. Live,
 * mid-turn, and just-written sessions are always skipped and counted, whatever the mode; held web
 * runtimes are disposed first, like the archive gesture. The index cache, both id lists, the drafts
 * and the session's attachments folder are updated per deleted file.
 *
 * paths mode is the irreversible second step after archiving: only files carrying the archive
 * mark are deleted, and every path is re-validated with resolveSessionPath (the same validation
 * the route and the archive gesture apply), so a path outside the sessions dir is refused. The
 * rest is refused with the reason in `refused` too: an unarchived session (archive it first), a
 * file that's gone, and a file whose header doesn't parse — never delete what can't be read as
 * a pi session.
 */
export async function cleanupSessions(req: CleanupRequest): Promise<CleanupResult> {
  const targets = req.mode === "paths" ? req.paths : await listSessionFiles();
  const live = readLive();
  const now = Date.now();
  const cutoff = req.mode === "age" ? now - req.minAgeDays * 86_400_000 : 0;
  const skipped = { live: 0, busy: 0, recent: 0, failed: 0 };
  const deletedIds: string[] = [];
  const refusals: { path: string; reason: string }[] = [];
  /** Ids whose file is really gone, so their group assignment goes too (one write after the loop). */
  const forgotten: string[] = [];
  for (const target of targets) {
    // paths mode re-validates what the route already checked, so a direct caller gets the same rule.
    const path = req.mode === "paths" ? resolveSessionPath(target) : target;
    if (!path) {
      refusals.push({ path: target, reason: "Not a session file under the pi sessions dir." });
      continue;
    }
    let st;
    try {
      st = await stat(path);
    } catch {
      if (req.mode === "paths") refusals.push({ path, reason: "Session file not found." });
      continue;
    }
    const matches = req.mode === "age" ? st.mtimeMs < cutoff : req.mode === "husks" ? await isZeroInput(path, st.size) : true;
    if (!matches) continue;
    if (live.has(path)) {
      skipped.live++;
      continue;
    }
    if (isSessionBusy(path)) {
      skipped.busy++;
      continue;
    }
    if (req.mode === "paths" && !isArchived(idOf(path))) {
      refusals.push({ path, reason: "Not archived — archive it first, then delete it." });
      continue;
    }
    if (now - st.mtimeMs < RECENT_WRITE_MS) {
      skipped.recent++;
      continue;
    }
    if (req.mode === "paths") {
      // Never delete what doesn't read as a pi session: the same header check a summary makes.
      const head = await readHead(path).catch(() => null);
      if (!head || typeof head.header.id !== "string") {
        refusals.push({ path, reason: "Couldn't read its transcript, so nothing was deleted." });
        continue;
      }
    }
    const id = idOf(path);
    if (req.dryRun) {
      deletedIds.push(id);
      continue;
    }
    try {
      await disposeHeldChat(path, "Session deleted by archive cleanup; its runtime was closed.");
      await unlink(path);
      cache.delete(path);
      setArchived(id, false);
      removeWebSession(id);
      dropDrafts([id]);
      removeSessionAttachments(id);
      deletedIds.push(id);
      forgotten.push(id);
    } catch {
      skipped.failed++;
    }
  }
  dropGroupAssignments(forgotten);
  return {
    deletedCount: req.dryRun ? 0 : deletedIds.length,
    deletedIds,
    skipped,
    ...(req.mode === "paths" ? { refused: refusals } : {}),
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Distinct existing cwds from the index, most recently used first. A cwd inside a target's
 * mount point is listed without touching it: statting a fuse path can block the whole event
 * loop while the mount hangs, and remoteOfCwd matches the configured mount blocks without statting. */
export async function listCwds(): Promise<string[]> {
  const seen = new Set<string>();
  for (const s of await listSessions()) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    if (remoteOfCwd(s.cwd)?.mounted || isDir(s.cwd)) seen.add(s.cwd);
  }
  return [...seen];
}
