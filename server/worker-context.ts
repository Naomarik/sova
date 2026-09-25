// A worker's context fill, for the subagents pane: how full the worker's OWN context window is as
// of its last reply — the session head's rule (server/transcript.ts contextForBranch) applied to
// the worker's transcript.
//
// Live workers publish no such number (the live registry's worker usage is spend only, and this
// server never changes that schema), so their fill is read off the tail of their own transcript:
// backwards from EOF like the sidebar's readTailContext, re-read only when the file's mtime or size
// moved. Restored workers get theirs from the transcript summary instead (worker-restore.ts).
//
// Read-only. Synchronous on purpose: the hosted chat's `workers` snapshot is built synchronously,
// and a tail read is a stat plus, only when the file moved, a few 16KB reads.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import type { ContextInfo, WatchContext, WorkerInfo } from "../shared/protocol";
import { claudeContextOf } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { piContextOf } from "../pi-config/extensions/subagents/adapters/pi.ts";
import { readWorkerManifests, type WorkerManifest } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { resolveClaudeSession } from "./claude-transcript";
import { resolveSessionPath } from "./paths";
import { targetsRoot } from "./targets";
import { activeBranch, parseLines } from "./transcript";

/** A model ref ("provider/id", or a bare id) → its context window, or null when unknown. */
export type WindowResolver = (ref: string) => number | null;

/**
 * The Claude Code provider's window rule: a `[1m]`-suffixed CLI alias is the 1M-context variant,
 * anything else 200k. The extension's own copy is contextWindowFor in
 * pi-config/extensions/claude-code/provider/index.ts, which the server cannot import (it pulls the
 * CLI bridge); server/worker-context.test.ts pins the two together.
 */
export function claudeCodeContextWindow(model: string): number {
  return model.endsWith("[1m]") ? 1_000_000 : 200_000;
}

/**
 * The model a claude-code worker was SPAWNED with, which is what names its window: the manifest's
 * spec model, else the biggest row of its last usage snapshot (the runner keys those by the spawn
 * id, `[1m]` kept). Never the transcript's model — Claude Code writes the bare id there, so a
 * `[1m]` worker would read as 200k.
 */
