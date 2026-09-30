/**
 * Per-provider request limits: the file, its strict parse, reader and atomic writer, and the lease
 * gate every process on this device claims a slot through. Node builtins only: Sova imports this
 * file (server/provider-limits.ts, server/decide-llm.ts), and so does the pi extension beside it.
 *
 * Files, all under the agent dir:
 *   provider-limits.json                      {version: 1, limits: {<provider>: n}}, n 1..999
 *   provider-limits/<provider>/slots/<id>.json {v: 1, pid, sessionId?, kind, at}   one per request in flight
 *   provider-limits/<provider>/wants/<id>.json {v: 1, pid, sessionId?, kind, since, at}   one per waiter
 *   provider-limits/<provider>/lowered.json    {v: 1, limit, until}   after a 429 (5 minutes)
 *   provider-limits/<provider>/lock            {pid, at}   held for a few fs calls per claim
 *
 * A slot or want is live while its pid is alive and its `at` is under 30 s old; each process
 * refreshes its own every 5 s (one globalThis ticker per process, whatever copies of this module
 * are loaded). Whoever reads a stale one removes it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_LIMITS_FILE_NAME = "provider-limits.json";
export const PROVIDER_LIMITS_DIR_NAME = "provider-limits";
/** What a missing (or unreadable) file stands for. */
export const DEFAULT_PROVIDER_LIMITS: Readonly<Record<string, number>> = Object.freeze({ zai: 5, "ollama-cloud": 10 });
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 999;

export const REFRESH_MS = 5_000;
export const STALE_MS = 30_000;
/** Background work waiting longer than this ranks as interactive. */
export const AGING_MS = 120_000;
export const POLL_MS = 1_000;
/** A 429 lowers the limit for this long. */
export const LOWERED_MS = 5 * 60_000;
/** Cooldown after a 429 without Retry-After, and the most times one request is re-queued. */
export const RATE_LIMIT_COOLDOWN_MS = 10_000;
export const RATE_LIMIT_RETRIES = 5;
const MAX_COOLDOWN_MS = 120_000;
const LOCK_STALE_MS = 2_000;
const LOCK_GIVE_UP_MS = 3_000;

export type RequestKind = "interactive" | "background";

export interface ProviderLimitsFile {
	version: 1;
	limits: Record<string, number>;
}

export type ProviderLimitsState =
	| { state: "ok"; file: string; value: ProviderLimitsFile }
	| { state: "absent"; file: string }
	| { state: "malformed"; file: string; errors: string[] };

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A provider id that can name a directory; any other provider is never gated. */
export const validProviderId = (id: string): boolean => PROVIDER_RE.test(id);
export const validLimit = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MIN_LIMIT && n <= MAX_LIMIT;

/** The agent dir as pi resolves it: $PI_CODING_AGENT_DIR (with ~), else ~/.pi/agent. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir === "~" ? os.homedir() : dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
	return path.join(os.homedir(), ".pi", "agent");
}

export const providerLimitsPath = (agentDir: string): string => path.join(agentDir, PROVIDER_LIMITS_FILE_NAME);
const providerDir = (agentDir: string, provider: string): string => path.join(agentDir, PROVIDER_LIMITS_DIR_NAME, provider);

/** The file's exact shape: `{version: 1, limits}`, every limit a whole number 1..999 under a valid provider id. */
export function parseProviderLimits(value: unknown): { ok: true; value: ProviderLimitsFile } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["not an object"] };
	const o = value as Record<string, unknown>;
	for (const key of Object.keys(o)) if (key !== "version" && key !== "limits") errors.push(`unknown key "${key}"`);
	if (o.version !== 1) errors.push("version must be 1");
	const limits: Record<string, number> = {};
	if (!o.limits || typeof o.limits !== "object" || Array.isArray(o.limits)) errors.push("limits must be an object");
	else
		for (const [provider, n] of Object.entries(o.limits as Record<string, unknown>)) {
			if (!validProviderId(provider)) errors.push(`"${provider}" is not a provider id`);
			else if (!validLimit(n)) errors.push(`${provider}: the limit must be a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}`);
			else limits[provider] = n;
		}
	return errors.length ? { ok: false, errors } : { ok: true, value: { version: 1, limits } };
}

export function readProviderLimits(agentDir: string): ProviderLimitsState {
	const file = providerLimitsPath(agentDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", file };
		return { state: "malformed", file, errors: [`cannot read: ${(error as Error).message}`] };
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return { state: "malformed", file, errors: [`not JSON: ${(error as Error).message}`] };
	}
	const parsed = parseProviderLimits(json);
	return parsed.ok ? { state: "ok", file, value: parsed.value } : { state: "malformed", file, errors: parsed.errors };
}

