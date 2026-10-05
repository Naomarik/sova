/**
 * Counts every model call a pi ModelRuntime makes (README.md). The runtime is the one object every
 * pi request of a process goes through: the agent's turns and their retries, compaction and branch
 * summaries, prompt-cache warming, and an extension's ctx.modelRegistry.stream/streamSimple/complete.
 * Its `complete*` and `fetchDeferred` call `this.stream*`, so wrapping the stream methods on the
 * instance counts each call once.
 *
 * Duck-typed and builtins only: Sova's server instruments the runtime it owns with this, and the
 * extension instruments the one `ctx.modelRegistry` fronts. The instance is marked, so a second
 * caller (or a reload) changes nothing.
 *
 * A call is in flight from its issue (the provider's `onPayload`, just before it sends; or, for a
 * provider that never calls it, the stream's first event) until its stream ends. Auth, setup and a
 * provider-limits queue come before the issue and never count; a cooldown after a rate limit is
 * marked waiting by the gate (tracker currentLlmCall), and the retry's own onPayload resumes it.
 *
 * Observing never changes a call: the original method runs with the same `this` and arguments
 * (its options copied with an `onPayload` that calls the caller's own and returns what it returns),
 * its stream is returned as is, a synchronous throw is rethrown, and the end is read from the
 * stream's own result promise (never a second iterator) or its `end()`.
 *
 * The one thing read from a reply is its final message's `usage`: its output tokens (reasoning
 * included) go to the call's end with the time of its first streamed event (tracker.ts's ring), and
 * its token counts to one usage record (record.ts), owned by the request's own session if that
 * registered, else by the caller's usage context (attribution.ts), resolved when the call is made.
 * A `claude-code-cli` reply is left to the CLI's stream observer when one records in this process
 * (claude.ts), so it is never recorded twice.
 */
import { resolveUsageAttribution, type UsageAttribution } from "./attribution.ts";
import { recordUsage, usageProviderClaimed } from "./record.ts";
import { beginLlmCall, markCounting, markDegraded, withinLlmCall, type LlmCallEnd } from "./tracker.ts";

const MARK = Symbol.for("sova.llm-inflight.runtime.v1");

type Method = (...args: unknown[]) => unknown;
type Runtime = Record<string | symbol, unknown>;

/** What `instrumentModelRuntime` did. */
export type Instrumented = "instrumented" | "already" | "unsupported";

interface StreamLike {
	result(): Promise<unknown>;
	end?: (...args: unknown[]) => unknown;
}

const isStream = (s: unknown): s is StreamLike => !!s && typeof s === "object" && typeof (s as StreamLike).result === "function";

/**
 * Wrap `stream`'s method `name` with an own property that calls the original (its own or its
 * prototype's) unchanged and then `after`. Returns the restore (the original own property put back
 * exactly, or none), or undefined when the object can't be wrapped (frozen, a non-configurable
 * method): then nothing is touched. Never throws.
 */
function around(stream: object, name: string, after: (args: unknown[]) => void): (() => void) | undefined {
	try {
		const own = Object.getOwnPropertyDescriptor(stream, name);
		const original = (stream as Record<string, unknown>)[name];
		if (typeof original !== "function" || (own && !own.configurable) || !Object.isExtensible(stream)) return undefined;
		Object.defineProperty(stream, name, {
			configurable: true,
			writable: true,
			enumerable: own?.enumerable ?? false,
			value: function (this: unknown, ...args: unknown[]) {
				try {
					return original.apply(this, args);
				} finally {
					try {
						after(args);
					} catch {
						// Observation only.
					}
				}
			},
		});
		return () => {
			try {
				if (own) Object.defineProperty(stream, name, own);
				else delete (stream as Record<string, unknown>)[name];
			} catch {
				// Left wrapped: still calls the original.
			}
		};
	} catch {
		return undefined;
	}
}

