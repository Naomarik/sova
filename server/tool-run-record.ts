/**
 * The tool-run store's record: one line per tool call an agent ran, written by the chat process that ran
 * it the moment the call ends, so time spent running tools counts even when the turn is stopped right
 * after (a reply's timing record is written when the reply finishes, before its tools run:
 * server/perf-record.ts).
 *
 * Files: `<agent dir>/usage/tools/v1/<UTC yyyy-mm-dd of end>/<producer>.jsonl`, beside the reply-timing
 * store and under its rules: `producer` is the writing process's llm-inflight producer id, so every file
 * has exactly one writer and needs no lock; each record is one `appendFileSync` of one `\n`-terminated
 * line; a reader takes only terminated lines and deduplicates by `key`. Never pruned. A chat on older code
 * writes none: readers treat the store as possibly absent.
 *
 * `kind`: `worker-wait` for a call that waits on the session's own workers (its time is the workers', never
 * added to the agents' total again), `tool` for every other call.
 *
 * Node builtins only. Never throws from the writer: recording is observation and never fails or holds
 * up a turn.
 */
import fs from "node:fs";
import path from "node:path";
import { PERF_KINDS, type PerfKind } from "./perf-record";

export const TOOL_RUN_RECORD_VERSION = 1;
/** Under the agent dir. */
export const TOOL_RUN_DIR_NAME = path.join("usage", "tools", "v1");

export type ToolRunKind = "tool" | "worker-wait";
export const TOOL_RUN_KINDS: readonly ToolRunKind[] = ["tool", "worker-wait"];

/** Tools that wait on the calling session's own workers, by their name without a server prefix. */
export const WORKER_WAIT_TOOLS: ReadonlySet<string> = new Set(["agent_wait"]);

/** A call's kind by its tool's name: a wait on workers, or any other tool. */
export const toolRunKindOf = (toolName: string | undefined): ToolRunKind =>
  toolName !== undefined && WORKER_WAIT_TOOLS.has(toolName.split("__").pop()!.toLowerCase()) ? "worker-wait" : "tool";

export interface ToolRunRecord {
  v: 1;
  /** `<sid>:<callId>`: the reader's dedup key. */
  key: string;
  /** The session the call belongs to (pi session id). */
  sid: string;
  /** ms epoch: the call began. */
  start: number;
  /** ms epoch: the call ended (or the turn stopped with it open). Also picks the day directory (UTC). */
  end: number;
  kind: ToolRunKind;
  /** The writing process (llm-inflight's producer id); also the file's name. */
  producer: string;
  /** This host's Sova id (`<agent dir>/sova/host.json` `id`), or null. */
  device: string | null;
  /** The session's kind, when known (the reply-timing record's `kind`). */
  sk?: PerfKind;
  /** The tool's name, when known. */
  tool?: string;
}

/** Above any real call (ms): a week. */
export const MAX_TOOL_RUN_MS = 7 * 86_400_000;
/** A record line is at most this long. */
export const MAX_TOOL_RUN_BYTES = 1024;

const PRODUCER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const epoch = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER;
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

/** `<agent dir>/usage/tools/v1`. */
export const toolRunRoot = (agentDir: string): string => path.join(agentDir, TOOL_RUN_DIR_NAME);
/** The file a producer's record ending at `end` goes to. */
export const toolRunFilePath = (agentDir: string, end: number, producer: string): string =>
  path.join(toolRunRoot(agentDir), new Date(end).toISOString().slice(0, 10), `${producer}.jsonl`);

/**
 * The strict parse: a record exactly as this version writes it, or null. Unknown fields are ignored; a
 * wrong type in a known one refuses the whole record. The result carries only known fields, in the
 * canonical order.
 */
export function normalizeToolRunRecord(value: unknown): ToolRunRecord | null {
  if (!isObj(value) || value.v !== 1) return null;
  const r = value;
  if (!text(r.key, 512) || !text(r.sid, 200)) return null;
  if (!epoch(r.start) || !epoch(r.end) || r.end < r.start || r.end - r.start > MAX_TOOL_RUN_MS) return null;
  if (!TOOL_RUN_KINDS.includes(r.kind as ToolRunKind)) return null;
  if (!(typeof r.producer === "string" && PRODUCER_RE.test(r.producer))) return null;
  if (!(r.device === null || text(r.device, 64))) return null;
  if (r.sk !== undefined && !PERF_KINDS.includes(r.sk as PerfKind)) return null;
  if (r.tool !== undefined && !text(r.tool, 256)) return null;
  return {
    v: 1,
    key: r.key,
    sid: r.sid,
    start: r.start,
    end: r.end,
    kind: r.kind as ToolRunKind,
    producer: r.producer,
    device: r.device as string | null,
    ...(r.sk !== undefined ? { sk: r.sk as PerfKind } : {}),
    ...(r.tool !== undefined ? { tool: r.tool as string } : {}),
  };
}

