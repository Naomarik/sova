/**
 * llm-inflight: counts this process's logical LLM calls in flight (README.md).
 *
 * At session_start (and before each turn, in case the session's runtime was replaced) the model
 * runtime behind `ctx.modelRegistry` is instrumented once (runtime.ts). Without that seam the
 * process is marked degraded: its calls are not counted, and its count says so instead of reading 0.
 *
 * Where the count goes: a session's live record carries it (the sessions extension reads
 * tracker.ts's snapshot). A worker is a chat process of its own, which Sova counts from that
 * process (server/chat-host.ts); it never loads this extension.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerUsageSession } from "./attribution.ts";
import { instrumentModelRuntime, runtimeOf } from "./runtime.ts";
import { markDegraded } from "./tracker.ts";

export default function llmInflightExtension(pi: ExtensionAPI): void {
	let releaseDegraded: (() => void) | undefined;
	const instrument = (ctx: ExtensionContext) => {
		const result = instrumentModelRuntime(runtimeOf(ctx.modelRegistry));
		if (result === "unsupported") releaseDegraded ??= markDegraded("pi-runtime");
		else {
			releaseDegraded?.();
			releaseDegraded = undefined;
		}
	};

	// The session this extension instance runs, for the usage ledger: its calls' routing id names it.
	let unregister: (() => void) | undefined;
	const register = (ctx: ExtensionContext) => {
		unregister?.();
		unregister = undefined;
		const sid = ctx.sessionManager?.getSessionId?.();
		if (!sid) return;
		unregister = registerUsageSession(sid, {
			kind: "main",
			...(ctx.cwd ? { cwd: ctx.cwd } : {}),
			parent: null,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			instrument(ctx);
			register(ctx);
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
		unregister?.();
		unregister = undefined;
	});
}
