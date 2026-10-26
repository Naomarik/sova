/**
 * The worker fold (al_3 stage 4): what a worker's pi events mean to its parent, whatever carries
 * them. A worker is a chat process of its own (chat-worker.ts drives it through Sova's worker host);
 * its feed is the pi events this fold always consumed, so the fold is the one the RPC runner had:
 * transcript items, usage, the task boundary a steer moves when pi delivers it, settle and failure
 * carrying. Lifecycle model (task outcome is deliberately separate from process state):
 *
 *   status        starting → running → waiting ⇄ running; stopping (teardown) → killed;
 *                 terminal: done | error | killed (the worker has ENDED)
 *   taskOutcome   outcome of the most recently COMPLETED task: "success" | "error" | "aborted";
 *                 undefined while a task runs
 *
 * `waiting` means: alive, idle, steerable. A task that FAILED still parks in `waiting` with
 * taskOutcome "error": the worker is fine, the work failed.
 *
 * Which instruction started which run (§app.chat-processes/worker-instructions): every steer and
 * follow-up is sent under a key of its own. A keyed feed (`keyed`, WorkerState.keys) names that key
 * on the user message pi delivers (`sendKey`), so the task boundary moves on an exact key match, and
 * tells a keyed send whose message never ran (`send_dropped`), reported as one line. A feed that names
 * no keys (a worker still on code from before them) gets the best-effort correlation below, from pi's
 * queue_update and the message text.
 * LEGACY: the text/queue correlation (QueuedSteer, trackQueue, isArmedDelivery/isSupersededDelivery's
 * text branches, agent_start beginning the armed run) and the subagents README's "best-effort" list
 * are deleted in al_7's follow-up, once no worker runs code from before keys.
 */
import type { SteerMode, Worker } from "./contracts.ts";
import { summarizeFileChange } from "./codefold.ts";
import type { AgentStatus, AgentUsage, RunnerLimits, SpawnOptions, SteerResult, TaskOutcome, TranscriptItem, TranscriptKind } from "./runner.ts";
import { summarizeToolCall } from "./runner.ts";

export interface FoldHandlers {
	onChange: () => void;
	/** The agent finished its current instructions (or the attempt definitively failed). Fires again after a steer. */
	onSettled: (worker: Worker) => void;
	/** The worker ended. Fires exactly once. */
	onExit: (worker: Worker) => void;
}

const DEFAULT_LIMITS: RunnerLimits = {
	maxTranscriptBytes: 2 * 1024 * 1024,
	maxItemChars: 256 * 1024,
};

export function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as any).type === "text") parts.push(String((part as any).text ?? ""));
	}
	return parts.join("");
}

/**
 * A steer as pi reported it queued. Pi expands /skill: commands and prompt templates (and input
 * extensions may transform text) before queueing, so the delivered user message carries this
 * text, not the raw steer.
 */
interface QueuedSteer {
	queue: "steering" | "followUp";
	text: string;
	/** Identical entries queued ahead of this one; Pi dequeues the first match. */
	ahead: number;
	/** Pi removed this entry from its queue, which it does right before emitting its user message. */
	dequeued: boolean;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** What a steer delivery returns: accepted, rejected with why, or unknown (no answer: it may have been delivered all the same). */
export type Delivery = { ok: true } | { ok: false; reason: string; unknown?: true };

/** The line an accepted instruction that never ran leaves in the transcript and the next report. */
export function neverRanLine(message: string): string {
	const first = message.trim().split("\n")[0]!;
	return `This instruction was accepted but never ran: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`;
}

export abstract class WorkerFold implements Worker {
	readonly backend: string = "pi";
	readonly id: string;
	readonly groupId: string;
	readonly name: string;
	readonly task: string;
	readonly cwd: string;
	readonly wake: boolean;
	readonly extensions: readonly string[];
	readonly forked: boolean;
	readonly startedAt: number;
	readonly whenClosed: Promise<void>;
	pid?: number;
	status: AgentStatus = "starting";
	taskOutcome: TaskOutcome | undefined = undefined;
	processAlive = false;
	model?: string;
	effort?: string;
	sessionId?: string;
	sessionFile?: string;
	transcript: TranscriptItem[] = [];
	/** Bumped on every transcript change (push, trim, marker rewrite, rollback splice). */
	transcriptRevision = 0;
	/** How much of the transcript was trimmed from the front (full data lives in the session file). */
	transcriptOmitted = { items: 0, approxBytes: 0 };
	usage: AgentUsage = emptyUsage();
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	endedAt?: number;
	lastActivity = Date.now();
	steerCount = 0;
	unreadCount = 0;

