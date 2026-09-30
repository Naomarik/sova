/**
 * The gated stream: a provider's `streamSimple` wrapped so each request claims a slot of its
 * provider (gate.ts) just before it is sent and gives it back when its stream ends — done, error or
 * abort. Used by the provider-limits extension for every pi provider with a limit, and by the
 * claude-code provider for its own streams.
 *
 * A 429 rate limit before any output is not passed on (when `retry` is on): the slot goes back, the
 * provider's limit is lowered for 5 minutes (gate.ts lowerAfterRateLimit), and after a cooldown
 * (Retry-After, else 10 s) the request queues again, at most RATE_LIMIT_RETRIES times. After that
 * the error reaches pi unchanged, and pi's own retry takes over.
 */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	AbortedWhileWaiting,
	RATE_LIMIT_RETRIES,
	acquireSlot,
	cooldownMs,
	defaultAgentDir,
	holdsSlot,
	isRateLimit,
	kindOf,
	lowerAfterRateLimit,
	waitReporter,
	whileHolding,
	type Slot,
} from "./gate.ts";

export type StreamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface GateStreamOptions {
	/** The limit's provider id; defaults to the request's model provider. */
	provider?: string;
	agentDir?: () => string;
	/** Re-queue after a 429 (pi providers). Off for a stream whose errors are not HTTP replies. */
	retry?: boolean;
	/** Test seam: the cooldown's sleep. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** An assistant message for a stream that ends before the provider ever answered. */
function ended(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});

/** APIs whose requests go through `options.fetch`, so a 429's Retry-After can be read. */
const FETCH_APIS = new Set(["openai-completions"]);

export function gateStreamSimple(inner: StreamSimple, gateOptions: GateStreamOptions = {}): StreamSimple {
	return (model, context, options) => {
		const provider = gateOptions.provider ?? model.provider;
		// Already holding this provider's slot (a Sova one-shot): don't claim a second.
		if (holdsSlot(provider)) return inner(model, context, options);
		const out = createAssistantMessageEventStream();
		const agentDir = gateOptions.agentDir?.() ?? defaultAgentDir();
		const signal = options?.signal;
		const sleep = gateOptions.sleep ?? abortableSleep;
		const sessionId = options?.sessionId;
		const report = waitReporter(sessionId);
		const run = async () => {
			for (let attempt = 0; ; attempt++) {
				let slot: Slot | null;
				try {
					slot = await acquireSlot(provider, { agentDir, kind: kindOf(sessionId), sessionId, signal, onWait: report });
				} catch (error) {
					if (!(error instanceof AbortedWhileWaiting)) throw error;
					out.push({ type: "error", reason: "aborted", error: ended(model, "aborted", "Request aborted") });
					out.end();
					return;
				}
				let status429 = false;
				let retryAfter: string | null = null;
				let requestOptions = options;
				if (slot && gateOptions.retry && FETCH_APIS.has(model.api)) {
					const baseFetch = options?.fetch ?? globalThis.fetch;
					const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
						const response = await baseFetch(input, init);
						if (response.status === 429) {
							status429 = true;
							retryAfter = response.headers.get("retry-after");
						}
						return response;
					};
					requestOptions = { ...options, fetch: fetch as typeof globalThis.fetch };
				}
				const held: AssistantMessageEvent[] = [];
				let answered = false;
				let rateLimited = false;
				try {
					const stream = slot ? whileHolding(provider, () => inner(model, context, requestOptions)) : inner(model, context, requestOptions);
					for await (const event of stream) {
						if (!answered) {
							// `start` says nothing yet; hold it until the reply is known not to be a 429.
							if (event.type === "start") {
								held.push(event);
								continue;
							}
							if (
								event.type === "error" &&
								event.reason === "error" &&
								slot &&
								gateOptions.retry &&
								attempt < RATE_LIMIT_RETRIES &&
								!signal?.aborted &&
								isRateLimit(event.error.errorMessage, status429 ? 429 : undefined)
							) {
								rateLimited = true;
								break;
							}
							answered = true;
							for (const h of held) out.push(h);
							held.length = 0;
						}
						out.push(event);
					}
				} finally {
					slot?.release();
				}
				if (!rateLimited || !slot) {
					for (const h of held) out.push(h);
					out.end();
					return;
				}
				await lowerAfterRateLimit(agentDir, provider, slot.limit).catch(() => null);
				await sleep(cooldownMs(retryAfter), signal);
				if (signal?.aborted) {
					out.push({ type: "error", reason: "aborted", error: ended(model, "aborted", "Request aborted") });
					out.end();
					return;
				}
			}
		};
		run().catch((error) => {
			out.push({ type: "error", reason: "error", error: ended(model, "error", `provider-limits: ${error instanceof Error ? error.message : String(error)}`) });
			out.end();
		});
		return out;
	};
}
