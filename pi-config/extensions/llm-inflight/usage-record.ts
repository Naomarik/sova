/**
 * The usage ledger's record (Sova's §app.insights/usage-ledger): one line per model call, written
 * once at the call's end by the process that made it. Token counts only, never a price: a reader
 * prices them with the rate in force at `ts`.
 *
 * Files: `<agent dir>/usage/v1/<UTC yyyy-mm-dd of ts>/<producer>.jsonl`. `producer` is the writing
 * process's llm-inflight producer id (tracker.ts), so every file has exactly one writer and needs no
 * lock; each record is one `appendFileSync` of one `\n`-terminated line. A reader takes only
 * terminated lines (a crash leaves at most one partial trailing line) and deduplicates by `key`, so
 * a replayed stream or a record written twice adds nothing.
 *
 * Node builtins only, imports nothing else: Sova's server imports this file (its own one-shots
 * write through it, its usage helper parses with it). Never throws from the writer: recording is
 * observation and never fails a call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USAGE_RECORD_VERSION = 1;
/** Under the agent dir. */
export const USAGE_DIR_NAME = path.join("usage", "v1");

/**
 * What the call was, from the ledger's point of view. `main`: a session's own conversation (a
 * coding session, a baton or org session, a TUI session) and its housekeeping (compaction, branch
 * summaries, cache warming); `overseer`: the Overseer's or a project overseer's conversation;
 * `worker`: a subagent or team member at any depth, pi or Claude Code; `oneshot`: a side call made
 * for a session or for Sova (a title, a decision, a topic outline, an image description).
 */
export type UsageKind = "main" | "worker" | "overseer" | "oneshot";
export const USAGE_KINDS: readonly UsageKind[] = ["main", "worker", "overseer", "oneshot"];

/**
 * Which observer wrote it. `pi`: the pi model runtime's stream end; `claude`: one Anthropic message
 * of a Claude Code CLI's stream; `claude-residual`: what a CLI's cumulative per-model totals show
 * beyond its streamed messages (its own subagents, side queries, compaction); `claude-p`: a
 * `claude -p --output-format json` envelope; `jev`: a Jev answer.
 */
export type UsageSource = "pi" | "claude" | "claude-residual" | "claude-p" | "jev";
export const USAGE_SOURCES: readonly UsageSource[] = ["pi", "claude", "claude-residual", "claude-p", "jev"];

/** Who started a project call (Sova's project costs split by it). */
export type UsageStarter = "operator" | "overseer" | "sova";
export const USAGE_STARTERS: readonly UsageStarter[] = ["operator", "overseer", "sova"];

/**
 * Known purposes (a side call's, a session's housekeeping, or a marked turn: `wrapup`, a baton's wrap-up turn). Any short kebab-case word parses, so
 * a new caller needs no schema change; readers group unknown ones as they are.
 */
export const USAGE_PURPOSES = [
	"title",
	"decide",
	"outline",
	"vision",
	"branch-summary",
	"compaction",
	"cache-warm",
	"reconcile",
	"explain",
	"wrapup",
	// A codemode script's classifier and image calls (models.classify / models.generateImages).
	"classify",
	"image",
] as const;

export interface UsageRecord {
	v: 1;
	/**
	 * Names the call; the reader's dedup key. `cc:<message id>` (a Claude Code message, in any
	 * process), `ccr:<claude session id>:<n>` (a residual), `cp:<envelope session id>:<model>` (a
	 * `claude -p` envelope), `pi:<session id>:<message.timestamp>:<provider>/<model>` (a pi reply
	 * that carries its stream-start timestamp), else `<producer>:<seq>`.
	 */
	key: string;
	/** ms epoch: the call's end. Also picks the day directory (UTC) and the price period. */
	ts: number;
	/** This host's Sova id (`<agent dir>/sova/host.json` `id`), or null where Sova never ran. */
	device: string | null;
	/** The writing process (llm-inflight's producer id); also the file's name. */
	producer: string;
	src: UsageSource;
	/** pi provider id as the call named it (`zai`, `claude-code-cli`, `openai-codex`, `jev`, …). */
	provider: string;
	/** The model asked for (`glm-5.3`, `opus[1m]`). */
	model: string;
	/** The model the provider says answered, when it says (pi `responseModel`, Claude `message.model`). */
	responseModel?: string;
	input: number;
	output: number;
	cacheRead: number;
	/** Every cache write, both TTLs. */
	cacheWrite: number;
	/** The 1-hour part of `cacheWrite`, when the provider reports the split (Anthropic). */
	cacheWrite1h?: number;
	/**
	 * The session the call belongs to: a pi session id, or for a Claude Code worker its Claude
	 * session id (what `/ws/watch?claude=` opens). Null for a call no session owns (a Sova decision).
	 */
	owner: string | null;
	/** The owner's parent session (a worker's), when the owner is a worker. */
	parent: string | null;
	/** The worker's id in its parent's roster (`ag_03`), on a worker's calls. */
	worker?: string;
	kind: UsageKind;
	/** A side call's or housekeeping call's purpose, or `wrapup` (USAGE_PURPOSES); absent on an ordinary turn. */
	purpose?: string;
	/** The owner's working directory, when known. */
	cwd?: string;
	/** The org project id (`prj_…`), when the caller knows the call is for one. */
	project?: string;
	/** Who asked for a call made on a project's behalf with no session of its own (a reconcile):
	    `operator`, `overseer` or `sova` (Sova on its own). */
	starter?: UsageStarter;
	/** The reply's stop reason as reported (`stop`, `toolUse`, `error`, `aborted`, …). */
	stop?: string;
	/** On the first call of a Claude Code process the provider bridge launched for a conversation: how
	    it started and why (UsageLaunch). Absent on every other call. */
	launch?: UsageLaunch;
}