	protected readonly handlers: FoldHandlers;
	protected readonly limits: RunnerLimits;
	private closedResolve!: () => void;
	/** The worker has ended (or its process was let go of): nothing it sends counts any more. */
	protected closed = false;
	/** From the moment we decided the worker must stop (kill, fatal). Events except endings are dropped. */
	protected killInitiated = false;
	/** Guards against re-announcing the same completion. Re-armed when a task is accepted. */
	protected settleAnnounced = false;
	/** Task-scoped failure flags, cleared when a prompt is accepted. A later successful assistant turn supersedes a transient error. */
	private taskError: string | undefined = undefined;
	private taskAborted = false;
	/** Tool calls awaiting their result, by toolCallId. */
	private openTools = new Map<string, string>();
	private markerItem: TranscriptItem | null = null;
	/** A steer awaits its acceptance. Serializes steers. */
	protected steerPending = false;
	/** The task was accepted: only then is the worker steerable. */
	protected initialPromptAccepted = false;
	/** A task completion was processed while a steer was pending acceptance. */
	private pendingSettled = false;
	/** A steer is armed; the next agent_start (or its delivery) begins its run. */
	private armedAwaitingRun = false;
	/** The transcript marker of the armed steer; moved to the new run's start. */
	private armedSteerItem: TranscriptItem | null = null;
	/** Text of the armed steer, to recognize its delivery when pi reported no queue entry for it. */
	private armedMessage: string | null = null;
	/** Pi's queue entry for the armed steer; its dequeue identifies the delivered user message. */
	private armedQueued: QueuedSteer | null = null;
	/** Pi's queues as of the last queue_update. */
	private piQueue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	/** Queue entries still being followed: only the armed steer's and the superseded one's. */
	private queuedSteers: QueuedSteer[] = [];
	/** While a steer awaits its acceptance: the still-armed steer it superseded, and the seq its run began at (0 = not yet). */
	private superseded: { queued: QueuedSteer | null; message: string | null; key: string | null; begunSeq: number; no: number } | null = null;
	/** Inbox turn record: every armed steer gets a number; tasks begun count from 0 (the first task). */
	private armSeq = 0;
	private armedNo = 0;
	private tasksBegun = 0;
	/** Ascending: steers numbered up to `upTo` had begun by task `task`. */
	private steerTasks: { upTo: number; task: number }[] = [];
	/** The previous task settled after the armed marker was pushed: until the armed run starts, its output is still current. */
	private armedPredecessorSettled = false;
	/** Output task boundaries as monotonic push sequence numbers (trimming may evict any marker). */
	private pushSeq = 0;
	private taskBoundarySeq = 0;
	private armedBoundarySeq = 0;
	/** Latest assistant text and its seq; kept even if its transcript item is trimmed. */
	private lastAssistant: { seq: number; text: string } | null = null;
	/** The next agent_start continues the same task (auto-retry or overflow compaction). */
	private recoveryPending = false;
	/** Failures of earlier runs in this unannounced task. Pi continues queued messages after a failed run. */
	private carriedFailures: { outcome: "error" | "aborted"; message: string }[] = [];
	/** Between compaction_start and compaction_end. */
	protected compactionActive = false;
	/** Picked back up after a reload or a restart: a run that starts after a settle with no armed steer was steered by an earlier manager. */
	protected adopted = false;
	/** The feed names each user message's send key (WorkerState.keys): boundaries move on exact keys. Otherwise the legacy correlation. */
	protected keyed = false;
	/** The key the armed steer was sent under. */
	private armedKey: string | null = null;
	/** Accepted (or awaiting acceptance) instructions whose message has not been seen yet, key → text:
	    tracked only while the feed is keyed (an unkeyed delivery names no key to clear one by). */
	protected readonly outstanding = new Map<string, string>();
	/** Between a run's start and its settle, as the feed says. */
	protected runActive = false;
	/** Never-ran lines the next report carries. */
	private neverRan: string[] = [];

	constructor(options: SpawnOptions, handlers: FoldHandlers, startedAt = Date.now()) {
		this.id = options.id;
		this.groupId = options.groupId;
		this.name = options.name;
		this.task = options.task;
		this.cwd = options.cwd;
		this.wake = options.wake ?? true;
		this.extensions = [...(options.extensions ?? [])];
		this.forked = Boolean(options.forkSession);
		this.model = options.model;
		this.effort = options.effort;
		this.startedAt = startedAt;
		this.handlers = handlers;
		this.limits = {
			...DEFAULT_LIMITS,
			...options.limits,
			maxItemChars: Math.min(options.limits?.maxItemChars ?? DEFAULT_LIMITS.maxItemChars, options.limits?.maxTranscriptBytes ?? DEFAULT_LIMITS.maxTranscriptBytes),
		};
		this.whenClosed = new Promise<void>((resolve) => {
			this.closedResolve = resolve;
		});
	}

	// ── the fold ─────────────────────────────────────────────────────────────

