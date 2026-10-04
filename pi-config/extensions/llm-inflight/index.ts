/**
 * llm-inflight: counts this process's logical LLM calls in flight (README.md).
 *
 * At session_start (and before each turn, in case the session's runtime was replaced) the model
 * runtime behind `ctx.modelRegistry` is instrumented once (runtime.ts). Without that seam the
 * process is marked degraded: its calls are not counted, and its count says so instead of reading 0.
 *
 * Where the count goes: a session's live record carries it (the sessions extension reads
 * tracker.ts's snapshot). A pi worker has no live record, so it reports its counts to the session
 * that runs it: on every change, a fire-and-forget `setStatus(LLM_STATUS_KEY, json)` on its RPC stdout,
 * which that session's subagents runner folds into its own count (tracker setChildCounts).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT } from "../mode/events.ts";
import { instrumentModelRuntime, runtimeOf } from "./runtime.ts";
import { LLM_STATUS_KEY, markDegraded, snapshot, subscribe, type LlmChildReport } from "./tracker.ts";

/** What a worker reports: its counts, who it is, whose counts it already includes, and its output-token ring. */
export function reportOf(): string {
	const s = snapshot();
	const report: LlmChildReport & { v: 1 } = {
		v: 1, producer: s.producer, active: s.active, approximate: s.approximate, claudeTurns: s.claudeTurns, degraded: s.degraded, folded: s.folded, tokens: s.tokens,
	};
	return JSON.stringify(report);
}

export default function llmInflightExtension(pi: ExtensionAPI): void {
	let worker = false;
	try {
		// worker-mark loads first in every pi worker and answers this at once.
		pi.events?.on(WORKER_ROLE_EVENT, (data: unknown) => {
			if ((data as { version?: unknown } | null)?.version === 1) worker = true;
		});
		pi.events?.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 1 });
	} catch {
		// No event bus: a session of its own.
	}

	let releaseDegraded: (() => void) | undefined;
	const instrument = (ctx: ExtensionContext) => {
		const result = instrumentModelRuntime(runtimeOf(ctx.modelRegistry));
		if (result === "unsupported") releaseDegraded ??= markDegraded("pi-runtime");
		else {
			releaseDegraded?.();
			releaseDegraded = undefined;
		}
	};

	let unsubscribe: (() => void) | undefined;
	let reportCtx: ExtensionContext | undefined;
	let last = "";
	const report = () => {
		const ctx = reportCtx;
		if (!ctx) return;
		try {
			const next = reportOf();
			if (next === last) return;
			last = next;
			ctx.ui.setStatus(LLM_STATUS_KEY, next);
		} catch {
			// A stale context after a session switch, or no UI: the next session_start rebinds.
		}
	};
	const bindReport = (ctx: ExtensionContext) => {
		if (!worker || ctx.mode !== "rpc") return;
		reportCtx = ctx;
		last = "";
		unsubscribe ??= subscribe(report);
		report();
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			instrument(ctx);
			bindReport(ctx);
		} catch {
			// Counting is observation: never fail a session over it.
		}
	});
	pi.on("before_agent_start", (_event, ctx) => {
		try {
			instrument(ctx);
		} catch {
			// As above.
		}
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		reportCtx = undefined;
	});
}
