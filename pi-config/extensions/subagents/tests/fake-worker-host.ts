/**
 * An in-memory WorkerHost for unit tests (al_3 stage 4): no server, no process. Starts are
 * recorded and idempotent by key, as the server's registry is; the feed is scripted by the test
 * (`event`, `state`, `turn`, `end`, `newProcess`), numbered per fake process, and kept in a ring that
 * `watch` replays from a cursor exactly as the server does (same process and seq in the ring:
 * replay; another process: `gap`, then the state).
 */
import type {
	WorkerCursor,
	WorkerFeedFrame,
	WorkerHost,
	WorkerHostAnnouncement,
	WorkerRef,
	WorkerStart,
	WorkerState,
} from "../worker-host.ts";
import { WORKER_HOST_DISCOVER_EVENT, WORKER_HOST_EVENT } from "../worker-host.ts";

type SendInput = Parameters<WorkerHost["send"]>[1];
type Ended = Extract<WorkerFeedFrame, { t: "ended" }>;

export interface FakeWorker {
	ref: WorkerRef;
	start: WorkerStart;
	state: WorkerState;
	proc: string;
	seq: number;
	/** Every frame sent, in order (the ring: `ringMax` newest). */
	frames: WorkerFeedFrame[];
	watchers: Set<(f: WorkerFeedFrame) => void>;
	sends: SendInput[];
	aborts: number;
	stops: string[];
}

export interface FakeWorkerHostOptions {
	/** Where the fake session files are named (never written). Default /fake/sessions. */
	sessionDir?: string;
	/** Frames kept per worker for replay. Default 2000, as the server's ring. */
	ringMax?: number;
	/** Make a start throw (after recording it), e.g. the server's "Workers need Bun …". */
	failStart?: (req: WorkerStart) => string | undefined;
	/** Make a send throw (after recording it). */
	failSend?: (chatId: string, input: SendInput) => string | Error | undefined;
	/** Settle the task right after a start with this final text (no scripting needed). */
	autoReply?: (req: WorkerStart) => string | undefined;
}

export class FakeWorkerHost implements WorkerHost {
	readonly workers = new Map<string, FakeWorker>();
	readonly starts: WorkerStart[] = [];
	private readonly byKey = new Map<string, string>();
	private n = 0;
	private procN = 0;

	readonly options: FakeWorkerHostOptions;

	constructor(options: FakeWorkerHostOptions = {}) {
		this.options = options;
	}

	/** The worker a start or a workerId names (the first match). */
	get(idOrWorker: string): FakeWorker {
		const w = this.workers.get(idOrWorker) ?? [...this.workers.values()].find((x) => x.ref.workerId === idOrWorker);
		if (!w) throw new Error(`no fake worker ${idOrWorker}`);
		return w;
	}

	async start(req: WorkerStart): Promise<WorkerRef> {
		this.starts.push(req);
		const known = this.byKey.get(req.key);
		if (known) return { ...this.workers.get(known)!.ref };
		const failed = this.options.failStart?.(req);
		if (failed) throw new Error(failed);
		const chatId = `fake-${String(++this.n).padStart(3, "0")}`;
		const sessionFile =
			"resume" in req.session ? req.session.resume.file : `${this.options.sessionDir ?? "/fake/sessions"}/${chatId}.jsonl`;
		const proc = this.nextProc();
		const pid = 40_000 + this.n;
		const ref: WorkerRef = {
			chatId,
			sessionId: chatId,
			sessionFile,
			workerId: req.spec.parent.workerId,
			kind: req.spec.kind,
			pid,
			state: "open",
		};
		const w: FakeWorker = {
			ref,
			start: req,
			proc,
			seq: 0,
			frames: [],
			watchers: new Set(),
			sends: [],
			aborts: 0,
			stops: [],
			state: {
				status: req.task === null ? "idle" : "starting",
				sessionId: chatId,
				sessionFile,
				pid,
				model: req.spec.model,
				thinking: req.spec.thinking,
				lastSettled: null,
				queue: { steering: [], followUp: [] },
			},
		};
		this.workers.set(chatId, w);
		this.byKey.set(req.key, chatId);
		this.stateFrame(w);
		const reply = req.task === null ? undefined : this.options.autoReply?.(req);
		if (reply !== undefined) queueMicrotask(() => this.turn(chatId, { user: req.task!, reply, key: `${req.key}:task` }));
		return { ...ref };
	}

	async send(chatId: string, input: SendInput): Promise<{ queued: boolean }> {
		const w = this.get(chatId);
		if (w.ref.state === "ended") throw new Error(`${w.ref.workerId} has ended`);
		w.sends.push(input);
		const failed = this.options.failSend?.(chatId, input);
		if (failed) throw typeof failed === "string" ? new Error(failed) : failed;
		if (w.ref.state === "idle") w.ref.state = "open";
		return { queued: w.state.status === "running" };
	}

	async abort(chatId: string): Promise<void> {
		this.get(chatId).aborts++;
	}

	async stop(chatId: string, reason: string): Promise<void> {
		const w = this.get(chatId);
		w.stops.push(reason);
		if (w.ref.state === "ended") return;
		this.end(chatId, { cause: "killed" });
	}

