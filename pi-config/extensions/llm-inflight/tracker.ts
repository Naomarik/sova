/**
 * The process's logical LLM calls in flight (README.md). Node builtins only: Sova's server imports
 * this file too, and every copy loaded in one process (jiti loads each extension on its own, the
 * server has its own import) shares one table through a globalThis singleton.
 *
 * Metadata only: a call is its source, whether its bounds are approximate and whether it is
 * waiting (a provider-limits queue or cooldown, which is not in flight). No prompt, reply, token or
 * credential is read or kept, and nothing is kept once a call ends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** The setStatus key a pi worker reports its counts under, on its RPC stdout (index.ts). */
export const LLM_STATUS_KEY = "sova-llm-inflight";

export type LlmCallSource = "runtime" | "claude-raw" | "claude-oneshot" | "jev";

/** What one process publishes (its live record's `presence.llm`), and what a child reports. */
export interface LlmCounts {
	/** Calls in flight now: begun, not ended, not waiting. */
	active: number;
	/** How many of `active` have approximate bounds (a CLI one-shot's spawn to exit). */
	approximate: number;
	/** Claude Code turns running now, whose internal calls the counter cannot see. */
	claudeTurns: number;
	/** Some calls this process makes can't be seen (runtime not instrumented, response-only Claude, …). */
	degraded: boolean;
}

export interface LlmProcessSnapshot extends LlmCounts {
	v: 1;
	/** One per process lifetime: two snapshots with the same producer are one process's counts. */
	producer: string;
	pid: number;
	/**
	 * Producers whose counts this snapshot already includes (its workers', transitively), sorted.
	 * A reader skips any of them it meets on its own: a worker that also writes a live record.
	 */
	folded: string[];
}

/** What a child reports to the process running it: its counts and who it is. */
export interface LlmChildReport extends LlmCounts {
	producer?: string;
	folded?: string[];
}

/**
 * At most this many folded producers (≤ 64 chars each: about 4 KB, well inside a live record's
 * 16 KB budget). A child whose identities would not fit is not summed at all, so nothing is ever
 * counted here that a reader can't also exclude elsewhere; the snapshot is degraded instead.
 */
export const MAX_FOLDED = 64;

/** The end of one call: idempotent, safe in `finally`. */
export interface LlmCallEnd {
	(): void;
	/** The call waits (a provider queue, a cooldown) or resumes; a waiting call is not in flight. */
	waiting(on: boolean): void;
	readonly ended: boolean;
}

interface Entry {
	source: string;
	approximate: boolean;
	waiting: boolean;
}

interface State {
	producer: string;
	nextId: number;
	active: Map<number, Entry>;
	gauges: Map<string, LlmChildReport>;
	claudeTurns: number;
	degraded: Map<string, number>;
	listeners: Set<() => void>;
	current: AsyncLocalStorage<LlmCallEnd | undefined>;
	last: string;
	/** A model runtime of this process is instrumented: its counts mean something. */
	counting: boolean;
}

const GLOBAL_KEY = Symbol.for("sova.llm-inflight.v1");

function state(): State {
	const g = globalThis as unknown as Record<symbol, State | undefined>;
	return (g[GLOBAL_KEY] ??= {
		producer: randomUUID(),
		nextId: 0,
		active: new Map(),
		gauges: new Map(),
		claudeTurns: 0,
		degraded: new Map(),
		listeners: new Set(),
		current: new AsyncLocalStorage<LlmCallEnd | undefined>(),
		last: "",
		counting: false,
	});
}

/** Notify listeners when the published counts changed (not for every bookkeeping step). */
function changed(s: State): void {
	const now = snapshot();
	const key = `${now.active}/${now.approximate}/${now.claudeTurns}/${now.degraded}/${s.counting}/${now.folded.join(",")}`;
	if (key === s.last) return;
	s.last = key;
	for (const fn of [...s.listeners]) {
		try {
			fn();
		} catch {
			// A listener's failure is its own.
		}
	}
}

/** Start one logical call: from its issue until its response ends, fails or is aborted. */
export function beginLlmCall(opts: {
	source: LlmCallSource | string;
	approximate?: boolean;
	/** Begin waiting: not in flight until `waiting(false)` says it was issued. */
	pending?: boolean;
	provider?: string;
	model?: string;
}): LlmCallEnd {
	const s = state();
	const id = ++s.nextId;
	// provider/model are accepted for callers' convenience and deliberately not kept.
	const entry: Entry = { source: String(opts?.source ?? "runtime"), approximate: opts?.approximate === true, waiting: opts?.pending === true };
	s.active.set(id, entry);
	changed(s);
	let ended = false;
	const end = (() => {
		if (ended) return;
		ended = true;
		if (s.active.delete(id)) changed(s);
	}) as LlmCallEnd;
	end.waiting = (on: boolean) => {
		if (ended || entry.waiting === on) return;
		entry.waiting = on;
		changed(s);
	};
	Object.defineProperty(end, "ended", { get: () => ended });
	return end;
}

