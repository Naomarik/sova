/**
 * Parent-side delivery to team members: a serial lane per recipient in front of every steer,
 * and the inbox wake scheduler. No pi or manager dependency (tests drive both with fakes).
 *
 * Lane: deliveries to one worker run one at a time, in order, so the worker's own
 * single-steer guard ("another steer is still awaiting acceptance") is never reached
 * concurrently; a redirect goes ahead of entries still queued, never ahead of the one in
 * flight. A transient refusal (still starting, a steer still awaiting acceptance) is retried
 * while the worker is live, so nothing is refused for being busy.
 *
 * Wakes: items are stored first (inbox.ts); the scheduler then wakes the member with one list.
 * Idle: normal items are gathered for ~3 s, urgent wake at once. Busy: urgent at its next step
 * (a mid-turn steer, where the backend has one), normal once the turn ends. One wake in flight
 * per member; a failed wake is retried with backoff while the member is live.
 */
import type { InboxItem } from "./inbox.ts";

export interface LaneResult { ok: boolean; reason?: string; unknown?: true }

interface LaneEntry { run: () => Promise<unknown>; jump: boolean; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class DeliveryLanes {
	private readonly lanes = new Map<string, { running: boolean; queue: LaneEntry[] }>();

	/** Run `fn` when every earlier delivery to `key` is done; `jump` (a redirect) goes ahead of queued, not in-flight, entries. */
	run<T>(key: string, fn: () => Promise<T>, opts: { jump?: boolean } = {}): Promise<T> {
		let lane = this.lanes.get(key);
		if (!lane) this.lanes.set(key, (lane = { running: false, queue: [] }));
		return new Promise<T>((resolve, reject) => {
			const entry: LaneEntry = { run: fn, jump: Boolean(opts.jump), resolve: resolve as (v: unknown) => void, reject };
			if (entry.jump) {
				// After redirects already waiting, ahead of everything else queued.
				const at = lane!.queue.findIndex((e) => !e.jump);
				if (at < 0) lane!.queue.push(entry);
				else lane!.queue.splice(at, 0, entry);
			} else lane!.queue.push(entry);
			this.pump(key);
		});
	}

	/** Entries waiting behind the one in flight. */
	queued(key: string): number {
		return this.lanes.get(key)?.queue.length ?? 0;
	}
	busy(key: string): boolean {
		return this.lanes.get(key)?.running ?? false;
	}

	private pump(key: string): void {
		const lane = this.lanes.get(key);
		if (!lane || lane.running) return;
		const next = lane.queue.shift();
		if (!next) {
			this.lanes.delete(key);
			return;
		}
		lane.running = true;
		let p: Promise<unknown>;
		try {
			p = Promise.resolve(next.run());
		} catch (error) {
			p = Promise.reject(error);
		}
		p.then(next.resolve, next.reject).finally(() => {
			lane.running = false;
			this.pump(key);
		});
	}
}

/** Refusals that only mean "not yet": retried on the lane while the worker is live. */
export const TRANSIENT_STEER = /agent is still starting|another steer is still awaiting acceptance/;
const TRANSIENT_DELAYS = [250, 500, 1000, 2000];

/** Steer until the worker takes it, refuses it for good, stops being live, or the caller cancels. */
export async function steerUntilTaken(
	steer: () => Promise<LaneResult>,
	live: () => boolean,
	opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; delays?: readonly number[] } = {},
): Promise<LaneResult> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const delays = opts.delays ?? TRANSIENT_DELAYS;
	for (let attempt = 0; ; attempt++) {
		const result = await steer();
		if (result.ok || result.unknown || !result.reason || !TRANSIENT_STEER.test(result.reason)) return result;
		if (opts.signal?.aborted) return { ok: false, unknown: true, reason: "steering wait cancelled; delivery unknown" };
		if (!live()) return result;
		await sleep(delays[Math.min(attempt, delays.length - 1)]);
		if (opts.signal?.aborted) return { ok: false, unknown: true, reason: "steering wait cancelled; delivery unknown" };
		if (!live()) return result;
	}
}

// ── Wake text (§app.teams/inbox "The list") ─────────────────────────────────

export const WAKE_MAX_ITEMS = 20;
export const WAKE_INLINE_CHARS = 600;
export const WAKE_INLINE_TOTAL = 4000;

const partyText = (p: { role: string; workerId: string }) => p.role;