	/** One pi event of the worker's feed (wire-1, pi's rpc shapes). */
	protected handleEvent(event: any): void {
		// Once we are stopping the worker or it ended, everything else on the feed is stale: a queued
		// agent_start must not resurrect a killed agent.
		if (this.closed || this.killInitiated) return;

		switch (event?.type) {
			case "agent_start": {
				// Retry and overflow-compaction runs continue the same attempt. Any other agent_start
				// before this task was announced means Pi is continuing queued messages after the
				// previous run ended, which it does even when that run failed. Keep that failure.
				const recovery = this.recoveryPending;
				this.recoveryPending = false;
				if (!recovery && !this.settleAnnounced && (this.taskError || this.taskAborted)) this.carryFailure();
				// Picked back up: a run after a settle this worker never armed was steered by an earlier manager. A fresh task.
				if (this.adopted && !recovery && this.settleAnnounced && !this.armedAwaitingRun) this.beginAdoptedRun();
				this.status = "running";
				this.runActive = true;
				// LEGACY (no keys): the next run is taken as the armed steer's. A keyed feed names it on its message.
				if (this.armedAwaitingRun && !recovery && !this.keyed) {
					this.beginArmedRun();
					// Before the pending steer is queued, this run can only be the superseded one's.
					if (this.superseded && !this.superseded.begunSeq) this.superseded.begunSeq = this.taskBoundarySeq;
				}
				break;
			}

			case "agent_end":
				if (event.willRetry === true) this.recoveryPending = true;
				break;

			case "agent_settled":
				this.runActive = false;
				this.processSettled();
				break;

			case "send_dropped":
				if (typeof event.sendKey === "string") this.instructionNeverRan(event.sendKey);
				break;

			case "message_end": {
				const message = event.message;
				if (!message) break;
				if (message.role === "assistant") {
					this.usage.turns++;
					this.addUsage(message.usage);
					const text = textOf(message.content);
					if (text.trim()) {
						this.push("assistant", text.trim());
						this.unreadCount++;
					}
					// A failed assistant turn is a failed TASK, not a dying worker: reported via
					// taskOutcome at settle time while it parks in `waiting`, still steerable.
					if (message.errorMessage) this.taskError = String(message.errorMessage);
					else if (message.stopReason === "error") this.taskError = "assistant turn failed (stopReason: error)";
					else this.taskError = undefined;
					this.taskAborted = message.stopReason === "aborted";
				} else if (message.role === "toolResult") {
					// Tool-reported usage is nested LLM work; it contributes to totals.
					this.addUsage(message.usage);
				} else if (message.role === "user" && (this.keyed || typeof event.sendKey === "string")) {
					this.setKeyed(true);
					this.keyedDelivery(typeof event.sendKey === "string" ? event.sendKey : undefined, textOf(message.content));
				} else if (message.role === "user" && this.isSupersededDelivery(textOf(message.content))) {
					this.beginSupersededRun();
				} else if (message.role === "user" && this.armedAwaitingRun && this.isArmedDelivery(textOf(message.content))) {
					// A steer can be delivered inside the running run without a new agent_start. Its user message is the task boundary.
					this.beginArmedRun();
				} else if (message.role === "user" && this.adopted && this.settleAnnounced === false && !this.armedAwaitingRun) {
					// Picked back up mid-run: a later instruction an earlier manager sent.
					this.push("steer", textOf(message.content));
				}
				break;
			}

			case "queue_update":
				// LEGACY: only an unkeyed feed needs pi's queue to tell its steers apart.
				if (!this.keyed) this.trackQueue(event);
				break;

			case "tool_execution_start": {
				const name = event.toolName ?? "tool";
				const args = event.args ?? {};
				if (event.toolCallId) this.openTools.set(event.toolCallId, name);
				this.push("tool", summarizeToolCall(name, args), name, summarizeFileChange(name, args));
				break;
			}

			case "tool_execution_end": {
				const name = event.toolName ?? this.openTools.get(event.toolCallId) ?? "tool";
				if (event.toolCallId) this.openTools.delete(event.toolCallId);
				if (event.isError) {
					const text = textOf(event.result?.content) || "(tool failed)";
					this.push("tool-result", text.slice(0, 2000), name);
				}
				break;
			}

			case "auto_retry_start":
				this.recoveryPending = true;
				this.push("system", `auto-retry ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}: ${String(event.errorMessage ?? "transient error").slice(0, 200)}`);
				break;

			case "auto_retry_end":
				// A retry that overcame the transient error un-fails the task; a final failure pins it.
				if (event.success === true) this.taskError = undefined;
				else if (event.success === false) {
					// No retry run follows (exhausted or cancelled); a later agent_start is a queued continuation.
					this.recoveryPending = false;
					this.taskError ??= event.finalError ? String(event.finalError) : "auto-retry failed after transient errors";
				}
				break;

			case "compaction_start":
				this.compactionActive = true;
				break;

			case "compaction_end":
				this.compactionActive = false;
				// A compaction failure can settle the run with no assistant error message; an aborted compaction is no task failure.
				if (!event.aborted && event.errorMessage) this.taskError = String(event.errorMessage);
				else if (!event.aborted && event.willRetry === true) this.recoveryPending = true;
				// Compaction's summarization call is model work; include it.
				if (event.result?.usage) this.addUsage(event.result.usage);
				break;

			case "extension_error":
				this.push("error", String(event.error ?? "extension error"));
				break;
		}
		this.touch();
	}

