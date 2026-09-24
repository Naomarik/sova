/**
 * The backend-neutral worker transcript protocol (v1).
 *
 * A worker of ANY backend (pi with any provider, claude-code, a future one) is
 * described by one durable manifest in its OWNER's session, and its own
 * transcript is read through a per-backend adapter that answers in one
 * normalized shape: a summary (state, last activity), usage (per model) and,
 * where supported, items. Nothing here starts a process: resume is
 * extension-side and needs the pi runtime; this module does not.
 *
 * Pi-runtime-free on purpose (node builtins only, like mode/state.ts): the
 * subagents extension and Sova's server both import it.
 *
 * Versioning: `protocol: 1` on adapters, `v: 1` on every record. Fields are
 * only ever ADDED within a major; readers ignore unknown fields and refuse a
 * higher major with WorkerProtocolVersionError. Capabilities are declared,
 * never discovered: a consumer checks `capabilities()`, and a call outside
 * them throws UnsupportedCapabilityError.
 */

export const WORKER_TRANSCRIPT_PROTOCOL = 1 as const;
/** Owner-session custom entry carrying one WorkerManifestRecord. */
export const WORKER_MANIFEST_ENTRY_TYPE = "subagents-worker-manifest";
/** The older, hosted-only record (registry.ts). Still folded, never written by new code. */
export const LEGACY_REGISTRY_ENTRY_TYPE = "subagents-worker-registry";
/** Task preview kept in a manifest; the full task is in the owner's tool call. */
export const MANIFEST_TASK_CHARS = 500;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WorkerCapability = "read" | "usage" | "items" | "resume" | "cost" | "perModel";

/** A call outside what an adapter declared in capabilities(). */
export class UnsupportedCapabilityError extends Error {
	readonly code = "unsupported-capability" as const;
	readonly backend: string;
	readonly capability: WorkerCapability;
	constructor(backend: string, capability: WorkerCapability) {
		super(`worker transcripts of backend "${backend}" do not support ${capability}`);
		this.backend = backend;
		this.capability = capability;
		this.name = "UnsupportedCapabilityError";
	}
}

/** A record or adapter of a newer major version than this reader. */
export class WorkerProtocolVersionError extends Error {
	readonly code = "protocol-version" as const;
	readonly what: "ref" | "manifest" | "adapter";
	readonly version: number;
	constructor(what: "ref" | "manifest" | "adapter", version: number) {
		super(`${what} is protocol v${version}; this reader understands v${WORKER_TRANSCRIPT_PROTOCOL}`);
		this.what = what;
		this.version = version;
		this.name = "WorkerProtocolVersionError";
	}
}

// ---------------------------------------------------------------------------
// Refs and usage
// ---------------------------------------------------------------------------

/** Where a worker's own transcript is. `locator` meaning depends on `kind`. */
export interface WorkerTranscriptRef {
	v: 1;
	backend: string;
	/** "pi-session-file" (locator = absolute path), "claude-session-id" (locator = UUID), or a future kind. */
	kind: "pi-session-file" | "claude-session-id" | (string & {});
	locator: string;
	/** The worker's cwd; lets a locator try the likely place first. */
	cwd?: string;
	/** pi: the worker's own session id, when known. */
	sessionId?: string;
}

/** Token counts, plus cost when the source reports one. */
export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** USD. Absent when the source has none (Claude transcripts never do). */
	cost?: number;
	/** Assistant replies counted. */
	turns?: number;
}

export interface WorkerUsageRow extends TokenCounts {
	/** "provider/model" (pi) or "claude/<model>" (claude-code). */
	model: string;
}

/** What was counted, so a rebuilt total that differs from a live one can say why. */
export interface WorkerUsagePolicy {
	/** pi `usage` entries (cache_warm and friends) are included. */
	cacheWarm: boolean;
	/** Nested agents (Claude sidechains) are included. */
	nestedAgents: boolean;
	/** Entries a forked worker copied from its parent were excluded. */
	forkBoundary: boolean;
}

export type UsageSource = "transcript" | "snapshot" | "none";

export interface WorkerUsage extends TokenCounts {
	byModel: WorkerUsageRow[];
	/** Where the token counts come from. "none" = unavailable: never show it as 0. */
	source: UsageSource;
	/** For source "snapshot": when the snapshot was taken (ms epoch). */
	asOf?: number;
	/** Where `cost` comes from when it differs from `source` (Claude: tokens from transcript, cost from the last snapshot). */
	costSource?: "transcript" | "snapshot";
	/** For costSource "snapshot": when that cost was reported (ms epoch). */
	costAsOf?: number;
	policy?: WorkerUsagePolicy;
}