/**
 * How a Claude Code process reached its conversation, on that process's first record. `how`
 * (LAUNCH_HOWS): `fresh` (nothing came before the message), `resumed` (Claude's own saved copy
 * picked up, `--resume`), `folded` / `joined` (the history re-sent condensed in one message: after a
 * restart, or to a first process for a conversation that already had history), `view` (a memory
 * view sent as written). `why` (LAUNCH_WHYS) it started; `fallback` (LAUNCH_FALLBACKS), when a saved
 * copy existed or was tried, why it was not resumed. Any short kebab-case word parses, so a new
 * reason needs no schema change; readers group unknown ones as they are.
 */
export interface UsageLaunch {
	how: string;
	why: string;
	fallback?: string;
}

export const LAUNCH_HOWS = ["fresh", "resumed", "folded", "joined", "view"] as const;
/** The `how`s that re-sent the conversation's history in full. */
export const RESEND_HOWS: readonly string[] = ["folded", "joined"];
export const LAUNCH_WHYS = [
	"new",
	"process-start",
	"reaped",
	"ended",
	"model",
	"effort",
	"system-prompt",
	"tools",
	"cwd",
	"diverged",
	"desynced",
	"aborted",
	"tool-results",
	"nothing-new",
	"login-leaving",
	"login-picked",
	"login-failover",
	"fork",
	"oneshot",
] as const;
export const LAUNCH_FALLBACKS = ["login-moved", "not-continuation", "settings-changed", "memory-view", "resume-failed"] as const;

/** Above any real call: a bound on a buggy report, never reached. */
export const MAX_RECORD_TOKENS = 1e10;
/** A record line is at most this long; a longer one is refused (a cwd is the only long field). */
export const MAX_RECORD_BYTES = 4096;

