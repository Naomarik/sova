/**
 * What a remote session hands to its workers (subagents): the event the remote extension publishes
 * so the subagents extension knows the session runs on a target. Every worker of a remote session
 * is a pi worker, which loads this extension with the session's `--target`.
 *
 * Pure: no node imports, no pi runtime. Imported by remote/index.ts and subagents/index.ts, so it
 * is a contract between the two: change it in one commit with them.
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
