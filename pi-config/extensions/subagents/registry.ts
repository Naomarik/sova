/**
 * Worker registry records in the OWNER's session file. Each worker gets small
 * custom entries: one when it is published, one when its backend session
 * identity becomes known (Pi session id/file, Claude session id), and one final
 * record when its process ends. Reading folds them in order, so the newest value
 * of each field wins per worker.
 *
 * The full task already lives in the owner transcript (the agent_spawn or team
 * tool call); records keep only a bounded preview plus the identity needed to
 * find the worker's own transcript or `claude --resume` it later.
 *
 * No process, UI or manager dependency.
 */
import type { Worker } from "./contracts.ts";

export const WORKER_REGISTRY_ENTRY_TYPE = "subagents-worker-registry";
/** Task preview kept in a record; the full task is in the owner's tool call. */
export const REGISTRY_TASK_CHARS = 500;

export interface WorkerRegistrySpec {
	name: string;
	model?: string;
	effort?: string;
	cwd: string;
	/** Bounded preview of the initial task. */
	task: string;
	/** Full task length in characters; greater than task.length when the preview was cut. */
	taskChars: number;
	teamId?: string;
	role?: string;
	wake: boolean;
}

/** Terminal registry states beyond a worker's own status: lost = its host died mid-turn. */
export type WorkerRegistryStatus = "done" | "error" | "killed" | "lost";

export interface WorkerRegistryRecord {
	v: 1;
	kind: "worker-registry";
	workerId: string;
	backend: string;
	groupId?: string;
	/** When this record was written. */
	at: number;
	backendSessionId?: string;
	backendSessionFile?: string;
	spec?: WorkerRegistrySpec;
	status?: WorkerRegistryStatus;
	taskOutcome?: string;
	endedAt?: number;
	error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function registrySpec(worker: Pick<Worker, "name" | "model" | "effort" | "cwd" | "task" | "wake">, team?: { teamId: string; role: string }): WorkerRegistrySpec {
	return {
		name: worker.name,
		...(worker.model === undefined ? {} : { model: worker.model }),
		...(worker.effort === undefined ? {} : { effort: worker.effort }),
		cwd: worker.cwd,
		task: worker.task.length > REGISTRY_TASK_CHARS ? worker.task.slice(0, REGISTRY_TASK_CHARS) : worker.task,
		taskChars: worker.task.length,
		...(team ? { teamId: team.teamId, role: team.role } : {}),
		wake: worker.wake,
	};
}

/** Validate one entry's data; undefined for anything that is not a v1 registry record. */
export function decodeRegistryRecord(data: unknown): WorkerRegistryRecord | undefined {
	if (!isRecord(data) || data.v !== 1 || data.kind !== "worker-registry" || !text(data.workerId) || !text(data.backend)) return undefined;
	return data as unknown as WorkerRegistryRecord;
}

/**
 * Newest record per worker wins, field by field: a later identity or final
 * record does not erase the spec written at publication.
 */
export function readWorkerRegistry(entries: readonly unknown[]): Map<string, WorkerRegistryRecord> {
	const out = new Map<string, WorkerRegistryRecord>();
	for (const entry of entries) {
		const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!e || e.type !== "custom" || e.customType !== WORKER_REGISTRY_ENTRY_TYPE) continue;
		const record = decodeRegistryRecord(e.data);
		if (!record) continue;
		const previous = out.get(record.workerId);
		out.set(record.workerId, previous ? { ...previous, ...record } : { ...record });
	}
	return out;
}

type Append = (customType: string, data: WorkerRegistryRecord) => void;
interface Tracked { identity: string; finished: boolean }

/**
 * Appends registry records for published workers. observe() is cheap and safe
 * to call on every change; it writes only when the identity changed.
 */
export class WorkerRegistryRecorder {
	private readonly tracked = new Map<string, Tracked>();
	private readonly append: Append;
	constructor(append: Append) { this.append = append; }

	private write(record: Omit<WorkerRegistryRecord, "v" | "kind" | "at">): void {
		try {
			this.append(WORKER_REGISTRY_ENTRY_TYPE, { v: 1, kind: "worker-registry", at: Date.now(), ...record });
		} catch {
			/* Session replacement can invalidate the append API; the registry is best effort. */
		}
	}

	private static identity(worker: Worker): { key: string; fields: Pick<WorkerRegistryRecord, "backendSessionId" | "backendSessionFile"> } {
		const fields = {
			...(text(worker.sessionId) ? { backendSessionId: worker.sessionId } : {}),
			...(text(worker.sessionFile) ? { backendSessionFile: worker.sessionFile } : {}),
		};
		return { key: `${fields.backendSessionId ?? ""}\n${fields.backendSessionFile ?? ""}`, fields };
	}

	/** First record for a published worker, with whatever identity is already known. */
	track(worker: Worker, team?: { teamId: string; role: string }): void {
		if (this.tracked.has(worker.id)) return;
		const { key, fields } = WorkerRegistryRecorder.identity(worker);
		this.tracked.set(worker.id, { identity: key, finished: false });
		this.write({ workerId: worker.id, backend: worker.backend ?? "pi", groupId: worker.groupId, ...fields, spec: registrySpec(worker, team) });
	}

	/** Append a fresh record when the backend session identity arrived or changed. */
	observe(worker: Worker): void {
		const tracked = this.tracked.get(worker.id);
		if (!tracked || tracked.finished) return;
		const { key, fields } = WorkerRegistryRecorder.identity(worker);
		if (key === tracked.identity || !Object.keys(fields).length) return;
		tracked.identity = key;
		this.write({ workerId: worker.id, backend: worker.backend ?? "pi", ...fields });
	}

	/** Final record once the process has ended (or its host was found dead: status "lost"). */
	finish(worker: Worker, status?: WorkerRegistryStatus): void {
		const tracked = this.tracked.get(worker.id);
		if (!tracked || tracked.finished) return;
		this.observe(worker);
		tracked.finished = true;
		const final = status ?? (worker.status === "done" || worker.status === "killed" ? worker.status : "error");
		this.write({
			workerId: worker.id, backend: worker.backend ?? "pi", status: final, endedAt: worker.endedAt ?? Date.now(),
			...(worker.taskOutcome ? { taskOutcome: worker.taskOutcome } : {}),
			...(worker.error ? { error: worker.error.slice(0, 500) } : {}),
		});
	}

	/** Re-adopted workers were recorded by an earlier instance; continue from their last identity. */
	resume(worker: Worker): void {
		if (this.tracked.has(worker.id)) return;
		this.tracked.set(worker.id, { identity: WorkerRegistryRecorder.identity(worker).key, finished: false });
	}

	clear(): void { this.tracked.clear(); }
}