	/** The feed names send keys, or stops naming them (its worker's process changed code): what was
	    outstanding under the other mode is no longer known, never reported as never run. */
	protected setKeyed(on: boolean): void {
		if (this.keyed === on) return;
		this.keyed = on;
		this.outstanding.clear();
	}

	/** A keyed feed's user message: the instruction whose key it names begins here (exact, never by text). */
	private keyedDelivery(sendKey: string | undefined, text: string): void {
		if (sendKey !== undefined) this.outstanding.delete(sendKey);
		const s = this.superseded;
		if (sendKey !== undefined && s && !s.begunSeq && this.steerPending && sendKey === s.key) this.beginSupersededRun();
		else if (sendKey !== undefined && this.armedAwaitingRun && sendKey === this.armedKey) this.beginArmedRun();
		else if (this.adopted && this.settleAnnounced === false && !this.armedAwaitingRun) {
			// Picked back up mid-run: a later instruction an earlier manager sent (or an untagged message).
			this.push("steer", text);
		}
	}

	/**
	 * An accepted instruction's message never ran and never will (Stop while it was queued, its turn
	 * failed before it began, its process ended): one line, in the transcript and the next report. With
	 * no run going, that report comes now, as an error; never a wait for a delivery that can't come.
	 */
	protected instructionNeverRan(key: string): void {
		const message = this.outstanding.get(key);
		if (message === undefined) return;
		this.outstanding.delete(key);
		const line = neverRanLine(message);
		this.push("error", line);
		if (this.armedAwaitingRun && key === this.armedKey) {
			this.armedAwaitingRun = false;
			this.armedSteerItem = null;
			this.armedMessage = null;
			this.armedQueued = null;
			this.armedKey = null;
			this.armedPredecessorSettled = false;
		}
		if (this.superseded?.key === key) this.superseded.key = null;
		// The report owes this line: the settle that comes (or one now) announces it.
		this.settleAnnounced = false;
		this.neverRan.push(line);
		if (!this.runActive) this.announceNeverRan();
	}

	/** No run is going to settle: report the never-ran lines now, as the outcome error. */
	private announceNeverRan(): void {
		this.taskError = this.neverRanLines().join("; ");
		this.taskAborted = false;
		this.processSettled();
	}

	/** The never-ran lines not reported yet (taken). */
	protected neverRanLines(): string[] {
		const lines = this.neverRan;
		this.neverRan = [];
		return lines;
	}

	/** A keyed worker's process died with instructions it accepted still unseen: none of them will run.
	    Reported with the next settle (`runActive`), or at once in one report. One still awaiting its
	    acceptance is not yet accepted: its send's answer says what became of it. */
	protected dropOutstanding(): void {
		if (!this.keyed || !this.outstanding.size) return;
		const running = this.runActive;
		this.runActive = true;
		for (const key of [...this.outstanding.keys()]) if (!(this.steerPending && key === this.armedKey)) this.instructionNeverRan(key);
		this.runActive = running;
		if (!running && this.neverRan.length) this.announceNeverRan();
	}

	/**
	 * Follow Pi's steering/follow-up queues. Pi queues a streaming prompt (and emits this update)
	 * before acknowledging it, so an entry appended while our steer awaits acceptance is that steer,
	 * as expanded by Pi. Pi removes an entry (first text match) right before emitting its user message.
	 */
	private trackQueue(event: any): void {
		const prev = this.piQueue;
		const next = { steering: stringList(event.steering), followUp: stringList(event.followUp) };
		this.piQueue = next;
		for (const queue of ["steering", "followUp"] as const) {
			const count = (list: string[], text: string) => list.filter((t) => t === text).length;
			for (const entry of [...this.queuedSteers]) {
				if (entry.queue !== queue) continue;
				const removed = count(prev[queue], entry.text) - count(next[queue], entry.text);
				if (removed <= 0) continue;
				entry.ahead -= removed;
				if (entry.ahead < 0) {
					entry.dequeued = true;
					this.queuedSteers.splice(this.queuedSteers.indexOf(entry), 1);
				}
			}
			// Pi appends exactly one entry per queued prompt.
			const appended = next[queue].length === prev[queue].length + 1 && prev[queue].every((t, i) => next[queue][i] === t);
			if (appended && this.steerPending && this.armedAwaitingRun && !this.armedQueued) {
				const text = next[queue][next[queue].length - 1]!;
				this.armedQueued = { queue, text, ahead: count(prev[queue], text), dequeued: false };
				this.queuedSteers.push(this.armedQueued);
			}
		}
		this.pruneQueuedSteers();
	}

