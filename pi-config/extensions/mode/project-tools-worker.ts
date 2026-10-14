/**
 * Project mode tools for a pi WORKER (and team member; a Claude Code worker is a pi worker on the
 * claude-code provider, so it gets them through its bridge like any registered tool). Workers start
 * with `--no-extensions`, so the mode extension never loads in them; the subagents spawn path loads
 * this file instead, with `-e`, beside spec-worker.ts, into a worker whose parent hands it project
 * modes (`workers: yes`) that have tools, and names their saved copies in the file
 * PROJECT_TOOLS_FILE_ENV points at (`writeWorkerToolsFile`).
 *
 * The worker gets the parent's copies, never a re-read of the folder: the same definitions as the
 * parent's (project-tools.ts `projectToolDefinitions`), so a program changed on disk since the
 * parent's approval refuses here too, and the session's sandbox (the worker's own, inherited from the
 * parent) refuses them while on. The tools are on for the worker's whole life: a worker's modes never
 * change after its start. No prompt of its own: the modes' blocks are in the worker's prompt already.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT } from "../sandbox/state.ts";
import { projectToolDefinitions, PROJECT_TOOLS_FILE_ENV, readWorkerToolsFile } from "./project-tools.ts";

export default function projectToolsWorker(pi: ExtensionAPI): void {
	const file = process.env[PROJECT_TOOLS_FILE_ENV];
	const copies = file ? readWorkerToolsFile(file) : [];
	if (copies.length === 0) return;
	let cwd = process.cwd();
	let sandboxOn = false;
	const names: string[] = [];
	for (const copy of copies) {
		for (const definition of projectToolDefinitions(copy, { cwd: () => cwd, sandboxOn: () => sandboxOn })) {
			pi.registerTool(definition as never);
			names.push(definition.name);
		}
	}

	pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
		if ((data as { version?: unknown } | undefined)?.version === 1) sandboxOn = (data as { on?: unknown }).on === true;
	});
	pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });

	// Registered with defaultActive false (as in the parent): put them in the loadout once the session exists.
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		const active = pi.getActiveTools();
		const next = [...active, ...names.filter((name) => !active.includes(name))];
		if (next.length !== active.length) pi.setActiveTools(next);
	});
}
