/**
 * `claude-models.json`: what Sova has learned from Claude Code's built-in table, ready at the next
 * start with no Claude Code installed. Only Sova's server writes it (server/claude-table.ts); the
 * server, this extension and every worker read it, synchronously. The file sits apart from catalog.ts
 * because the web app imports catalog.ts, and this one needs node:fs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultAgentDir } from "./accounts.ts";
import { mergeClaudeCatalog, type ClaudeCatalogData } from "./catalog.ts";

export const CLAUDE_MODELS_FILE = "claude-models.json";

/** The program file a read was made from: a read happens again only when this changes. */
export interface ClaudeTableCli {
	path: string;
	realPath: string;
	mtimeMs: number;
	version?: string;
}

/** The newest one-word test of a model. A pass also lists the model in `tested`. */
export interface ClaudeModelProbe {
	at: number;
	ok: boolean;
	reason?: string;
}

export interface ClaudeModelsFile extends ClaudeCatalogData {
	v: 1;
	cli?: ClaudeTableCli;
	checkedAt?: number;
	/** The last read couldn't make sense of the table: the list above is the last good one. */
	unreadable?: { reason: string; at: number; cliVersion?: string };
	/** The last look found no `claude` program: nothing to read, and nothing wrong with the table. */
	noProgram?: boolean;
	probes?: Record<string, ClaudeModelProbe>;
}

export interface ClaudeTableStatus {
	/** False only when a Claude Code program exists, reading is on, and its table couldn't be read. */
	readable: boolean;
	/** There is no `claude` program to read; another Settings line says so. */
	noProgram?: boolean;
	reason?: string;
	at?: number;
	cliVersion?: string;
}

/** Where this process's server keeps its state: a worker on a worktree's agent dir still reads its server's. */
export function claudeStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.SOVA_CHAT_STATE_ROOT || path.join(defaultAgentDir(env), "sova");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The file as written, or null when it is missing or damaged: then only the seed stands. */
export function readClaudeModelsFile(root: string = claudeStateRoot()): ClaudeModelsFile | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, CLAUDE_MODELS_FILE), "utf8"));
		if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.models)) return null;
		return parsed as unknown as ClaudeModelsFile;
	} catch {
		return null;
	}
}

/** The part of the file the catalog merges. */
export function catalogDataOf(file: ClaudeModelsFile | null): ClaudeCatalogData {
	if (!file) return { models: [] };
	const { models, dropped, tested } = file;
	return { models, ...(dropped ? { dropped } : {}), ...(tested ? { tested } : {}) };
}

/** Sova doesn't read the table in these, so nothing can be said about it. */
function readingOff(env: NodeJS.ProcessEnv): boolean {
	return !!env.PI_OFFLINE || ["off", "0", "false"].includes((env.SOVA_MODELS_FETCH ?? "").toLowerCase()) || env.SOVA_CLAUDE_TABLE === "off";
}

function statusOf(file: ClaudeModelsFile | null, env: NodeJS.ProcessEnv): ClaudeTableStatus {
	if (readingOff(env)) return { readable: true };
	if (file?.noProgram) return { readable: true, noProgram: true };
	const bad = file?.unreadable;
	if (!bad) return { readable: true };
	return { readable: false, reason: bad.reason, at: bad.at, ...(bad.cliVersion ? { cliVersion: bad.cliVersion } : {}) };
}

/**
 * Calls `onChange` whenever the file changes, whichever process wrote it: its mtime, polled (each
 * write replaces the file by rename, which a watch on the file itself would lose). Returns the stop.
 */
export function watchClaudeModelsFile(root: string, onChange: () => void, intervalMs = 1000): () => void {
	const file = path.join(root, CLAUDE_MODELS_FILE);
	const listener = (cur: fs.Stats, prev: fs.Stats) => {
		if (cur.mtimeMs !== prev.mtimeMs) onChange();
	};
	fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);
	return () => fs.unwatchFile(file, listener);
}

/** What Settings says about the table: one quiet line while `readable` is false. */
export function claudeTableStatus(root: string = claudeStateRoot(), env: NodeJS.ProcessEnv = process.env): ClaudeTableStatus {
	return statusOf(readClaudeModelsFile(root), env);
}

let lastStatus = JSON.stringify({ readable: true });

/** Reads the file into the catalog. True when the list or the status changed: whoever shows either redraws. */
export function loadClaudeModels(root: string = claudeStateRoot()): boolean {
	const file = readClaudeModelsFile(root);
	const listChanged = mergeClaudeCatalog(catalogDataOf(file));
	const status = JSON.stringify(statusOf(file, process.env));
	const statusChanged = status !== lastStatus;
	lastStatus = status;
	return listChanged || statusChanged;
}