/** One item's list line: `! i_42 notice from monitor — Wrap up: context 78%`. */
export function itemLine(item: InboxItem): string {
	const first = item.movedFrom?.[0];
	return `${item.urgent ? "!" : "-"} ${item.id} ${item.kind} from ${partyText(item.from)}${item.replyTo ? ` (re ${item.replyTo})` : ""}${first ? ` (sent to ${first.role})` : ""} — ${item.subject}`;
}

/**
 * The wake list for a member's unread items: urgent first, oldest first within each, at most 20;
 * short bodies in full up to 4,000 chars. Returns the ids listed and those shown in full (read).
 */
export function wakeText(unread: readonly InboxItem[]): { text: string; listed: string[]; full: string[] } {
	const sorted = [...unread].sort((a, b) => Number(b.urgent) - Number(a.urgent) || parseInt(a.id.slice(2), 36) - parseInt(b.id.slice(2), 36));
	const shown = sorted.slice(0, WAKE_MAX_ITEMS);
	const urgent = sorted.filter((i) => i.urgent).length;
	const lines = [`[Team inbox: ${sorted.length} new${urgent ? ` (${urgent} urgent)` : ""} — team_inbox open <ids> to read, done <ids> to mark addressed]`];
	const full: string[] = [];
	let used = 0;
	for (const item of shown) {
		lines.push(itemLine(item));
		const body = item.body.trim();
		if (body === item.subject) {
			full.push(item.id);
			continue;
		}
		if (body.length <= WAKE_INLINE_CHARS && used + body.length <= WAKE_INLINE_TOTAL) {
			used += body.length;
			lines.push(...body.split("\n").map((l) => `    ${l}`));
			full.push(item.id);
		}
	}
	if (sorted.length > shown.length) lines.push(`… and ${sorted.length - shown.length} more`);
	lines.push("(Items shown in full above count as read. Answer an item with team_msg and replyTo set to its id.)");
	return { text: lines.join("\n"), listed: shown.map((i) => i.id), full };
}

// ── Wake scheduler ──────────────────────────────────────────────────────────

export type WakeState = "gone" | "idle" | "busy";
export interface WakeHost {
	state(workerId: string): WakeState;
	/** Whether a busy worker takes a steer at its next step (the pi backend). */
	nextStep(workerId: string): boolean;
	/** A member on older code (no caps marker) or a backend without team tools: full text per item. */
	legacy(workerId: string): boolean;
	unlisted(workerId: string): InboxItem[];
	unread(workerId: string): InboxItem[];
	markListed(workerId: string, ids: string[]): void;
	markRead(workerId: string, ids: string[]): void;
	/** Deliver on the member's lane (mode undefined: a prompt when idle, a next-step steer when busy). */
	deliver(workerId: string, text: string): Promise<LaneResult>;
	/** A legacy member's full-text delivery of one item. */
	legacyText(workerId: string, item: InboxItem): string;
	/** A legacy delivery was accepted (the legacy inbox.jsonl copy). */
	legacyDelivered?(workerId: string, item: InboxItem): void;
	/** The first failure of a wake (attempt 1), recorded as a team action. */
	retrying(workerId: string, attempt: number, reason: string): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
}
export const WAKE_DEBOUNCE_MS = 3000;
export const WAKE_RETRY_MS: readonly number[] = [5000, 15_000, 60_000, 300_000];

interface WakeSlot { debounce?: unknown; retry?: unknown; inFlight: boolean; again: boolean; attempt: number }

export class WakeScheduler {
	private readonly slots = new Map<string, WakeSlot>();
	private readonly host: WakeHost;
	private readonly debounceMs: number;
	private readonly retryMs: readonly number[];
	private disposed = false;

	constructor(host: WakeHost, opts: { debounceMs?: number; retryMs?: readonly number[] } = {}) {
		this.host = host;
		this.debounceMs = opts.debounceMs ?? WAKE_DEBOUNCE_MS;
		this.retryMs = opts.retryMs ?? WAKE_RETRY_MS;
	}

	private slot(workerId: string): WakeSlot {
		let s = this.slots.get(workerId);
		if (!s) this.slots.set(workerId, (s = { inFlight: false, again: false, attempt: 0 }));
		return s;
	}

