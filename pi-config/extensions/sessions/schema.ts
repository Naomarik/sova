/**
 * Live-record data contract (v1 envelope + additive schemaVersion 2).
 *
 * Authoritative definition of ~/.pi/agent/sessions/live/<id>.json, shared by the
 * pi extension, the overlay and the standalone `pi-sessions` CLI. This file is
 * executed directly by `node` (type stripping, no jiti, no pi packages): import
 * ONLY node builtins and relative `.ts` files, use ONLY erasable TypeScript.
 *
 * PRIVACY BAR — records NEVER contain user prompts, thinking blocks, full tool
 * output, bash commands, or session file contents (sessionFile is a path only).
 * Assistant text is bounded (preview ≤2000 chars, activity.error ≤200).
 * activity.toolDetail is a tool name plus a file BASENAME only, never commands
 * or arguments. Outline text is an LLM paraphrase (lastHeading may be a
 * user-typed `#` heading) gated by topic-outline's own sharing settings.
 * The live directory is created with mode 0700.
 *
 * Compatibility: `v: 1` is frozen forever; `schemaVersion: 2` marks v2 writers
 * (absent ⇒ legacy v1). Every v1 field keeps its exact v1 meaning; v2 fields are
 * optional. Readers ignore unknown keys and coerce unknown enum values to safe
 * defaults ("idle" for session state, "running" for worker state).
 */
import { isFocusTarget, type FocusTarget } from "./focus.ts";

export type { FocusTarget };

export const SCHEMA_VERSION = 2;
export type SessionState = "working" | "idle" | "needs-input" | "error";
export type WorkerState = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed";
export type OutlineState = "none" | "drafting" | "fresh" | "updating" | "stale" | "failed-keeping-last";

export const SESSION_STATES: readonly SessionState[] = ["working", "idle", "needs-input", "error"];
export const WORKER_STATES: readonly WorkerState[] = ["starting", "running", "waiting", "stopping", "done", "error", "killed"];
export const OUTLINE_STATES: readonly OutlineState[] = ["none", "drafting", "fresh", "updating", "stale", "failed-keeping-last"];
export const SESSION_MODES: readonly NonNullable<SessionMeta["mode"]>[] = ["tui", "rpc", "json", "print"];
export const WORKER_OUTCOMES: readonly NonNullable<WorkerEntry["outcome"]>[] = ["success", "error", "aborted"];

/** Total serialized UTF-8 budget enforced by fit(). */
export const RECORD_BUDGET = 16_384;
export const MAX_WORKERS = 40;
/** WorkerEntry.sessionFile/sessionId caps (same as session.sessionFile/sessionId). */
export const WORKER_SESSION_FILE_MAX = 1024;
export const WORKER_SESSION_ID_MAX = 64;
/** Records dated further in the future than this are treated as garbage. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface SessionMeta {
  /** "p<pid>-<8hex>", equals the file stem. */
  id: string;
  endpointEpoch?: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  /** ms epoch of the last write. */
  lastActivity: number;
  /** v1 free-text label, frozen semantics ("Idle", "Running: bash", …). */
  status?: string;
  /** pi session uuid. */
  sessionId?: string;
  /** Absolute JSONL transcript path (path only, never contents). */
  sessionFile?: string;
  mode?: "tui" | "rpc" | "json" | "print";
  host?: string;
  piVersion?: string;
}

/** Superset of v1 WorkerSummary. `status` stays free text; see workerState(). */
export interface WorkerEntry {
  id: string;
  name: string;
  status: string;
  model?: string;
  preview?: string;
  backend?: string;
  /** Absolute path of the worker's own transcript JSONL; never its contents. Read-only for consumers. */
  sessionFile?: string;
  /** Backend session id (Claude's session id for claude-code workers). */
  sessionId?: string;
  startedAt?: number;
  lastActivity?: number;
  endedAt?: number;
  outcome?: "success" | "error" | "aborted";
  /** Token counts this worker has used so far. Counts only, never text; cost in USD when the backend reports one. */
  usage?: WorkerUsage;
}

/** Cumulative token counts. Non-negative integers; `cost` is USD and may be fractional. */
export interface WorkerUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }

/** Σ across every worker the session ever spawned, including ones retention dropped.
 *  `workers` is that lifetime count, so it can exceed `workers.length` and workerCounts.total. */
export interface WorkerUsageTotal extends WorkerUsage { workers: number }

/** working = starting|running|stopping (and unknown statuses). */
export interface WorkerCounts { total: number; working: number; waiting: number; done: number; error: number; killed: number }

