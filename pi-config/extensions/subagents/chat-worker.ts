/**
 * A worker as its parent's manager holds it (al_3 stage 4, design §2.7): a chat process of its own,
 * started and driven through Sova's worker host (worker-host.ts), never a child of this process. The
 * host's feed is the worker's pi events, folded exactly as an RPC worker's were (fold.ts). A parent
 * that reloads or crashes lets go of its workers (dispose detaches) and the next one picks them back
 * up (`attach`); only a kill stops one.
 */
import * as path from "node:path";
import type { SteerMode, Worker } from "./contracts.ts";
import { type Delivery, type FoldHandlers, WorkerFold } from "./fold.ts";
import { fileMessages } from "./run-watch.ts";
import type { SpawnOptions } from "./runner.ts";
import { WORKER_TOOLS_ENV } from "./worker-mark.ts";
import { isNoAnswer, type WorkerFeedFrame, type WorkerHost, type WorkerKind, type WorkerRef, type WorkerSession, type WorkerStart, type WorkerState } from "./worker-host.ts";

/** The parent a worker belongs to: its session, and the key prefix its starts and sends carry. */
export interface WorkerParent {
	sessionId: string;
	path: string;
}

/**
 * Today's SpawnOptions as a WorkerStart (design §2.2): the loadout as data, nothing interpreted.
 * `defaultSessionDir(cwd)`: where pi keeps a session for that cwd, for a worker that names no
 * directory of its own.
 */
export function workerStartOf(o: SpawnOptions, parent: WorkerParent, key: string, defaultSessionDir: (cwd: string) => string, kind: WorkerKind = "worker"): WorkerStart {
	const env: Record<string, string> = { ...o.env };
	const agentDir = env.PI_CODING_AGENT_DIR ?? null;
	delete env.PI_CODING_AGENT_DIR;
	// Restricted by exclusion: the marker extension activates the requested built-ins pi's default set lacks.
	if (o.tools?.length && o.extensions?.length) env[WORKER_TOOLS_ENV] = o.tools.join(",");
	const dir = o.sessionDir ?? defaultSessionDir(o.cwd);
	const session: WorkerSession = o.resume?.sessionFile
		? { resume: { file: o.resume.sessionFile } }
		: o.forkSession
			? { fork: { from: o.forkSession, dir } }
			: { new: { dir } };
	return {
		key,
		spec: {
			kind,
			parent: { sessionId: parent.sessionId, path: parent.path, workerId: o.id },
			cwd: o.cwd,
			model: o.model ?? null,
			thinking: o.effort ?? null,
			builtins: o.tools ? [...o.tools] : null,
			extensions: [...(o.extensions ?? [])],
			flags: { ...o.flags },
			appendSystemPrompt: o.systemPrompt?.trim() ? o.systemPrompt : null,
			env,
			agentDir,
			lowered: true,
		},
		session,
		task: o.resume ? null : o.task,
	};
}

