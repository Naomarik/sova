/**
 * The spec census for a pi WORKER (and team member). Workers start with `--no-extensions`, so the mode
 * extension (and its hooks) never loads in them; the subagents spawn path loads this file instead, with
 * `-e`, into every code-writing pi worker a spec-on session spawns (beside the worker spec brief in its
 * prompt).
 *
 * After any tool call, bash included, a Git delta (the first changed file in the boundary, each new file,
 * a new file outside the boundary no claim maps) appends the same `[spec census]` digest as the parent's
 * (spec-guard.ts CensusHook), plus the write guard (the current spec written by hand, commits a draft's
 * evidence names rewritten) and promote's drift warnings. A turn ends when the model stops: nothing is
 * checked at its end.
 *
 * No prompt, command or tool of its own; the trusted tools are found as spec-mode.md's `$core` line finds
 * them. PI_SPEC_CENSUS_HOOK=0 turns the census off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { bashCommands, CensusHook, coreDir, driftNote, SpecWriteGuard } from "./spec-guard.ts";

export default function specWorker(pi: ExtensionAPI): void {
	const census = new CensusHook({ core: () => coreDir(process.env, homedir()) });
	const writes = new SpecWriteGuard();
	const off = () => process.env.PI_SPEC_CENSUS_HOOK === "0";
	let running = false;

	pi.on("session_start", async () => {
		census.reset();
		running = false;
	});

	// The tree as the run finds it is the baseline, so the run's first edit is already a delta.
	pi.on("agent_start", async (_event, ctx) => {
		if (running) return;
		running = true;
		if (!off()) await census.prime(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (off()) return;
		await writes.before(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		await census.before({ cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (off()) return;
		const { text: forbidden, lost } = await writes.after(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		const { text: digest, failure } = await census.after({
			cwd: ctx.cwd,
			orphansSaid: lost,
			toolName: event.toolName,
			input: event.input,
			signal: ctx.signal,
			commands: bashCommands(ctx.sessionManager.getBranch()),
			sessionStart: ctx.sessionManager.getHeader()?.timestamp,
		});
		// Workers are headless: a failure is said to the model (F12).
		const text = [forbidden, driftNote(event.toolName, event.input, event.content), digest, failure].filter(Boolean).join("\n");
		if (text) return { content: [...event.content, { type: "text" as const, text }] };
	});

	pi.on("agent_settled", async () => {
		running = false;
	});
}