export interface Outline {
  now?: string;
  overall?: string;
  topics?: string[];
  lastHeading?: string;
  state?: OutlineState;
  generatedAt?: number;
  detail?: { heading: string; bullets: string[] }[];
}

export interface Activity {
  state: SessionState;
  since: number;
  /** ≤6 currently-executing tool names. */
  tools?: string[];
  /** e.g. "edit · auth.ts" — basename only, NEVER commands/args. */
  toolDetail?: string;
  /** Only when state === "error". */
  error?: string;
  lastAssistantAt?: number;
  lastToolAt?: number;
  lastPromptAt?: number;
  /** Settled agent runs in this process. */
  turns?: number;
  /** ≤16 tool-execution counts per bucket, oldest first. */
  buckets?: number[];
  bucketMs?: number;
}

export interface Presence {
  type: "presence";
  version: 1;
  status: string;
  since: number;
  completed: number;
  preview: string;
  workers: WorkerEntry[];
  target?: FocusTarget;
  outline?: Outline;
  activity?: Activity;
  workerCounts?: WorkerCounts;
  /** (v2) lifetime token Σ across all workers, surviving the workers[] cap. */
  workerUsage?: WorkerUsageTotal;
  focusable?: boolean;
  focusReason?: string;
  previewAt?: number;
}

export interface LiveRecord {
  v: 1;
  schemaVersion?: 2;
  session: SessionMeta;
  presence?: Presence;
  /** pi-internal transient control traffic; consumers must ignore. */
  note?: { payload: unknown; at: number };
  heartbeat: number;
}

export function clean(value: string, limit = 2000): string {
  // Do not let model output or peer metadata inject terminal controls.
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, limit);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const str = (v: unknown, limit: number): string | undefined => typeof v === "string" ? clean(v, limit) : undefined;
const whole = (v: unknown, limit: number): string | undefined =>
  typeof v === "string" && v.length <= limit ? clean(v, limit) || undefined : undefined;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? v as T : undefined;

/** Copy only defined keys so parsed records round-trip through JSON unchanged. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

/** Token counts are advisory: a malformed field is 0, a wholly malformed object is dropped.
 *  Non-finite, negative and non-integer counts never reach a consumer. */
function parseUsage(value: unknown): WorkerUsage | undefined {
  if (!isObj(value)) return;
  const tokens = (v: unknown) => (num(v) && v >= 0 ? Math.floor(v) : 0);
  const cost = num(value.cost) && value.cost > 0 ? value.cost : undefined;
  const usage: WorkerUsage = {
    input: tokens(value.input), output: tokens(value.output),
    cacheRead: tokens(value.cacheRead), cacheWrite: tokens(value.cacheWrite),
  };
  return compact({ ...usage, cost });
}

function parseUsageTotal(value: unknown): WorkerUsageTotal | undefined {
  const usage = parseUsage(value);
  if (!usage || !isObj(value)) return;
  return { ...usage, workers: count(value.workers) ? value.workers : 0 };
}