/** One line of a store file (with or without its `\n`), or null when it isn't a record. */
export function parseToolRunLine(line: string): ToolRunRecord | null {
  const s = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!s || s.length > MAX_TOOL_RUN_BYTES) return null;
  try {
    return normalizeToolRunRecord(JSON.parse(s));
  } catch {
    return null;
  }
}

/** The line for `record` (canonical order, `\n`-terminated), or null when it doesn't parse back. */
export function formatToolRunRecord(record: ToolRunRecord): string | null {
  const normal = normalizeToolRunRecord(record);
  if (!normal) return null;
  const line = `${JSON.stringify(normal)}\n`;
  return Buffer.byteLength(line) <= MAX_TOOL_RUN_BYTES ? line : null;
}

interface WriterState {
  dirs: Set<string>;
  failures: number;
}
const WRITER_KEY = Symbol.for("sova.tool-run-record.v1");
function writer(): WriterState {
  const g = globalThis as unknown as Record<symbol, WriterState | undefined>;
  return (g[WRITER_KEY] ??= { dirs: new Set(), failures: 0 });
}

/** Appends refused or failed so far in this process. */
export const toolRunWriteFailures = (): number => writer().failures;

/** Append one record to its producer's file for its day; false when refused or failed. Never throws. */
export function appendToolRunRecord(record: ToolRunRecord, agentDir: string): boolean {
  const w = writer();
  try {
    const line = formatToolRunRecord(record);
    if (!line) {
      w.failures++;
      return false;
    }
    const file = toolRunFilePath(agentDir, record.end, record.producer);
    const dir = path.dirname(file);
    if (!w.dirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      w.dirs.add(dir);
    }
    try {
      fs.appendFileSync(file, line);
    } catch {
      // The day's directory went away under a cached mkdir: make it again, once.
      w.dirs.delete(dir);
      fs.mkdirSync(dir, { recursive: true });
      w.dirs.add(dir);
      fs.appendFileSync(file, line);
    }
    return true;
  } catch {
    w.failures++;
    return false;
  }
}

/** Where a finished call's record goes and who it names: what the timer asks of its chat. */
export interface ToolRunSink {
  /** Who a record names, read when its call starts. */
  who(): { sid: string; sk?: PerfKind; device: string | null; producer: string };
  write(record: ToolRunRecord): void;
}

interface OpenCall {
  start: number;
  kind: ToolRunKind;
  tool?: string;
  who: ReturnType<ToolRunSink["who"]>;
}

/**
 * The open calls of one chat, by call id: `start` at a call's start, `end` at its end writes its record.
 * `settle` closes every call still open (a stopped turn, a chat going away) at that moment, so a call
 * whose end never arrives still counts up to the stop. Only top-level calls: a call another tool made is
 * its caller's time. Never throws.
 */
export class ToolRunTimer {
  private open = new Map<string, OpenCall>();

  constructor(
    private readonly sink: ToolRunSink,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many calls are open now. */
  get openCount(): number {
    return this.open.size;
  }

  start(callId: string, toolName: string | undefined): void {
    if (!callId || this.open.has(callId)) return;
    try {
      // Who it names is taken now: a rebind may change the session before the call ends.
      this.open.set(callId, { start: this.now(), kind: toolRunKindOf(toolName), ...(toolName ? { tool: toolName } : {}), who: this.sink.who() });
    } catch (err) {
      console.error("[chat] tool run record failed", err);
    }
  }

  end(callId: string): void {
    const call = this.open.get(callId);
    if (!call) return;
    this.open.delete(callId);
    this.write(callId, call, this.now());
  }

  /** Close every open call now. */
  settle(): void {
    if (!this.open.size) return;
    const at = this.now();
    const calls = [...this.open];
    this.open.clear();
    for (const [callId, call] of calls) this.write(callId, call, at);
  }

  private write(callId: string, call: OpenCall, end: number): void {
    const { start, kind, tool } = call;
    try {
      const { sid, sk, device, producer } = call.who;
      this.sink.write({
        v: 1,
        key: `${sid}:${callId}`,
        sid,
        start,
        end: Math.max(start, end),
        kind,
        producer,
        device,
        ...(sk ? { sk } : {}),
        // A name the parse would refuse is left out, never the record.
        ...(tool && text(tool) ? { tool } : {}),
      });
    } catch (err) {
      console.error("[chat] tool run record failed", err);
    }
  }
}
