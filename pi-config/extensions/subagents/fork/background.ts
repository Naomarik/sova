/**
 * Background forks: a hidden pi child that works in a copy of the parent's conversation, on the
 * parent's prompt cache, under a policy, and reports back through `onSettled` — without opening a
 * session anyone sees. /explain runs one per page; anything that needs "the agent, with all this
 * context, writes X on the side" starts one the same way. (Sova's "Fork from here" is the other
 * kind of fork: a new visible session, built by the server; its cache identity is the same
 * `./cache.ts`.)
 *
 * Hosting: the subagents extension's `SubagentRunner` (`../runner.ts`). It already owns the exact
 * argv this needs (`--fork`, `--no-extensions`, `-e <source>`, `--session-dir`), the RPC handshake,
 * the settle/outcome distinction, and the abort → SIGTERM → SIGKILL teardown. It is used as a
 * class, not as an extension: no manager, no registry, no `agent_*` tools, nothing of the
 * subagents extension's state is touched, and the child discovers no extensions of its own.
 *
 * The child is NOT a subagent in the `/agents` sense: it never appears in that monitor, and the
 * caller stops it at session shutdown. It does load the subagents worker marker
 * (`../worker-mark.ts`) first, like every subagents pi worker: the child's own session then
 * carries a `subagents-worker-session` entry, and Sova keeps it out of its session list.
 *
 * No tool restriction on the argv: the child's tools are the parent's, declared exactly as the
 * parent declared them, so the fork keeps the parent's prompt cache; `./child.ts` (loaded last)
 * sets them up and blocks every call its `ForkPolicy` does not allow. See mirror.ts.
 */
import { fileURLToPath } from "node:url";
import { CLAUDE_FORK_ENV, encodeForkPoint, parentForkPoint, type ClaudeForkPoint } from "../../claude-code/provider/fork-point.ts";
import { claudeCodeProviderLoad, rpcScopedModel, SubagentRunner, type SpawnOptions } from "../runner.ts";
import { FORK_POLICY_ENV, type ForkPolicy } from "./mirror.ts";

export type BackgroundForkOutcome = "success" | "error" | "aborted";

export interface BackgroundForkSpec {
	/** Unique per run: the runner's id and group are `<name>-<id>`. */
	id: string;
	/** Worker name, so a stray child is recognizable in `ps` output and in its own session list. */
	name: string;
	/** The child's one prompt. */
	task: string;
	cwd: string;
	/** "provider/modelId"; a claude-code-cli model loads its provider into the child. */
	model?: string;
	effort?: string;
	/** Session file the child forks: a copy of the parent's (`copyForFork`); omitted for an unpersisted parent (the child starts fresh). */
	forkSession?: string;
	/** Where the child's own session file goes (`--session-dir`); default: pi's session dir for `cwd`. */
	sessionDir?: string;
	/** What the child may do beyond reading (child.ts enforces it per call). */
	policy: ForkPolicy;
	/** The parent's live Claude CLI session, for a claude-code-cli child to resume instead of folding. Only with `forkSession`. */
	claudeFork?: ClaudeForkPoint;
	/** Extra extension sources for the child (web search, …); loaded after the worker marker, before child.ts. */
	extensions?: string[];
	/** @internal Test seam. */
	spawnImpl?: SpawnOptions["spawnImpl"];
	/** @internal Test seam. */
	timings?: SpawnOptions["timings"];
}

export interface BackgroundForkResult {
	outcome: BackgroundForkOutcome;
	error?: string;
	/** The child's last assistant text. */
	finalOutput: string;
	/** Model the child reported for itself. */
	model?: string;
}

export interface BackgroundForkHandle {
	/** Model the child reported for itself, once it answered `get_state`. */
	readonly model?: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	/** Stop the child (abort, then SIGTERM, then SIGKILL). A run that had not settled settles once, as aborted or error. */
	stop(): Promise<void>;
}

export interface BackgroundForkHandlers {
	/** The child finished its task (or definitively failed). Fires once per run. */
	onSettled(result: BackgroundForkResult): void;
}

/**
 * The subagents worker marker, loaded FIRST into the child on top of `--no-extensions` — the
 * same order subagents uses (`MARKER_EXTENSION`). Its session_start entry is what hides the
 * child's session from Sova's Recent list; nothing else of the subagents extension comes with it.
 */
export const WORKER_MARK_EXTENSION = fileURLToPath(new URL("../worker-mark.ts", import.meta.url));

/** The child's own extension (child.ts), loaded LAST so its before_agent_start has the final word on the prompt. */
export const CHILD_EXTENSION = fileURLToPath(new URL("./child.ts", import.meta.url));

/**
 * Where a claude-code-cli parent's fork picks up: its live, idle CLI session in THIS process
 * (`claude --resume <parent> --fork-session`), so the child's first request is the prefix the
 * parent's last turn cached. Undefined for every other model, or when the parent's CLI session is
 * not live and in step; the child then folds the history (no cache).
 */
export function claudeForkPointFor(model: string | undefined, parentSessionId: string): ClaudeForkPoint | undefined {
	return rpcScopedModel(model) ? parentForkPoint(parentSessionId) : undefined;
}

/** Start the child. The caller owns the handle and must stop it at shutdown. */
export function startBackgroundFork(spec: BackgroundForkSpec, handlers: BackgroundForkHandlers): BackgroundForkHandle {
	let settled = false;
	// A claude-code-cli model needs its provider's extension and switch in the child.
	const load = claudeCodeProviderLoad(spec.model, [WORKER_MARK_EXTENSION, ...(spec.extensions ?? [])], undefined);
	const env: Record<string, string> = { [FORK_POLICY_ENV]: JSON.stringify(spec.policy) };
	// Only a forked child has the parent's conversation to resume.
	if (spec.claudeFork && spec.forkSession) env[CLAUDE_FORK_ENV] = encodeForkPoint(spec.claudeFork);
	const runner = new SubagentRunner(
		{
			id: `${spec.name}-${spec.id}`,
			groupId: `${spec.name}-${spec.id}`,
			name: spec.name,
			task: spec.task,
			cwd: spec.cwd,
			wake: false,
			...(spec.model ? { model: spec.model } : {}),
			...(spec.effort ? { effort: spec.effort } : {}),
			...(spec.forkSession ? { forkSession: spec.forkSession } : {}),
			...(spec.sessionDir ? { sessionDir: spec.sessionDir } : {}),
			extensions: [...load.extensions, CHILD_EXTENSION],
			...(load.flags ? { flags: load.flags } : {}),
			env,
			...(spec.spawnImpl ? { spawnImpl: spec.spawnImpl } : {}),
			...(spec.timings ? { timings: spec.timings } : {}),
		},
		{
			onChange: () => {},
			onSettled: (worker) => {
				if (settled) return; // A stopped child settles again on exit; the first outcome is the run's.
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
				handlers.onSettled({ outcome: "error", error: runner.error ?? `the ${spec.name} worker exited before it finished`, finalOutput: runner.finalOutput() ?? "", model: runner.model });
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
		get sessionFile() {
			return runner.sessionFile;
		},
		stop: () => runner.kill(),
	};
}
