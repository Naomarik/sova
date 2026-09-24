/**
 * The durable worker record: small `subagents-worker-manifest` custom entries in
 * the OWNER's session file, one set per worker of ANY backend and transport
 * (worker-transcript.ts owns the record type and the one fold, readWorkerManifests,
 * which Sova reads too). Records are appended when a worker is published (spec,
 * team, launch spec), when its backend session identity becomes known (ref),
 * when it starts a new task (status running), at each settle (status waiting,
 * usage snapshot), when its process ends (terminal status), and when it is
 * resumed. The fold keeps the newest value of each field, so no record repeats
 * what an earlier one said.
 *
 * The full task already lives in the owner transcript (the agent_spawn or team
 * tool call); records keep only a bounded preview. `launch` is this
 * extension's own spawn spec, needed to resume and opaque to every other reader.
 *
 * No process, UI or manager dependency.
 */
import type { Worker } from "./contracts.ts";
import {
	LEGACY_REGISTRY_ENTRY_TYPE,
	WORKER_MANIFEST_ENTRY_TYPE,
	refFromIdentity,
	taskPreview,
	usageSnapshot,
	type TokenCounts,
	type WorkerManifestRecord,
	type WorkerManifestStatus,
	type WorkerTranscriptRef,
} from "./worker-transcript.ts";

export { WORKER_MANIFEST_ENTRY_TYPE };
/** The hosted-only record this one replaced; still folded by readWorkerManifests, never written. */
export const WORKER_REGISTRY_ENTRY_TYPE = LEGACY_REGISTRY_ENTRY_TYPE;

/** What resume needs to start the worker again; written once, at publication. */
export interface WorkerLaunchSpec {
	backend: string;
	/** The spec's own cwd (before resolution): a remote session resolves it against its far cwd again. */
	cwd?: string;
	/** The model the worker ran on at spawn (resolved: pi's inherited parent model is written out). */
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	agentType?: string;
	extensions?: string[];
	backendOptions?: Record<string, unknown>;
	/** Team membership, for re-attaching the member tools and mailbox. */
	orchestrator?: boolean;
}

type Append = (customType: string, data: WorkerManifestRecord) => void;
/** A worker's lifetime usage (any base carried over a resume included). */
type UsageOf = (worker: Worker) => TokenCounts;
interface Tracked { identity: string; busy: boolean; finished: boolean }
type Fields = Omit<WorkerManifestRecord, "v" | "kind" | "workerId" | "backend" | "at">;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Current worker identity as a transcript ref, and a key that changes when it does. */
function identity(worker: Worker): { key: string; ref?: WorkerTranscriptRef } {
	const ref = refFromIdentity(worker.backend ?? "pi", {
		...(text(worker.sessionId) ? { sessionId: worker.sessionId } : {}),
		...(text(worker.sessionFile) ? { sessionFile: worker.sessionFile } : {}),
		cwd: worker.cwd,
	});
	return { key: `${worker.sessionId ?? ""}\n${worker.sessionFile ?? ""}`, ...(ref ? { ref } : {}) };
}

/**
 * Appends manifest records. observe() is cheap and safe to call on every
 * change; it writes only when the identity arrived or a new task began.
 */
export class WorkerRegistryRecorder {
	private readonly tracked = new Map<string, Tracked>();
	private readonly append: Append;
	private readonly usageOf: UsageOf;
	constructor(append: Append, usageOf: UsageOf = (worker) => worker.usage) {
		this.append = append;
		this.usageOf = usageOf;
	}