function writeJsonAtomic(file: string, value: unknown, pretty = false): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), { encoding: "utf8", mode: 0o644 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best effort */
		}
		throw error;
	}
}

/** Validate, then write atomically. Refuses a value that does not parse; returns what it wrote. */
export function writeProviderLimits(agentDir: string, value: unknown): ProviderLimitsFile {
	const parsed = parseProviderLimits(value);
	if (!parsed.ok) throw new Error(`Refusing to write ${PROVIDER_LIMITS_FILE_NAME}: ${parsed.errors.join("; ")}`);
	writeJsonAtomic(providerLimitsPath(agentDir), parsed.value, true);
	return parsed.value;
}

/** The limits that apply now: the file's, else (absent or unreadable) the defaults. */
export function limitsInEffect(agentDir: string): Record<string, number> {
	const state = readProviderLimits(agentDir);
	return state.state === "ok" ? { ...state.value.limits } : { ...DEFAULT_PROVIDER_LIMITS };
}

export interface Lowered {
	v: 1;
	limit: number;
	until: number;
}

const loweredPath = (agentDir: string, provider: string) => path.join(providerDir(agentDir, provider), "lowered.json");

/** The provider's lowered limit while it lasts, else null. */
export function readLowered(agentDir: string, provider: string, now = Date.now()): Lowered | null {
	if (!validProviderId(provider)) return null;
	const rec = readJson(loweredPath(agentDir, provider));
	if (!rec || rec.v !== 1 || !validLimit(rec.limit) || typeof rec.until !== "number" || rec.until <= now) return null;
	return { v: 1, limit: rec.limit, until: rec.until };
}

export interface EffectiveLimit {
	/** The limit that applies now. */
	limit: number;
	/** The Settings number (the file's, or the default). */
	settings: number;
	/** Set while a 429 has the limit lowered below the Settings number. */
	lowered?: Lowered;
}

/** The provider's limit now, or null when it has none. */
export function effectiveLimit(agentDir: string, provider: string, now = Date.now()): EffectiveLimit | null {
	if (!validProviderId(provider)) return null;
	const settings = limitsInEffect(agentDir)[provider];
	if (settings === undefined) return null;
	const lowered = readLowered(agentDir, provider, now);
	return lowered && lowered.limit < settings ? { limit: lowered.limit, settings, lowered } : { limit: settings, settings };
}

// --- process-wide state -----------------------------------------------------------------------

interface Owned {
	file: string;
	record: Record<string, unknown>;
}

interface GateGlobal {
	seq: number;
	owned: Map<string, Owned>;
	ticker: ReturnType<typeof setInterval> | null;
	exitHook: boolean;
	/** Providers whose slot the current async context already holds. */
	held: AsyncLocalStorage<ReadonlySet<string>>;
	/** Session id → its class and its waiting reporter (the extension registers these). */
	sessions: Map<string, { kind: RequestKind; onWait?: (info: WaitInfo | null) => void }>;
	/** Session ids that are background whatever registers them (the Overseer). */
	background: Set<string>;
}

const GLOBAL_KEY = Symbol.for("sova.provider-limits.gate.v1");

function gate(): GateGlobal {
	const g = globalThis as unknown as Record<symbol, GateGlobal | undefined>;
	return (g[GLOBAL_KEY] ??= {
		seq: 0,
		owned: new Map(),
		ticker: null,
		exitHook: false,
		held: new AsyncLocalStorage<ReadonlySet<string>>(),
		sessions: new Map(),
		background: new Set(),
	});
}

function own(file: string, record: Record<string, unknown>): void {
	const g = gate();
	g.owned.set(file, { file, record });
	if (!g.ticker) {
		g.ticker = setInterval(refreshOwned, REFRESH_MS);
		g.ticker.unref?.();
	}
	if (!g.exitHook) {
		g.exitHook = true;
		process.once("exit", () => {
			for (const o of gate().owned.values()) unlinkQuiet(o.file);
		});
	}
}

function disown(file: string): void {
	const g = gate();
	g.owned.delete(file);
	unlinkQuiet(file);
	if (g.owned.size === 0 && g.ticker) {
		clearInterval(g.ticker);
		g.ticker = null;
	}
}

/** Rewrite every file this process holds with a fresh `at`. */
export function refreshOwned(now = Date.now()): void {
	for (const o of gate().owned.values()) {
		o.record.at = now;
		try {
			writeJsonAtomic(o.file, o.record);
		} catch {
			/* the next tick tries again */
		}
	}
}

