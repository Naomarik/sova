/**
 * Project minor modes, the filesystem half: find the checkout a chat runs in, read its
 * `.sova/minor-modes/<id>/` folders, hash what their tools run. Node builtins only (no pi, no git process),
 * so the mode extension and Sova's server share it. The format is project-format.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	BUILTIN_MINOR_NAMES,
	isProjectModeId,
	ModeFileError,
	parseModeFile,
	PROJECT_MODE_ENTRY,
	PROJECT_MODE_ID_MAX,
	PROJECT_MODES_DIR,
	projectModeBlock,
	snapshotShaInput,
	toolFiles,
	toolsHashInput,
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

/** sha256 of each tool file's bytes, keyed by its `./…` path; a file that can't be read is absent. */
export function toolFileShas(dir: string, tools: readonly ProjectModeTool[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const file of toolFiles(tools)) {
		try {
			out[file] = sha256(readFileSync(join(dir, file.slice(2))));
		} catch {
			// Missing: toolsHashInput writes "missing", and discovery reports the folder broken.
		}
	}
	return out;
}

/** The approval hash of a mode's tools as they are on disk now; "" for a mode with no tools. */
export function toolsHashOf(dir: string, tools: readonly ProjectModeTool[]): string {
	return tools.length === 0 ? "" : sha256(toolsHashInput(tools, toolFileShas(dir, tools)));
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
		const shas = toolFileShas(dir, parsed.tools);
		const missing = toolFiles(parsed.tools).find((rel) => !(rel in shas) || !statSync(join(dir, rel.slice(2))).isFile());
		if (missing) return { id, kind: "parse", path: file, error: `tool file ${missing} is not a file in the mode folder` };
		const kept = {
			description: parsed.description,
			workers: parsed.workers,
			tools: parsed.tools,
			text: projectModeBlock(id, dir, parsed.body),
			toolsHash: parsed.tools.length === 0 ? "" : sha256(toolsHashInput(parsed.tools, shas)),
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
