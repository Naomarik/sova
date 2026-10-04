/**
 * A fork point: where a forked pi child can pick up its parent's Claude CLI session instead of
 * folding the history into one message (session-bridge.ts `foldHistory`).
 *
 * A fold can never hit the parent's prompt cache: the CLI sees one new user message where the
 * parent's conversation used to be. `claude --resume <parent> --fork-session` starts from the
 * parent's own record, so the request prefix is the one the parent's last turn cached, and only
 * the fork's new messages are sent.
 *
 * The parent's bridge knows which pi transcript prefix its CLI child has heard (the cumulative
 * fingerprints `transcriptFingerprint` records per turn). The fork point names that prefix by its
 * length and last fingerprint; the child's bridge resumes only if its own transcript starts with
 * exactly that prefix. The point travels to the child process in `CLAUDE_FORK_ENV`.
 *
 * Builtins only, no import of the bridge: background forks (`subagents/fork/`) and Sova's web fork
 * read and seed fork points through the process-global registry without loading the provider.
 */

/** Environment variable carrying an encoded fork point into a forked pi child. */
export const CLAUDE_FORK_ENV = "PI_CLAUDE_CODE_FORK";

/** The process-global bridge registry's key (session-bridge.ts `getSessionBridge`). */
export const BRIDGE_REGISTRY = Symbol.for("sova.claude-code.session-bridge");

export interface ClaudeForkPoint {
	v: 1;
	/** The parent's live CLI session, to resume and fork. */
	claudeSessionId: string;
	/** How many pi messages (as sent to the provider) that session has heard. */
	messages: number;
	/** The cumulative fingerprint of those messages (session-bridge.ts `transcriptFingerprint`). */
	prefix: string;
	/** The CLI child's working directory: its record lives under this project. */
	cwd: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeForkPoint(point: ClaudeForkPoint): string {
	return JSON.stringify(point);
}

/** The fork point in `raw`, or undefined for anything that is not exactly one. */
export function decodeForkPoint(raw: string | undefined): ClaudeForkPoint | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const p = value as Record<string, unknown>;
	if (p.v !== 1) return undefined;
	if (typeof p.claudeSessionId !== "string" || !UUID.test(p.claudeSessionId)) return undefined;
	if (typeof p.messages !== "number" || !Number.isInteger(p.messages) || p.messages < 1) return undefined;
	if (typeof p.prefix !== "string" || !p.prefix) return undefined;
	if (typeof p.cwd !== "string" || !p.cwd) return undefined;
	return { v: 1, claudeSessionId: p.claudeSessionId, messages: p.messages, prefix: p.prefix, cwd: p.cwd };
}

interface ForkPointSource {
	forkPoint?(piSessionId: string): ClaudeForkPoint | undefined;
	seedFork?(piSessionId: string, point: ClaudeForkPoint, fromPiSessionId: string): void;
}

/**
 * The fork point of a pi session in THIS process, if its CLI child is live, idle and in step with
 * pi. Never creates the registry; undefined when the provider never ran here.
 */
export function parentForkPoint(piSessionId: string): ClaudeForkPoint | undefined {
	const host = globalThis as unknown as Record<symbol, { bridge?: ForkPointSource } | undefined>;
	try {
		return host[BRIDGE_REGISTRY]?.bridge?.forkPoint?.(piSessionId);
	} catch {
		return undefined;
	}
}

/**
 * Seed a pi session in THIS process (a fork Sova just created beside its source) with its
 * source's fork point: that session's first conversation turn resumes the source's CLI session
 * instead of folding. The bridge takes the seed only while the source's CLI is still exactly at
 * `point` (`fromPiSessionId` names the source), so a fork prompted after the source moved on
 * folds as before. False when the provider never ran here.
 */
export function seedForkPoint(piSessionId: string, point: ClaudeForkPoint, fromPiSessionId: string): boolean {
	const host = globalThis as unknown as Record<symbol, { bridge?: ForkPointSource } | undefined>;
	try {
		const bridge = host[BRIDGE_REGISTRY]?.bridge;
		if (!bridge?.seedFork) return false;
		bridge.seedFork(piSessionId, point, fromPiSessionId);
		return true;
	} catch {
		return false;
	}
}