/** Register a session's class (and how to tell it that it waits). The last registration wins, except `markBackground`. */
export function registerSession(sessionId: string, kind: RequestKind, onWait?: (info: WaitInfo | null) => void): void {
	gate().sessions.set(sessionId, { kind, onWait });
}
export function unregisterSession(sessionId: string): void {
	gate().sessions.delete(sessionId);
}
/** This session's requests are background work, whoever registers it (Sova's Overseer). */
export function markBackground(sessionId: string): void {
	gate().background.add(sessionId);
}
/** A request's class: registered sessions by their class, everything else (one-shots, extension calls) background. */
export function kindOf(sessionId: string | undefined): RequestKind {
	if (!sessionId) return "background";
	const g = gate();
	if (g.background.has(sessionId)) return "background";
	return g.sessions.get(sessionId)?.kind ?? "background";
}
export function waitReporter(sessionId: string | undefined): ((info: WaitInfo | null) => void) | undefined {
	return sessionId ? gate().sessions.get(sessionId)?.onWait : undefined;
}

/** Does the current async context already hold a slot of `provider` (a Sova one-shot wrapped by the extension)? */
export function holdsSlot(provider: string): boolean {
	return gate().held.getStore()?.has(provider) ?? false;
}
/** Run `fn` as holding `provider`'s slot, so a gated stream it reaches does not claim a second one. */
export function whileHolding<T>(provider: string, fn: () => T): T {
	const g = gate();
	const next = new Set(g.held.getStore() ?? []);
	next.add(provider);
	return g.held.run(next, fn);
}

// --- files ------------------------------------------------------------------------------------