	/** Entries of steers that began, were superseded and accepted over, or were cleared by Pi are not needed. */
	private pruneQueuedSteers(): void {
		this.queuedSteers = this.queuedSteers.filter((e) => e === this.armedQueued || e === this.superseded?.queued);
	}

	/** Is this delivered user message the armed steer? */
	private isArmedDelivery(text: string): boolean {
		// Pi reported the steer queued: only its dequeue proves delivery.
		if (this.armedQueued) return this.armedQueued.dequeued && text === this.armedQueued.text;
		return text === this.armedMessage;
	}

	/** Is this delivered user message the superseded steer, delivered while the new steer awaits its acceptance? */
	private isSupersededDelivery(text: string): boolean {
		const s = this.superseded;
		if (!s || s.begunSeq || !this.steerPending) return false;
		if (s.queued) return s.queued.dequeued && text === s.queued.text;
		return text === s.message;
	}

	/** The superseded steer's run began inside the running run: output from here on is not the predecessor's. */
	private beginSupersededRun(): void {
		this.superseded!.begunSeq = this.taskBoundarySeq = ++this.pushSeq;
		this.markTaskBegun(this.superseded!.no);
		this.taskError = undefined;
		this.taskAborted = false;
	}

	/** Complete the current task: park in `waiting`, record the outcome, announce once. */
	protected processSettled(): void {
		if (this.settleAnnounced) return;
		if (this.steerPending) this.pendingSettled = true;
		// The armed steer has not started: this settle completes its predecessor.
		if (this.armedAwaitingRun) this.armedPredecessorSettled = true;
		this.recoveryPending = false;
		if (this.status === "running" || this.status === "starting") this.status = "waiting";
		this.openTools.clear();
		this.settleAnnounced = true;
		let outcome: TaskOutcome = this.taskAborted ? "aborted" : this.taskError ? "error" : "success";
		let error = outcome === "error" ? this.taskError : undefined;
		if (this.carriedFailures.length) {
			// Queued continuation ran after an earlier failure; do not report success.
			const earlier = this.carriedFailures.map((f) => `${f.outcome}: ${f.message}`).join("; ");
			if (outcome === "success" || (outcome === "aborted" && this.carriedFailures.some((f) => f.outcome === "error")))
				outcome = this.carriedFailures.some((f) => f.outcome === "error") ? "error" : "aborted";
			error = `Earlier instructions failed before Pi continued queued instructions (${earlier})${error ? `; final run error: ${error}` : ""}`;
			this.carriedFailures = [];
		}
		if (this.neverRan.length) {
			error = [error, ...this.neverRan].filter(Boolean).join("; ");
			this.neverRan = [];
		}
		this.taskOutcome = outcome;
		if (error !== undefined) this.error = error;
		else if (outcome === "success") this.error = undefined;
		// Synchronous on purpose: the callback must see exactly this task's completed state.
		this.handlers.onSettled(this);
	}

	/** Picked back up: an unarmed run after a settled task (steered by an earlier manager) starts a new task. */
	private beginAdoptedRun(): void {
		this.taskBoundarySeq = ++this.pushSeq;
		this.markTaskBegun(0);
		this.settleAnnounced = false;
		this.taskError = undefined;
		this.taskAborted = false;
		this.taskOutcome = undefined;
		this.error = undefined;
		this.carriedFailures = [];
	}

	/** A new task began; it carries every steer numbered up to `steerNo` that had not begun. */
	private markTaskBegun(steerNo: number): void {
		this.tasksBegun++;
		const last = this.steerTasks[this.steerTasks.length - 1];
		if (steerNo > (last?.upTo ?? 0)) {
			this.steerTasks.push({ upTo: steerNo, task: this.tasksBegun });
			if (this.steerTasks.length > 128) this.steerTasks.splice(0, this.steerTasks.length - 128);
		}
	}

	/**
	 * The inbox's turn record (§app.teams/inbox-zero): the task running now (0 = the first), and the
	 * number of the newest accepted steer while its run has not begun (a wake taken now is seen in
	 * that steer's task, not in the one running or just ended).
	 */
	inboxTurn(): { task: number; steer?: number } {
		return this.armedAwaitingRun ? { task: this.tasksBegun, steer: this.armedNo } : { task: this.tasksBegun };
	}
	/** The task a numbered steer was delivered in, once it began; undefined while it has not. */
	steerTask(no: number): number | undefined {
		for (const e of this.steerTasks) if (e.upTo >= no) return e.task;
		return undefined;
	}

