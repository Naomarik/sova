/**
 * Counts the model calls a Claude Code CLI reports on its stream-json stdout (README.md).
 *
 * Claude Code 2.x writes `{"type":"system","subtype":"status","status":"requesting"}` when its query
 * loop starts a model request, before the request is sent. A call is counted from then until the
 * reply's `message_stop` (a tool_use reply ends there: running the tool is not a call), the next
 * `requesting`, the turn's `result`, or the process closing. A reply seen with no `requesting`
 * before it (a CLI without the signal) is counted from its `message_start` and marks the process
 * degraded: the time before the first token was not seen.
 *
 * What it cannot see is reported, not guessed: while a turn runs (first frame after a `result`
 * until the next `result`), the CLI may make calls it does not report (its own subagents, side
 * queries, compaction), so the turn is counted in `claudeTurns`. The CLI's own retries of one
 * request are inside that one call. A re-adopted worker's replayed history is never counted; until
 * its host goes live it counts as one running turn (unknown, so partial), then as it really is.
 *
 * A counted call's end carries its reply's output tokens (the stream's `usage.output_tokens`, thinking
 * included; never input or cache), spread back to its `message_start` (tracker.ts's ring); a
 * bridge (countRequests: false) counts none, since the pi runtime counts that call already.
 *
 * Frames only drive a small per-lane state; nothing else is kept from them. Builtins only.
 */
import { beginClaudeTurn, beginLlmCall, markDegraded, type LlmCallEnd } from "./tracker.ts";

export interface ClaudeRequestObserver {
	/** One decoded stdout record. Never throws. */
	frame(event: unknown): void;
	/**
	 * Start counting: a re-adopted worker's replay is over, so a request or turn the replay left
	 * open is counted from now. Observers start active unless created with `active: false`.
	 */
	activate(): void;
	/** The process closed: every open call and turn ends. Idempotent. */
	close(): void;
}

export interface ClaudeObserverOptions {
	/** Count requests (false: a provider bridge, whose calls the pi runtime already counts). */
	countRequests?: boolean;
	/** Start counting at once (default) or only at activate(). */
	active?: boolean;
}

interface Lane {
	/** "requesting": sent (or about to be), no reply yet; "responding": the reply is streaming. */
	phase: "requesting" | "responding";
	approximate: boolean;
	end?: LlmCallEnd;
	/** When its reply's first streamed event came (message_start). */
	firstAt?: number;
	/** Its reply's output tokens as last reported (cumulative in the stream). */
	output: number;
}

/** A usage block's output tokens, or 0. */
const outputOf = (usage: unknown): number => {
	const n = (usage as { output_tokens?: unknown } | null | undefined)?.output_tokens;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};

export function createClaudeRequestObserver(options: ClaudeObserverOptions = {}): ClaudeRequestObserver {
	const countRequests = options.countRequests !== false;
	let active = options.active !== false;
	let closed = false;
	const lanes = new Map<string, Lane>();
	let turnOpen = false;
	let endTurn: (() => void) | undefined;
	let releaseDegraded: (() => void) | undefined;
	// While a re-adopted worker's history replays, whether a turn is running is not known yet: the
	// count is partial (one turn) until the host goes live and the real state counts.
	let replayTurn = active ? undefined : beginClaudeTurn();

	const laneOf = (e: Record<string, unknown>): string => (typeof e.parent_tool_use_id === "string" ? e.parent_tool_use_id : "");
	const startCall = (lane: Lane) => {
		if (!active || !countRequests || lane.end) return;
		lane.end = beginLlmCall({ source: "claude-raw", approximate: lane.approximate });
		if (lane.approximate) releaseDegraded ??= markDegraded("claude-response-only");
	};
	const endLane = (key: string) => {
		const lane = lanes.get(key);
		if (!lane) return;
		lanes.delete(key);
		lane.end?.(lane.output ? { output: lane.output, since: lane.firstAt } : undefined);
	};
	const openLane = (key: string, phase: Lane["phase"], approximate: boolean) => {
		endLane(key);
		const lane: Lane = { phase, approximate, output: 0 };
		lanes.set(key, lane);
		startCall(lane);
	};
	const turn = (on: boolean) => {
		if (on === turnOpen) return;
		turnOpen = on;
		if (on) {
			if (active) endTurn = beginClaudeTurn();
		} else {
			endTurn?.();
			endTurn = undefined;
		}
	};
	const endAll = () => {
		for (const key of [...lanes.keys()]) endLane(key);
		turn(false);
	};

	return {
		frame(event) {
			if (closed || !event || typeof event !== "object") return;
			try {
				const e = event as Record<string, any>;
				switch (e.type) {
					case "system":
						if (e.subtype === "status" && e.status === "requesting") {
							turn(true);
							openLane(laneOf(e), "requesting", false);
						}
						return;
					case "stream_event": {
						const type = e.event?.type;
						const key = laneOf(e);
						if (type === "message_start") {
							turn(true);
							if (lanes.get(key)) lanes.get(key)!.phase = "responding";
							else openLane(key, "responding", true);
							const lane = lanes.get(key)!;
							lane.firstAt = Date.now();
							lane.output = Math.max(lane.output, outputOf(e.event?.message?.usage));
						} else if (type === "message_delta") {
							const lane = lanes.get(key);
							if (lane) lane.output = Math.max(lane.output, outputOf(e.event?.usage));
						} else if (type === "message_stop") endLane(key);
						return;
					}
					case "assistant": {
						// A whole reply with no stream before it (a non-streamed reply, an API error) ends the
						// request. While a reply streams, assistant frames echo its blocks and change nothing.
						const key = laneOf(e);
						const lane = lanes.get(key);
						if (lane?.phase === "requesting") {
							lane.output = outputOf(e.message?.usage);
							endLane(key);
						}
						return;
					}
					case "result":
						endAll();
						return;
				}
			} catch {
				// Observation only.
			}
		},
		activate() {
			if (closed || active) return;
			active = true;
			for (const lane of lanes.values()) startCall(lane);
			if (turnOpen) endTurn ??= beginClaudeTurn();
			replayTurn?.();
			replayTurn = undefined;
		},
		close() {
			if (closed) return;
			endAll();
			closed = true;
			replayTurn?.();
			replayTurn = undefined;
			releaseDegraded?.();
			releaseDegraded = undefined;
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
