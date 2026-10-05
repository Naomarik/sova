// A worker's context fill, for the subagents pane: how full the worker's OWN context window is as
// of its last reply — the session head's rule (server/harness/pi/usage.ts contextStep) applied to
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
import { claudeContextWindow } from "../pi-config/extensions/claude-code/context-window.ts";
import type { HEntry } from "../shared/harness";
import { claudeContextOf } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { readWorkerManifests, type WorkerManifest } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { resolveClaudeSession } from "./claude-transcript";
import { lineEntry, parsePiBranch } from "./harness/pi/reader";
import { contextStep } from "./harness/pi/usage";
import { parseJsonl } from "./jsonl";
import { resolveSessionPath } from "./paths";
import { targetsRoot } from "./targets";

/** A model ref ("provider/id", or a bare id) → its context window, or null when unknown. */
export type WindowResolver = (ref: string) => number | null;

/**
 * The model a claude-code worker was SPAWNED with, which is what names its window: the manifest's
 * spec model, else the biggest row of its last usage snapshot (the runner keys those by the spawn
 * id, `[1m]` kept). Never the transcript's model — Claude Code writes the bare id there, so a
 * `[1m]` worker of a model that is not natively 1M would read as 200k.
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
  // claude-code: the extension's own window rule (context-window.ts): `[1m]` or a natively 1M model.
  return w.backend === "claude-code" ? claudeContextWindow(model) : resolve(model);
}

/** One transcript's fill as its tail says: tokens and the reply's own model (pi: "provider/id";
    Claude: absent), "compacted", or null when the tail holds neither. */
export type TailFill = { tokens: number; model: string | null } | "compacted" | null;
export type Format = "pi" | "claude";

const CHUNK = 16 * 1024;
const MAX_TAIL = 256 * 1024;
const NL = 0x0a;

/** What one Claude Code line says. */
function claudeFill(entry: unknown): TailFill {
  const c = claudeContextOf(entry);
  return typeof c === "number" ? { tokens: c, model: null } : c;
}

/** What one pi entry says. */
function piFill(h: HEntry | null): TailFill {
  const c = h ? contextStep(h) : null;
  if (typeof c !== "number") return c;
  const m = h as Extract<HEntry, { kind: "assistant" }>;
  return { tokens: c, model: typeof m.provider === "string" && typeof m.model === "string" ? `${m.provider}/${m.model}` : null };
}

/** Cheap pre-filter before JSON.parse: only these lines can say anything. */
const mayMatter = (line: Buffer, format: Format): boolean =>
  line.includes('"assistant"') || line.includes(format === "pi" ? "compaction" : "compact_boundary");

/** Exact, for a pi line as text: only a reply, a compaction or a compaction's summary says anything (piFill), and
    such a line spells "assistant" or "compaction" in it, unless it escapes them (`\u`). */
const mayFill = (line: string): boolean => line.includes("assistant") || line.includes("compaction") || line.includes("\\u");

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
            const hit = format === "claude" ? claudeFill(JSON.parse(line.toString("utf8"))) : piFill(lineEntry(line));
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
    if (format === "pi") {
      if (part === "snapshot") {
        for (const h of parsePiBranch(text).branch) {
          const fill = piFill(h);
          if (fill) state = fill;
        }
      } else {
        // Appended lines in file order, each read only when it can say something (the rows read them all).
        for (const line of text.split("\n")) {
          if (!mayFill(line)) continue;
          const fill = piFill(lineEntry(line));
          if (fill) state = fill;
        }
      }
    } else {
      for (const e of parseJsonl(text)) {
        const fill = claudeFill(e);
        if (fill) state = fill;
      }
    }
    if (state === null || state === "compacted") return state;
    return { tokens: state.tokens, window: format === "pi" && state.model ? resolve(state.model) : null };
  };
}
