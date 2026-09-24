import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKER_EFFORT_MAX, WORKER_OUTCOMES, WORKER_SESSION_FILE_MAX, WORKER_SESSION_ID_MAX, WORKER_USAGE_SOURCES, type WorkerEntry, type WorkerUsage, type WorkerUsageTotal } from "./schema.ts";

/** schema.ts WorkerEntry: the v1 summary plus optional backend/session/effort/timing/outcome/usage. */
export type WorkerSummary = WorkerEntry;
export type { WorkerUsage, WorkerUsageTotal };

/** Shared with the subagent manager; Claude workers use that same manager. */
export const WORKERS_SNAPSHOT_EVENT = "subagents:workers-snapshot";
export const WORKERS_REQUEST_EVENT = "subagents:workers-request";
export interface WorkersSnapshot {
	version: 1;
	workers: WorkerSummary[];
	/** Lifetime Σ over every worker the manager ever ran, including evicted ones. */
	workerUsage?: WorkerUsageTotal;
}

const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// Advisory counts: a bad field is 0, a non-object usage is dropped. Never fatal to a snapshot.
const tokens = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
function usageOf(value: unknown): WorkerUsage | undefined {
	if (!value || typeof value !== "object") return;
	const u = value as Record<string, unknown>;
	const cost = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost > 0 ? u.cost : undefined;
	return { input: tokens(u.input), output: tokens(u.output), cacheRead: tokens(u.cacheRead), cacheWrite: tokens(u.cacheWrite),
		...(cost === undefined ? {} : { cost }) };
}
// A truncated path or id is wrong, not shorter: over-limit values are dropped.
const bounded = (value: unknown, limit: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= limit;

function decodeUsageTotal(data: unknown): WorkerUsageTotal | undefined {
	const usage = usageOf(data);
	if (!usage) return;
	const { workers, asOf, restored } = data as Record<string, unknown>;
	return { ...usage, workers: typeof workers === "number" && Number.isSafeInteger(workers) && workers >= 0 ? workers : 0,
		...(time(asOf) ? { asOf } : {}),
		...(typeof restored === "number" && Number.isSafeInteger(restored) && restored > 0 ? { restored } : {}) };
}

function decodeSnapshot(data: unknown): WorkersSnapshot | undefined {
	if (!data || typeof data !== "object") return;
	const snapshot = data as Partial<WorkersSnapshot>;
	if (snapshot.version !== 1 || !Array.isArray(snapshot.workers)) return;
	const workers: WorkerSummary[] = [];
	const ids = new Set<string>();
	for (const worker of snapshot.workers) {
		if (!worker || typeof worker !== "object" || typeof worker.id !== "string" || !worker.id ||
			typeof worker.name !== "string" || typeof worker.status !== "string" ||
			(worker.model !== undefined && typeof worker.model !== "string") ||
			(worker.preview !== undefined && typeof worker.preview !== "string") || ids.has(worker.id)) return;
		ids.add(worker.id);
		// Copy only the public fields: never leak mutable runner objects to the UI.
		// Additive fields are optional: an invalid one is omitted, never fatal.
		const w = worker as unknown as Record<string, unknown>;
		workers.push({ id: worker.id, name: worker.name, status: worker.status,
			...(worker.model === undefined ? {} : { model: worker.model }),
			...(worker.preview === undefined ? {} : { preview: worker.preview }),
			...(typeof w.backend === "string" ? { backend: w.backend } : {}),
			...(bounded(w.sessionFile, WORKER_SESSION_FILE_MAX) ? { sessionFile: w.sessionFile } : {}),
			...(bounded(w.sessionId, WORKER_SESSION_ID_MAX) ? { sessionId: w.sessionId } : {}),
			...(bounded(w.effort, WORKER_EFFORT_MAX) ? { effort: w.effort } : {}),
			...(time(w.startedAt) ? { startedAt: w.startedAt } : {}),
			...(time(w.lastActivity) ? { lastActivity: w.lastActivity } : {}),
			...(time(w.endedAt) ? { endedAt: w.endedAt } : {}),
			...((WORKER_OUTCOMES as readonly unknown[]).includes(w.outcome) ? { outcome: w.outcome as WorkerEntry["outcome"] } : {}),
			...(usageOf(w.usage) ? { usage: usageOf(w.usage) } : {}),
			// Restored workers (rebuilt after a restart; no process): see schema.ts WorkerEntry.
			...(w.restored === true ? { restored: true as const } : {}),
			...((WORKER_USAGE_SOURCES as readonly unknown[]).includes(w.usageSource) ? { usageSource: w.usageSource as WorkerEntry["usageSource"] } : {}),
			...(time(w.usageAsOf) ? { usageAsOf: w.usageAsOf } : {}),
			...(time(w.interruptedAt) ? { interruptedAt: w.interruptedAt } : {}),
			...(typeof w.resumable === "boolean" ? { resumable: w.resumable } : {}) });
	}
	const workerUsage = decodeUsageTotal((data as Record<string, unknown>).workerUsage);
	return { version: 1, workers, ...(workerUsage ? { workerUsage } : {}) };
}

/**
 * Subscribe once per extension instance (factory or session_start). Immediately
 * reports [], then requests an authoritative snapshot. The second callback argument
 * is the manager's session-lifetime token Σ (`workerUsage`, absent from older
 * managers): it covers evicted workers too, so it is NOT the sum of the list.
 * The manager must emit
 * { version: 1, workers: [...] } on WORKERS_SNAPSHOT_EVENT at startup and whenever
 * its committed worker state changes, and answer WORKERS_REQUEST_EVENT
 * { version: 1 } with the same full snapshot. Empty snapshots clear the list.
 *
 * Includes background/idle/retained finished workers from every backend. Status
 * is the manager's actual lifecycle status, not inferred from parent tool calls;
 * notably "waiting" means steerable, not necessarily successful. Workers may
 * also carry optional backend, sessionFile (absolute path of the worker's own
 * transcript JSONL, ≤ 1024 chars; never its contents, and consumers must not
 * write to it), sessionId (backend session id, ≤ 64 chars), effort (the thinking/effort
 * level the worker was spawned with, ≤ 32 chars), startedAt/
 * lastActivity/endedAt (ms epoch), outcome ("success"|"error"|"aborted") and
 * usage (cumulative input/output/cacheRead/cacheWrite counts, plus cost in USD
 * when the backend reports one — counts only, never text);
 * empty or over-limit strings and other invalid optional values are dropped
 * per field without rejecting the snapshot. An invalid usage count reads as 0. No polling,
 * subprocesses, session-history inference, or dependence on an open monitor.
 *
 * Cleanup is idempotent and automatic on session_shutdown. The owner should also
 * call it when discarding its view. A new extension instance must subscribe anew
 * after reload/session replacement. Renderers must escape untrusted text.
 */
export function subscribeWorkers(
	pi: ExtensionAPI,
	onChange: (workers: WorkerSummary[], usage?: WorkerUsageTotal) => void,
): () => void {
	let callback: typeof onChange | undefined = onChange;
	// Matches the shape decodeSnapshot returns, so the first empty snapshot after
	// the synchronous onChange([]) is deduplicated as it always was.
	let previous = JSON.stringify({ version: 1, workers: [] });
	let off: (() => void) | undefined;
	const dispose = () => {
		callback = undefined;
		off?.();
		off = undefined;
	};
	const request = () => {
		if (callback) pi.events.emit(WORKERS_REQUEST_EVENT, { version: 1 });
	};
	off = pi.events.on(WORKERS_SNAPSHOT_EVENT, (data: unknown) => {
		if (!callback) return;
		const snapshot = decodeSnapshot(data);
		if (!snapshot) return;
		const serialized = JSON.stringify(snapshot);
		if (serialized === previous) return;
		previous = serialized;
		callback(snapshot.workers, snapshot.workerUsage);
	});
	// Pi's lifecycle handlers have no unsubscribe API; disposed handlers are inert
	// and release the UI callback. The event-bus listener *is* removed on disposal.
	pi.on("session_start", request);
	pi.on("session_shutdown", dispose);
	try {
		onChange([]);
		request();
	} catch (error) {
		dispose();
		throw error;
	}
	return dispose;
}
