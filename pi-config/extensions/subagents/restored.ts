/**
 * A restored worker: rebuilt at session start from the owner session's durable
 * record (worker-transcript.ts manifest fold) and its own transcript, after the
 * process that ran it is gone (server restart, reload, session switch). It has
 * no process and never gets one: agent_resume starts a NEW runner that reopens
 * the same backend session idle, and replaces this entry.
 *
 * Status: a worker that had ended keeps its recorded ending (done/error/killed);
 * one that was alive at the restart is "restored", with interruptedAt when it
 * died mid-turn. It is settled and finished, so it never counts as live, never
 * takes a live-cap slot, and a steer is refused with the way back.
 *
 * No process, UI or manager dependency.
 */
import type { AgentStatus, AgentUsage, SteerResult, TaskOutcome, TranscriptItem, Worker } from "./contracts.ts";
import { hasEnded, isInterrupted, type FoldedWorkerManifest, type UsageSource, type WorkerTranscriptView } from "./worker-transcript.ts";

/**
 * The model a worker ran on, in the form its running runner reports (so a label never changes
 * between states): the transcript's last reply, else the largest row (by tokens) of its last
 * usage snapshot, else the spawn spec's model. The claude-code adapter names models
 * "claude/<id>"; a running Claude worker reports the bare <id>, so the prefix is dropped there.
 * Sova's unhosted path (server/worker-restore.ts) applies the same rule.
 */
export function resolvedModel(manifest: FoldedWorkerManifest, view: Pick<WorkerTranscriptView, "summary"> | undefined): string | undefined {
	const bare = (model: string | undefined) => model && manifest.backend === "claude-code" && model.startsWith("claude/") ? model.slice("claude/".length) : model;
	const fromTranscript = bare(view?.summary?.model);
	if (fromTranscript) return fromTranscript;
	const rows = manifest.usageSnapshot?.byModel ?? [];
	const size = (r: (typeof rows)[number]) => r.input + r.output + r.cacheRead + r.cacheWrite;
	const biggest = rows.length ? rows.reduce((a, b) => (size(b) > size(a) ? b : a)) : undefined;
	return bare(biggest?.model) || manifest.spec?.model;
}

/** Why this worker cannot be resumed, or undefined when it can. */
export type ResumeRefusal = string | undefined;

export class RestoredWorker implements Worker {
	readonly restored = true as const;
	readonly backend: string;
	readonly id: string;
	readonly groupId: string;
	readonly name: string;
	readonly task: string;
	readonly cwd: string;
	readonly wake: boolean;
	readonly extensions: readonly string[] = [];
	readonly forked = false;
	readonly startedAt: number;
	readonly whenClosed = Promise.resolve();
	status: AgentStatus;
	taskOutcome?: TaskOutcome;
	processAlive = false;
	model?: string;
	effort?: string;
	sessionId?: string;
	sessionFile?: string;
	transcript: TranscriptItem[];
	transcriptRevision = 0;
	transcriptOmitted = { items: 0, approxBytes: 0 };
	usage: AgentUsage;
	error?: string;
	endedAt?: number;
	lastActivity: number;
	steerCount = 0;
	unreadCount = 0;
	/** Where `usage` came from; "none" = unavailable, never to be shown as 0. */
	readonly usageSource: UsageSource;
	/** When the snapshot `usage` (or only its cost) was taken. */
	readonly usageAsOf?: number;
	/** It died mid-turn: its last known activity. */
	readonly interruptedAt?: number;
	readonly resumeRefusal: ResumeRefusal;
	readonly manifest: FoldedWorkerManifest;
	private readonly lastText: string;

	constructor(manifest: FoldedWorkerManifest, view: WorkerTranscriptView, resumeRefusal: ResumeRefusal) {
		const m = manifest;
		const summary = view.summary;
		this.manifest = m;
		this.resumeRefusal = resumeRefusal;
		this.backend = m.backend;
		this.id = m.workerId;
		this.groupId = m.groupId ?? "run_restored";
		this.name = m.name ?? m.team?.role ?? m.workerId;
		this.task = m.spec?.taskPreview ?? "";
		this.cwd = m.spec?.cwd ?? "";
		this.wake = m.spec?.wake ?? true;
		this.model = resolvedModel(m, view);
		this.effort = m.spec?.effort ?? summary?.effort;
		if (m.ref?.kind === "pi-session-file") {
			this.sessionFile = m.ref.locator;
			if (m.ref.sessionId) this.sessionId = m.ref.sessionId;
		} else if (m.ref) this.sessionId = m.ref.locator;
		this.startedAt = summary?.startedAt ?? m.at;
		this.lastActivity = Math.max(summary?.lastActivityAt ?? 0, m.at);
		// No status at all (a publication record only) is treated as alive at the restart.
		this.status = hasEnded(m) ? (m.status as "done" | "error" | "killed") : "restored";
		if (isInterrupted(m) || m.status === undefined) this.interruptedAt = this.lastActivity;
		this.taskOutcome = m.taskOutcome ?? summary?.lastOutcome;
		if (m.error) this.error = m.error;
		if (m.endedAt !== undefined) this.endedAt = m.endedAt;
		const u = view.usage;
		this.usageSource = u.source;
		this.usageAsOf = u.source === "snapshot" ? u.asOf : u.costSource === "snapshot" ? u.costAsOf : undefined;
		this.usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost ?? 0, turns: u.turns ?? 0, contextTokens: 0 };
		this.lastText = summary?.lastAssistantText ?? "";
		this.transcript = (summary?.items ?? []).map((item) => ({
			ts: item.at ?? 0, kind: item.kind, text: item.text, ...(item.toolName ? { toolName: item.toolName } : {}),
		}));
	}

	get resumable(): boolean { return this.resumeRefusal === undefined; }
	isFinished(): boolean { return true; }
	isSettled(): boolean { return true; }
	isStopping(): boolean { return false; }
	finalOutput(): string { return this.lastText; }
	async steer(): Promise<SteerResult> {
		return { ok: false, reason: `${this.id} was restored after a restart and has no process; ${this.resumable ? "bring it back first with agent_resume" : `it cannot be resumed (${this.resumeRefusal})`}` };
	}
	async kill(): Promise<void> {}
	async dispose(): Promise<void> {}
}

export const isRestored = (worker: Worker): worker is RestoredWorker => (worker as { restored?: unknown }).restored === true;
