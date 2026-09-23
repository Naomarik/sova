import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type RawLiveRecord, readLiveRecords } from "./live";
import { canonicalPath, sessionPathShape } from "./paths";

/**
 * Which session files are a subagent's / team member's OWN session, so the sidebar can keep them
 * out of the list (`SessionSummary.workerSession`). Three independent inputs, unioned:
 *
 * 1. self: the worker's own file carries the spawn marker — a `custom` entry of type
 *    WORKER_SESSION_MARKER, appended by pi-config's subagents `worker-mark.ts` in every pi child.
 * 2. durable refs: another session's file names it — `custom` entries of type
 *    WORKER_REGISTRY_TYPE (`data.backendSessionFile` / `data.backendSessionId`, host transport), and
 *    the HEADER BLOCK of `custom_message` entries of type COMPLETION_TYPE (completionHeaderRef).
 * 3. live refs: `presence.workers[].sessionFile` (else `.sessionId`) of every live record,
 *    this server's own included — Sova-hosted sessions spawn workers too.
 *
 * A ref is an absolute .jsonl path or a bare pi session id; it counts only when it resolves to a
 * session file in the listing the caller passed in. Nothing else is guessed or stat'ed.
 *
 * Session files are append-only, so each one is scanned incrementally: only the bytes past the
 * last complete line already parsed. Read-only: files are opened "r" and never written.
 */

/** pi-config/extensions/subagents/worker-mark.ts. Renaming it there unhides every worker. */
export const WORKER_SESSION_MARKER = "subagents-worker-session";
/** pi-config/extensions/subagents/registry.ts WORKER_REGISTRY_ENTRY_TYPE. */
export const WORKER_REGISTRY_TYPE = "subagents-worker-registry";
/** pi-config/extensions/subagents/index.ts, the completion message the owner receives. */
export const COMPLETION_TYPE = "subagent-complete";

const CHUNK = 16 * 1024;
const NEEDLES = [WORKER_SESSION_MARKER, WORKER_REGISTRY_TYPE, COMPLETION_TYPE].map((t) => Buffer.from(`"${t}"`));

export interface ScanEntry {
  /** Byte offset just past the last COMPLETE line parsed. */
  scanned: number;
  /** File size at the last scan: unchanged ⇒ nothing to read; smaller ⇒ rewritten, rescan. */
  size: number;
  self: boolean;
  /** Raw refs (paths or ids) this file names as its workers, deduplicated, unresolved. */
  refs: string[];
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * The `Session:` ref of a subagent-complete message, from its header block only. The builder
 * writes `### <id> (<name>) — <status>` / optional `Error: …` / `Session: <path|id>` / `Model: …`
 * then the worker's own output, so the ref is the line IMMEDIATELY before the first `Model: ` line,
 * and only when the first line is the `### ` heading. Anything a worker's report (or an error
 * text) quotes elsewhere is never a ref: treating it as one would hide a real thread.
 */
export function completionHeaderRef(text: string): string | null {
  if (!text.startsWith("### ")) return null;
  const model = text.indexOf("\nModel: ");
  if (model < 0) return null;
  const header = text.slice(0, model);
  const lastNl = header.lastIndexOf("\n");
  if (lastNl < 0) return null; // "### …" directly followed by Model: no Session line
  const line = header.slice(lastNl + 1);
  if (!line.startsWith("Session: ")) return null;
  const ref = line.slice("Session: ".length).trim();
  return ref || null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/** What one parsed session entry says: it marks its own file, and/or names worker refs. */
export function entryFacts(e: any): { self: boolean; refs: string[] } {
  const none = { self: false, refs: [] };
  if (!e || typeof e !== "object") return none;
  if (e.type === "custom" && e.customType === WORKER_SESSION_MARKER) return { self: true, refs: [] };
  if (e.type === "custom" && e.customType === WORKER_REGISTRY_TYPE) {
    const d = e.data;
    if (!d || typeof d !== "object") return none;
    return { self: false, refs: [d.backendSessionFile, d.backendSessionId].filter(nonEmpty).map((s) => s.trim()) };
  }
  if (e.type === "custom_message" && e.customType === COMPLETION_TYPE) {
    const ref = completionHeaderRef(contentText(e.content));
    return { self: false, refs: ref ? [ref] : [] };
  }
  return none;
}

/** Live worker refs: `presence.workers[].sessionFile`, falling back to `sessionId` only when no
 *  file is given. Paths are canonicalized only after they pass the sessions-dir shape check. */
export function liveWorkerRefs(records: RawLiveRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const workers = r.rec?.presence?.workers;
    if (!Array.isArray(workers)) continue;
    for (const w of workers) {
      if (!w || typeof w !== "object") continue;
      if (nonEmpty(w.sessionFile)) {
        const shaped = isAbsolute(w.sessionFile) ? sessionPathShape(w.sessionFile) : null;
        if (shaped) out.push(canonicalPath(shaped));
      } else if (nonEmpty(w.sessionId)) out.push(w.sessionId.trim());
    }
  }
  return out;
}

