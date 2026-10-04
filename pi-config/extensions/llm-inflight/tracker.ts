/**
 * The process's logical LLM calls in flight (README.md). Node builtins only: Sova's server imports
 * this file too, and every copy loaded in one process (jiti loads each extension on its own, the
 * server has its own import) shares one table through a globalThis singleton.
 *
 * Metadata only: a call is its source, whether its bounds are approximate and whether it is
 * waiting (a provider-limits queue or cooldown, which is not in flight). No prompt, reply or
 * credential is read or kept, and nothing is kept once a call ends but the number of output tokens
 * its caller hands to its end, added to a ring of 30 s slots (never written per token).
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

/** Slot width of the output-token ring: slot `k` holds the tokens of [k × 30 s, (k + 1) × 30 s). */
export const TOKEN_BUCKET_MS = 30_000;
/** Slots in the ring: 30 minutes. */
export const TOKEN_SLOTS = 60;
/** The most one process's slot may hold (≈ 330k tokens/s): a bound on a buggy report, never reached by real work. */
export const MAX_SLOT_TOKENS = 10_000_000;

/**
 * Output tokens of ended calls, per slot, epoch-aligned: `out[TOKEN_SLOTS - 1]` is slot `end`
 * (`floor(ms / TOKEN_BUCKET_MS)`), `out[0]` slot `end - 59`, oldest first.
 */
export interface TokenRing {
	bucketMs: number;
	end: number;
	out: number[];
	/** Some of this process's calls' tokens are known missing (a child that reported no ring). */
	partial?: true;
}

/** What one call's end adds: its output tokens (reasoning included; never input or cache), spread
    evenly from `since` (its reply's first streamed event) to `at` (its end, default now). */
export interface LlmCallTokens {
	output: number;
	since?: number;
	at?: number;
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
	/** The output tokens of its ended calls (its summed workers' too), aligned to the snapshot's time. */
	tokens: TokenRing;
}

/** What a child reports to the process running it: its counts and who it is. */
export interface LlmChildReport extends LlmCounts {
	producer?: string;
	folded?: string[];
	/** Its ring as it reported it; absent from a counter without one (its tokens are unknown). */
	tokens?: TokenRing;
}

/**
 * At most this many folded producers (≤ 64 chars each: about 4 KB, well inside a live record's
 * 16 KB budget). A child whose identities would not fit is not summed at all, so nothing is ever
 * counted here that a reader can't also exclude elsewhere; the snapshot is degraded instead.
 */
export const MAX_FOLDED = 64;

/** The end of one call: idempotent, safe in `finally`. Its output tokens, if any, are added at once. */
export interface LlmCallEnd {
	(tokens?: LlmCallTokens): void;
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
	/** This process's own calls' output tokens. */
	own: TokenRing;
	/** The tokens of children forgotten while summed: they stay until they age out. */
	retired: TokenRing;
	/** Bumped whenever the summed tokens gain some (so a change is published once, with its call's end). */
	tokenRev: number;
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
		own: emptyRing(0),
		retired: emptyRing(0),
		tokenRev: 0,
	});
}

export const slotOf = (ms: number): number => Math.floor(ms / TOKEN_BUCKET_MS);

function emptyRing(end: number): TokenRing {
	return { bucketMs: TOKEN_BUCKET_MS, end, out: new Array<number>(TOKEN_SLOTS).fill(0) };
}

/** `ring`'s slots as seen from slot `end`: slots older than end − 59 are gone, newer ones are 0. */
export function alignRing(ring: TokenRing, end: number): number[] {
	const out = new Array<number>(TOKEN_SLOTS).fill(0);
	const shift = end - ring.end;
	if (Math.abs(shift) >= TOKEN_SLOTS) return out;
	for (let i = 0; i < TOKEN_SLOTS; i++) {
		const j = i + shift;
		if (j >= 0 && j < TOKEN_SLOTS) out[i] = ring.out[j] ?? 0;
	}
	return out;
}

/** `into`'s slots plus `add`'s, each capped. */
function addSlots(into: number[], add: readonly number[]): void {
	for (let i = 0; i < TOKEN_SLOTS; i++) into[i] = Math.min(MAX_SLOT_TOKENS, (into[i] ?? 0) + (add[i] ?? 0));
}

/** `ring` moved forward to slot `end` (never back). */
function advance(ring: TokenRing, end: number): TokenRing {
	return end <= ring.end ? ring : { bucketMs: TOKEN_BUCKET_MS, end, out: alignRing(ring, end) };
}

/**
 * Add `n` tokens spread evenly over [since, at] to `ring` (already at `at`'s slot or later): each
 * slot gets its share of the time, rounded so the shares add up to exactly `n`. The part before
 * the ring's oldest slot is gone.
 */
function spread(ring: TokenRing, n: number, since: number, at: number): void {
	const a = Math.min(since, at);
	const span = at - a;
	const oldest = ring.end - TOKEN_SLOTS + 1;
	const first = Math.max(slotOf(a), oldest);
	const last = slotOf(at);
	const upTo = (ms: number) => (span > 0 ? Math.round((n * (ms - a)) / span) : n);
	let given = span > 0 ? upTo(Math.max(a, first * TOKEN_BUCKET_MS)) : 0;
	for (let k = first; k <= last; k++) {
		const cum = k === last ? n : upTo((k + 1) * TOKEN_BUCKET_MS);
		const i = k - oldest;
		if (i >= 0 && i < TOKEN_SLOTS) ring.out[i] = Math.min(MAX_SLOT_TOKENS, (ring.out[i] ?? 0) + cum - given);
		given = cum;
	}
}

