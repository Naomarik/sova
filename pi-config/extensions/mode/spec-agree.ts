/**
 * Where an `agree` stamp's go-ahead was given (`agreed.source`), as pi knows it. The spec tools take it from
 * SPEC_AGREE_SOURCE, refuse a `--source` that differs from it, and refuse to stamp without one.
 *
 * A session that is not a worker points at its own latest user message: `pi-session:<session id>#<entry id>`.
 * The mode extension sets it for the session's bash before each tool call while spec is on; the subagents spawn
 * path hands it to each worker in its environment. A process that was started with the variable already set
 * (a worker) relays that value and never derives one from its own messages, which are its spawner's brief.
 * Node builtins only; no pi imports.
 */
export const AGREE_SOURCE_ENV = "SPEC_AGREE_SOURCE";

/** What whoever started this process gave it: read at load, before this session sets its own. */
const GIVEN: string | undefined = process.env[AGREE_SOURCE_ENV]?.trim() || undefined;

/** The slice of pi's session manager this needs; a host's may lack either method (then there is no reference). */
export interface BranchSource {
	getSessionId?(): string;
	getBranch?(): readonly unknown[];
}

/** The id of the latest user message on the branch, or undefined. */
export function latestUserEntry(branch: readonly unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: unknown; id?: unknown; message?: { role?: unknown } } | null;
		if (e && e.type === "message" && e.message?.role === "user" && typeof e.id === "string" && e.id) return e.id;
	}
	return undefined;
}

/**
 * The go-ahead reference this session hands to `agree` and to its workers: the one it was given, else its own
 * latest user message. `given` is for tests.
 */
export function goAheadRef(session: BranchSource, given: string | undefined = GIVEN): string | undefined {
	if (given !== undefined) return given;
	const entry = latestUserEntry(session.getBranch?.() ?? []);
	const id = session.getSessionId?.();
	return entry && id ? `pi-session:${id}#${entry}` : undefined;
}

/**
 * Before a tool call of a session that is not a worker: SPEC_AGREE_SOURCE as its bash should see it (spec on: its
 * go-ahead reference; spec off: what the process was given, usually nothing).
 */
export function setAgreeSource(session: BranchSource, specOn: boolean, env: NodeJS.ProcessEnv = process.env, given: string | undefined = GIVEN): void {
	const ref = specOn ? goAheadRef(session, given) : given;
	if (ref === undefined) delete env[AGREE_SOURCE_ENV];
	else env[AGREE_SOURCE_ENV] = ref;
}
