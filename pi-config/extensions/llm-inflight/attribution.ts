/**
 * Whose model call it is, for the usage ledger (usage-record.ts). Builtins only: Sova's server
 * imports it (its one-shots name their owner here), and every copy loaded in one process shares
 * one table through a globalThis singleton.
 *
 * A request's `sessionId` is a ROUTING id (a prompt-cache key, a provider affinity): it names the
 * owner only when that session registered with this process (the extension does at session_start).
 * A side call (a title, a decision, a summary) gets a fresh routing id, so its owner comes from the
 * usage context its caller set around it (`withUsageContext`, an AsyncLocalStorage scope: two
 * concurrent calls never take each other's). With neither, a process running exactly one session
 * (a TUI, a worker) gives it that session; otherwise the call has no owner.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageKind, UsageStarter } from "./usage-record.ts";

/** What a caller says about the calls it makes. Inner scopes override outer ones field by field. */
export interface UsageContext {
	/** The session the calls are for; null: for no session (a call Sova makes for itself). */
	owner?: string | null;
	cwd?: string;
	purpose?: string;
	kind?: UsageKind;
	project?: string;
	/** Who asked for a project call no session owns (a reconcile). */
	starter?: UsageStarter;
	parent?: string | null;
	worker?: string;
}

/** A session this process runs. */
export interface UsageSession {
	kind: UsageKind;
	cwd?: string;
	parent?: string | null;
	worker?: string;
	project?: string;
	/** What its own turns are for right now (a baton's wrap-up): they keep the session's kind. */
	purpose?: string;
}

/** Who a call is recorded for. */
export interface UsageAttribution {
	owner: string | null;
	parent: string | null;
	worker?: string;
	kind: UsageKind;
	purpose?: string;
	cwd?: string;
	project?: string;
	starter?: UsageStarter;
	/** The owner is the request's own (registered) session id: its replies can be keyed by it. */
	routed: boolean;
}

/** The env var a worker's spawn sets: `<parent session id>:<worker id>`. */
export const USAGE_PARENT_ENV = "PI_USAGE_PARENT";

/** Housekeeping of a session's own conversation: it keeps the session's kind. */
const HOUSEKEEPING = new Set(["compaction", "branch-summary", "cache-warm"]);

interface State {
	sessions: Map<string, UsageSession>;
	/** What a host says about its sessions (an Overseer's kind, a project), whenever it says it. */
	notes: Map<string, Partial<UsageSession>>;
	context: AsyncLocalStorage<UsageContext>;
}
const KEY = Symbol.for("sova.llm-inflight.attribution.v1");
function state(): State {
	const g = globalThis as unknown as Record<symbol, State | undefined>;
	return (g[KEY] ??= { sessions: new Map(), notes: new Map(), context: new AsyncLocalStorage<UsageContext>() });
}

/** `PI_USAGE_PARENT` as {parent, worker}, or undefined. */
export function usageParentFromEnv(env: NodeJS.ProcessEnv = process.env): { parent: string; worker?: string } | undefined {
	const v = env[USAGE_PARENT_ENV];
	if (!v) return undefined;
	const i = v.lastIndexOf(":");
	const parent = i > 0 ? v.slice(0, i) : v;
	const worker = i > 0 ? v.slice(i + 1) : undefined;
	return parent ? { parent, ...(worker ? { worker } : {}) } : undefined;
}

/** Register a session this process runs (idempotent; the last registration wins). Returns its removal. */
export function registerUsageSession(sessionId: string, session: UsageSession): () => void {
	if (!sessionId) return () => undefined;
	const s = state();
	s.sessions.set(sessionId, session);
	return () => {
		if (s.sessions.get(sessionId) === session) s.sessions.delete(sessionId);
	};
}

/** A host's word on one of its sessions (Sova: an Overseer's kind, an org project), kept until cleared. */
export function noteUsageSession(sessionId: string, note: Partial<UsageSession> | undefined): void {
	if (!sessionId) return;
	if (note) state().notes.set(sessionId, note);
	else state().notes.delete(sessionId);
}

/**
 * Mark what session `sessionId`'s own calls are for until cleared (undefined), over any other
 * note: a turn its host prompts for a purpose of its own (a baton's wrap-up), whatever async
 * path its calls take.
 */
export function setUsageSessionPurpose(sessionId: string, purpose: string | undefined): void {
	if (!sessionId) return;
	const s = state();
	const { purpose: _, ...rest } = s.notes.get(sessionId) ?? {};
	noteUsageSession(sessionId, purpose ? { ...rest, purpose } : Object.keys(rest).length ? rest : undefined);
}

/** The registered session `sessionId`, with any host note over it. */
export function usageSession(sessionId: string | undefined): UsageSession | undefined {
	if (!sessionId) return undefined;
	const s = state();
	const session = s.sessions.get(sessionId);
	return session ? { ...session, ...s.notes.get(sessionId) } : undefined;
}

/** Run `fn` with `context` over the current one (field by field). */
export function withUsageContext<T>(context: UsageContext, fn: () => T): T {
	const s = state();
	return s.context.run({ ...s.context.getStore(), ...context }, fn);
}

/**
 * Run a side call `fn` with `purpose` (a one-shot): its owner is the one an outer context names,
 * else none, never the process's only session.
 */
export function withUsagePurpose<T>(purpose: string, fn: () => T): T {
	const outer = state().context.getStore();
	return withUsageContext({ purpose, ...(outer?.owner === undefined ? { owner: null } : {}) }, fn);
}

export function currentUsageContext(): UsageContext | undefined {
	return state().context.getStore();
}

/**
 * Who a call with routing id `routingId` (a request's `sessionId`, if any) is recorded for: its
 * own registered session, else the caller's usage context, else the process's only session, else
 * no one. A housekeeping purpose keeps the owning session's kind; any other purpose is a one-shot.
 */
export function resolveUsageAttribution(routingId?: string, hint?: { purpose?: string }): UsageAttribution {
	const s = state();
	const ctx = s.context.getStore();
	let purpose = ctx?.purpose ?? hint?.purpose;
	const of = (owner: string | null, session: UsageSession | undefined, routed: boolean): UsageAttribution => {
		// A session's own turn marked by its host (session.purpose) keeps the session's kind.
		const own = routed && !purpose ? session?.purpose : undefined;
		if (own) purpose = own;
		const kind = ctx?.kind ?? (purpose && !own && !HOUSEKEEPING.has(purpose) ? "oneshot" : routed || purpose ? (session?.kind ?? "oneshot") : "oneshot");
		const parent = ctx?.parent !== undefined ? ctx.parent : (session?.parent ?? null);
		const worker = ctx?.worker ?? session?.worker;
		const cwd = ctx?.cwd ?? session?.cwd;
		const project = ctx?.project ?? session?.project;
		return { owner, parent, ...(worker ? { worker } : {}), kind, ...(purpose ? { purpose } : {}), ...(cwd ? { cwd } : {}), ...(project ? { project } : {}), ...(ctx?.starter ? { starter: ctx.starter } : {}), routed };
	};
	const own = usageSession(routingId);
	if (own) return of(routingId!, own, true);
	if (ctx && ctx.owner !== undefined) return of(ctx.owner, usageSession(ctx.owner ?? undefined), false);
	if (s.sessions.size === 1) {
		const only = s.sessions.keys().next().value as string;
		return of(only, usageSession(only), false);
	}
	return of(null, undefined, false);
}