/** Notify listeners when the published counts changed (not for every bookkeeping step). */
function changed(s: State): void {
	const now = snapshot();
	const key = `${now.active}/${now.approximate}/${now.claudeTurns}/${now.degraded}/${s.counting}/${s.tokenRev}/${now.tokens.partial === true}/${now.folded.join(",")}`;
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
	const end = ((tokens?: LlmCallTokens) => {
		if (ended) return;
		ended = true;
		// The tokens land with the call's end: one change, published once.
		const added = addOwnTokens(s, tokens);
		if (s.active.delete(id) || added) changed(s);
	}) as LlmCallEnd;
	end.waiting = (on: boolean) => {
		if (ended || entry.waiting === on) return;
		entry.waiting = on;
		changed(s);
	};
	Object.defineProperty(end, "ended", { get: () => ended });
	return end;
}

/** Add one ended call's output tokens to this process's ring; whether any were added. */
function addOwnTokens(s: State, tokens: LlmCallTokens | undefined): boolean {
	try {
		const n = whole(tokens?.output, MAX_SLOT_TOKENS * TOKEN_SLOTS);
		if (n === 0) return false;
		const at = typeof tokens!.at === "number" && Number.isFinite(tokens!.at) ? tokens!.at : Date.now();
		const since = typeof tokens!.since === "number" && Number.isFinite(tokens!.since) ? tokens!.since : at;
		s.own = advance(s.own, slotOf(at));
		spread(s.own, n, since, at);
		s.tokenRev++;
		return true;
	} catch {
		return false; // bookkeeping only
	}
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
 * never added to, so a replayed report changes nothing. `undefined` forgets the child: its tokens,
 * if they were summed, stay in this process's ring until they age out (`retire: false` drops them
 * instead: a detached worker goes on reporting them itself).
 */
export function setChildCounts(key: string, counts: LlmChildReport | undefined, opts?: { retire?: boolean; now?: number }): void {
	const s = state();
	const old = s.gauges.get(key);
	if (counts === undefined) {
		if (!old) return;
		if (old.tokens && opts?.retire !== false && summedChildren(s).includes(key)) {
			const end = Math.max(s.retired.end, old.tokens.end, slotOf(opts?.now ?? Date.now()));
			const out = alignRing(s.retired, end);
			addSlots(out, alignRing(old.tokens, end));
			s.retired = { bucketMs: TOKEN_BUCKET_MS, end, out };
		}
		s.gauges.delete(key);
		changed(s);
		return;
	}
	const next = normalizeCounts(counts);
	if (next.tokens && !(old?.tokens && sameSlots(alignRing(old.tokens, next.tokens.end), next.tokens.out))) s.tokenRev++;
	s.gauges.set(key, next);
	changed(s);
}

const sameSlots = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => v === b[i]);

/** The children whose counts a snapshot sums, in key order (so which ones fit is stable). */
function summedChildren(s: State): string[] {
	const folded = new Set<string>();
	const keys: string[] = [];
	for (const key of [...s.gauges.keys()].sort()) {
		const g = s.gauges.get(key)!;
		const ids = [g.producer, ...(g.folded ?? [])].filter((f): f is string => !!f && f !== s.producer && !folded.has(f));
		if (folded.size + ids.length > MAX_FOLDED) continue;
		for (const f of ids) folded.add(f);
		keys.push(key);
	}
	return keys;
}

export function snapshot(now: number = Date.now()): LlmProcessSnapshot {
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
	const end = Math.max(slotOf(now), s.own.end);
	const out = alignRing(s.own, end);
	addSlots(out, alignRing(s.retired, end));
	let tokensPartial = false;
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
		if (g.tokens) {
			addSlots(out, alignRing(g.tokens, end));
			if (g.tokens.partial) tokensPartial = true;
		} else tokensPartial = true;
	}
	const tokens: TokenRing = { bucketMs: TOKEN_BUCKET_MS, end, out, ...(tokensPartial ? { partial: true as const } : {}) };
	return { v: 1, producer: s.producer, pid: process.pid, active, approximate, claudeTurns, degraded, folded: [...folded].sort(), tokens };
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
const whole = (n: unknown, max = MAX): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0);

/** A reported ring, bounded; undefined when it isn't one (then its tokens are unknown). */
export function parseTokenRing(v: unknown): TokenRing | undefined {
	const r = v as Partial<TokenRing> | null | undefined;
	if (!r || typeof r !== "object" || r.bucketMs !== TOKEN_BUCKET_MS || !Number.isSafeInteger(r.end) || (r.end as number) < 0) return undefined;
	if (!Array.isArray(r.out) || r.out.length !== TOKEN_SLOTS) return undefined;
	const out = r.out.map((n) => whole(n, MAX_SLOT_TOKENS));
	return { bucketMs: TOKEN_BUCKET_MS, end: r.end as number, out, ...(r.partial === true ? { partial: true as const } : {}) };
}

const validProducer = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 64 && /^[\w.:-]+$/.test(p);

function normalizeCounts(c: Partial<LlmChildReport>): LlmChildReport {
	const active = whole(c.active);
	const out: LlmChildReport = { active, approximate: Math.min(whole(c.approximate), active), claudeTurns: whole(c.claudeTurns), degraded: c.degraded === true };
	if (validProducer(c.producer)) out.producer = c.producer;
	const tokens = parseTokenRing(c.tokens);
	if (tokens) out.tokens = tokens;
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
