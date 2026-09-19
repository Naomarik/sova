import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorkerSummary {
	id: string;
	name: string;
	status: string;
	model?: string;
	preview?: string;
}

/** Shared with the subagent manager; Claude workers use that same manager. */
export const WORKERS_SNAPSHOT_EVENT = "subagents:workers-snapshot";
export const WORKERS_REQUEST_EVENT = "subagents:workers-request";
export interface WorkersSnapshot {
	version: 1;
	workers: WorkerSummary[];
}

function decodeSnapshot(data: unknown): WorkerSummary[] | undefined {
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
		workers.push({ id: worker.id, name: worker.name, status: worker.status,
			...(worker.model === undefined ? {} : { model: worker.model }),
			...(worker.preview === undefined ? {} : { preview: worker.preview }) });
	}
	return workers;
}

/**
 * Subscribe once per extension instance (factory or session_start). Immediately
 * reports [], then requests an authoritative snapshot. The manager must emit
 * { version: 1, workers: [...] } on WORKERS_SNAPSHOT_EVENT at startup and whenever
 * its committed worker state changes, and answer WORKERS_REQUEST_EVENT
 * { version: 1 } with the same full snapshot. Empty snapshots clear the list.
 *
 * Includes background/idle/retained finished workers from every backend. Status
 * is the manager's actual lifecycle status, not inferred from parent tool calls;
 * notably "waiting" means steerable, not necessarily successful. No polling,
 * subprocesses, session-history inference, or dependence on an open monitor.
 *
 * Cleanup is idempotent and automatic on session_shutdown. The owner should also
 * call it when discarding its view. A new extension instance must subscribe anew
 * after reload/session replacement. Renderers must escape untrusted text.
 */
export function subscribeWorkers(pi: ExtensionAPI, onChange: (workers: WorkerSummary[]) => void): () => void {
	let callback: typeof onChange | undefined = onChange;
	let previous = "[]";
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
		const workers = decodeSnapshot(data);
		if (!workers) return;
		const serialized = JSON.stringify(workers);
		if (serialized === previous) return;
		previous = serialized;
		callback(workers);
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