function readJson(file: string): Record<string, any> | null {
	try {
		const v = JSON.parse(fs.readFileSync(file, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

function unlinkQuiet(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		/* already gone */
	}
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface SlotRecord {
	v: 1;
	pid: number;
	sessionId?: string;
	kind: RequestKind;
	at: number;
}
export interface WantRecord extends SlotRecord {
	since: number;
}

type Listed<T> = T & { name: string };

/**
 * The live records in one of a provider's directories. `prune`: remove the dead and the stale
 * (never this process's own, which it refreshes itself); otherwise only skip them.
 */
function listLive<T extends SlotRecord>(dir: string, now: number, prune: boolean, want: boolean): Listed<T>[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: Listed<T>[] = [];
	const owned = gate().owned;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		const rec = readJson(file);
		const shaped =
			rec &&
			rec.v === 1 &&
			Number.isInteger(rec.pid) &&
			typeof rec.at === "number" &&
			(rec.kind === "interactive" || rec.kind === "background") &&
			(!want || typeof rec.since === "number");
		const mine = owned.has(file);
		const live = shaped && (mine || (pidAlive(rec.pid) && now - rec.at <= STALE_MS));
		if (live) {
			out.push({ ...(rec as T), name });
			continue;
		}
		if (!prune || mine) continue;
		if (!shaped) {
			// A file that doesn't parse is garbage only once it is old (writes are atomic renames).
			try {
				if (now - fs.statSync(file).mtimeMs <= STALE_MS) continue;
			} catch {
				continue;
			}
		}
		unlinkQuiet(file);
	}
	return out;
}

/** The effective class of a waiter now: interactive, or background aged past AGING_MS. */
const rank = (w: WantRecord, now: number): number => (w.kind === "interactive" || now - w.since > AGING_MS ? 0 : 1);

/** Queue order: interactive (and aged background) first, then first come, first served. */
export function queueOrder<T extends WantRecord & { name: string }>(wants: T[], now: number): T[] {
	return [...wants].sort((a, b) => rank(a, now) - rank(b, now) || a.since - b.since || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});

/** A short exclusive-create lock around one claim; a lock older than 2 s or of a dead pid is broken. */
async function withLock<T>(dir: string, fn: () => T): Promise<T> {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "lock");
	const started = Date.now();
	for (;;) {
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o644 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = readJson(file);
		const age = held && typeof held.at === "number" ? Date.now() - held.at : Infinity;
		if (!held || !pidAlive(held.pid) || age > LOCK_STALE_MS || Date.now() - started > LOCK_GIVE_UP_MS) {
			unlinkQuiet(file);
			continue;
		}
		await sleep(2 + Math.floor(Math.random() * 6));
	}
	try {
		return fn();
	} finally {
		const held = readJson(file);
		if (held?.pid === process.pid) unlinkQuiet(file);
	}
}

// --- the gate ---------------------------------------------------------------------------------

export interface WaitInfo {
	provider: string;
	inUse: number;
	limit: number;
	/** The limit is lowered after a rate limit. */
	lowered: boolean;
}

/** The one waiting sentence, for the TUI's status bar and Sova alike. */
export function waitingText(info: WaitInfo): string {
	return `Waiting for ${info.provider} · ${info.inUse} of ${info.limit} in use${info.lowered ? " (lowered after a rate limit)" : ""}`;
}

export interface Slot {
	provider: string;
	/** The limit the request was sent under (for lowering after a 429). */
	limit: number;
	release(): void;
}

export interface AcquireOptions {
	agentDir?: string;
	kind: RequestKind;
	sessionId?: string;
	signal?: AbortSignal;
	/** Called with the wait's state when it starts or changes, and with null once the slot is had. */
	onWait?: (info: WaitInfo | null) => void;
	pollMs?: number;
}

export class AbortedWhileWaiting extends Error {
	constructor(provider: string) {
		super(`Request aborted while waiting for ${provider}`);
		this.name = "AbortError";
	}
}

/**
 * Claim one of `provider`'s slots, waiting in its queue while it is full. Resolves null when the
 * provider has no limit (nothing to release). Rejects with AbortedWhileWaiting when `signal`
 * aborts first; the queue entry is gone by then.
 */
export async function acquireSlot(provider: string, opts: AcquireOptions): Promise<Slot | null> {
	const agentDir = opts.agentDir ?? defaultAgentDir();
	if (!validProviderId(provider) || effectiveLimit(agentDir, provider) === null) return null;
	if (opts.signal?.aborted) throw new AbortedWhileWaiting(provider);
	const dir = providerDir(agentDir, provider);
	const slotsDir = path.join(dir, "slots");
	const wantsDir = path.join(dir, "wants");
	const g = gate();
	const id = `${process.pid}-${++g.seq}-${randomBytes(3).toString("hex")}`;
	const name = `${id}.json`;
	const wantFile = path.join(wantsDir, name);
	const base = { v: 1 as const, pid: process.pid, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), kind: opts.kind };
	const want: WantRecord = { ...base, since: Date.now(), at: Date.now() };
	fs.mkdirSync(slotsDir, { recursive: true });
	fs.mkdirSync(wantsDir, { recursive: true });
	writeJsonAtomic(wantFile, want);
	own(wantFile, want as unknown as Record<string, unknown>);

	let reported: string | null = null;
	const watchers: fs.FSWatcher[] = [];
	let wake: (() => void) | null = null;
	// Not the provider dir itself: every claim's lock churns there, and would wake its own waiter.
	// A short delay coalesces a burst of changes into one look.
	const poke = () => {
		const w = wake;
		if (w) setTimeout(w, 5);
	};
	for (const d of [slotsDir, wantsDir]) {
		try {
			const w = fs.watch(d, poke);
			w.on("error", () => {});
			w.unref?.();
			watchers.push(w);
		} catch {
			/* the poll covers it */
		}
	}
	try {
		for (;;) {
			if (opts.signal?.aborted) throw new AbortedWhileWaiting(provider);
			const now = Date.now();
			const eff = effectiveLimit(agentDir, provider, now);
			if (!eff) {
				// The limit was removed while this waited.
				if (reported !== null) opts.onWait?.(null);
				return null;
			}
			const outcome = await withLock(dir, () => {
				const t = Date.now();
				const slots = listLive<SlotRecord>(slotsDir, t, true, false);
				// Pruned as stale while this process was stalled: put the entry back, same place in line.
				if (!fs.existsSync(wantFile)) writeJsonAtomic(wantFile, { ...want, at: t });
				const wants = queueOrder(listLive<WantRecord>(wantsDir, t, true, true), t);
				const ahead = wants.findIndex((w) => w.name === name);
				if (slots.length + Math.max(0, ahead) < eff.limit) {
					const slotFile = path.join(slotsDir, name);
					const slot: SlotRecord = { ...base, at: t };
					writeJsonAtomic(slotFile, slot);
					own(slotFile, slot as unknown as Record<string, unknown>);
					disown(wantFile);
					return { slotFile };
				}
				return { inUse: slots.length };
			});
			if ("slotFile" in outcome) {
				if (reported !== null) opts.onWait?.(null);
				let released = false;
				return {
					provider,
					limit: eff.limit,
					release() {
						if (released) return;
						released = true;
						disown(outcome.slotFile);
					},
				};
			}
			const info: WaitInfo = { provider, inUse: outcome.inUse, limit: eff.limit, lowered: !!eff.lowered };
			const key = JSON.stringify(info);
			if (key !== reported) {
				reported = key;
				opts.onWait?.(info);
			}
			await new Promise<void>((resolve) => {
				const t = setTimeout(done, opts.pollMs ?? POLL_MS);
				function done() {
					clearTimeout(t);
					wake = null;
					opts.signal?.removeEventListener("abort", done);
					resolve();
				}
				wake = done;
				opts.signal?.addEventListener("abort", done, { once: true });
			});
		}
	} catch (error) {
		disown(wantFile);
		if (reported !== null) opts.onWait?.(null);
		throw error;
	} finally {
		for (const w of watchers) w.close();
	}
}

// --- rate limits ------------------------------------------------------------------------------

/** A 429 "rate limit" reply — not one that says the quota or balance ran out. */
export function isRateLimit(message: string | undefined, status?: number): boolean {
	const text = message ?? "";
	if (/quota|balance|insufficient|billing|credit/i.test(text)) return false;
	return status === 429 || /^\s*429\b/.test(text) || /\b429\b/.test(text) || /rate[ _-]?limit/i.test(text);
}

/** The cooldown before a re-queue: Retry-After (seconds or an HTTP date), else 10 s; 1 s .. 2 min. */
export function cooldownMs(retryAfter: string | null | undefined, now = Date.now()): number {
	if (retryAfter) {
		const seconds = Number(retryAfter.trim());
		const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
		if (Number.isFinite(ms)) return Math.min(MAX_COOLDOWN_MS, Math.max(1_000, ms));
	}
	return RATE_LIMIT_COOLDOWN_MS;
}

/**
 * After a 429 on a request sent under `sentUnder`: lower the provider's limit to one below that
 * (never below 1, never above what applies now) for 5 minutes, shared by every process. Returns
 * the lowering, or null when the provider has no limit.
 */
export async function lowerAfterRateLimit(agentDir: string, provider: string, sentUnder: number, now = Date.now()): Promise<Lowered | null> {
	if (!validProviderId(provider)) return null;
	const dir = providerDir(agentDir, provider);
	return withLock(dir, () => {
		const eff = effectiveLimit(agentDir, provider, now);
		if (!eff) return null;
		const lowered: Lowered = { v: 1, limit: Math.max(MIN_LIMIT, Math.min(eff.limit, sentUnder - 1)), until: now + LOWERED_MS };
		writeJsonAtomic(loweredPath(agentDir, provider), lowered);
		return lowered;
	});
}

// --- what Sova reads --------------------------------------------------------------------------

export interface ProviderQueue {
	provider: string;
	limit: number;
	settings: number;
	lowered?: Lowered;
	inUse: number;
	waiting: { sessionId?: string; kind: RequestKind; since: number; pid: number }[];
}

/** Every provider with a limit and files on disk: its slots in use and who waits, in queue order. Read-only. */
export function queueSnapshot(agentDir: string, now = Date.now()): ProviderQueue[] {
	let providers: string[];
	try {
		providers = fs.readdirSync(path.join(agentDir, PROVIDER_LIMITS_DIR_NAME));
	} catch {
		return [];
	}
	const out: ProviderQueue[] = [];
	for (const provider of providers.sort()) {
		const eff = effectiveLimit(agentDir, provider, now);
		if (!eff) continue;
		const dir = providerDir(agentDir, provider);
		const inUse = listLive<SlotRecord>(path.join(dir, "slots"), now, false, false).length;
		const wants = queueOrder(listLive<WantRecord>(path.join(dir, "wants"), now, false, true), now);
		out.push({
			provider,
			limit: eff.limit,
			settings: eff.settings,
			...(eff.lowered ? { lowered: eff.lowered } : {}),
			inUse,
			waiting: wants.map((w) => ({ ...(w.sessionId ? { sessionId: w.sessionId } : {}), kind: w.kind, since: w.since, pid: w.pid })),
		});
	}
	return out;
}

/** Each waiting session id's wait (its earliest, if it waits on more than one provider). */
export function waitingBySession(queues: ProviderQueue[]): Map<string, WaitInfo> {
	const out = new Map<string, WaitInfo & { since: number }>();
	for (const q of queues)
		for (const w of q.waiting) {
			if (!w.sessionId) continue;
			const prev = out.get(w.sessionId);
			if (!prev || w.since < prev.since) out.set(w.sessionId, { provider: q.provider, inUse: q.inUse, limit: q.limit, lowered: !!q.lowered, since: w.since });
		}
	return new Map([...out].map(([id, { since: _since, ...info }]) => [id, info]));
}