	/** Record a failed run that Pi followed with queued instructions, and start the next run clean. */
	private carryFailure(): void {
		const failure = this.taskAborted ? { outcome: "aborted" as const, message: this.taskError ?? "run aborted" } : { outcome: "error" as const, message: this.taskError! };
		this.carriedFailures.push(failure);
		this.push("error", `Run ended with ${failure.outcome} (${failure.message}); Pi is continuing queued instructions.`);
		this.taskError = undefined;
		this.taskAborted = false;
	}

	/** The armed steer's run has begun: re-arm the announcement and make its marker the output boundary. */
	private beginArmedRun(): void {
		this.markTaskBegun(this.armedNo);
		this.armedAwaitingRun = false;
		this.armedPredecessorSettled = false;
		this.armedMessage = null;
		this.armedKey = null;
		this.armedQueued = null;
		this.pruneQueuedSteers();
		this.taskBoundarySeq = ++this.pushSeq;
		this.settleAnnounced = false;
		this.taskError = undefined;
		this.taskAborted = false;
		this.taskOutcome = undefined;
		this.error = undefined;
		// Display boundary: show the marker at the new run's start.
		if (this.armedSteerItem) {
			const idx = this.transcript.indexOf(this.armedSteerItem);
			if (idx !== this.transcript.length - 1) {
				if (idx !== -1) this.transcript.splice(idx, 1);
				this.transcript.push(this.armedSteerItem);
				if (idx === -1) this.trimTranscript();
				this.transcriptRevision++;
			}
			this.armedSteerItem = null;
		}
	}

	protected addUsage(usage: any): void {
		if (!usage) return;
		this.usage.input += usage.input || 0;
		this.usage.output += usage.output || 0;
		this.usage.cacheRead += usage.cacheRead || 0;
		this.usage.cacheWrite += usage.cacheWrite || 0;
		this.usage.cost += usage.cost?.total || 0;
		if (usage.totalTokens) this.usage.contextTokens = usage.totalTokens;
	}

	// ── steering ─────────────────────────────────────────────────────────────

	/** Why a steer can't be sent now, or null. */
	protected abstract steerRefusal(): string | null;
	/** A new key for the next steer or follow-up (each send its own). */
	protected abstract nextSendKey(): string;
	/** Send the steer under `key`; its acceptance, rejection, or no answer (unknown). */
	protected abstract deliver(message: string, mode: SteerMode | undefined, wasRunning: boolean, key: string): Promise<Delivery>;