const PRODUCER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PURPOSE_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A launch's how, why or fallback: the purpose's shape. */
const word = (v: unknown): v is string => typeof v === "string" && PURPOSE_RE.test(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A producer id that can name a file. */
export const validProducer = (id: unknown): id is string => typeof id === "string" && PRODUCER_RE.test(id);
/** A day directory's name. */
export const validUsageDay = (day: unknown): day is string => typeof day === "string" && DAY_RE.test(day);

/** The agent dir as pi resolves it: $PI_CODING_AGENT_DIR (with ~), else ~/.pi/agent. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir === "~" ? os.homedir() : dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** `<agent dir>/usage/v1`. */
export const usageRoot = (agentDir: string): string => path.join(agentDir, USAGE_DIR_NAME);
/** The UTC day (`yyyy-mm-dd`) a record at `ts` is filed under. */
export const usageDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** The file a producer's record at `ts` goes to. */
export const usageFilePath = (agentDir: string, ts: number, producer: string): string =>
	path.join(usageRoot(agentDir), usageDay(ts), `${producer}.jsonl`);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_RECORD_TOKENS;
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

/**
 * The strict parse: a record exactly as this version writes it, or null. Unknown fields are
 * ignored (a later minor addition reads as this version); a wrong type in a known one refuses the
 * whole record. The result carries only known fields, in the canonical order.
 */
export function normalizeUsageRecord(value: unknown): UsageRecord | null {
	if (!isObj(value) || value.v !== 1) return null;
	const r = value;
	if (!text(r.key) || !(typeof r.ts === "number" && Number.isInteger(r.ts) && r.ts > 0)) return null;
	if (!(r.device === null || text(r.device, 64))) return null;
	if (!validProducer(r.producer)) return null;
	if (!USAGE_SOURCES.includes(r.src as UsageSource)) return null;
	if (!text(r.provider, 128) || !text(r.model, 256)) return null;
	if (r.responseModel !== undefined && !text(r.responseModel, 256)) return null;
	if (!count(r.input) || !count(r.output) || !count(r.cacheRead) || !count(r.cacheWrite)) return null;
	if (r.cacheWrite1h !== undefined && !(count(r.cacheWrite1h) && r.cacheWrite1h <= r.cacheWrite)) return null;
	if (!(r.owner === null || text(r.owner, 200)) || !(r.parent === null || text(r.parent, 200))) return null;
	if (r.worker !== undefined && !text(r.worker, 64)) return null;
	if (!USAGE_KINDS.includes(r.kind as UsageKind)) return null;
	if (r.purpose !== undefined && !(typeof r.purpose === "string" && PURPOSE_RE.test(r.purpose))) return null;
	if (r.cwd !== undefined && !text(r.cwd, 2048)) return null;
	if (r.project !== undefined && !text(r.project, 64)) return null;
	if (r.starter !== undefined && !USAGE_STARTERS.includes(r.starter as UsageStarter)) return null;
	if (r.stop !== undefined && !text(r.stop, 32)) return null;
	let launch: UsageLaunch | undefined;
	if (r.launch !== undefined) {
		const l = r.launch;
		if (!isObj(l) || !word(l.how) || !word(l.why) || (l.fallback !== undefined && !word(l.fallback))) return null;
		launch = { how: l.how, why: l.why, ...(l.fallback !== undefined ? { fallback: l.fallback as string } : {}) };
	}
	return {
		v: 1,
		key: r.key,
		ts: r.ts,
		device: r.device as string | null,
		producer: r.producer,
		src: r.src as UsageSource,
		provider: r.provider,
		model: r.model,
		...(r.responseModel !== undefined ? { responseModel: r.responseModel as string } : {}),
		input: r.input,
		output: r.output,
		cacheRead: r.cacheRead,
		cacheWrite: r.cacheWrite,
		...(r.cacheWrite1h !== undefined ? { cacheWrite1h: r.cacheWrite1h as number } : {}),
		owner: r.owner as string | null,
		parent: r.parent as string | null,
		...(r.worker !== undefined ? { worker: r.worker as string } : {}),
		kind: r.kind as UsageKind,
		...(r.purpose !== undefined ? { purpose: r.purpose as string } : {}),
		...(r.cwd !== undefined ? { cwd: r.cwd as string } : {}),
		...(r.project !== undefined ? { project: r.project as string } : {}),
		...(r.starter !== undefined ? { starter: r.starter as UsageStarter } : {}),
		...(r.stop !== undefined ? { stop: r.stop as string } : {}),
		...(launch ? { launch } : {}),
	};
}

/** One line of a ledger file (without or with its `\n`), or null when it isn't a record. */
export function parseUsageLine(line: string): UsageRecord | null {
	const s = line.endsWith("\n") ? line.slice(0, -1) : line;
	if (!s || s.length > MAX_RECORD_BYTES) return null;
	try {
		return normalizeUsageRecord(JSON.parse(s));
	} catch {
		return null;
	}
}

/** The record's tokens add up to nothing: such a call writes no record. */
export const emptyUsage = (r: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">): boolean =>
	r.input + r.output + r.cacheRead + r.cacheWrite === 0;

/** The line for `record` (canonical order, `\n`-terminated), or null when it doesn't parse back. */
export function formatUsageRecord(record: UsageRecord): string | null {
	const normal = normalizeUsageRecord(record);
	if (!normal) return null;
	const line = `${JSON.stringify(normal)}\n`;
	return Buffer.byteLength(line) <= MAX_RECORD_BYTES ? line : null;
}

interface WriterState {
	dirs: Set<string>;
	devices: Map<string, string | null>;
	failures: number;
}
const WRITER_KEY = Symbol.for("sova.usage-record.v1");
function writer(): WriterState {
	const g = globalThis as unknown as Record<symbol, WriterState | undefined>;
	return (g[WRITER_KEY] ??= { dirs: new Set(), devices: new Map(), failures: 0 });
}

/** This host's Sova id from `<agent dir>/sova/host.json`, read once per agent dir; null without one. */
export function readDeviceId(agentDir: string): string | null {
	const w = writer();
	if (w.devices.has(agentDir)) return w.devices.get(agentDir) ?? null;
	let id: string | null = null;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "sova", "host.json"), "utf8")) as unknown;
		if (isObj(raw) && typeof raw.id === "string" && /^h_[a-z0-9]{8}$/.test(raw.id)) id = raw.id;
	} catch {
		// Sova never ran here (or not yet): the record says so.
	}
	// Once per process: a host.json Sova writes later reaches the next process's records.
	w.devices.set(agentDir, id);
	return id;
}

/** Appends refused or failed so far in this process (for a test or a diagnostic). */
export const usageWriteFailures = (): number => writer().failures;

/**
 * Append one record to its producer's file for its day. A record with no tokens writes nothing
 * (returns false); so does one that doesn't pass the strict parse. Never throws.
 */
export function appendUsageRecord(record: UsageRecord, agentDir: string = defaultAgentDir()): boolean {
	const w = writer();
	try {
		if (emptyUsage(record)) return false;
		const line = formatUsageRecord(record);
		if (!line) {
			w.failures++;
			return false;
		}
		const file = usageFilePath(agentDir, record.ts, record.producer);
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
