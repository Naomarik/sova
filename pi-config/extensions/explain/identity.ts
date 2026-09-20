/**
 * Who the parent is: the session id recorded in every explanation, and the
 * session file the child forks from.
 *
 * `PI_SESSION_ID` / `PI_SESSION_FILE` are the documented names for this, but pi
 * only injects them into *tool* subprocesses, not into its own process, and a
 * host that embeds pi (pi-web) can have one process behind several runtimes. So
 * the session manager — which is per session, always — is authoritative, and
 * the environment is the fallback for the case where it reports nothing.
 */
export interface SessionIdentitySource {
	getSessionId(): string | undefined;
	getSessionFile(): string | undefined;
}

export interface ParentIdentity {
	id: string;
	/** Absolute path of the parent JSONL; undefined for an ephemeral or not-yet-written session. */
	file?: string;
}

export function parentIdentity(session: SessionIdentitySource | undefined, env: NodeJS.ProcessEnv = process.env): ParentIdentity {
	let id: string | undefined;
	let file: string | undefined;
	try {
		id = session?.getSessionId();
		file = session?.getSessionFile();
	} catch {
		// A replaced session can invalidate the manager mid-command.
	}
	const resolvedFile = nonEmpty(file) ?? nonEmpty(env.PI_SESSION_FILE);
	return {
		id: nonEmpty(id) ?? nonEmpty(env.PI_SESSION_ID) ?? "unknown",
		...(resolvedFile ? { file: resolvedFile } : {}),
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