	/**
	 * Redirect the agent: a steer while it runs, a fresh prompt when idle. Resolves once the worker
	 * accepts or rejects the message. Cancellation ends only the caller's wait, delivery unknown;
	 * task events still reconcile normally and never cause a kill.
	 */
	async steer(message: string, signal?: AbortSignal, mode?: SteerMode): Promise<SteerResult> {
		signal?.throwIfAborted();
		let cancelled = false;
		let onAbort: (() => void) | undefined;
		const cancellation = new Promise<SteerResult>((resolve) => {
			onAbort = () => {
				cancelled = true;
				resolve({ ok: false, reason: "steering wait cancelled; delivery unknown — worker was not stopped; inspect status/transcript before retrying" });
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([this.deliverSteer(message, mode, () => cancelled), cancellation]);
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	private async deliverSteer(message: string, mode: SteerMode | undefined, cancelled: () => boolean): Promise<SteerResult> {
		if (this.isFinished()) return { ok: false, reason: "agent process exited" };
		if (!this.initialPromptAccepted)
			return { ok: false, reason: this.compactionActive ? "agent is still starting (Pi is compacting context before accepting the task)" : "agent is still starting" };
		if (this.killInitiated) return { ok: false, reason: "agent is being stopped" };
		if (this.steerPending) return { ok: false, reason: "another steer is still awaiting acceptance" };
		const refused = this.steerRefusal();
		if (refused) return { ok: false, reason: refused };

		const wasRunning = this.status === "running";
		const snapshot = {
			status: this.status,
			taskOutcome: this.taskOutcome,
			error: this.error,
			settleAnnounced: this.settleAnnounced,
			taskError: this.taskError,
			taskAborted: this.taskAborted,
			openTools: new Map(this.openTools),
			armedAwaitingRun: this.armedAwaitingRun,
			armedSteerItem: this.armedSteerItem,
			armedMessage: this.armedMessage,
			armedQueued: this.armedQueued,
			armedKey: this.armedKey,
			armedPredecessorSettled: this.armedPredecessorSettled,
			taskBoundarySeq: this.taskBoundarySeq,
			armedBoundarySeq: this.armedBoundarySeq,
		};
		this.superseded = snapshot.armedAwaitingRun ? { queued: snapshot.armedQueued, message: snapshot.armedMessage, key: snapshot.armedKey, begunSeq: 0, no: this.armedNo } : null;
		const priorArmedNo = this.armedNo;
		const key = this.nextSendKey();

		// Arm the new task BEFORE sending: its acceptance and the new task's events can arrive in either
		// order, and those events must land in the NEW task (announced, parked, finalOutput scoped).
		this.steerPending = true;
		this.pendingSettled = false;
		// Superseding a steer still awaiting its run: that earlier marker becomes a fixed boundary.
		if (this.armedAwaitingRun) this.taskBoundarySeq = this.armedBoundarySeq;
		this.armedAwaitingRun = true;
		this.armedNo = ++this.armSeq;
		this.armedMessage = message;
		this.armedKey = key;
		if (this.keyed) this.outstanding.set(key, message);
		this.armedQueued = null;
		this.armedPredecessorSettled = false;
		this.settleAnnounced = false;
		this.taskOutcome = undefined;
		this.error = undefined;
		if (!wasRunning) {
			// Steering an idle agent: any prior failure flags are stale history.
			this.taskError = undefined;
			this.taskAborted = false;
		}
		this.openTools.clear();
		this.status = "running";
		this.steerCount++;
		this.push("steer", message);
		const steerItem = this.transcript[this.transcript.length - 1]!;
		this.armedSteerItem = steerItem;
		this.armedBoundarySeq = this.pushSeq;
		this.touch();

		const res = await this.deliver(message, mode, wasRunning, key);
		this.steerPending = false;
		const superseded = this.superseded;
		this.superseded = null;

		if (this.closed || this.killInitiated) return { ok: false, reason: "process exited" };
		if (res.ok !== true) {
			// A rejection, or no answer (unknown: the worker is healthy and sends are keyed, so it is
			// neither stopped nor sent again). Either way undo the arm, except completion state that
			// legitimately progressed meanwhile; should the message land after all, its run shows as
			// the worker's next task.
			const result: SteerResult = res.unknown
				? { ok: false, unknown: true, reason: `${res.reason}; delivery unknown — the message may not have been delivered; the worker was not stopped and nothing is sent again; inspect status/transcript before retrying` }
				: { ok: false, reason: res.reason };
			const idx = this.transcript.indexOf(steerItem);
			if (idx !== -1) {
				this.transcript.splice(idx, 1);
				this.transcriptRevision++;
			}
			this.steerCount--;
			if (res.unknown) this.push("error", `${res.reason}; this message may not have been delivered; the worker was not stopped:\n${message}`);
			// Not accepted: never reported as an instruction that never ran (a refusal, or delivery unknown).
			this.outstanding.delete(key);
			if (superseded?.begunSeq) {
				// The previously armed steer's run began while we waited: it is the current task now.
				this.armedAwaitingRun = false;
				this.armedSteerItem = null;
				this.armedMessage = null;
				this.armedQueued = null;
				this.armedKey = null;
				this.armedPredecessorSettled = false;
				this.taskBoundarySeq = superseded.begunSeq;
				this.pruneQueuedSteers();
				this.touch();
				return result;
			}
			// A previously accepted steer may still be awaiting ITS run: restore the armed bookkeeping.
			this.armedAwaitingRun = snapshot.armedAwaitingRun;
			this.armedNo = priorArmedNo;

			this.armedSteerItem = snapshot.armedSteerItem;
			this.armedMessage = snapshot.armedMessage;
			this.armedQueued = snapshot.armedQueued;
			this.armedKey = snapshot.armedKey;
			this.taskBoundarySeq = snapshot.taskBoundarySeq;
			this.armedBoundarySeq = snapshot.armedBoundarySeq;
			this.armedPredecessorSettled = snapshot.armedPredecessorSettled || this.pendingSettled;
			if (!this.pendingSettled) {
				this.status = snapshot.status;
				this.taskOutcome = snapshot.taskOutcome;
				this.error = snapshot.error;
				this.settleAnnounced = snapshot.settleAnnounced;
				this.taskError = snapshot.taskError;
				this.taskAborted = snapshot.taskAborted;
				this.openTools = snapshot.openTools;
			}
			this.pruneQueuedSteers();
			this.touch();
			return result;
		}
		// Accepted: the new task is armed and events that raced the acceptance were processed under it.
		this.pruneQueuedSteers();
		return { ok: true };
	}

	// ── ending ───────────────────────────────────────────────────────────────

	/**
	 * Exactly-once end bookkeeping: the worker ended (killed, failed, done). An unsettled task still
	 * owes the caller one completion announcement.
	 */
	protected finalize(end: { status?: AgentStatus; error?: string; exitCode?: number | null; signal?: string | null }): void {
		if (this.closed) return;
		this.closed = true;
		this.processAlive = false;
		this.exitCode = end.exitCode ?? null;
		this.signal = end.signal ?? null;
		if (end.error) this.error = end.error;
		if (this.status === "stopping") this.status = "killed";
		else if (end.status) this.status = end.status;
		else if (this.status !== "killed" && this.status !== "error") this.status = "done";
		if (!this.settleAnnounced) {
			this.settleAnnounced = true;
			if (this.carriedFailures.some((f) => f.outcome === "error") && this.taskOutcome !== "error") this.taskOutcome = "error";
			this.carriedFailures = [];
			this.taskOutcome ??= this.killInitiated && this.status !== "error" ? "aborted" : "error";
			this.handlers.onSettled(this);
		}
		this.endedAt = Date.now();
		this.touch();
		this.handlers.onExit(this);
		this.closedResolve();
	}

	/** Let go of the worker without ending it (its process runs on, the host keeps it): no end, no announcement. */
	protected release(): void {
		if (this.closed) return;
		this.closed = true;
		this.closedResolve();
	}

	abstract kill(reason?: string): Promise<void>;
	abstract dispose(): Promise<void>;

	/** The worker has ended, or was let go of (see Worker's termination contract). */
	isFinished(): boolean {
		return this.closed;
	}

	/** Teardown is in flight, not yet closed; see Worker.isStopping. */
	isStopping(): boolean {
		return !this.closed && this.killInitiated;
	}

	/**
	 * Nothing left to do right now: what callers should wait on (a healthy worker parks in `waiting`).
	 * `stopping` is deliberately NOT settled. Check `taskOutcome` for how the task ended.
	 */
	isSettled(): boolean {
		return this.isFinished() || this.status === "waiting";
	}

	/**
	 * Latest assistant text from the CURRENT task only: until an accepted steer's task produces output
	 * this is "", never the previous task's answer. A steer marker pushed before its predecessor settled
	 * is no boundary until the steer's run begins.
	 */
	finalOutput(): string {
		const boundary = this.armedAwaitingRun && !this.armedPredecessorSettled ? this.armedBoundarySeq : this.taskBoundarySeq;
		return this.lastAssistant && this.lastAssistant.seq > boundary ? this.lastAssistant.text : "";
	}

	// ── transcript ───────────────────────────────────────────────────────────

	protected push(kind: TranscriptKind, text: string, toolName?: string, summary?: string): void {
		const maxChars = this.limits.maxItemChars;
		if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars — full content in this agent's session file]`;
		this.transcript.push(summary ? { ts: Date.now(), kind, text, toolName, summary } : { ts: Date.now(), kind, text, toolName });
		const seq = ++this.pushSeq;
		if (kind === "task") this.taskBoundarySeq = seq;
		else if (kind === "assistant") this.lastAssistant = { seq, text };
		this.lastActivity = Date.now();
		this.trimTranscript();
		this.transcriptRevision++;
	}

	/** Bound in-memory retention to a ~2 MiB tail (UTF-8 bytes); a head marker says what was omitted. */
	private trimTranscript(): void {
		const cap = this.limits.maxTranscriptBytes;
		const sizeOf = (t: TranscriptItem) => Buffer.byteLength(t.text, "utf8") + 48;
		let total = 0;
		for (const item of this.transcript) total += sizeOf(item);
		if (total <= cap) return;
		const head = this.transcript[0]?.kind === "task" ? 1 : 0; // never trim the task item
		const hasMarker = this.markerItem !== null && this.transcript.includes(this.markerItem);
		const fixed = head + (hasMarker ? 1 : 0);
		const target = Math.floor(cap * 0.75);
		let dropped = 0;
		let droppedBytes = 0;
		while (this.transcript.length > fixed + 1 && total > target) {
			const item = this.transcript.splice(fixed, 1)[0]!;
			total -= sizeOf(item);
			dropped++;
			droppedBytes += sizeOf(item);
		}
		if (!dropped) return;
		this.transcriptOmitted.items += dropped;
		this.transcriptOmitted.approxBytes += droppedBytes;
		const text = `… ${this.transcriptOmitted.items} earlier transcript item(s) (~${Math.max(1, Math.round(this.transcriptOmitted.approxBytes / 1024))} KiB) trimmed — full history in this agent's session file …`;
		if (this.markerItem) this.markerItem.text = text;
		else {
			this.markerItem = { ts: Date.now(), kind: "system", text };
			this.transcript.splice(head, 0, this.markerItem);
		}
	}

	protected touch(): void {
		this.lastActivity = Date.now();
		this.handlers.onChange();
	}
}
