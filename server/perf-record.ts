/**
 * The reply-timing store's record (§app.insights/reply-timing): one line per finished, measured
 * assistant reply, written once at its end by the chat process that ran it.
 *
 * Files: `<agent dir>/usage/perf/v1/<UTC yyyy-mm-dd of ts>/<producer>.jsonl`, beside the usage ledger
 * (pi-config/extensions/llm-inflight/usage-record.ts) and under its rules: `producer` is the writing
 * process's llm-inflight producer id, so every file has exactly one writer and needs no lock; each
 * record is one `appendFileSync` of one `\n`-terminated line; a reader takes only terminated lines
 * and deduplicates by `key`. Never pruned.
 *
 * Node builtins only. Never throws from the writer: measuring is observation and never fails or holds
 * up a reply. The usage helper's reader (server/usage-helper/perf-store.ts) reads these fields.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReplyTiming } from "../shared/harness-wire";

export const PERF_RECORD_VERSION = 1;
/** Under the agent dir. */
export const PERF_DIR_NAME = path.join("usage", "perf", "v1");

/** The session kinds a record names (the usage ledger's, less `oneshot`: a side call is never timed). */
export type PerfKind = "main" | "worker" | "overseer";
export const PERF_KINDS: readonly PerfKind[] = ["main", "worker", "overseer"];

/** How a measured reply ended: only a finished reply is recorded. */
export type PerfStop = "stop" | "length" | "toolUse";
export const PERF_STOPS: readonly PerfStop[] = ["stop", "length", "toolUse"];

/** One part kind's summed windows: total ms and how many parts. */
export interface PerfWindow {
  ms: number;
  n: number;
}

export interface PerfRecord {
  v: 1;
  /** `<sid>:<entryId>`: the reader's dedup key. */
  key: string;
  /** ms epoch: the reply's end. Also picks the day directory (UTC). */
  ts: number;
  /** This host's Sova id (`<agent dir>/sova/host.json` `id`), or null. */
  device: string | null;
  /** The writing process (llm-inflight's producer id); also the file's name. */
  producer: string;
  /** The session the reply belongs to (pi session id). */
  sid: string;
  /** The entry the reply was written as. */
  entryId: string;
  /** The session's kind, when known. */
  kind?: PerfKind;
  /** Provider id as the reply names it (`zai`, `claude-code-cli`, `openai-codex`, …). */
  provider: string;
  /** The model asked for. */
  model: string;
  /** The model the provider says answered, when it says. */
  responseModel?: string;
  /** The thinking level the reply was requested at (`off` when none), when known. */
  effort?: string;
  /** The provider-native level it ran at, when the provider says. */
  providerEffort?: string;
  stop: PerfStop;
  /** ms epoch: the request went out. */
  sentAt: number;
  /** Request sent to the first part of any kind. */
  ttftMs: number;
  /** Thinking parts' windows, summed (0: no thinking). */
  thinkingMs: number;
  /** Text and tool-call parts' windows, summed (`textMs + toolMs`). */
  replyMs: number;
  thinking: PerfWindow;
  text: PerfWindow;
  tool: PerfWindow;
  /** Request sent to the reply's end. */
  endMs: number;
  /** Every output token, thinking included. */
  output: number;
  /** The provider's thinking-token count, only where the split is real: absent when not reported,
      and absent when a 0 was reported for a reply with a thinking window. Never a guessed 0. */
  reasoning?: number;
}

/** Above any real reply: a bound on a buggy report. */
export const MAX_PERF_TOKENS = 1e9;
/** Above any real reply's duration (ms): a week. */
export const MAX_PERF_MS = 7 * 86_400_000;
/** A record line is at most this long. */
export const MAX_PERF_BYTES = 2048;

const PRODUCER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const windowOf = (v: unknown): PerfWindow | null => (isObj(v) && int(v.ms, MAX_PERF_MS) && int(v.n, 1e6) ? { ms: v.ms, n: v.n } : null);

/** `<agent dir>/usage/perf/v1`. */
export const perfRoot = (agentDir: string): string => path.join(agentDir, PERF_DIR_NAME);
/** The file a producer's record at `ts` goes to. */
export const perfFilePath = (agentDir: string, ts: number, producer: string): string =>
  path.join(perfRoot(agentDir), new Date(ts).toISOString().slice(0, 10), `${producer}.jsonl`);

/**
 * The strict parse: a record exactly as this version writes it, or null. Unknown fields are ignored;
 * a wrong type in a known one refuses the whole record. The result carries only known fields, in the
 * canonical order.
 */