	watch(chatId: string, cursor: WorkerCursor | null, fn: (f: WorkerFeedFrame) => void): () => void {
		const w = this.get(chatId);
		if (cursor && cursor.proc === w.proc) {
			const ring = w.frames.filter((f) => f.t === "state" || f.t === "event");
			const oldest = ring.length ? (ring[0] as { cursor: WorkerCursor }).cursor.seq : w.seq + 1;
			if (cursor.seq + 1 >= oldest) {
				for (const f of ring) if ((f as { cursor: WorkerCursor }).cursor.seq > cursor.seq) fn(f);
			} else fn({ t: "gap" });
		} else if (cursor) fn({ t: "gap" });
		// The state snapshot, as of now, after any replay.
		if (!cursor || cursor.proc !== w.proc || cursor.seq < w.seq) fn({ t: "state", cursor: { proc: w.proc, seq: w.seq }, state: clone(w.state) });
		if (w.ref.state === "ended") {
			const last = [...w.frames].reverse().find((f) => f.t === "ended");
			if (last) fn(last);
		}
		w.watchers.add(fn);
		return () => void w.watchers.delete(fn);
	}

	async list(): Promise<WorkerRef[]> {
		return [...this.workers.values()].filter((w) => w.ref.state !== "ended").map((w) => ({ ...w.ref }));
	}

	// ---- scripting --------------------------------------------------------------------------------

	/** Send one pi event on the worker's feed. */
	event(chatId: string, event: Record<string, unknown>): void {
		const w = this.get(chatId);
		this.emit(w, { t: "event", cursor: { proc: w.proc, seq: ++w.seq }, event });
	}

	/** Change the worker's state and send it. */
	state(chatId: string, patch: Partial<WorkerState>): void {
		const w = this.get(chatId);
		w.state = { ...w.state, ...patch };
		this.stateFrame(w);
	}

	/** One whole run: agent_start, the user message, an assistant reply, agent_end, settled, idle. */
	turn(chatId: string, o: { user?: string; reply: string; key?: string; error?: string; usage?: Record<string, number> }): void {
		const w = this.get(chatId);
		this.state(chatId, { status: "running" });
		this.event(chatId, { type: "agent_start" });
		if (o.user !== undefined) {
			const user = { role: "user", content: [{ type: "text", text: o.user }] };
			this.event(chatId, { type: "message_start", message: user });
			this.event(chatId, { type: "message_end", message: user, entryId: `e${w.seq + 1}` });
		}
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: o.reply }],
			stopReason: o.error ? "error" : "stop",
			...(o.error ? { errorMessage: o.error } : {}),
			usage: o.usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		};
		this.event(chatId, { type: "message_start", message: assistant });
		const entryId = `e${w.seq + 1}`;
		this.event(chatId, { type: "message_end", message: assistant, entryId });
		this.event(chatId, { type: "agent_end", messages: [] });
		const settleKey = o.key ?? `${chatId}:${w.seq}`;
		this.event(chatId, { type: "agent_settled", settleKey, settleEntryId: entryId });
		this.state(chatId, {
			status: "idle",
			lastSettled: { key: settleKey, entryId, outcome: o.error ? "error" : "success", ...(o.error ? { error: o.error } : {}) },
		});
	}

	/** Send `ended`. `resuming` keeps the worker open in a new process (a crash resume); `idle` and
	    `reload` keep it too (an idle stop, a code reload); anything else ends its record. */
	end(chatId: string, f: Omit<Ended, "t">): void {
		const w = this.get(chatId);
		this.emit(w, { t: "ended", ...f });
		if (f.resuming || f.cause === "reload") this.newProcess(chatId);
		else if (f.cause === "idle") {
			w.ref.state = "idle";
			w.ref.pid = null;
			w.state = { ...w.state, pid: null };
		} else {
			w.ref.state = "ended";
			w.ref.pid = null;
			w.state = { ...w.state, status: "ended", pid: null };
			this.stateFrame(w);
		}
	}

	/** The worker now runs in another process (a reload, a crash resume): a new cursor process, a new pid. */
	newProcess(chatId: string): void {
		const w = this.get(chatId);
		w.proc = this.nextProc();
		w.seq = 0;
		w.ref.pid = (w.ref.pid ?? 50_000) + 1;
		w.ref.state = "open";
		w.state = { ...w.state, pid: w.ref.pid };
		this.stateFrame(w);
	}

	/** The parent's `pi.events`: announce this host now and on every discover. Returns the unsubscribe. */
	announceOn(events: { on(name: string, fn: (data: unknown) => void): () => void; emit(name: string, data: unknown): void }): () => void {
		const announcement: WorkerHostAnnouncement = { version: 1, host: this };
		const off = events.on(WORKER_HOST_DISCOVER_EVENT, () => events.emit(WORKER_HOST_EVENT, announcement));
		events.emit(WORKER_HOST_EVENT, announcement);
		return off;
	}

	private nextProc(): string {
		return `proc-${++this.procN}`;
	}

	private stateFrame(w: FakeWorker): void {
		this.emit(w, { t: "state", cursor: { proc: w.proc, seq: ++w.seq }, state: clone(w.state) });
	}

	private emit(w: FakeWorker, f: WorkerFeedFrame): void {
		w.frames.push(f);
		const max = this.options.ringMax ?? 2000;
		if (w.frames.length > max) w.frames.splice(0, w.frames.length - max);
		for (const fn of [...w.watchers]) fn(f);
	}
}

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}