export function claudeSpawnModel(m: Pick<WorkerManifest, "spec" | "usageSnapshot">): string | undefined {
  if (m.spec?.model) return m.spec.model;
  const rows = m.usageSnapshot?.byModel ?? [];
  const size = (r: (typeof rows)[number]) => r.input + r.output + r.cacheRead + r.cacheWrite;
  const biggest = rows.length ? rows.reduce((a, b) => (size(b) > size(a) ? b : a)) : undefined;
  const model = biggest?.model;
  return model && model !== "claude/unknown" ? model.replace(/^claude\//, "") : undefined;
}

/** Spawn models by worker id, from a session's worker manifest records (claude-code only: the
    one backend whose window the transcript can't name). */
export function claudeSpawnModels(entries: readonly unknown[]): (id: string) => string | undefined {
  const { manifests } = readWorkerManifests(entries);
  const byId = new Map<string, string>();
  for (const m of manifests.values()) {
    const model = m.backend === "claude-code" ? claudeSpawnModel(m) : undefined;
    if (model) byId.set(m.workerId, model);
  }
  return (id) => byId.get(id);
}

/** A worker's window by its spawn model; `spawnModel` overrides the row's own model (restored
    claude-code workers, whose row names the transcript's bare id). Null when unknown. */
export function workerWindow(w: Pick<WorkerInfo, "backend" | "model">, resolve: WindowResolver, spawnModel?: string): number | null {
  const model = spawnModel ?? w.model;
  if (!model) return null;
  return w.backend === "claude-code" ? claudeCodeContextWindow(model) : resolve(model);
}

/** One transcript's fill as its tail says: tokens and the reply's own model (pi: "provider/id";
    Claude: absent), "compacted", or null when the tail holds neither. */
export type TailFill = { tokens: number; model: string | null } | "compacted" | null;
export type Format = "pi" | "claude";

const CHUNK = 16 * 1024;
const MAX_TAIL = 256 * 1024;
const NL = 0x0a;

/** What one parsed line says, in `format`. */
function lineFill(entry: unknown, format: Format): TailFill {
  if (format === "claude") {
    const c = claudeContextOf(entry);
    return typeof c === "number" ? { tokens: c, model: null } : c;
  }
  const c = piContextOf(entry);
  if (typeof c !== "number") return c;
  const m = (entry as { message?: { provider?: unknown; model?: unknown } }).message;
  return { tokens: c, model: typeof m?.provider === "string" && typeof m.model === "string" ? `${m.provider}/${m.model}` : null };
}

/** Cheap pre-filter before JSON.parse: only these lines can say anything. */
const mayMatter = (line: Buffer, format: Format): boolean =>
  line.includes('"assistant"') || line.includes(format === "pi" ? "compaction" : "compact_boundary");

/**
 * The fill at the file's LAST reply that reports one, scanned backwards from EOF (16KB chunks,
 * capped at 256KB; torn and capped lines are skipped). The first compaction met walking back means
 * "compacted". Not branch-aware for pi — like the sidebar's ring, a rewound worker's tail can be a
 * reply its branch no longer holds. Null when the window holds neither.
 */
export function readTailFill(file: string, size: number, format: Format): TailFill {
  const fd = openSync(file, "r");
  try {
    const floor = Math.max(0, size - MAX_TAIL);
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      if (readSync(fd, chunk, 0, chunk.length, start) < chunk.length) return null; // truncated under us
      end = start;
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let stop = buf.length;
      for (;;) {
        const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
        if (i < 0 && start > 0) break; // this line's start is still unread
        const line = buf.subarray(i + 1, stop);
        if (line.length > 0 && mayMatter(line, format)) {
          try {
            const hit = lineFill(JSON.parse(line.toString("utf8")), format);
            if (hit) return hit;
          } catch {
            // a torn trailing line, or not JSON
          }
        }
        if (i < 0) return null;
        stop = i;
      }
      carry = buf.subarray(0, stop);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Where a worker's transcript is, as a LOCAL file this server may read, and in which format. */
export type WorkerFileOf = (w: WorkerInfo) => { file: string; format: Format } | null;

/**
 * pi: its session file, only when it is a session path the rest of the API accepts and not under
 * a remote target's placeholder tree (server/targets.ts) — there is nothing local to read there,
 * and "unknown" is said by omission, never as 0. Claude: the session record the transcript
 * socket reads, found by id inside ~/.claude/projects.
 */
export const localWorkerFile: WorkerFileOf = (w) => {
  if (w.sessionFile) {
    if (!isAbsolute(w.sessionFile) || w.sessionFile.startsWith(targetsRoot() + sep)) return null;
    const file = resolveSessionPath(w.sessionFile);
    return file ? { file, format: "pi" } : null;
  }
  if (w.backend === "claude-code" && w.sessionId) {
    const file = resolveClaudeSession(w.sessionId);
    return file ? { file, format: "claude" } : null;
  }
  return null;
};

const MAX_CACHED = 256;

/** Tail fills per file, re-read only when the file's mtime or size moved. */
export class WorkerContextReader {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; fill: TailFill }>();
  constructor(private readonly fileOf: WorkerFileOf = localWorkerFile) {}

  /** The worker's tail fill; undefined when its transcript isn't a local, readable file. */
  fill(w: WorkerInfo): TailFill | undefined {
    const where = this.fileOf(w);
    if (!where) return undefined;
    try {
      const st = statSync(where.file);
      if (!st.isFile()) return undefined;
      const hit = this.cache.get(where.file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.fill;
      const fill = readTailFill(where.file, st.size, where.format);
      this.cache.delete(where.file);
      this.cache.set(where.file, { mtimeMs: st.mtimeMs, size: st.size, fill });
      while (this.cache.size > MAX_CACHED) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return fill;
    } catch {
      return undefined; // gone or unreadable right now: say nothing
    }
  }
}

/**
 * A fill as the wire carries it. pi: the reply's own model names the window (a worker can change
 * models), else the worker's. Claude Code: always the worker's — its transcript's model is the bare
 * id, which would drop a `[1m]` variant.
 */
export function toWorkerContext(fill: TailFill, w: Pick<WorkerInfo, "backend">, resolve: WindowResolver, window: number | null): ContextInfo | "compacted" | null {
  if (fill === null) return null;
  if (fill === "compacted") return "compacted";
  const own = w.backend !== "claude-code" && fill.model ? resolve(fill.model) : null;
  return { tokens: fill.tokens, window: own ?? window };
}

/** A model id with the spawn model's context variant (`[1m]`) when it names none itself:
    "claude-opus-5-5" spawned as "opus[1m]" → "claude-opus-5-5[1m]". The id stays the row's own. */
export function withSpawnVariant(model: string, spawn: string | undefined): string {
  const variant = spawn ? /\[[^\]]+\]\s*$/.exec(spawn)?.[0].trim() : undefined;
  return variant && !/\[[^\]]*\]\s*$/.test(model) ? `${model}${variant}` : model;
}

/**
 * Stamps `contextWindow` and `context` on each worker in place and returns the list. A worker that
 * already carries a `context` (a restored one, from its summary) keeps it. `spawnModel` names a
 * worker's spawn model when the session's manifests know it (claude-code windows need it: a
 * restored claude-code row's model has lost its `[1m]`). The same spawn model gives such a row's
 * model its variant back, so its label says 1M where its window is.
 */
export function withWorkerContext(
  workers: WorkerInfo[],
  reader: WorkerContextReader,
  resolve: WindowResolver,
  spawnModel: (id: string) => string | undefined = () => undefined,
): WorkerInfo[] {
  for (const w of workers) {
    const spawn = w.backend === "claude-code" ? spawnModel(w.id) : undefined;
    if (w.model && spawn) w.model = withSpawnVariant(w.model, spawn);
    const window = w.contextWindow ?? workerWindow(w, resolve, spawn);
    if (window) w.contextWindow = window;
    if (w.context !== undefined) continue;
    const fill = reader.fill(w);
    const context = fill === undefined ? null : toWorkerContext(fill, w, resolve, window);
    if (context) w.context = context;
  }
  return workers;
}

/**
 * The open transcript's fill for /ws/watch, per connection: fed the same text as the usage tally
 * (a "snapshot" restarts it; an "append" moves it on), it returns the state after that text. pi's
 * snapshot is the active branch, as the rows are; appends are taken as they land. The window is the
 * reply's own model's for pi; Claude Code's file names no variant, so the client supplies it.
 */
export type ContextTally = (text: string, part: "snapshot" | "append") => WatchContext;

export function contextTally(format: Format, resolve: WindowResolver): ContextTally {
  let state: TailFill = null;
  return (text, part) => {
    if (part === "snapshot") state = null;
    const lines = parseLines(text);
    for (const e of format === "pi" && part === "snapshot" ? activeBranch(lines) : lines) {
      const fill = lineFill(e, format);
      if (fill) state = fill;
    }
    if (state === null || state === "compacted") return state;
    return { tokens: state.tokens, window: format === "pi" && state.model ? resolve(state.model) : null };
  };
}