/** A ref → a listed session path, or null. Paths must be absolute and in `listed` (so a deleted
 *  file or one outside the sessions dir resolves to nothing); ids must be in `byId`. */
function resolveRef(ref: string, listed: Set<string>, byId: Map<string, string>): string | null {
  if (ref.includes("/")) {
    const p = isAbsolute(ref) ? sessionPathShape(ref) : null;
    return p && listed.has(p) ? p : null;
  }
  return byId.get(ref) ?? null;
}

export interface WorkerSessionOptions {
  /** Session id of a session file (sessions-index's idOf; injected to avoid an import cycle). */
  idOf: (path: string) => string;
  /** Live records to read worker refs from; default: every live file, this server's own too. */
  live?: () => RawLiveRecord[];
}

export class WorkerSessions {
  readonly entries = new Map<string, ScanEntry>();
  /** Total bytes read from disk, for tests and measurement. */
  bytesRead = 0;
  private readonly idOf: (path: string) => string;
  private readonly live: () => RawLiveRecord[];
  private readonly inflight = new Map<string, Promise<ScanEntry | null>>();

  constructor(opts: WorkerSessionOptions) {
    this.idOf = opts.idOf;
    this.live = opts.live ?? (() => readLiveRecords({ includeOwn: true }));
  }

  /** Bring one file's entry up to date (one scan per path at a time). Null when it's gone. */
  scan(path: string): Promise<ScanEntry | null> {
    const running = this.inflight.get(path);
    if (running) return running;
    const p = this.scanNow(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  private async scanNow(path: string): Promise<ScanEntry | null> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.entries.delete(path);
      return null;
    }
    let entry = this.entries.get(path);
    if (entry && size === entry.size) return entry;
    // Shrunk: rewritten or migrated, so everything parsed before may be gone. Start over.
    if (!entry || size < entry.size || size < entry.scanned) entry = { scanned: 0, size: 0, self: false, refs: [] };
    const next: ScanEntry = { ...entry, refs: [...entry.refs] };
    try {
      await this.readFrom(path, next, size);
    } catch {
      return this.entries.get(path) ?? null; // unreadable right now: keep what we had
    }
    next.size = size;
    this.entries.set(path, next);
    return next;
  }

  /** Parse the complete lines in [entry.scanned, size) and advance `scanned` past the last one. */
  private async readFrom(path: string, entry: ScanEntry, size: number): Promise<void> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      const seen = new Set(entry.refs);
      let pending: Buffer[] = [];
      let pendingLen = 0;
      let pos = entry.scanned;
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
        if (bytesRead === 0) break;
        this.bytesRead += bytesRead;
        pos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
          const piece = chunk.subarray(start, nl);
          const line = pendingLen ? Buffer.concat([...pending, piece]) : piece;
          pending = [];
          pendingLen = 0;
          this.consider(line, entry, seen);
          start = nl + 1;
        }
        if (start < bytesRead) {
          pending.push(Buffer.from(chunk.subarray(start))); // copy: buf is reused
          pendingLen += bytesRead - start;
        }
      }
      // A trailing partial line (a writer mid-append) is left for the next scan.
      entry.scanned = pos - pendingLen;
      entry.refs = [...seen];
    } finally {
      await fh.close();
    }
  }

  private consider(line: Buffer, entry: ScanEntry, seen: Set<string>): void {
    if (!NEEDLES.some((n) => line.includes(n))) return; // cheap: most lines are never parsed
    let e: unknown;
    try {
      e = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const facts = entryFacts(e);
    if (facts.self) entry.self = true;
    for (const r of facts.refs) seen.add(r);
  }

  /**
   * The worker-session paths among `files` (the caller's current listing): scan every file,
   * drop entries for files no longer listed, then union self-marked files with the resolved
   * durable and live refs. Recomputed on every call; nothing is baked in.
   */
  async refresh(files: string[]): Promise<Set<string>> {
    const listed = new Set(files);
    for (const k of this.entries.keys()) if (!listed.has(k)) this.entries.delete(k);
    await Promise.all(files.map((f) => this.scan(f)));
    return this.flagged(listed);
  }

  /** One file's flag, for a single-summary read: scans just that file and resolves against the
   *  entries of the last refresh (plus this file). */
  async isWorker(path: string): Promise<boolean> {
    const entry = await this.scan(path);
    if (!entry) return false;
    if (entry.self) return true;
    return this.flagged(new Set(this.entries.keys())).has(path);
  }

  private flagged(listed: Set<string>): Set<string> {
    const byId = new Map<string, string>();
    for (const p of listed) byId.set(this.idOf(p), p);
    const out = new Set<string>();
    const add = (ref: string) => {
      const p = resolveRef(ref, listed, byId);
      if (p) out.add(p);
    };
    for (const [path, e] of this.entries) {
      if (!listed.has(path)) continue;
      if (e.self) out.add(path);
      for (const r of e.refs) add(r);
    }
    let live: RawLiveRecord[] = [];
    try {
      live = this.live();
    } catch {
      // unreadable live dir: durable inputs still stand
    }
    for (const r of liveWorkerRefs(live)) add(r);
    return out;
  }
}
