/**
 * The spec census for a pi WORKER. Workers start with `--no-extensions`, so the mode extension (and its
 * census hook) never loads in them; the subagents spawn path loads this file instead, with `-e`, into
 * every code-writing pi worker a spec-on session spawns (beside the worker spec brief in its prompt).
 *
 * It is only the census: after any tool call, bash included, a Git delta (the first changed file in the
 * boundary, each new file, a new file outside the boundary no claim maps) appends the same
 * `[spec census]` digest as the parent's (spec-guard.ts CensusHook). No prompt, command, tool or state
 * of its own; the trusted tools are found as spec-mode.md's `$core` line finds them. The same digest says
 * when the call wrote the current spec by hand or rewrote commits a draft's evidence names (SpecWriteGuard).
 * PI_SPEC_CENSUS_HOOK=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { bashCommands, CensusHook, coreDir, SpecWriteGuard } from "./spec-guard.ts";

export default function specWorker(pi: ExtensionAPI): void {
	const census = new CensusHook({ core: () => coreDir(process.env, homedir()) });
	const writes = new SpecWriteGuard();

	pi.on("session_start", async () => census.reset());

	// The tree as the run finds it is the baseline, so the run's first edit is already a delta.
	pi.on("agent_start", async (_event, ctx) => {
		if (process.env.PI_SPEC_CENSUS_HOOK !== "0") await census.prime(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (process.env.PI_SPEC_CENSUS_HOOK !== "0") await writes.before(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (process.env.PI_SPEC_CENSUS_HOOK === "0") return;
		const forbidden = await writes.after(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		const { text: digest, failure } = await census.after({
			cwd: ctx.cwd,
			toolName: event.toolName,
			input: event.input,
			signal: ctx.signal,
			commands: bashCommands(ctx.sessionManager.getBranch()),
			sessionStart: ctx.sessionManager.getHeader()?.timestamp,
		});
		if (failure && ctx.hasUI) ctx.ui.notify(failure, "warning");
		const text = [forbidden, digest].filter(Boolean).join("\n");
		if (text) return { content: [...event.content, { type: "text" as const, text }] };
	});
}
