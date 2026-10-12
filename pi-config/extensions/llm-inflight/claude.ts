/**
 * Watches a Claude Code provider bridge's CLI on its stream-json stdout (README.md). The pi runtime
 * counts the bridge's model calls (and their output tokens) itself, so this counts none of them.
 *
 * What it cannot see is reported, not guessed: while a turn runs (from a `requesting` status or a
 * reply's `message_start` until the turn's `result`, or the process closing), the CLI may make calls
 * it does not report (its own subagents, side queries, compaction), so the turn is counted in
 * `claudeTurns`.
 *
 * With `usage`, the same frames also feed the usage ledger (claude-usage.ts): one record per
 * Anthropic message id, and at each result a residual against the session's last recorded total.
 *
 * Nothing else is kept from the frames. Builtins only.
 */
import path from "node:path";
import type { UsageAttribution } from "./attribution.ts";
import { createClaudeUsageCollector, fileBaselineStore, type ClaudeUsageCollector } from "./claude-usage.ts";
import { claimUsageProvider, recordUsage } from "./record.ts";
import { beginClaudeTurn, beginLlmCall, type LlmCallEnd } from "./tracker.ts";
import { defaultAgentDir, type UsageLaunch } from "./usage-record.ts";

export interface ClaudeRequestObserver {
	/** One decoded stdout record. Never throws. */
	frame(event: unknown): void;
	/** The process closed: an open turn ends. Idempotent. */
	close(): void;
}

export interface ClaudeObserverOptions {
	/** Record what the CLI spends in the usage ledger (claude-usage.ts), whether counting or not. */
	usage?: ClaudeUsageRecording;
}

export interface ClaudeUsageRecording {
	/** Who its calls are for; `claudeSession` is the CLI's own session id, once a frame named it. */
	who(claudeSession: string | undefined): UsageAttribution;
	/** The model asked for (an alias such as `opus[1m]`), when known; the answering model is `responseModel`. */
	model?: string;
	/** The CLI starts its session fresh (no `--resume`): a session with no baseline starts at zero. */
	fresh?: boolean;
	/** Where the per-session baselines live (default `<agent dir>/usage/cc-baseline`). */
	baselineDir?: string;
	/** A provider bridge: this observer records `claude-code-cli`'s calls, and the pi runtime no longer does. */
	bridge?: boolean;
	/** How this process started (a provider bridge's launch): read once, for its first root call's record. */
	launch?: () => UsageLaunch | undefined;
}

/** `<agent dir>/usage/cc-baseline`: each Claude session's last cumulative total (a sibling of the ledger's `v1`). */
export const claudeBaselineDir = (agentDir: string = defaultAgentDir()): string => path.join(agentDir, "usage", "cc-baseline");

/** The usage half of an observer: one record per Anthropic message, plus each result's residual. */
function usageCollector(rec: ClaudeUsageRecording): ClaudeUsageCollector | undefined {
	try {
		if (rec.bridge) claimUsageProvider("claude-code-cli");
		const model = (answered: string) => (rec.model ? { model: rec.model, ...(answered && answered !== rec.model ? { responseModel: answered } : {}) } : { model: answered || "unknown" });
		let launched = !rec.launch;
		return createClaudeUsageCollector({
			fresh: rec.fresh === true,
			baseline: fileBaselineStore(rec.baselineDir ?? claudeBaselineDir()),
			sink: {
				call(c) {
					// The process's first call of its own (not a Task subagent's) says how the process started.
					let launch: UsageLaunch | undefined;
					if (!launched && c.lane === "") {
						launched = true;
						try { launch = rec.launch?.(); } catch { launch = undefined; }
					}
					recordUsage({
						src: "claude",
						provider: "claude-code-cli",
						...model(c.model),
						tokens: { input: c.tokens.i, output: c.tokens.o, cacheRead: c.tokens.cr, cacheWrite: c.tokens.cw, cacheWrite1h: c.tokens.cw1h },
						who: rec.who(c.claudeSession),
						...(c.id ? { key: `cc:${c.id}` } : {}),
						...(c.stop ? { stop: c.stop } : {}),
						...(launch ? { launch } : {}),
						ts: c.at,
					});
				},
				residual(r) {
					recordUsage({
						src: "claude-residual",
						provider: "claude-code-cli",
						...model(r.model),
						tokens: { input: r.tokens.i, output: r.tokens.o, cacheRead: r.tokens.cr, cacheWrite: r.tokens.cw },
						who: rec.who(r.claudeSession),
						key: `ccr:${r.claudeSession}:${r.total}:${r.model}`,
						ts: r.at,
					});
				},
			},
		});
	} catch {
		return undefined;
	}
}

export function createClaudeRequestObserver(options: ClaudeObserverOptions = {}): ClaudeRequestObserver {
	const usage = options.usage ? usageCollector(options.usage) : undefined;
	let closed = false;
	let endTurn: (() => void) | undefined;
	const turn = (on: boolean) => {
		if (on) endTurn ??= beginClaudeTurn();
		else {
			endTurn?.();
			endTurn = undefined;
		}
	};

	return {
		frame(event) {
			if (closed || !event || typeof event !== "object") return;
			usage?.frame(event);
			try {
				const e = event as Record<string, any>;
				if (e.type === "system" && e.subtype === "status" && e.status === "requesting") turn(true);
				else if (e.type === "stream_event" && e.event?.type === "message_start") turn(true);
				else if (e.type === "result") turn(false);
			} catch {
				// Observation only.
			}
		},
		close() {
			if (closed) return;
			turn(false);
			usage?.close();
			closed = true;
		},
	};
}

/**
 * A `claude -p` one-shot without a stream (`--output-format json`): counted from spawn to exit,
 * as approximate. Returns the end (idempotent).
 */
export function beginClaudeOneShot(): LlmCallEnd {
	return beginLlmCall({ source: "claude-oneshot", approximate: true });
}