// ---------------------------------------------------------------------------
// Summary and items
// ---------------------------------------------------------------------------

export type WorkerTranscriptState = "in-progress" | "settled" | "unknown";
export type WorkerTurnOutcome = "success" | "error" | "aborted";

export type WorkerTranscriptItemKind = "task" | "steer" | "assistant" | "thinking" | "tool" | "tool-result" | "error" | "system";

/** The runner's TranscriptItem shape (runner.ts) plus provenance. */
export interface WorkerTranscriptItem {
	kind: WorkerTranscriptItemKind;
	text: string;
	toolName?: string;
	/** ms epoch, when the source has one. */
	at?: number;
	model?: string;
}

export interface WorkerTranscriptSummary {
	ref: WorkerTranscriptRef;
	/** The transcript exists and was read. When false, `reason` says why and usage.source is "none". */
	found: boolean;
	reason?: string;
	file?: string;
	sizeBytes?: number;
	mtimeMs?: number;
	startedAt?: number;
	lastActivityAt?: number;
	/** Model of the last reply, same naming as WorkerUsageRow.model. */
	model?: string;
	effort?: string;
	/** Of the active branch (pi) / main chain (Claude): is a turn still open at the end of the file? */
	state: WorkerTranscriptState;
	lastOutcome?: WorkerTurnOutcome;
	lastAssistantText?: string;
	usage: WorkerUsage;
	compactions: number;
	/** The file ends inside a turn (prompt or tool call with no final reply): the worker died mid-turn. */
	partialTurn: boolean;
	items?: WorkerTranscriptItem[];
}

export interface WorkerReadOptions {
	/** Items to return: none (default), the last `limit`, or all. Requires capabilities().items. */
	items?: "none" | "tail" | "all";
	/** For items "tail": how many (default 50). */
	limit?: number;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface WorkerTranscriptCapabilities {
	read: boolean;
	usage: "exact" | "tokens-only" | "none";
	perModel: boolean;
	cost: boolean;
	items: boolean;
	resume: "native" | "none";
}

export interface WorkerTranscriptLocation {
	file: string | null;
	reason?: string;
}

export interface WorkerTranscriptAdapter {
	readonly protocol: 1;
	readonly backend: string;
	capabilities(): WorkerTranscriptCapabilities;
	/** Resolve a ref to a file. Read-only; never writes. */
	locate(ref: WorkerTranscriptRef): WorkerTranscriptLocation;
	/**
	 * Read the transcript. A missing file is `found: false`, not an error.
	 * Throws UnsupportedCapabilityError when `read` (or requested items) is not
	 * supported, WorkerProtocolVersionError for a ref of a higher major.
	 */
	read(ref: WorkerTranscriptRef, opts?: WorkerReadOptions): Promise<WorkerTranscriptSummary>;
}

export const NO_CAPABILITIES: WorkerTranscriptCapabilities = Object.freeze({
	read: false, usage: "none", perModel: false, cost: false, items: false, resume: "none",
}) as WorkerTranscriptCapabilities;

/** The adapter of a backend nobody registered: everything is unavailable, nothing is 0. */
export function noneAdapter(backend: string): WorkerTranscriptAdapter {
	return {
		protocol: 1,
		backend,
		capabilities: () => ({ ...NO_CAPABILITIES }),
		locate: () => ({ file: null, reason: `no transcript adapter for backend "${backend}"` }),
		read: async () => { throw new UnsupportedCapabilityError(backend, "read"); },
	};
}

/** Throws for a ref this reader must refuse. */
export function checkRef(ref: WorkerTranscriptRef): void {
	const v = (ref as { v?: unknown }).v;
	if (typeof v === "number" && v > WORKER_TRANSCRIPT_PROTOCOL) throw new WorkerProtocolVersionError("ref", v);
}

/** Backend name → adapter. Unknown backends get noneAdapter, so callers never special-case. */
export class WorkerTranscriptAdapters {
	private readonly byBackend = new Map<string, WorkerTranscriptAdapter>();

	constructor(adapters: readonly WorkerTranscriptAdapter[] = []) {
		for (const adapter of adapters) this.register(adapter);
	}

	/** Refuses an adapter of a higher protocol major. Replaces any earlier adapter of the backend. */
	register(adapter: WorkerTranscriptAdapter): void {
		if (adapter.protocol > WORKER_TRANSCRIPT_PROTOCOL) throw new WorkerProtocolVersionError("adapter", adapter.protocol);
		this.byBackend.set(adapter.backend, adapter);
	}

