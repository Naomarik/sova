/**
 * Project minor modes, the filesystem half: find the checkout a chat runs in, read its
 * `.sova/minor-modes/<id>/` folders, hash what their tools run. Node builtins only (no pi, no git process),
 * so the mode extension and Sova's server share it. The format is project-format.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	BUILTIN_MINOR_NAMES,
	isProjectModeId,
	ModeFileError,
	parseModeFile,
	PROJECT_MODE_BYTES_MAX,
	PROJECT_MODE_ENTRY,
	PROJECT_MODE_FILES_MAX,
	PROJECT_MODE_ID_MAX,
	PROJECT_MODES_DIR,
	projectModeBlock,
	snapshotShaInput,
	hasActions,
	toolFiles,
	toolsHashInput,
	type ModeActions,
	type ProjectModeListing,
	type ProjectModeProblem,
	type ProjectModeSnapshot,
	type ProjectModeTool,
} from "./project-format.ts";

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * The checkout a cwd is in: the nearest ancestor (the cwd included) holding `.git` (a directory, or a
 * worktree's `.git` file), else the cwd itself. Null for a relative cwd (a remote cwd is the caller's to refuse
 * first) or one that is not a directory.
 */
export function checkoutRootOf(cwd: string): string | null {
	if (!isAbsolute(cwd)) return null;
	const start = resolve(cwd);
	try {
		if (!statSync(start).isDirectory()) return null;
	} catch {
		return null;
	}
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return start;
	}
}

/** A mode folder past PROJECT_MODE_FILES_MAX files or PROJECT_MODE_BYTES_MAX bytes. */
export class ModeFolderTooLarge extends Error {}

/**
 * Every file in a mode folder but its top-level MODE.md, recursively (dotfiles included), as `./<path>` → sha256
 * hex of its bytes. A symlink is hashed as its target path, never followed (the runner refuses one pointing out of
 * the folder); anything that is neither a file, a directory nor a symlink is hashed by its kind. Throws
 * ModeFolderTooLarge past the caps; an unreadable entry hashes as "unreadable".
 */
export function folderFileShas(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	let count = 0;
	let bytes = 0;
	const walk = (rel: string): void => {
		let names: string[];
		try {
			names = readdirSync(join(dir, rel)).sort();
		} catch {
			out[`./${rel}`] = "unreadable";
			return;
		}
		for (const name of names) {
			const child = rel === "" ? name : `${rel}/${name}`;
			if (child === PROJECT_MODE_ENTRY) continue;
			const path = join(dir, child);
			let kind: string;
			let size = 0;
			try {
				const st = lstatSync(path);
				if (st.isDirectory()) {
					walk(child);
					continue;
				}
				kind = st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other";
				size = st.size;
			} catch {
				out[`./${child}`] = "unreadable";
				continue;
			}
			if (++count > PROJECT_MODE_FILES_MAX) throw new ModeFolderTooLarge(`the mode folder has more than ${PROJECT_MODE_FILES_MAX} files`);
			bytes += size;
			if (bytes > PROJECT_MODE_BYTES_MAX) throw new ModeFolderTooLarge(`the mode folder holds more than ${PROJECT_MODE_BYTES_MAX / (1024 * 1024)} MB`);
			try {
				out[`./${child}`] = kind === "file" ? sha256(readFileSync(path)) : kind === "symlink" ? `symlink:${sha256(readlinkSync(path))}` : "other";
			} catch {
				out[`./${child}`] = "unreadable";
			}
		}
	};
	walk("");
	return out;
}

/**
 * The approval hash of what a mode runs as it is on disk now: the declared tools (and its commands and hooks, when
 * it has them) and every file in the mode folder (toolsHashInput); "" for a mode that declares none of them. A
 * folder past the caps hashes as "too-large", which no approval ever matches.
 */
export function toolsHashOf(dir: string, tools: readonly ProjectModeTool[], actions?: ModeActions): string {
	if (tools.length === 0 && !hasActions(actions)) return "";
	try {
		return sha256(toolsHashInput(tools, folderFileShas(dir), actions));
	} catch (error) {
		if (error instanceof ModeFolderTooLarge) return "too-large";
		throw error;
	}
}

/** One mode folder read now: its snapshot, or the problem that makes it broken. */
export function readProjectMode(modesDir: string, id: string): ProjectModeSnapshot | ProjectModeProblem {
	const dir = join(modesDir, id);
	if (!isProjectModeId(id)) {
		return { id, kind: "bad-id", path: dir, error: `"${id}" is not a mode name: lowercase letters, digits and hyphens, starting with a letter, at most ${PROJECT_MODE_ID_MAX} characters` };
	}
	if (BUILTIN_MINOR_NAMES.includes(id)) return { id, kind: "clash", path: dir, error: `"${id}" is the name of a built-in minor mode; rename the folder` };
	const file = join(dir, PROJECT_MODE_ENTRY);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { id, kind: "no-entry", path: dir, error: `no ${PROJECT_MODE_ENTRY} in the folder` };
	}
	try {
		const parsed = parseModeFile(text);
		const actions: ModeActions = { commands: parsed.commands, hooks: parsed.hooks };
		const runs = parsed.tools.length > 0 || hasActions(actions);
		const missing = toolFiles(parsed.tools, actions).find((rel) => {
			try {
				return !statSync(join(dir, rel.slice(2))).isFile();
			} catch {
				return true;
			}
		});
		if (missing) return { id, kind: "parse", path: file, error: `tool file ${missing} is not a file in the mode folder` };
		let shas: Record<string, string> = {};
		if (runs) {
			try {
				shas = folderFileShas(dir);
			} catch (error) {
				if (error instanceof ModeFolderTooLarge) return { id, kind: "parse", path: dir, error: `${error.message}; a mode with tools is approved as its whole folder, so keep it small` };
				throw error;
			}
		}
		const kept = {
			description: parsed.description,
			workers: parsed.workers,
			tools: parsed.tools,
			// Only when declared: a mode without them keeps the copy (and sha) it always had.
			...(parsed.commands ? { commands: parsed.commands } : {}),
			...(parsed.hooks ? { hooks: parsed.hooks } : {}),
			text: projectModeBlock(id, dir, parsed.body),
			toolsHash: runs ? sha256(toolsHashInput(parsed.tools, shas, actions)) : "",
		};
		return { v: 1, id, dir, ...kept, sha: sha256(snapshotShaInput(kept)) };
	} catch (error) {
		return { id, kind: "parse", path: file, error: error instanceof ModeFileError ? error.message : `can't read MODE.md: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Every project mode of the checkout `cwd` is in, read now: usable modes and broken folders, each sorted by
 * folder name. One bad folder never hides another. No folder, no modes; never throws.
 */
export function discoverProjectModes(cwd: string): ProjectModeListing {
	const root = checkoutRootOf(cwd);
	if (root === null) return { root: null, name: "", modes: [], problems: [] };
	const listing: ProjectModeListing = { root, name: basename(root), modes: [], problems: [] };
	const modesDir = join(root, PROJECT_MODES_DIR);
	let names: string[];
	try {
		names = readdirSync(modesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !name.startsWith("."))
			.sort();
	} catch {
		return listing;
	}
	for (const name of names) {
		const read = readProjectMode(modesDir, name);
		if ("kind" in read) listing.problems.push(read);
		else listing.modes.push(read);
	}
	return listing;
}