	/** A new item was stored for the member. */
	notify(workerId: string): void {
		this.evaluate(workerId, "item");
	}
	/** The member's turn ended (or its first task settled): list what waits now. */
	settled(workerId: string): void {
		this.evaluate(workerId, "settled");
	}
	/** The member ended: drop its timers (its items stay stored). */
	forget(workerId: string): void {
		const s = this.slots.get(workerId);
		if (!s) return;
		if (s.debounce !== undefined) this.host.clearTimer(s.debounce);
		if (s.retry !== undefined) this.host.clearTimer(s.retry);
		this.slots.delete(workerId);
	}
	dispose(): void {
		this.disposed = true;
		for (const id of [...this.slots.keys()]) this.forget(id);
	}
	/** Test/diagnostic view. */
	pending(workerId: string): { debounce: boolean; retry: boolean; inFlight: boolean; attempt: number } {
		const s = this.slots.get(workerId);
		return { debounce: s?.debounce !== undefined, retry: s?.retry !== undefined, inFlight: s?.inFlight ?? false, attempt: s?.attempt ?? 0 };
	}

	private evaluate(workerId: string, why: "item" | "settled" | "debounce" | "retry" | "after"): void {
		if (this.disposed) return;
		const state = this.host.state(workerId);
		if (state === "gone") {
			this.forget(workerId);
			return;
		}
		const s = this.slot(workerId);
		if (s.inFlight) {
			s.again = true;
			return;
		}
		if (s.retry !== undefined && why !== "retry") return; // A retry is already scheduled.
		const unlisted = this.host.unlisted(workerId);
		if (!unlisted.length) {
			if (s.debounce !== undefined) {
				this.host.clearTimer(s.debounce);
				s.debounce = undefined;
			}
			return;
		}
		if (this.host.legacy(workerId)) {
			// Older code: each item in full, at once, as before (never refused for busyness).
			this.fire(workerId, s, true);
			return;
		}
		const urgent = unlisted.some((i) => i.urgent);
		if (state === "idle") {
			if (urgent || why === "settled" || why === "debounce" || why === "retry") {
				this.fire(workerId, s, false);
				return;
			}
			if (s.debounce === undefined) s.debounce = this.host.setTimer(() => {
				s.debounce = undefined;
				this.evaluate(workerId, "debounce");
			}, this.debounceMs);
			return;
		}
		// Busy: urgent at its next step where the backend has one; everything else at the turn's end.
		if (urgent && this.host.nextStep(workerId)) this.fire(workerId, s, false);
	}

	private fire(workerId: string, s: WakeSlot, legacy: boolean): void {
		if (s.debounce !== undefined) {
			this.host.clearTimer(s.debounce);
			s.debounce = undefined;
		}
		s.inFlight = true;
		s.again = false;
		const done = (result: LaneResult) => {
			s.inFlight = false;
			if (this.disposed) return;
			if (result.ok) {
				s.attempt = 0;
				if (this.host.unlisted(workerId).length) this.evaluate(workerId, "after");
				return;
			}
			if (this.host.state(workerId) === "gone") {
				this.forget(workerId);
				return;
			}
			s.attempt++;
			if (s.attempt === 1) this.host.retrying(workerId, s.attempt, result.reason ?? "delivery unknown");
			const delay = this.retryMs[Math.min(s.attempt - 1, this.retryMs.length - 1)];
			s.retry = this.host.setTimer(() => {
				s.retry = undefined;
				this.evaluate(workerId, "retry");
			}, delay);
		};
		const run = legacy ? this.fireLegacy(workerId) : this.fireList(workerId);
		run.then(done, (error) => done({ ok: false, reason: String(error) }));
	}

	private async fireList(workerId: string): Promise<LaneResult> {
		const { text, listed, full } = wakeText(this.host.unread(workerId));
		if (!listed.length) return { ok: true };
		const result = await this.host.deliver(workerId, text);
		if (result.ok) {
			this.host.markListed(workerId, listed);
			if (full.length) this.host.markRead(workerId, full);
		}
		return result;
	}

	private async fireLegacy(workerId: string): Promise<LaneResult> {
		for (const item of this.host.unlisted(workerId)) {
			const result = await this.host.deliver(workerId, this.host.legacyText(workerId, item));
			if (!result.ok) return result;
			this.host.markListed(workerId, [item.id]);
			this.host.markRead(workerId, [item.id]);
			this.host.legacyDelivered?.(workerId, item);
		}
		return { ok: true };
	}
}
