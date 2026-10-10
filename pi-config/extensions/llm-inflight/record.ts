/**
 * One usage record per model call (usage-record.ts), written by the observer that saw the call end:
 * the pi runtime (runtime.ts), a Claude Code CLI's stream (claude.ts), a `claude -p` envelope
 * (claudeEnvelopeRecords) and Sova's Jev provider. Builtins only; Sova's server imports it.
 *
 * Never throws: recording is observation and never fails a call.
 */
import type { UsageAttribution } from "./attribution.ts";
import { producerId } from "./tracker.ts";
import { appendUsageRecord, defaultAgentDir, readDeviceId, type UsageLaunch, type UsageRecord, type UsageSource } from "./usage-record.ts";

export interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
}

export interface RecordUsageInput {
	src: UsageSource;
	provider: string;
	model: string;
	responseModel?: string;
	tokens: UsageTokens;
	who: UsageAttribution;
	/** The call's name (usage-record.ts `key`); default `<producer>:<seq>`. */
	key?: string;
	stop?: string;
	/** How the Claude Code process this call opens started (its first call only). */
	launch?: UsageLaunch;
	/** The call's end (default now). */
	ts?: number;
}

interface State {
	seq: number;
	/** Providers whose calls another observer records (a Claude Code bridge: `claude-code-cli`). */
	claimed: Set<string>;
}
const KEY = Symbol.for("sova.llm-inflight.record.v1");
function state(): State {
	const g = globalThis as unknown as Record<symbol, State | undefined>;
	return (g[KEY] ??= { seq: 0, claimed: new Set() });
}

/** Another observer records `provider`'s calls in this process: the pi runtime leaves them out. */
export function claimUsageProvider(provider: string): void {
	state().claimed.add(provider);
}
export const usageProviderClaimed = (provider: string): boolean => state().claimed.has(provider);

const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const short = (v: string | undefined, max: number): string | undefined => (v && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : undefined);

/** The record `input` describes (not written). */
export function usageRecordOf(input: RecordUsageInput, agentDir: string = defaultAgentDir()): UsageRecord {
	const producer = producerId();
	const ts = whole(input.ts) || Date.now();
	const input_ = whole(input.tokens.input);
	const output = whole(input.tokens.output);
	const cacheRead = whole(input.tokens.cacheRead);
	const cacheWrite = whole(input.tokens.cacheWrite);
	const cacheWrite1h = Math.min(whole(input.tokens.cacheWrite1h), cacheWrite);
	const w = input.who;
	const responseModel = short(input.responseModel, 256);
	const stop = short(input.stop, 32);
	return {
		v: 1,
		key: input.key ?? `${producer}:${++state().seq}`,
		ts,
		device: readDeviceId(agentDir),
		producer,
		src: input.src,
		provider: input.provider || "unknown",
		model: input.model || "unknown",
		...(responseModel && responseModel !== input.model ? { responseModel } : {}),
		input: input_,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h ? { cacheWrite1h } : {}),
		owner: w.owner,
		parent: w.parent,
		...(w.worker ? { worker: w.worker } : {}),
		kind: w.kind,
		...(w.purpose ? { purpose: w.purpose } : {}),
		...(w.cwd ? { cwd: w.cwd } : {}),
		...(w.project ? { project: w.project } : {}),
		...(w.starter ? { starter: w.starter } : {}),
		...(stop ? { stop } : {}),
		...(input.launch ? { launch: input.launch } : {}),
	};
}

/** Write one call's record; false when it has no tokens or could not be written. Never throws. */
export function recordUsage(input: RecordUsageInput): boolean {
	try {
		const agentDir = defaultAgentDir();
		return appendUsageRecord(usageRecordOf(input, agentDir), agentDir);
	} catch {
		return false;
	}
}

/**
 * A `claude -p --output-format json` envelope's records: one per model in its `modelUsage`, keyed
 * `cp:<envelope session id>:<model>` (a failed run's envelope too: its tokens were spent). The
 * stdout is the CLI's whole output; anything that isn't its envelope records nothing.
 */
export function recordClaudeEnvelope(stdout: string, who: UsageAttribution, asked?: string): number {
	let env: Record<string, any>;
	try {
		env = JSON.parse(stdout);
	} catch {
		return 0;
	}
	if (!env || typeof env !== "object") return 0;
	const sid = typeof env.session_id === "string" ? env.session_id : undefined;
	const mu = env.modelUsage && typeof env.modelUsage === "object" ? (env.modelUsage as Record<string, any>) : undefined;
	let n = 0;
	const ts = Date.now();
	if (mu && Object.keys(mu).length) {
		for (const [model, u] of Object.entries(mu)) {
			if (!u || typeof u !== "object") continue;
			const ok = recordUsage({
				src: "claude-p",
				provider: "claude-code-cli",
				model,
				...(asked && asked !== model ? { responseModel: model, model: asked } : {}),
				tokens: { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens },
				who,
				...(sid ? { key: `cp:${sid}:${model}` } : {}),
				...(typeof env.subtype === "string" ? { stop: env.subtype } : {}),
				ts,
			});
			if (ok) n++;
		}
		return n;
	}
	// An envelope without per-model totals: its `usage` under the model asked for.
	const u = env.usage;
	if (!u || typeof u !== "object") return 0;
	const model = asked || "unknown";
	return recordUsage({
		src: "claude-p",
		provider: "claude-code-cli",
		model,
		tokens: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens },
		who,
		...(sid ? { key: `cp:${sid}:${model}` } : {}),
		ts,
	})
		? 1
		: 0;
}