	private write(worker: Worker, fields: Fields): void {
		try {
			this.append(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", workerId: worker.id, backend: worker.backend ?? "pi", at: Date.now(), ...fields });
		} catch {
			/* Session replacement can invalidate the append API; the record is best effort. */
		}
	}

	private snapshot(worker: Worker) {
		const u = this.usageOf(worker);
		return usageSnapshot({
			input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
			...(u.cost ? { cost: u.cost } : {}),
			...(typeof u.turns === "number" ? { turns: u.turns } : {}),
		});
	}

	/** First record for a published worker, with whatever identity is already known. */
	track(worker: Worker, team?: { teamId: string; role: string; orchestrator?: boolean }, launch?: WorkerLaunchSpec): void {
		if (this.tracked.has(worker.id)) return;
		const { key, ref } = identity(worker);
		this.tracked.set(worker.id, { identity: key, busy: true, finished: false });
		this.write(worker, {
			groupId: worker.groupId,
			name: worker.name,
			spec: {
				cwd: worker.cwd,
				...(worker.model === undefined ? {} : { model: worker.model }),
				...(worker.effort === undefined ? {} : { effort: worker.effort }),
				...(launch?.tools ? { tools: [...launch.tools] } : {}),
				...taskPreview(worker.task),
				wake: worker.wake,
			},
			...(team ? { team: { teamId: team.teamId, role: team.role, ...(team.orchestrator ? { orchestrator: true } : {}) } } : {}),
			...(ref ? { ref } : {}),
			status: "running",
			...(launch ? { launch: launch as unknown as Record<string, unknown> } : {}),
		});
	}

	/** Identity that arrived or changed, and a settled worker that began a new task. */
	observe(worker: Worker): void {
		const tracked = this.tracked.get(worker.id);
		if (!tracked || tracked.finished || worker.isFinished()) return;
		const { key, ref } = identity(worker);
		const identityChanged = key !== tracked.identity && ref !== undefined;
		const started = !tracked.busy && !worker.isSettled();
		if (!identityChanged && !started) return;
		if (identityChanged) tracked.identity = key;
		if (started) tracked.busy = true;
		this.write(worker, { ...(identityChanged ? { ref } : {}), ...(started ? { status: "running" as const } : {}) });
	}

	/** A task settled: the worker is idle; record its outcome and a usage snapshot. */
	settled(worker: Worker): void {
		const tracked = this.tracked.get(worker.id);
		if (!tracked || tracked.finished || worker.isFinished()) return;
		const { key, ref } = identity(worker);
		const identityChanged = key !== tracked.identity && ref !== undefined;
		if (identityChanged) tracked.identity = key;
		tracked.busy = false;
		this.write(worker, {
			...(identityChanged ? { ref } : {}),
			status: "waiting",
			...(worker.taskOutcome ? { taskOutcome: worker.taskOutcome } : {}),
			settledAt: Date.now(),
			usageSnapshot: this.snapshot(worker),
		});
	}

	/** Final record once the process has ended (or its host was found dead: status "lost"). */
	finish(worker: Worker, status?: WorkerManifestStatus): void {
		const tracked = this.tracked.get(worker.id);
		if (!tracked || tracked.finished) return;
		const { key, ref } = identity(worker);
		tracked.finished = true;
		const final = status ?? (worker.status === "done" || worker.status === "killed" ? worker.status : "error");
		this.write(worker, {
			...(key !== tracked.identity && ref ? { ref } : {}),
			status: final, endedAt: worker.endedAt ?? Date.now(),
			...(worker.taskOutcome ? { taskOutcome: worker.taskOutcome } : {}),
			...(worker.error ? { error: worker.error.slice(0, 500) } : {}),
			usageSnapshot: this.snapshot(worker),
		});
	}

	/** A restored worker came back idle (agent_resume): clears its ending in the fold. */
	resumed(worker: Worker): void {
		const { key, ref } = identity(worker);
		this.tracked.set(worker.id, { identity: key, busy: false, finished: false });
		this.write(worker, { resumedAt: Date.now(), status: "waiting", ...(ref ? { ref } : {}) });
	}

	/** Re-adopted workers were recorded by an earlier instance; continue from their last identity. */
	resume(worker: Worker): void {
		if (this.tracked.has(worker.id)) return;
		this.tracked.set(worker.id, { identity: identity(worker).key, busy: !worker.isSettled(), finished: false });
	}

	clear(): void { this.tracked.clear(); }
}
