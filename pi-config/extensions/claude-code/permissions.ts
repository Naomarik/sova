import type { ClaudePermissionDecision } from "./runner.ts";

type Answer = (signal: AbortSignal) => Promise<ClaudePermissionDecision>;
interface Request {
	signal: AbortSignal;
	answer: Answer;
	resolve: (decision: ClaudePermissionDecision) => void;
	cancel: () => void;
	controller?: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	finished: boolean;
}
const deny = (message: string): ClaudePermissionDecision => ({ behavior: "deny", message });

/** Serialize dialogs across workers. Waiting does not consume the user's answer time.
 * Both the queue and each displayed dialog are bounded; cancellation removes a queued
 * request immediately, even when an earlier UI callback ignores its abort signal.
 */
export class PermissionQueue {
	private readonly pending: Request[] = [];
	private active?: Request;
	private stopped = false;
	constructor(private readonly timeoutMs = 60000, private readonly maxPending = 128) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxPending) || maxPending <= 0) {
			throw new Error("Permission queue limits must be positive integers.");
		}
	}
	run(signal: AbortSignal, answer: Answer): Promise<ClaudePermissionDecision> {
		if (this.stopped || signal.aborted) return Promise.resolve(deny("Permission request cancelled before it was shown."));
		if (this.pending.length >= this.maxPending) return Promise.resolve(deny("Permission queue is full; this request was not shown."));
		return new Promise(resolve => {
			const request: Request = { signal, answer, resolve, finished: false, cancel: () => {
				this.finish(request, deny(request.controller ? "Permission request cancelled." : "Permission request cancelled before it was shown."));
			} };
			signal.addEventListener("abort", request.cancel, { once: true });
			this.pending.push(request);
			this.drain();
		});
	}
	private drain(): void {
		if (this.active || this.stopped) return;
		const request = this.pending.shift();
		if (!request) return;
		this.active = request;
		request.controller = new AbortController();
		request.timer = setTimeout(() => {
			this.finish(request, deny("Permission approval timed out after the dialog was shown."));
		}, this.timeoutMs);
		Promise.resolve().then(() => {
			if (request.finished) return deny("Permission request cancelled.");
			return request.answer(request.controller!.signal);
		}).then(decision => this.finish(request, decision), () => this.finish(request, deny("Permission dialog failed; no approval was granted.")));
	}
	private finish(request: Request, decision: ClaudePermissionDecision): void {
		if (request.finished) return;
		request.finished = true;
		if (request.timer) clearTimeout(request.timer);
		request.signal.removeEventListener("abort", request.cancel);
		request.controller?.abort();
		const index = this.pending.indexOf(request);
		if (index >= 0) this.pending.splice(index, 1);
		if (this.active === request) this.active = undefined;
		request.resolve(decision);
		queueMicrotask(() => this.drain());
	}
	dispose(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const request of [this.active, ...this.pending]) {
			if (request) this.finish(request, deny("Permission request cancelled because the session is shutting down."));
		}
	}
}
