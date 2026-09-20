/**
 * Hosting: one forked pi child per `/explain`, run through the subagents
 * extension's `SubagentRunner` (`../subagents/runner.ts`).
 *
 * Why that runner and not our own process handling: it already owns the exact
 * argv this feature needs (`--fork`, `--no-extensions`, tool restriction,
 * `-e <installed package>`), the RPC handshake, the settle/outcome distinction,
 * and the abort → SIGTERM → SIGKILL teardown. It is imported as a class, not as
 * an extension: no manager, no registry, no `agent_*` tools, nothing of the
 * subagents extension's state is touched, and the child still loads no
 * extensions of its own.
 *
 * The child is NOT a subagent in the `/agents` sense: it never appears in that
 * monitor, and this extension stops its own children at session shutdown.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner, type SpawnOptions } from "../subagents/runner.ts";
import { agentDir } from "./store.ts";

/** Everything the child needs to research a topic and write the two store files. */
export const EXPLAIN_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash", "write", "edit"];

/** Worker name, so a stray child is recognizable in `ps` output and in its own session list. */
export const WORKER_NAME = "explain";

export type ExplainOutcome = "success" | "error" | "aborted";

export interface ExplainWorkerSpec {
	id: string;
	task: string;
	cwd: string;
	model?: string;
	effort?: string;
	/** Parent session file to copy; omitted for an unpersisted parent. */
	forkSession?: string;
	/** Extra extension sources for the child (web search, when it is already installed). */
	extensions?: string[];
	/** @internal Test seam. */
	spawnImpl?: SpawnOptions["spawnImpl"];
	/** @internal Test seam. */
	timings?: SpawnOptions["timings"];
}

export interface ExplainWorkerHandle {
	/** Model the child reported for itself, once it answered `get_state`. */
	readonly model?: string;
	readonly sessionId?: string;
	kill(): Promise<void>;
}

export interface ExplainWorkerHandlers {
	/** The child finished its task (or definitively failed). Fires once per run: the runner is killed after. */
	onSettled(result: { outcome: ExplainOutcome; error?: string; finalOutput: string; model?: string }): void;
}

/** A parent session can be forked only once pi has actually written its file. */
export function forkable(sessionFile: string | undefined): sessionFile is string {
	if (!sessionFile) return false;
	try {
		const stats = statSync(sessionFile);
		return stats.isFile() && stats.size > 0;
	} catch {
		return false;
	}
}

/**
 * Web search/fetch for the child, but only if the package pi already installed
 * for this user is sitting there: the point is "trivially available", never an
 * install on the critical path of a slash command.
 */
export function webAccessExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dir = join(agentDir(env), "npm", "node_modules", "pi-web-access");
	return existsSync(dir) ? dir : undefined;
}

/** Start the child. The caller owns the handle and must kill it at shutdown. */
export function startExplainWorker(spec: ExplainWorkerSpec, handlers: ExplainWorkerHandlers): ExplainWorkerHandle {
	let settled = false;
	const runner = new SubagentRunner(
		{
			id: `explain-${spec.id}`,
			groupId: `explain-${spec.id}`,
			name: WORKER_NAME,
			task: spec.task,
			cwd: spec.cwd,
			tools: [...EXPLAIN_TOOLS],
			wake: false,
			...(spec.model ? { model: spec.model } : {}),
			...(spec.effort ? { effort: spec.effort } : {}),
			...(spec.forkSession ? { forkSession: spec.forkSession } : {}),
			...(spec.extensions?.length ? { extensions: spec.extensions } : {}),
			...(spec.spawnImpl ? { spawnImpl: spec.spawnImpl } : {}),
			...(spec.timings ? { timings: spec.timings } : {}),
		},
		{
			onChange: () => {},
			onSettled: (worker) => {
				if (settled) return; // A killed child settles again on exit; the first outcome is the run's.
				settled = true;
				handlers.onSettled({
					outcome: worker.taskOutcome ?? "error",
					error: worker.error,
					finalOutput: worker.finalOutput() ?? "",
					model: worker.model,
				});
			},
			onExit: () => {
				if (settled) return;
				settled = true;
				handlers.onSettled({ outcome: "error", error: runner.error ?? "the explain worker exited before it finished", finalOutput: runner.finalOutput() ?? "", model: runner.model });
			},
		},
	);
	return {
		get model() {
			return runner.model;
		},
		get sessionId() {
			return runner.sessionId;
		},
		kill: () => runner.kill(),
	};
}