	get(backend: string): WorkerTranscriptAdapter {
		return this.byBackend.get(backend) ?? noneAdapter(backend);
	}

	has(backend: string): boolean {
		return this.byBackend.has(backend);
	}

	backends(): string[] {
		return [...this.byBackend.keys()];
	}
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface WorkerManifestSpec {
	cwd: string;
	model?: string;
	effort?: string;
	/** Tool allow-list the worker was spawned with, when restricted. */
	tools?: string[];
	/** Bounded preview of the initial task (MANIFEST_TASK_CHARS). */
	taskPreview: string;
	/** Full task length; greater than taskPreview.length when cut. */
	taskChars?: number;
	wake: boolean;
	sandbox?: { on: boolean; flags?: string[] };
}

export interface WorkerManifestTeam {
	teamId: string;
	role: string;
	orchestrator?: boolean;
}

/** Terminal states: a worker's own ending, or lost = its host died mid-turn. */
export type WorkerManifestStatus = "running" | "waiting" | "done" | "error" | "killed" | "lost";

/**
 * The folded view of one worker. Every field but workerId/backend is optional
 * in a single record: the owner appends small records (publication, identity,
 * each settle's usage snapshot, end) and the fold keeps the newest of each.
 */
export interface WorkerManifest {
	v: 1;
	workerId: string;
	backend: string;
	groupId?: string;
	name?: string;
	spec?: WorkerManifestSpec;
	team?: WorkerManifestTeam;
	ref?: WorkerTranscriptRef;
	/** Last usage the live runner reported; source "snapshot", asOf = when. */
	usageSnapshot?: WorkerUsage;
	status?: WorkerManifestStatus;
	taskOutcome?: WorkerTurnOutcome;
	endedAt?: number;
	error?: string;
	/** Newest record time folded in (ms epoch). */
	at: number;
}

/** One appended record (the entry's `data`). */
export type WorkerManifestRecord = Partial<Omit<WorkerManifest, "v" | "workerId" | "backend" | "at">> & {
	v: 1;
	kind: "worker-manifest";
	workerId: string;
	backend: string;
	at: number;
};

export interface FoldedWorkerManifest extends WorkerManifest {
	/** Some record of this worker is on the active branch (only when activeEntryIds was given). */
	onActiveBranch?: boolean;
}

export interface WorkerManifestFold {
	manifests: Map<string, FoldedWorkerManifest>;
	/** Records of a higher major, skipped. Non-zero means a newer writer touched this session. */
	refused: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Clip a task to its manifest preview. */
export function taskPreview(task: string): { taskPreview: string; taskChars: number } {
	return { taskPreview: task.length > MANIFEST_TASK_CHARS ? task.slice(0, MANIFEST_TASK_CHARS) : task, taskChars: task.length };
}

/**
 * One entry's data as a manifest record. undefined for anything else;
 * throws WorkerProtocolVersionError for a manifest of a higher major.
 */
export function decodeManifestRecord(data: unknown): WorkerManifestRecord | undefined {
	if (!isRecord(data) || data.kind !== "worker-manifest") return undefined;
	if (typeof data.v === "number" && data.v > WORKER_TRANSCRIPT_PROTOCOL) throw new WorkerProtocolVersionError("manifest", data.v);
	if (data.v !== 1 || !text(data.workerId) || !text(data.backend)) return undefined;
	return data as unknown as WorkerManifestRecord;
}

/** A registry.ts record translated to a manifest record (hosted workers before manifests existed). */
export function manifestFromLegacyRegistry(data: unknown): WorkerManifestRecord | undefined {
	if (!isRecord(data) || data.v !== 1 || data.kind !== "worker-registry" || !text(data.workerId) || !text(data.backend)) return undefined;
	const backend = data.backend;
	const out: WorkerManifestRecord = { v: 1, kind: "worker-manifest", workerId: data.workerId, backend, at: typeof data.at === "number" ? data.at : 0 };
	if (text(data.groupId)) out.groupId = data.groupId;
	const spec = isRecord(data.spec) ? data.spec : undefined;
	if (spec) {
		if (text(spec.name)) out.name = spec.name;
		out.spec = {
			cwd: typeof spec.cwd === "string" ? spec.cwd : "",
			...(text(spec.model) ? { model: spec.model } : {}),
			...(text(spec.effort) ? { effort: spec.effort } : {}),
			taskPreview: typeof spec.task === "string" ? spec.task : "",
			...(typeof spec.taskChars === "number" ? { taskChars: spec.taskChars } : {}),
			wake: spec.wake === true,
		};
		if (text(spec.teamId) && text(spec.role)) out.team = { teamId: spec.teamId, role: spec.role };
	}
	const ref = legacyRef(backend, data.backendSessionId, data.backendSessionFile, typeof spec?.cwd === "string" ? spec.cwd : undefined);
	if (ref) out.ref = ref;
	if (text(data.status)) out.status = data.status as WorkerManifestStatus;
	if (text(data.taskOutcome)) out.taskOutcome = data.taskOutcome as WorkerTurnOutcome;
	if (typeof data.endedAt === "number") out.endedAt = data.endedAt;
	if (text(data.error)) out.error = data.error;
	return out;
}

/** The ref a backend's (session id, session file) identity implies. */
export function refFromIdentity(backend: string, identity: { sessionId?: string; sessionFile?: string; cwd?: string }): WorkerTranscriptRef | undefined {
	return legacyRef(backend, identity.sessionId, identity.sessionFile, identity.cwd);
}

function legacyRef(backend: string, sessionId: unknown, sessionFile: unknown, cwd: string | undefined): WorkerTranscriptRef | undefined {
	const where = text(cwd) ? { cwd } : {};
	if (text(sessionFile)) return { v: 1, backend, kind: "pi-session-file", locator: sessionFile, ...(text(sessionId) ? { sessionId } : {}), ...where };
	if (backend === "claude-code" && text(sessionId)) return { v: 1, backend, kind: "claude-session-id", locator: sessionId, ...where };
	return undefined;
}

/** Newest-wins per field; spec and team merge one level down so a later partial record keeps the rest. */
function mergeManifest(previous: WorkerManifest | undefined, record: WorkerManifestRecord): WorkerManifest {
	const { kind: _kind, ...fields } = record;
	if (!previous) return { ...fields } as WorkerManifest;
	const merged: WorkerManifest = { ...previous, ...fields, at: Math.max(previous.at, record.at) };
	if (previous.spec && record.spec) merged.spec = { ...previous.spec, ...record.spec };
	if (previous.team && record.team) merged.team = { ...previous.team, ...record.team };
	return merged;
}

/**
 * Fold owner-session entries into one manifest per worker, in entry order,
 * newest value of each field winning. Reads manifest records and legacy
 * registry records alike. Pass ALL entries (every branch) to restore; pass
 * `activeEntryIds` (the active branch's entry ids) to mark what to show.
 */
export function readWorkerManifests(entries: readonly unknown[], options: { activeEntryIds?: ReadonlySet<string> } = {}): WorkerManifestFold {
	const manifests = new Map<string, FoldedWorkerManifest>();
	let refused = 0;
	for (const entry of entries) {
		const e = entry as { type?: unknown; customType?: unknown; data?: unknown; id?: unknown } | null;
		if (!e || e.type !== "custom") continue;
		let record: WorkerManifestRecord | undefined;
		if (e.customType === WORKER_MANIFEST_ENTRY_TYPE) {
			try {
				record = decodeManifestRecord(e.data);
			} catch (error) {
				if (error instanceof WorkerProtocolVersionError) refused++;
				continue;
			}
		} else if (e.customType === LEGACY_REGISTRY_ENTRY_TYPE) {
			record = manifestFromLegacyRegistry(e.data);
		}
		if (!record) continue;
		const previous = manifests.get(record.workerId);
		const next: FoldedWorkerManifest = mergeManifest(previous, record);
		if (options.activeEntryIds) {
			const here = typeof e.id === "string" && options.activeEntryIds.has(e.id);
			next.onActiveBranch = (previous?.onActiveBranch ?? false) || here;
		}
		manifests.set(record.workerId, next);
	}
	return { manifests, refused };
}

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

export function emptyUsage(source: UsageSource = "none"): WorkerUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: [], source };
}

/** Anything counted at all. */
export function usageSpent(u: TokenCounts): boolean {
	return u.input + u.output + u.cacheRead + u.cacheWrite > 0 || (u.cost ?? 0) > 0;
}

/** A live runner's cumulative numbers as a manifest snapshot. */
export function usageSnapshot(u: TokenCounts & { byModel?: WorkerUsageRow[] }, at: number = Date.now()): WorkerUsage {
	return {
		input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
		...(typeof u.cost === "number" ? { cost: u.cost } : {}),
		...(typeof u.turns === "number" ? { turns: u.turns } : {}),
		byModel: u.byModel ? u.byModel.map((row) => ({ ...row })) : [],
		source: "snapshot",
		asOf: at,
	};
}

/**
 * The usage to show for a worker: the transcript's when it was read, else the
 * last snapshot, else "none". A transcript without cost (Claude) borrows the
 * snapshot's cost, marked costSource "snapshot" with its asOf.
 */
export function resolveWorkerUsage(fromTranscript: WorkerUsage | undefined, snapshot: WorkerUsage | undefined): WorkerUsage {
	if (fromTranscript && fromTranscript.source === "transcript") {
		if (fromTranscript.cost !== undefined || snapshot?.cost === undefined) return fromTranscript;
		return { ...fromTranscript, cost: snapshot.cost, costSource: "snapshot", ...(snapshot.asOf === undefined ? {} : { costAsOf: snapshot.asOf }) };
	}
	if (snapshot) return { ...snapshot, source: "snapshot" };
	return emptyUsage("none");
}

/** Sum of many workers' usage (the lifetime Σ over manifests). Rows merge by model; source is the weakest seen. */
export function sumWorkerUsage(usages: readonly WorkerUsage[]): WorkerUsage {
	const total = emptyUsage(usages.length ? "transcript" : "none");
	const rows = new Map<string, WorkerUsageRow>();
	let anyCost = false;
	const rank: Record<UsageSource, number> = { transcript: 2, snapshot: 1, none: 0 };
	for (const u of usages) {
		total.input += u.input; total.output += u.output; total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
		if (u.cost !== undefined) { total.cost = (total.cost ?? 0) + u.cost; anyCost = true; }
		if (u.turns !== undefined) total.turns = (total.turns ?? 0) + u.turns;
		if (rank[u.source] < rank[total.source]) total.source = u.source;
		for (const row of u.byModel) addRow(rows, row.model, row);
	}
	if (!anyCost) delete total.cost;
	total.byModel = [...rows.values()];
	return total;
}

/** Add counts into a per-model row map (shared by the adapters). */
export function addRow(rows: Map<string, WorkerUsageRow>, model: string, counts: TokenCounts): void {
	let row = rows.get(model);
	if (!row) { row = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; rows.set(model, row); }
	row.input += counts.input; row.output += counts.output; row.cacheRead += counts.cacheRead; row.cacheWrite += counts.cacheWrite;
	if (counts.cost !== undefined) row.cost = (row.cost ?? 0) + counts.cost;
	if (counts.turns !== undefined) row.turns = (row.turns ?? 0) + counts.turns;
}

/** JSONL text → objects; blank and malformed lines (a torn last line) are skipped. */
export function parseJsonLines(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object") out.push(value);
		} catch {
			/* malformed line: skip */
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export interface WorkerTranscriptView {
	manifest: WorkerManifest;
	capabilities: WorkerTranscriptCapabilities;
	/** The adapter's summary, when the backend can read and the ref is known. */
	summary?: WorkerTranscriptSummary;
	/** Why there is no summary (no ref, unsupported backend, read failure). */
	unavailable?: string;
	/** Transcript usage merged with the manifest snapshot (resolveWorkerUsage). */
	usage: WorkerUsage;
}

/** Everything the UI needs for one manifest; never throws. */
export async function viewWorker(manifest: WorkerManifest, adapters: WorkerTranscriptAdapters, opts?: WorkerReadOptions): Promise<WorkerTranscriptView> {
	const adapter = adapters.get(manifest.backend);
	const capabilities = adapter.capabilities();
	const base = { manifest, capabilities };
	if (!capabilities.read) return { ...base, unavailable: adapter.locate(manifest.ref ?? { v: 1, backend: manifest.backend, kind: "none", locator: "" }).reason ?? "transcript not readable", usage: resolveWorkerUsage(undefined, manifest.usageSnapshot) };
	if (!manifest.ref) return { ...base, unavailable: "no transcript recorded yet", usage: resolveWorkerUsage(undefined, manifest.usageSnapshot) };
	try {
		const summary = await adapter.read(manifest.ref, capabilities.items ? opts : { ...opts, items: "none" });
		if (!summary.found) return { ...base, summary, unavailable: summary.reason ?? "transcript not found", usage: resolveWorkerUsage(undefined, manifest.usageSnapshot) };
		return { ...base, summary, usage: resolveWorkerUsage(summary.usage, manifest.usageSnapshot) };
	} catch (error) {
		return { ...base, unavailable: error instanceof Error ? error.message : String(error), usage: resolveWorkerUsage(undefined, manifest.usageSnapshot) };
	}
}
