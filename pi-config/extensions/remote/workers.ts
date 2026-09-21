/**
 * What a remote session hands to its workers (subagents): the event the remote extension publishes
 * so the subagents extension knows the session runs on a target, and the identity a claude-code
 * worker's `remote` MCP server (mcp-server.ts) is launched with.
 *
 * Pure: no node imports, no pi runtime. Imported by remote/index.ts, remote/mcp-server.ts and
 * subagents/index.ts, so it is a contract between the three: change it in one commit with them.
 */

/**
 * Emitted on `pi.events` by remote/index.ts on `session_start` (and again on every
 * REMOTE_DISCOVER_EVENT), so an extension loaded in any order learns the session's target.
 * `pi.getFlag("target")` cannot serve: the loader only answers for flags the calling extension
 * registered itself.
 */
export const REMOTE_SESSION_EVENT = "remote:session";
export const REMOTE_DISCOVER_EVENT = "remote:discover";

export interface RemoteSessionEvent {
	version: 1;
	/** Target name (the `--target` flag). */
	target: string;
	/** The far working directory of the session (absolute, far side); absent when `error` is set. */
	farCwd?: string;
	/** The user's label for the target, when the entry has one. */
	label?: string;
	/** `--no-channel` / PI_REMOTE_CHANNEL=0: workers spawn per call too. */
	channelOff?: boolean;
	/** The target could not be loaded: every tool of the session refuses; workers must refuse too. */
	error?: string;
}

/** Name of the worker's MCP server in its mcp.json; Claude prefixes every tool with `mcp__remote__`. */
export const REMOTE_MCP_SERVER_NAME = "remote";
/** Environment variable carrying the JSON identity to mcp-server.ts (inside the private mcp.json, never argv). */
export const REMOTE_MCP_ENV = "PI_REMOTE_MCP";

export interface RemoteMcpIdentity {
	version: 1;
	target: string;
	/** Far working directory every relative path resolves against. */
	farCwd: string;
	/** $PI_CODING_AGENT_DIR of the parent; the server reads targets.json there (default ~/.pi/agent). */
	agentDir?: string;
	label?: string;
	/** false = never pin a channel; every call spawns its own ssh over the parent's ControlMaster. */
	channel?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function encodeRemoteMcpIdentity(id: RemoteMcpIdentity): string {
	return JSON.stringify(id);
}

/** The identity from the env value, or undefined when missing or malformed (the server then exits without serving). */
export function decodeRemoteMcpIdentity(raw: string | undefined): RemoteMcpIdentity | undefined {
	if (!raw) return undefined;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(v) || v.version !== 1) return undefined;
	if (typeof v.target !== "string" || !/^(?!\.+$)[A-Za-z0-9._-]+$/.test(v.target)) return undefined;
	if (typeof v.farCwd !== "string" || !v.farCwd.startsWith("/")) return undefined;
	if (v.agentDir !== undefined && typeof v.agentDir !== "string") return undefined;
	if (v.label !== undefined && typeof v.label !== "string") return undefined;
	if (v.channel !== undefined && typeof v.channel !== "boolean") return undefined;
	return { version: 1, target: v.target, farCwd: v.farCwd, ...(v.agentDir !== undefined ? { agentDir: v.agentDir } : {}), ...(v.label !== undefined ? { label: v.label } : {}), ...(v.channel !== undefined ? { channel: v.channel } : {}) };
}

/**
 * The sentence a remote worker is told, from two independent sources: the subagents extension
 * appends it to the worker's system prompt, and mcp-server.ts returns it as `initialize.instructions`.
 */
export function remoteWorkerInstructions(id: Pick<RemoteMcpIdentity, "target" | "farCwd" | "label">): string {
	const name = id.label ? `${id.label} (${id.target})` : id.target;
	return (
		`All file and shell operations happen on the remote target "${name}" in ${id.farCwd}, not on this machine. ` +
		`Use the remote_* tools (remote_bash, remote_read, remote_write, remote_edit, remote_ls, remote_find, remote_grep); ` +
		`you have no local file or shell tools, and this machine's working directory is an empty placeholder, not the project. ` +
		`Paths are the target's paths: relative paths resolve against ${id.farCwd}, and ~ is the target's home.`
	);
}