export function normalizePerfRecord(value: unknown): PerfRecord | null {
  if (!isObj(value) || value.v !== 1) return null;
  const r = value;
  if (!text(r.key, 512) || !int(r.ts, Number.MAX_SAFE_INTEGER) || r.ts === 0) return null;
  if (!(r.device === null || text(r.device, 64))) return null;
  if (!(typeof r.producer === "string" && PRODUCER_RE.test(r.producer))) return null;
  if (!text(r.sid, 200) || !text(r.entryId, 200)) return null;
  if (r.kind !== undefined && !PERF_KINDS.includes(r.kind as PerfKind)) return null;
  if (!text(r.provider, 128) || !text(r.model, 256)) return null;
  if (r.responseModel !== undefined && !text(r.responseModel, 256)) return null;
  if (r.effort !== undefined && !text(r.effort, 32)) return null;
  if (r.providerEffort !== undefined && !text(r.providerEffort, 32)) return null;
  if (!PERF_STOPS.includes(r.stop as PerfStop)) return null;
  if (!int(r.sentAt, Number.MAX_SAFE_INTEGER)) return null;
  for (const k of ["ttftMs", "thinkingMs", "replyMs", "endMs"] as const) if (!int(r[k], MAX_PERF_MS)) return null;
  const thinking = windowOf(r.thinking);
  const textW = windowOf(r.text);
  const tool = windowOf(r.tool);
  if (!thinking || !textW || !tool) return null;
  if (!int(r.output, MAX_PERF_TOKENS)) return null;
  if (r.reasoning !== undefined && !(int(r.reasoning, MAX_PERF_TOKENS) && r.reasoning <= r.output)) return null;
  return {
    v: 1,
    key: r.key,
    ts: r.ts,
    device: r.device as string | null,
    producer: r.producer,
    sid: r.sid,
    entryId: r.entryId,
    ...(r.kind !== undefined ? { kind: r.kind as PerfKind } : {}),
    provider: r.provider,
    model: r.model,
    ...(r.responseModel !== undefined ? { responseModel: r.responseModel as string } : {}),
    ...(r.effort !== undefined ? { effort: r.effort as string } : {}),
    ...(r.providerEffort !== undefined ? { providerEffort: r.providerEffort as string } : {}),
    stop: r.stop as PerfStop,
    sentAt: r.sentAt,
    ttftMs: r.ttftMs as number,
    thinkingMs: r.thinkingMs as number,
    replyMs: r.replyMs as number,
    thinking,
    text: textW,
    tool,
    endMs: r.endMs as number,
    output: r.output,
    ...(r.reasoning !== undefined ? { reasoning: r.reasoning as number } : {}),
  };
}

/** One line of a store file (with or without its `\n`), or null when it isn't a record. */
export function parsePerfRecordLine(line: string): PerfRecord | null {
  const s = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!s || s.length > MAX_PERF_BYTES) return null;
  try {
    return normalizePerfRecord(JSON.parse(s));
  } catch {
    return null;
  }
}

/** The line for `record` (canonical order, `\n`-terminated), or null when it doesn't parse back. */
export function formatPerfRecord(record: PerfRecord): string | null {
  const normal = normalizePerfRecord(record);
  if (!normal) return null;
  const line = `${JSON.stringify(normal)}\n`;
  return Buffer.byteLength(line) <= MAX_PERF_BYTES ? line : null;
}

interface WriterState {
  dirs: Set<string>;
  failures: number;
}
const WRITER_KEY = Symbol.for("sova.perf-record.v1");
function writer(): WriterState {
  const g = globalThis as unknown as Record<symbol, WriterState | undefined>;
  return (g[WRITER_KEY] ??= { dirs: new Set(), failures: 0 });
}

/** Appends refused or failed so far in this process. */
export const perfWriteFailures = (): number => writer().failures;

/** Append one record to its producer's file for its day; false when refused or failed. Never throws. */
export function appendPerfRecord(record: PerfRecord, agentDir: string): boolean {
  const w = writer();
  try {
    const line = formatPerfRecord(record);
    if (!line) {
      w.failures++;
      return false;
    }
    const file = perfFilePath(agentDir, record.ts, record.producer);
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

/** A record's timing as the reply card and a row's `reply` fact read it (the helper's perf-store maps a
    stored record the same way). */
export function replyTimingOf(rec: PerfRecord): ReplyTiming {
  return {
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ttftMs: rec.ttftMs,
    thinkingMs: rec.thinkingMs,
    replyMs: rec.replyMs,
    ...(rec.tool.n > 0 ? { toolCalls: rec.tool.n } : {}),
    ...(rec.thinking.n > 0 ? { thinkingParts: rec.thinking.n } : {}),
    output: rec.output,
    ...(rec.reasoning !== undefined ? { reasoning: rec.reasoning } : {}),
  };
}