/** pi's own session directory name for a cwd (session-manager.js getDefaultSessionDirPath). */
export function sessionDirName(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface ChatWorkerOptions {
	host: WorkerHost;
	parent: WorkerParent;
	/** A new start (its key), or a worker the host already runs: picked back up. */
	start?: { key: string; defaultSessionDir: (cwd: string) => string };
	attach?: {
		ref: WorkerRef;
		/** What the parent's record and the worker's file said (the restored entry it replaces). */
		seed?: Pick<Worker, "transcript" | "usage" | "status" | "taskOutcome" | "error" | "startedAt" | "model" | "effort">;
		/** The settle the parent's record last announced (registry.ts settleKey), its final entry and
		    when it was recorded (or the worker last resumed). */
		settleKey?: string;
		settleEntryId?: string;
		settledAt?: number;
	};
}

const isActive = (s: WorkerState["status"]) => s === "running" || s === "starting";

export class ChatWorker extends WorkerFold {
	readonly backend: string;
	/** What `usage` covers: a worker picked back up starts from its whole session's spend. */
	readonly usageScope: "process" | "session";
	/** The worker chat's id with the host, once started. */
	chatId?: string;
	/** The key of the settle last announced (written with it, registry.ts), and its final entry. */
	settleKey?: string;
	settleEntryId?: string;
	/** Picked back up: what the parent last recorded, for a reopened process that no longer knows its settle. */
	private recorded?: { entryId?: string; at?: number };
	/** When this worker last learned of a settle (its event or its state), for a resync's file check. */
	private settleSeenAt?: number;
	/** A gap was fed: the next state is read as a first one. */
	private resync = false;
	private readonly host: WorkerHost;
	private readonly resumed: boolean;
	private unwatch: (() => void) | null = null;
	private lastState: WorkerState | null = null;
	private steers = 0;
	private readonly nonce = Math.random().toString(36).slice(2, 8);

	constructor(options: SpawnOptions, handlers: FoldHandlers, o: ChatWorkerOptions) {
		super(options, handlers, (o.attach?.seed?.startedAt ?? (options.resume ? options.resume.startedAt : undefined)) ?? Date.now());
		this.backend = options.backend ?? "pi";
		this.host = o.host;
		this.resumed = !o.attach && Boolean(options.resume);
		this.usageScope = o.attach ? "session" : "process";
		if (o.attach) this.attachTo(o.attach);
		else this.begin(options, o);
	}

	// ── start ────────────────────────────────────────────────────────────────

	private begin(options: SpawnOptions, o: ChatWorkerOptions): void {
		if (this.resumed) {
			// A resumed worker owes no completion, not even for a failed reopen: nothing was asked of it.
			this.settleAnnounced = true;
			this.push("system", `Resuming session ${options.resume?.sessionFile ?? ""}; idle until steered`);
		} else this.push("task", options.task);
		const req = workerStartOf(options, o.parent, o.start!.key, o.start!.defaultSessionDir);
		let started: Promise<WorkerRef>;
		try {
			started = this.host.start(req);
		} catch (err) {
			// Refused at once: the worker fails before its constructor returns.
			return this.failStart(err);
		}
		void started.then(
			(ref) => {
				if (this.closed) return;
				this.bind(ref);
				if (this.killInitiated) {
					void this.host.stop(ref.chatId, this.error ?? "killed by user").catch(() => {}).finally(() => this.finalize({ status: "killed" }));
					return;
				}
				// The task was accepted (the host sends it under its key before answering).
				this.initialPromptAccepted = true;
				if (this.resumed) {
					this.status = "waiting";
					this.push("system", "Session reopened; waiting for instructions");
				} else if (this.status === "starting") this.status = "running";
				this.touch();
			},
			(err) => this.failStart(err),
		);
	}

	private failStart(err: unknown): void {
		if (this.closed) return;
		this.taskOutcome = "error";
		const message = err instanceof Error ? err.message : String(err);
		this.push("error", message);
		this.finalize({ status: "error", error: message });
	}

	/** Picked back up: its record and file say what it did; the host's feed says the rest. */
	private attachTo(a: NonNullable<ChatWorkerOptions["attach"]>): void {
		this.adopted = true;
		this.initialPromptAccepted = true;
		this.settleAnnounced = true;
		this.settleKey = a.settleKey;
		this.settleEntryId = a.settleEntryId;
		this.recorded = { entryId: a.settleEntryId, at: a.settledAt };
		if (a.seed) {
			this.transcript = [...a.seed.transcript];
			this.usage = { ...a.seed.usage };
			this.taskOutcome = a.seed.taskOutcome;
			this.error = a.seed.error;
			if (a.seed.model) this.model = a.seed.model;
			if (a.seed.effort) this.effort = a.seed.effort;
		}
		this.status = "waiting";
		this.bind(a.ref);
	}

	private bind(ref: WorkerRef): void {
		this.chatId = ref.chatId;
		this.sessionId = ref.sessionId;
		this.sessionFile = ref.sessionFile;
		if (ref.pid) this.pid = ref.pid;
		this.processAlive = ref.pid !== null;
		// Watched once its holder has it: a settle the first state announces (picked back up) must find
		// the worker registered (a host answers a watch at once).
		queueMicrotask(() => {
			if (this.closed || this.unwatch) return;
			this.unwatch = this.host.watch(ref.chatId, null, (f) => this.onFrame(f));
		});
	}

	// ── the feed ─────────────────────────────────────────────────────────────

	private onFrame(f: WorkerFeedFrame): void {
		if (this.closed) return;
		if (f.t === "event") {
			const e = f.event as { settleKey?: unknown; settleEntryId?: unknown } | null;
			if (typeof e?.settleKey === "string") {
				this.settleSeenAt = Date.now();
				this.settleKey = e.settleKey;
				this.settleEntryId = typeof e.settleEntryId === "string" ? e.settleEntryId : undefined;
			}
			return this.handleEvent(f.event);
		}
		if (f.t === "state") return this.onState(f.state);
		if (f.t === "gap") {
			this.push("system", "Some of this worker's activity was missed; its session file has it all.");
			// The next state is read as a first one: a run that settled in the gap is announced, once.
			this.resync = true;
			this.recorded = { entryId: this.settleEntryId, at: this.settleSeenAt ?? this.startedAt };
			return;
		}
		switch (f.cause) {
			case "idle":
			case "reload":
				// Its chat waits (or runs on new code): nothing the parent sees changes. Either comes only at
				// a quiet moment (nothing queued), and a "reload" is also how a new process is first noted,
				// after it may have taken an instruction: never a sign that one won't run.
				return;
			case "killed":
				return this.finalize({ status: "killed" });
			case "died":
				if (f.resuming) {
					this.push("system", `Process stopped unexpectedly (${firstLine(f.detail)}); continuing once`);
					// What the dead process held is gone: told with the resumed run's settle.
					this.dropOutstanding();
					this.touch();
					return;
				}
				this.taskOutcome ??= "error";
				this.runActive = true; // its end announces: no report of its own
				this.dropOutstanding();
				return this.finalize({ status: "error", error: [f.detail ?? "This worker's process stopped unexpectedly", ...this.neverRanLines()].join("\n") });
			case "done":
				return this.finalize({});
		}
	}

	private onState(s: WorkerState): void {
		const first = this.lastState === null;
		const resync = this.resync;
		this.resync = false;
		this.lastState = s;
		this.pid = s.pid ?? undefined;
		this.processAlive = s.pid !== null;
		if (s.model) this.model = s.model;
		if (s.thinking) this.effort = s.thinking;
		// A process says whether its feed names send keys (none: a worker on code from before them).
		if (s.pid !== null) this.setKeyed(s.keys === true);
		this.sessionId = s.sessionId;
		this.sessionFile = s.sessionFile;
		if ((first && this.adopted) || resync) {
			if (isActive(s.status)) {
				// Mid-run when picked back up: its settle is owed.
				this.status = "running";
				this.runActive = true;
				this.settleAnnounced = false;
			} else if (s.lastSettled && s.lastSettled.key !== this.settleKey) {
				// It settled while no parent watched: announced now, once.
				this.status = "running";
				this.settleAnnounced = false;
				this.settleKey = s.lastSettled.key;
				this.settleEntryId = s.lastSettled.entryId;
				this.settleSeenAt = Date.now();
				if (s.lastSettled.outcome === "error" && s.lastSettled.error) this.error = s.lastSettled.error;
				this.processSettled();
			} else if (!s.lastSettled) {
				// Its process was reopened since (an idle stop, a crash): the file says whether a run
				// settled after the one the parent recorded.
				const last = lastSettledRun(s.sessionFile);
				if (last && last.entryId !== this.recorded?.entryId && last.at > (this.recorded?.at ?? 0)) {
					this.status = "running";
					this.settleAnnounced = false;
					this.settleEntryId = last.entryId;
					if (last.error) this.error = last.error;
					this.processSettled();
				}
			}
		}
		if (s.lastSettled) {
			if (s.lastSettled.key !== this.settleKey) this.settleSeenAt = Date.now();
			this.settleKey = s.lastSettled.key;
			if (s.lastSettled.entryId) this.settleEntryId = s.lastSettled.entryId;
		}
		this.touch();
	}

	// ── control ──────────────────────────────────────────────────────────────

	protected steerRefusal(): string | null {
		return this.chatId ? null : "agent is still starting";
	}

	protected nextSendKey(): string {
		return `${this.id}:${this.nonce}:s${++this.steers}`;
	}

	protected async deliver(message: string, mode: SteerMode | undefined, wasRunning: boolean, key: string): Promise<Delivery> {
		const delivery = mode === "followUp" ? "followUp" : wasRunning ? "steer" : "prompt";
		try {
			await this.host.send(this.chatId!, { text: message, delivery, key });
			return { ok: true };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			// The server never answered: delivery unknown (the worker is not stopped for it). Anything
			// else is the worker's refusal.
			if (isNoAnswer(err)) return { ok: false, unknown: true, reason: "Sova's server didn't answer within a minute" };
			return { ok: false, reason };
		}
	}

	/** Stop the worker: its chat process is stopped; resolves when it is gone. */
	kill(reason = "killed by user"): Promise<void> {
		if (this.closed) return this.whenClosed;
		if (!this.killInitiated) {
			this.killInitiated = true;
			if (this.status !== "error") this.status = "stopping";
			this.error ??= reason;
			this.push("system", reason);
			// The in-flight task is aborted; announced once the worker is gone.
			if (!this.settleAnnounced) this.taskOutcome = "aborted";
			this.touch();
			if (this.chatId) {
				void this.host.stop(this.chatId, reason).then(
					() => this.finalize({ status: "killed" }),
					(err) => {
						this.push("error", `stop failed: ${err instanceof Error ? err.message : String(err)}`);
						this.finalize({ status: "killed" });
					},
				);
			}
		}
		return this.whenClosed;
	}

	/** The parent's session is closing: let go of the worker, which runs on (picked back up at the next start). */
	dispose(): Promise<void> {
		this.unwatch?.();
		this.unwatch = null;
		if (!this.chatId && !this.closed) {
			// Never started: nothing runs to pick back up.
			this.killInitiated = true;
			this.finalize({ status: this.status === "error" ? "error" : "killed" });
			return this.whenClosed;
		}
		this.release();
		return this.whenClosed;
	}
}

/** How much of a worker's file is read for its last settled run: its tail. */
const TAIL_BYTES = 512 * 1024;

/**
 * The run that last settled in a worker's session file: its final assistant message (any that did not
 * stop to call a tool), its entry id and time. Undefined when none is in the file's tail or it can't be read.
 */
export function lastSettledRun(file: string): { entryId: string; at: number; error?: string } | undefined {
	const entries = fileMessages(file, TAIL_BYTES);
	for (let i = entries.length - 1; i >= 0; i--) {
		const { id, timestamp, message: m } = entries[i]!;
		if (m.role !== "assistant" || m.stopReason === "toolUse" || !id) continue;
		const at = timestamp ? Date.parse(timestamp) : NaN;
		return { entryId: id, at: Number.isFinite(at) ? at : 0, ...(m.stopReason === "error" && typeof m.errorMessage === "string" ? { error: m.errorMessage } : {}) };
	}
	return undefined;
}

function firstLine(text: string | undefined): string {
	const line = (text ?? "").split("\n")[0]!.replace(/^This worker's process stopped unexpectedly \(|\)$/g, "");
	return line || "it stopped answering";
}
