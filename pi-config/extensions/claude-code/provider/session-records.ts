/**
 * The Claude CLI session records the provider bridge leaves on disk.
 *
 * Every child the bridge launches gets `--session-id claudeSessionId(pi, n)`,
 * and the CLI writes that session's record to
 * `<projects>/<cwd-slug>/<id>.jsonl`. Those records are the only durable trace
 * of how many launches a pi session has used, so a new process reads them to
 * pick its next launch number instead of probing ids the previous process
 * already took.
 *
 * Node builtins only, and no pi runtime: the server and the worker-transcript
 * adapters may import this file.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// uuid5, for a CLI session id derived from the pi session
// ---------------------------------------------------------------------------

/** RFC 4122 namespace URL. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * RFC 4122 v5 (SHA-1) UUID. No `uuid` dependency exists here — pi-config
 * extensions are restricted to node builtins — so it is derived directly.
 * Checked against the RFC vector
 * `uuid5(DNS, "python.org") === 886313e1-3b8a-5372-9b90-0c9aee199e5d`.
 */
export function uuidv5(namespace: string, name: string): string {
	const hex = namespace.replace(/-/g, "");
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("uuidv5: namespace is not a UUID");
	const digest = createHash("sha1").update(Buffer.from(hex, "hex")).update(Buffer.from(name, "utf8")).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
	const s = bytes.toString("hex");
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The CLI `--session-id` for the `launch`-th child of a pi session.
 *
 * `--session-id` CREATES a record; it never re-attaches to one. Handed an id
 * that already exists the CLI prints `Session ID <id> is already in use.` on
 * stderr and exits 1 before answering `initialize`, so a *stable* id would make
 * every relaunch after the first child's death fail forever. Each launch
 * therefore gets its own id, still derived from the pi session id so the
 * records stay attributable to it. Launch 0 keeps the bare `pi:<id>` name, so
 * an existing session's first child is unchanged.
 */
export function claudeSessionId(piSessionId: string, launch = 0): string {
	return uuidv5(NAMESPACE_URL, launch === 0 ? `pi:${piSessionId}` : `pi:${piSessionId}#${launch}`);
}

// ---------------------------------------------------------------------------
// Locating records
// ---------------------------------------------------------------------------

/** `$CLAUDE_CONFIG_DIR` (or `~/.claude`) `/projects`, as the CLI resolves it. */
export function claudeProjectsRoot(env: { CLAUDE_CONFIG_DIR?: string } = process.env): string {
	return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Longest slug the CLI keeps whole; a longer one is cut here and given a hash suffix. */
const SLUG_MAX = 200;

/** The CLI's project directory name for a cwd: every non-alphanumeric becomes `-`. */
export function claudeProjectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The project directories a cwd's records may be in. A slug over the CLI's
 * limit carries a hash suffix whose function is the CLI's own, so every
 * directory sharing the cut prefix is a candidate.
 */
function projectDirsFor(cwd: string, root: string): string[] {
	const slug = claudeProjectSlug(cwd);
	if (slug.length <= SLUG_MAX) return [join(root, slug)];
	const prefix = `${slug.slice(0, SLUG_MAX)}-`;
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name.startsWith(prefix))
			.map((d) => join(root, d.name));
	} catch {
		return [];
	}
}

function allProjectDirs(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
	} catch {
		return [];
	}
}

export interface ClaudeSessionRecord {
	/** The bridge launch number the id was derived from. */
	launch: number;
	sessionId: string;
	file: string;
}

export interface SessionRecordOptions {
	/** Only this cwd's project directory; absent, every project directory is searched. */
	cwd?: string;
	/** Defaults to `claudeProjectsRoot()`. */
	projectsRoot?: string;
	/**
	 * Consecutive missing launches that end the walk. A launch can leave no
	 * record (its child failed before the CLI wrote one), so the first gap is
	 * not the end. Defaults to 32.
	 */
	maxGap?: number;
	/** First launch number to look at. Defaults to 0. */
	from?: number;
}

const DEFAULT_MAX_GAP = 32;

/**
 * The records the provider bridge created for a pi session, in launch order.
 * One stat per candidate launch and project directory; with `cwd` that is
 * about `records + maxGap` stats.
 */
export function listBridgeSessionRecords(piSessionId: string, options: SessionRecordOptions = {}): ClaudeSessionRecord[] {
	const root = options.projectsRoot ?? claudeProjectsRoot();
	const dirs = options.cwd !== undefined ? projectDirsFor(options.cwd, root) : allProjectDirs(root);
	const maxGap = Math.max(1, options.maxGap ?? DEFAULT_MAX_GAP);
	const records: ClaudeSessionRecord[] = [];
	if (!dirs.length) return records;
	for (let launch = Math.max(0, options.from ?? 0), gap = 0; gap < maxGap; launch++) {
		const sessionId = claudeSessionId(piSessionId, launch);
		const file = dirs.map((dir) => join(dir, `${sessionId}.jsonl`)).find((f) => existsSync(f));
		if (file === undefined) { gap++; continue; }
		gap = 0;
		records.push({ launch, sessionId, file });
	}
	return records;
}

/**
 * The first launch number at or after `from` that is past every record on
 * disk: the last record's launch + 1, or `from` when there is none.
 */
export function nextFreeLaunch(piSessionId: string, options: SessionRecordOptions = {}): number {
	const from = Math.max(0, options.from ?? 0);
	const last = listBridgeSessionRecords(piSessionId, { ...options, from }).at(-1);
	return last ? Math.max(from, last.launch + 1) : from;
}