function parseWorker(value: unknown): WorkerEntry | undefined {
  if (!isObj(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.status !== "string") return;
  return compact({
    id: clean(value.id, 150), name: clean(value.name, 120), status: clean(value.status, 80),
    model: str(value.model, 100), preview: str(value.preview, 180), backend: str(value.backend, 32),
    // Truncating a path/id would point elsewhere: empty or over-limit ⇒ dropped.
    sessionFile: whole(value.sessionFile, WORKER_SESSION_FILE_MAX),
    sessionId: whole(value.sessionId, WORKER_SESSION_ID_MAX),
    startedAt: num(value.startedAt) ? value.startedAt : undefined,
    lastActivity: num(value.lastActivity) ? value.lastActivity : undefined,
    endedAt: num(value.endedAt) ? value.endedAt : undefined,
    outcome: oneOf(value.outcome, WORKER_OUTCOMES),
    usage: parseUsage(value.usage),
  });
}

/** Tolerant outline parser. v1 fields keep v1 strictness (malformed ⇒ no outline);
 *  v2 fields (state enum, detail) are dropped individually when invalid. */
export function parseOutline(value: unknown): Outline | undefined {
  if (!isObj(value)) return;
  const out: Outline = {};
  if (value.now !== undefined) {
    if (typeof value.now !== "string") return;
    out.now = clean(value.now, 160);
  }
  if (value.overall !== undefined) {
    if (typeof value.overall !== "string") return;
    out.overall = clean(value.overall, 300);
  }
  if (value.topics !== undefined) {
    if (!Array.isArray(value.topics) || value.topics.some(t => typeof t !== "string")) return;
    out.topics = value.topics.slice(0, 12).map(t => clean(t as string, 60));
  }
  if (value.generatedAt !== undefined) {
    if (!num(value.generatedAt)) return;
    out.generatedAt = value.generatedAt;
  }
  if (value.lastHeading !== undefined) {
    if (typeof value.lastHeading !== "string") return;
    const heading = clean(value.lastHeading, 80).trim();
    if (heading) out.lastHeading = heading;
  }
  const state = oneOf(value.state, OUTLINE_STATES);
  if (state) out.state = state;
  if (Array.isArray(value.detail)) {
    const detail = value.detail.filter(isObj).filter(d => typeof d.heading === "string" && Array.isArray(d.bullets))
      .slice(0, 6).map(d => ({ heading: clean(d.heading as string, 80),
        bullets: (d.bullets as unknown[]).filter(b => typeof b === "string").slice(0, 3).map(b => clean(b as string, 120)) }));
    if (detail.length) out.detail = detail;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseActivity(value: unknown): Activity | undefined {
  if (!isObj(value) || !num(value.since)) return;
  const state = oneOf(value.state, SESSION_STATES) ?? "idle";
  const tools = Array.isArray(value.tools)
    ? value.tools.filter(t => typeof t === "string").slice(0, 6).map(t => clean(t as string, 40)) : undefined;
  const buckets = Array.isArray(value.buckets) && value.buckets.every(count)
    ? (value.buckets as number[]).slice(-16) : undefined;
  return compact({
    state, since: value.since, tools, toolDetail: str(value.toolDetail, 60),
    error: state === "error" ? str(value.error, 200) : undefined,
    lastAssistantAt: num(value.lastAssistantAt) ? value.lastAssistantAt : undefined,
    lastToolAt: num(value.lastToolAt) ? value.lastToolAt : undefined,
    lastPromptAt: num(value.lastPromptAt) ? value.lastPromptAt : undefined,
    turns: count(value.turns) ? value.turns : undefined,
    buckets, bucketMs: num(value.bucketMs) && value.bucketMs > 0 ? value.bucketMs : undefined,
  });
}

function parseCounts(value: unknown): WorkerCounts | undefined {
  if (!isObj(value)) return;
  const { total, working, waiting, done, error, killed } = value;
  if (![total, working, waiting, done, error, killed].every(count)) return;
  return { total, working, waiting, done, error, killed } as WorkerCounts;
}

/** Tolerant superset of the v1 parser: v1 required fields stay mandatory, new
 *  optional fields are validated when present, unknown keys are ignored, and an
 *  invalid optional field never drops the presence. */
export function parsePresence(value: unknown): Presence | undefined {
  if (!isObj(value)) return;
  const p = value;
  if (p.type !== "presence" || p.version !== 1 || typeof p.status !== "string" || !num(p.since)
    || !num(p.completed) || typeof p.preview !== "string" || !Array.isArray(p.workers)) return;
  const workers: WorkerEntry[] = [];
  for (const w of p.workers.slice(0, MAX_WORKERS)) {
    const worker = parseWorker(w);
    if (!worker) return; // v1 semantics: a malformed worker invalidates the snapshot
    workers.push(worker);
  }
  return compact({
    type: "presence", version: 1, status: clean(p.status, 100), since: p.since, completed: p.completed,
    preview: clean(p.preview), workers,
    target: isFocusTarget(p.target) ? p.target : undefined,
    outline: parseOutline(p.outline),
    activity: parseActivity(p.activity),
    workerCounts: parseCounts(p.workerCounts),
    workerUsage: parseUsageTotal(p.workerUsage),
    focusable: typeof p.focusable === "boolean" ? p.focusable : undefined,
    focusReason: str(p.focusReason, 120),
    previewAt: num(p.previewAt) ? p.previewAt : undefined,
  } as Presence);
}

function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 128 && clean(v) === v && !/[\/\\]/.test(v);
}

function parseSession(value: unknown): SessionMeta | undefined {
  if (!isObj(value)) return;
  const s = value;
  if (!validId(s.id) || !Number.isSafeInteger(s.pid) || (s.pid as number) <= 0
    || typeof s.cwd !== "string" || typeof s.model !== "string" || !num(s.startedAt) || !num(s.lastActivity)
    || (s.name !== undefined && typeof s.name !== "string")) return;
  return compact({
    id: s.id, endpointEpoch: str(s.endpointEpoch, 64), name: str(s.name, 80),
    cwd: clean(s.cwd, 300), model: clean(s.model, 160), pid: s.pid as number,
    startedAt: s.startedAt, lastActivity: s.lastActivity, status: str(s.status, 100),
    sessionId: str(s.sessionId, 64), sessionFile: str(s.sessionFile, 1024),
    mode: oneOf(s.mode, SESSION_MODES), host: str(s.host, 64), piVersion: str(s.piVersion, 32),
  });
}

/** Full validation of one live file. Malformed ⇒ undefined; never throws.
 *  A present-but-invalid presence block is omitted (the session stays listed as
 *  basic metadata, exactly as v1 readers treat it). schemaVersion > 2 means a
 *  breaking change this reader cannot interpret ⇒ undefined. */
export function parseLiveRecord(value: unknown, now = Date.now()): LiveRecord | undefined {
  try {
    if (!isObj(value) || value.v !== 1 || !num(value.heartbeat) || value.heartbeat > now + FUTURE_SKEW_MS) return;
    if (typeof value.schemaVersion === "number" && value.schemaVersion > SCHEMA_VERSION) return;
    const session = parseSession(value.session);
    if (!session) return;
    const note = value.note;
    return compact<LiveRecord>({
      v: 1, schemaVersion: value.schemaVersion === SCHEMA_VERSION ? 2 : undefined, session,
      presence: value.presence === undefined ? undefined : parsePresence(value.presence),
      note: isObj(note) && num(note.at) ? { payload: note.payload, at: note.at } : undefined,
      heartbeat: value.heartbeat,
    });
  } catch {
    return;
  }
}

/** Activity state, falling back to the legacy free-text status mapping. */
export function deriveState(p: Presence | undefined, session: SessionMeta): SessionState {
  if (p?.activity) return p.activity.state;
  const status = p?.status ?? session.status ?? "";
  if (/^Running/.test(status)) return "working";
  if (status === "Needs input") return "needs-input";
  if (/^Error|error/.test(status)) return "error";
  return "idle";
}

const WORKER_ALIASES: Record<string, WorkerState> = {
  busy: "running", working: "running", active: "running", idle: "waiting",
  completed: "done", complete: "done", finished: "done", success: "done", succeeded: "done",
  failed: "error", failure: "error", errored: "error",
  aborted: "killed", cancelled: "killed", canceled: "killed", stopped: "killed",
};

/** Normalise a free-text worker status; unknown ⇒ "running" (safe default). */
export function workerState(status: string): WorkerState {
  const s = status.trim().toLowerCase();
  return oneOf(s, WORKER_STATES) ?? WORKER_ALIASES[s] ?? "running";
}

export function isFinishedWorker(worker: WorkerEntry): boolean {
  const s = workerState(worker.status);
  return s === "done" || s === "error" || s === "killed";
}

export function countWorkers(workers: WorkerEntry[]): WorkerCounts {
  const counts: WorkerCounts = { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0 };
  for (const w of workers) {
    counts.total++;
    const s = workerState(w.status);
    if (s === "waiting" || s === "done" || s === "error" || s === "killed") counts[s]++;
    else counts.working++;
  }
  return counts;
}

const bytes = (record: LiveRecord) => Buffer.byteLength(JSON.stringify(record));

/** Enforce the TOTAL serialized UTF-8 budget. Drop order: outline.detail,
 *  activity.buckets, preview → 600 chars, outline.overall+topics, per-worker
 *  usage, then workers (finished ones first, otherwise from the end).
 *  workerCounts and workerUsage are kept so the tallies stay truthful after
 *  truncation. Mutates and returns; never throws. */
export function fit(record: LiveRecord, budget = RECORD_BUDGET): LiveRecord {
  try {
    const p = record.presence;
    if (!p || bytes(record) <= budget) return record;
    if (p.outline?.detail) { delete p.outline.detail; if (bytes(record) <= budget) return record; }
    if (p.activity?.buckets) { delete p.activity.buckets; if (bytes(record) <= budget) return record; }
    const chars = Array.from(p.preview);
    if (chars.length > 600) { p.preview = chars.slice(0, 600).join(""); if (bytes(record) <= budget) return record; }
    if (p.outline && (p.outline.overall !== undefined || p.outline.topics)) {
      delete p.outline.overall; delete p.outline.topics;
      if (bytes(record) <= budget) return record;
    }
    // A row's own counts go before the row itself; the Σ in workerUsage survives either way.
    if (p.workers.some(w => w.usage)) {
      for (const w of p.workers) delete w.usage;
      if (bytes(record) <= budget) return record;
    }
    while (p.workers.length && bytes(record) > budget) {
      let index = -1;
      for (let i = p.workers.length - 1; i >= 0; i--) if (isFinishedWorker(p.workers[i])) { index = i; break; }
      p.workers.splice(index === -1 ? p.workers.length - 1 : index, 1);
    }
  } catch { /* never throw from a writer path */ }
  return record;
}
