/**
 * Which repos Sova's merge queue serves, as the server that started this chat last wrote it:
 *
 *   <state root>/merge-served.json
 *   { "v": 1, "at": "<ISO time>", "roots": [ { "root": "/abs/main/checkout", "target": "master" } ] }
 *
 * The server alone writes it (a project on its Projects list whose merge setup is done, with the queue's target
 * branch), atomically, at start-up and whenever the answer changes. The `worktree` tool reads it afresh at each
 * `merge` and `land`: a served repo's branches reach its target only through the queue; every other repo merges
 * plainly. The server imports SERVED_FILE_NAME and ServedData from here, so the name and the shape have one home.
 *
 * Node builtins only (the extension runs in every chat) and nothing of Sova.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { chatStateRoot } from "./landing.ts";

export const SERVED_FILE_NAME = "merge-served.json";

export interface ServedRoot {
	/** The repo's main-checkout root: an absolute, realpath'd path with no trailing slash. */
	root: string;
	/** The branch the queue lands into. */
	target: string;
}

export interface ServedData {
	v: 1;
	/** ISO time of the write. */
	at: string;
	roots: ServedRoot[];
}

/** The file, beside landing.json: under `SOVA_CHAT_STATE_ROOT`, else `<agent dir>/sova`. */
export function servedFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(chatStateRoot(env), SERVED_FILE_NAME);
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;

/** A path as the file compares it: realpath'd when it exists, absolute, no trailing slash. */
export function servedKey(path: string): string {
	let p = resolve(path);
	try {
		p = realpathSync(p);
	} catch {
		// gone or unreadable: compare as given
	}
	return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The file's contents; null when it is absent or damaged (any malformed root makes the whole file damaged). */
export function readServed(file: string = servedFile()): ServedData | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRec(raw) || raw.v !== 1 || !str(raw.at) || !Array.isArray(raw.roots)) return null;
		const roots: ServedRoot[] = [];
		for (const r of raw.roots) {
			if (!isRec(r) || !str(r.root) || !isAbsolute(r.root) || !str(r.target)) return null;
			roots.push({ root: r.root, target: r.target });
		}
		return { v: 1, at: raw.at, roots };
	} catch {
		return null;
	}
}

/**
 * The served entry for a repo's main-checkout root: `{root, target}` when the queue serves it, null when it doesn't,
 * "unknown" when the file is absent or damaged (the caller then behaves as served: fail closed).
 */
export function servedRoot(mainRoot: string, file: string = servedFile()): ServedRoot | null | "unknown" {
	const data = readServed(file);
	if (!data) return "unknown";
	const key = servedKey(mainRoot);
	return data.roots.find((r) => servedKey(r.root) === key) ?? null;
}