/**
 * Run `fn` as part of `call`, so a wrapper below it (the provider-limits gate) can mark that very
 * call waiting. A call begun inside `fn` is a new call of its own, never suppressed.
 */
export function withinLlmCall<T>(call: LlmCallEnd, fn: () => T): T {
	return state().current.run(call, fn);
}

/** The call the running code belongs to, if a wrapper above it began one and it has not ended. */
export function currentLlmCall(): LlmCallEnd | undefined {
	const call = state().current.getStore();
	return call && !call.ended ? call : undefined;
}

/** A running Claude Code turn (its internal calls are unseen); returns its end (idempotent). */
export function beginClaudeTurn(): () => void {
	const s = state();
	s.claudeTurns++;
	changed(s);
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		s.claudeTurns = Math.max(0, s.claudeTurns - 1);
		changed(s);
	};
}

/** This process can't see some of its calls while this lasts (reference counted); returns its release. */
export function markDegraded(reason: string): () => void {
	const s = state();
	s.degraded.set(reason, (s.degraded.get(reason) ?? 0) + 1);
	changed(s);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (s.degraded.get(reason) ?? 1) - 1;
		if (left > 0) s.degraded.set(reason, left);
		else s.degraded.delete(reason);
		changed(s);
	};
}

/**
 * A child process's counts as it last reported them (a worker's, through its parent): replaced,
 * never added to, so a replayed report changes nothing. `undefined` forgets the child.
 */
export function setChildCounts(key: string, counts: LlmChildReport | undefined): void {
	const s = state();
	if (counts === undefined) {
		if (s.gauges.delete(key)) changed(s);
		return;
	}
	s.gauges.set(key, normalizeCounts(counts));
	changed(s);
}

export function snapshot(): LlmProcessSnapshot {
	const s = state();
	let active = 0;
	let approximate = 0;
	for (const e of s.active.values()) {
		if (e.waiting) continue;
		active++;
		if (e.approximate) approximate++;
	}
	let claudeTurns = s.claudeTurns;
	let degraded = s.degraded.size > 0;
	const folded = new Set<string>();
	// In key order, so which children fit is stable across snapshots.
	for (const key of [...s.gauges.keys()].sort()) {
		const g = s.gauges.get(key)!;
		const ids = [g.producer, ...(g.folded ?? [])].filter((f): f is string => !!f && f !== s.producer && !folded.has(f));
		if (folded.size + ids.length > MAX_FOLDED) {
			degraded = true; // not summed: a reader could not tell its calls from its own record's
			continue;
		}
		for (const f of ids) folded.add(f);
		active += g.active;
		approximate += g.approximate;
		claudeTurns += g.claudeTurns;
		degraded ||= g.degraded;
	}
	return { v: 1, producer: s.producer, pid: process.pid, active, approximate, claudeTurns, degraded, folded: [...folded].sort() };
}

/** This process's model runtime is instrumented (runtime.ts says so). */
export function markCounting(): void {
	const s = state();
	if (s.counting) return;
	s.counting = true;
	changed(s);
}

/**
 * Whether this process counts its pi calls at all. A process without it publishes no counts: a
 * missing count makes a total partial, where a published 0 would claim nothing runs.
 */
export function isCounting(): boolean {
	return state().counting;
}

/** Called synchronously whenever the snapshot's counts change (never per token). */
export function subscribe(fn: () => void): () => void {
	const s = state();
	s.listeners.add(fn);
	return () => {
		s.listeners.delete(fn);
	};
}

const MAX = 9999;
const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX) : 0);

const validProducer = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 64 && /^[\w.:-]+$/.test(p);

function normalizeCounts(c: Partial<LlmChildReport>): LlmChildReport {
	const active = whole(c.active);
	const out: LlmChildReport = { active, approximate: Math.min(whole(c.approximate), active), claudeTurns: whole(c.claudeTurns), degraded: c.degraded === true };
	if (validProducer(c.producer)) out.producer = c.producer;
	if (Array.isArray(c.folded)) {
		const folded = [...new Set(c.folded.filter(validProducer))].sort();
		if (folded.length > MAX_FOLDED) {
			// More than any counter folds: its counts can't be told apart from its workers' own
			// records, so none of them is summed; its own id is still named.
			return { active: 0, approximate: 0, claudeTurns: 0, degraded: true, ...(out.producer ? { producer: out.producer } : {}), folded: [] };
		}
		out.folded = folded;
	}
	return out;
}

/** The counts in a child's report (an object or its JSON); undefined when it isn't one. */
export function parseCounts(value: unknown): LlmChildReport | undefined {
	let v = value;
	if (typeof v === "string") {
		if (v.length > 65_536) return undefined;
		try {
			v = JSON.parse(v);
		} catch {
			return undefined;
		}
	}
	if (!v || typeof v !== "object" || (v as { v?: unknown }).v !== 1) return undefined;
	return normalizeCounts(v as Partial<LlmChildReport>);
}