/** A final message's output tokens (pi's `usage.output`: reasoning included, never input or cache). */
function outputOf(message: unknown): number {
	const n = (message as { usage?: { output?: unknown } } | undefined)?.usage?.output;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

interface Asked {
	provider: string;
	model: string;
	who: UsageAttribution;
}

/** What the request asked for and who it is for, read when the call is made. */
function askedOf(model: unknown, options: unknown): Asked | undefined {
	try {
		const m = model as { provider?: unknown; id?: unknown } | undefined;
		const o = options as { sessionId?: unknown; maxTokens?: unknown } | undefined;
		const sid = typeof o?.sessionId === "string" ? o.sessionId : undefined;
		// pi's prompt-cache warm asks for one token.
		const who = resolveUsageAttribution(sid, o?.maxTokens === 1 ? { purpose: "cache-warm" } : undefined);
		return { provider: typeof m?.provider === "string" ? m.provider : "", model: typeof m?.id === "string" ? m.id : "", who };
	} catch {
		return undefined;
	}
}

/** One usage record for a call's final message (none for a deferred handle, or no tokens). Never throws. */
function recordReply(message: unknown, asked: Asked | undefined): void {
	try {
		if (!asked) return;
		const m = message as { provider?: unknown; model?: unknown; responseModel?: unknown; stopReason?: unknown; timestamp?: unknown; usage?: Record<string, unknown> } | undefined;
		if (!m?.usage || m.stopReason === "deferred") return;
		const provider = typeof m.provider === "string" && m.provider ? m.provider : asked.provider;
		if (usageProviderClaimed(provider)) return;
		const model = typeof m.model === "string" && m.model ? m.model : asked.model;
		const u = m.usage;
		const ts = typeof m.timestamp === "number" && m.timestamp > 0 ? m.timestamp : undefined;
		recordUsage({
			src: "pi",
			provider,
			model,
			...(typeof m.responseModel === "string" ? { responseModel: m.responseModel } : {}),
			tokens: { input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number, cacheWrite1h: u.cacheWrite1h as number },
			who: asked.who,
			// A registered session's reply carries its stream-start time, persisted with it.
			...(asked.who.routed && asked.who.owner && ts ? { key: `pi:${asked.who.owner}:${ts}:${provider}/${model}` } : {}),
			...(typeof m.stopReason === "string" ? { stop: m.stopReason } : {}),
		});
	} catch {
		// Recording only.
	}
}

/**
 * Watch `stream` until it ends, then end `call` with its reply's output tokens. The call is in
 * flight from its issue: the request's `onPayload` (every pi provider calls it just before
 * sending), else the stream's first event that isn't an error. Never throws.
 */
function finishWith(stream: unknown, call: LlmCallEnd, onResult?: (message: unknown) => void): void {
	try {
		if (!isStream(stream)) {
			call();
			return;
		}
		let firstAt: number | undefined;
		Promise.resolve(stream.result()).then(
			(message) => {
				let output = 0;
				try {
					output = outputOf(message);
				} catch {
					// Bookkeeping only.
				}
				call(output ? { output, since: firstAt } : undefined);
				try {
					onResult?.(message);
				} catch {
					// Bookkeeping only.
				}
			},
			() => call(),
		);
		// A provider that never calls onPayload: its first real event says the request went out.
		let seen = false;
		const restorePush = around(stream, "push", (args) => {
			if (seen) return;
			const type = (args[0] as { type?: unknown } | undefined)?.type;
			if (type === "error") return;
			seen = true;
			firstAt = Date.now();
			call.waiting(false);
			restorePush?.();
		});
		// A stream ended without a final message never settles its result: its end() still ends the
		// call. One microtask later, so a final message settled just before (pi's push of "done"
		// resolves the result, then end() runs) ends it first, with its tokens.
		around(stream, "end", () => {
			Promise.resolve().then(() => call());
		});
	} catch {
		call();
	}
}

/** The request's options with an onPayload that marks `call` issued, then runs the caller's own. */
function issuing(options: unknown, call: LlmCallEnd): unknown {
	if (options !== undefined && (options === null || typeof options !== "object")) return options;
	const own = (options as { onPayload?: unknown } | undefined)?.onPayload;
	const onPayload = function (this: unknown, ...args: unknown[]) {
		call.waiting(false);
		return typeof own === "function" ? own.apply(this, args) : undefined;
	};
	return { ...(options as object | undefined), onPayload };
}

interface DeferredHandleLike {
	provider?: unknown;
	id?: unknown;
	expiresAt?: unknown;
}

const keyOf = (handle: unknown): string | undefined => {
	const h = handle as DeferredHandleLike | undefined;
	return h && typeof h.id === "string" ? `${String(h.provider)}\u0000${h.id}` : undefined;
};

/**
 * Deferred responses: a request that returns a handle (stop reason "deferred") goes on being
 * computed remotely, where nothing local sees it, so while a handle is pending the process is
 * degraded rather than counting it. Fetching a handle is retrieval, never a counted call; a final
 * reply (or a cancel) retires the handle.
 */
class DeferredTracker {
	private readonly pending = new Map<string, number | undefined>();
	private release?: () => void;

	note(message: unknown): void {
		const m = message as { stopReason?: unknown; deferred?: DeferredHandleLike } | undefined;
		if (m?.stopReason !== "deferred" || !m.deferred) return;
		const key = keyOf(m.deferred);
		if (!key) return;
		this.pending.set(key, typeof m.deferred.expiresAt === "number" ? m.deferred.expiresAt : undefined);
		this.sync();
	}
	retire(handle: unknown): void {
		const key = keyOf(handle);
		if (key && this.pending.delete(key)) this.sync();
	}
	private sync(): void {
		const now = Date.now();
		for (const [key, expires] of this.pending) if (expires !== undefined && expires <= now) this.pending.delete(key);
		while (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value as string);
		if (this.pending.size > 0) this.release ??= markDegraded("pi-deferred");
		else {
			this.release?.();
			this.release = undefined;
		}
	}
}

/** Instrument one ModelRuntime instance (idempotent). */
export function instrumentModelRuntime(runtime: unknown): Instrumented {
	try {
		if (!runtime || typeof runtime !== "object") return "unsupported";
		const rt = runtime as Runtime;
		if (rt[MARK]) {
			markCounting();
			return "already";
		}
		const stream = rt.stream;
		const streamSimple = rt.streamSimple;
		if (typeof stream !== "function" || typeof streamSimple !== "function") return "unsupported";
		const deferred = new DeferredTracker();
		const define = (name: string, value: Method) =>
			Object.defineProperty(rt, name, { configurable: true, writable: true, enumerable: false, value });
		const counted = (original: Method): Method =>
			function (this: unknown, ...args: unknown[]) {
				let call: LlmCallEnd;
				let callArgs: unknown[];
				const asked = askedOf(args[0], args[2]);
				try {
					// Pending until issued: auth, a provider-limits queue and setup are not in flight.
					call = beginLlmCall({ source: "runtime", pending: true });
					callArgs = [args[0], args[1], issuing(args[2], call), ...args.slice(3)];
				} catch {
					return original.apply(this, args);
				}
				let result: unknown;
				try {
					result = withinLlmCall(call, () => original.apply(this, callArgs));
				} catch (error) {
					call();
					throw error;
				}
				finishWith(result, call, (message) => {
					deferred.note(message);
					recordReply(message, asked);
				});
				return result;
			};
		/** Fetching or cancelling a deferred handle: not a call; a final answer retires the handle. */
		const retiring = (original: Method, final: (value: unknown) => boolean, record = false): Method =>
			function (this: unknown, ...args: unknown[]) {
				const asked = record ? askedOf(args[0], args[2]) : undefined;
				const result = original.apply(this, args);
				try {
					const settled = isStream(result) ? result.result() : result;
					Promise.resolve(settled).then(
						(value) => {
							if (!final(value)) return;
							deferred.retire(args[1]);
							// A deferred request's final reply: what its remote work spent.
							recordReply(value, asked);
						},
						() => undefined,
					);
				} catch {
					// Bookkeeping only.
				}
				return result;
			};
		define("stream", counted(stream as Method));
		define("streamSimple", counted(streamSimple as Method));
		if (typeof rt.streamDeferred === "function")
			define("streamDeferred", retiring(rt.streamDeferred as Method, (m) => (m as { stopReason?: unknown } | undefined)?.stopReason !== "deferred", true));
		if (typeof rt.cancelDeferred === "function") define("cancelDeferred", retiring(rt.cancelDeferred as Method, () => true));
		Object.defineProperty(rt, MARK, { value: true, configurable: false, enumerable: false });
		markCounting();
		return "instrumented";
	} catch {
		return "unsupported";
	}
}

/** The runtime behind an extension's `ctx.modelRegistry` (pi 0.87: its `runtime` field). */
export function runtimeOf(modelRegistry: unknown): unknown {
	try {
		const runtime = (modelRegistry as { runtime?: unknown } | undefined)?.runtime;
		return runtime && typeof runtime === "object" ? runtime : undefined;
	} catch {
		return undefined;
	}
}
