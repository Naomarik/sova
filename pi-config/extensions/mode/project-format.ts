/**
 * Project minor modes, the format: what a project's `.sova/minor-modes/<id>/MODE.md` may say, and the shapes
 * every reader shares (the mode extension, Sova's server, its web app). Pure: no imports, no node builtins,
 * no DOM, so the browser can import it through shared/project-modes.ts. The filesystem half (finding the
 * checkout, reading folders, hashing) is project-discovery.ts.
 *
 * A project mode is a folder `<checkout root>/.sova/minor-modes/<id>/`: the id is the folder name, the
 * entry file is MODE.md (frontmatter, then the body the model reads), and the folder holds whatever
 * reference files and tool programs the body and the tool declarations name.
 */

/** Where a checkout keeps its project modes, relative to its root. */
export const PROJECT_MODES_DIR = ".sova/minor-modes";
/** The one entry file of a project mode folder. */
export const PROJECT_MODE_ENTRY = "MODE.md";
/** The longest project mode id. */
export const PROJECT_MODE_ID_MAX = 30;
const ID_RE = /^[a-z][a-z0-9-]*$/;

/** Whether `value` is a well-formed project mode id: `^[a-z][a-z0-9-]*$`, at most 30 characters. */
export function isProjectModeId(value: unknown): value is string {
	return typeof value === "string" && value.length <= PROJECT_MODE_ID_MAX && ID_RE.test(value);
}

/**
 * The built-in minor mode names, as pi-config/extensions/mode/minor.ts's MINOR_MODES (a test keeps them equal).
 * A project folder with one of these names is a problem row ("clash"), never an override of the built-in.
 */
export const BUILTIN_MINOR_NAMES: readonly string[] = ["align", "spec", "vis", "codemode", "memory"];

/**
 * Most modes a worker carries: built-in worker modes plus project modes with `workers: yes`
 * (pi-config/extensions/sessions/schema.ts WORKER_MODES_MAX drops a longer list whole). Project modes past
 * the cap are not handed to the worker, in the chat's turn-on order.
 */
export const WORKER_MODES_CAP = 8;

/** Most tools one project mode declares. */
export const PROJECT_TOOLS_MAX = 16;
/** A declared tool's name: lowercase, digits and single underscores, at most 32 characters. */
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const PROJECT_TOOL_NAME_MAX = 32;
/** Default and largest per-call timeout of a tool's command, seconds. */
export const PROJECT_TOOL_TIMEOUT_DEFAULT_S = 60;
export const PROJECT_TOOL_TIMEOUT_MAX_S = 600;

/** One tool a project mode declares. */
export interface ProjectModeTool {
	/** As declared: `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, at most 32 characters, unique in its mode. */
	name: string;
	description: string;
	/** A JSON schema whose `type` is "object"; the call's arguments are checked by the harness against it. */
	params: Record<string, unknown>;
	/**
	 * argv. Element 0 is a program on PATH (a bare name, no `/`) or a file in the mode folder (`./…`). Any
	 * element starting with `./` names a file in the mode folder: the runner passes it as that file's
	 * absolute path. No other element may contain a `/`: a tool runs only its own folder's code (all of which
	 * toolsHash covers) or a program of the machine (a bare name, not covered). Nothing else is rewritten.
	 */
	command: string[];
	/** Per-call timeout in seconds, 1–600 (default 60). */
	timeoutS: number;
}

/** What MODE.md says, parsed and checked. */
export interface ProjectModeFile {
	description: string;
	/** `workers: yes`: the mode reaches the workers a chat starts (default no). */
	workers: boolean;
	tools: ProjectModeTool[];
	/** The body after the frontmatter, ends trimmed. */
	body: string;
}

/**
 * The version of a project mode a chat keeps: saved in the chat's own history when the mode is turned on, and
 * the only thing the chat ever reads for it after that (never the folder again while it stays on).
 */
export interface ProjectModeSnapshot {
	v: 1;
	id: string;
	/** The mode folder's absolute path when it was turned on (tool programs resolve against it). */
	dir: string;
	description: string;
	workers: boolean;
	tools: ProjectModeTool[];
	/** The injected block exactly (projectModeBlock). */
	text: string;
	/**
	 * The copy's identity: sha256 hex of snapshotShaInput (text, description, workers, tools, toolsHash), so
	 * any edit that reaches the chat on off/on gives a new sha. Approval looks at toolsHash alone.
	 */
	sha: string;
	/** sha256 hex over the declared tools and every file in the mode folder but MODE.md (toolsHashInput); "" with no tools. */
	toolsHash: string;
}

/** Why a folder under .sova/minor-modes/ is not a usable mode. */
export type ProjectModeProblemKind = "bad-id" | "clash" | "no-entry" | "parse";

export interface ProjectModeProblem {
	/** The folder name as found (not a valid id when kind is "bad-id"). */
	id: string;
	kind: ProjectModeProblemKind;
	/** Absolute path of the folder, or of MODE.md for "parse". */
	path: string;
	/** One line for the user: what is wrong. */
	error: string;
}

/** A checkout's project modes as read now: every usable mode (sorted by id) and every broken folder. */
export interface ProjectModeListing {
	/** The checkout root read (git toplevel of the cwd, else the cwd), or null when there is none (remote/relative cwd). */
	root: string | null;
	/** The name the menu shows ("This project · <name>"): the root's last path segment. */
	name: string;
	modes: ProjectModeSnapshot[];
	problems: ProjectModeProblem[];
}

/**
 * A project mode as the mode entry and a mode note record it (`projectModes` beside the closed `minorModes`):
 * which mode, and which saved version (its snapshot's sha). Order is turn-on order.
 */
export interface ProjectModeRef {
	id: string;
	sha: string;
}

/**
 * The namespace (a8): project modes are stored only under their own keys (`projectModes` on the mode entry
 * and note details, `projectMinors` on the wire), never in a `minorModes` list, so a built-in added later with
 * the same name never takes a chat's project mode over. Where one string must name either kind (the `/mode`
 * command), `project:<id>` always means the project mode; a bare name means the built-in when there is one.
 */
export const PROJECT_MODE_PREFIX = "project:";

/** "project:foo" or bare "foo" (not a built-in) → "foo"; anything else → undefined. */
export function projectModeArg(value: string): string | undefined {
	const id = value.startsWith(PROJECT_MODE_PREFIX) ? value.slice(PROJECT_MODE_PREFIX.length) : BUILTIN_MINOR_NAMES.includes(value) ? undefined : value;
	return isProjectModeId(id) ? id : undefined;
}

/**
 * The name a tool is registered under for the model: the mode id with `-` as `_`, two underscores, the tool's
 * name. Ids have no `_` and tool names no `__`, so two modes' tools never share a name, and none collides
 * with a harness tool.
 */
export function projectToolName(modeId: string, toolName: string): string {
	return `${modeId.replace(/-/g, "_")}__${toolName}`;
}

/** The custom entry type a turn-on appends to the chat's branch: `data` is a ProjectModeSnapshot. */
export const PROJECT_SNAPSHOT_TYPE = "mode-project-snapshot";

/** The injected block: a header naming the mode and its folder, then the body. */
export function projectModeBlock(id: string, dir: string, body: string): string {
	return `# Project minor mode: ${id}\nFolder: ${dir}\nEvery relative path in this mode is relative to that folder.\n\n${body.trim()}`;
}

/** What a snapshot's sha digests: everything the chat keeps of the mode but its folder path. */
export function snapshotShaInput(snapshot: Pick<ProjectModeSnapshot, "text" | "description" | "workers" | "tools" | "toolsHash">): string {
	return JSON.stringify(canonical({ text: snapshot.text, description: snapshot.description, workers: snapshot.workers, tools: snapshot.tools, toolsHash: snapshot.toolsHash }));
}

/** Thrown by parseModeFile: the message is the user-facing problem line. */
export class ModeFileError extends Error {}

const KEYS = new Set(["description", "workers", "tools"]);

/**
 * MODE.md, strictly. A `---` fence on line 1 and a closing `---` line; between them `key: value` lines, where
 * a line starting with whitespace continues the previous key's value (so `tools:` can span lines). Keys:
 * `description` (required, one line), `workers` (`yes`/`no`, default no), `tools` (a JSON array of
 * `{name, description, params?, command, timeoutS?}`). Any other key, a repeated key, an empty body or a bad
 * tool throws ModeFileError. There is deliberately no key that turns a mode on.
 */
export function parseModeFile(text: string): ProjectModeFile {
	const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split("\n").map((line) => line.replace(/\r$/, ""));
	if (lines[0]?.trimEnd() !== "---") throw new ModeFileError("MODE.md must start with a --- frontmatter line");
	const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (close < 0) throw new ModeFileError("MODE.md frontmatter has no closing --- line");
	const fields = new Map<string, string>();
	let last: string | undefined;
	for (const [i, line] of lines.slice(1, close).entries()) {
		if (line.trim() === "") continue;
		if (/^\s/.test(line)) {
			if (last === undefined) throw new ModeFileError(`MODE.md line ${i + 2}: indented line before any key`);
			fields.set(last, `${fields.get(last)}\n${line}`);
			continue;
		}
		const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) throw new ModeFileError(`MODE.md line ${i + 2}: expected "key: value"`);
		const key = m[1]!;
		if (!KEYS.has(key)) throw new ModeFileError(`MODE.md line ${i + 2}: unknown key "${key}" (keys: description, workers, tools)`);
		if (fields.has(key)) throw new ModeFileError(`MODE.md line ${i + 2}: "${key}" given twice`);
		fields.set(key, m[2]!.trim());
		last = key;
	}
	const description = unquote(fields.get("description") ?? "");
	if (description === "") throw new ModeFileError("MODE.md needs a description");
	if (description.includes("\n")) throw new ModeFileError("MODE.md description must be one line");
	const workersRaw = fields.get("workers");
	if (workersRaw !== undefined && workersRaw !== "yes" && workersRaw !== "no") throw new ModeFileError(`MODE.md workers must be yes or no, not "${workersRaw}"`);
	const tools = parseTools(fields.get("tools"));
	const body = lines.slice(close + 1).join("\n").trim();
	if (body === "") throw new ModeFileError("MODE.md has no instructions after the frontmatter");
	return { description, workers: workersRaw === "yes", tools, body };
}

function unquote(value: string): string {
	return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0] ? value.slice(1, -1) : value;
}

function parseTools(raw: string | undefined): ProjectModeTool[] {
	if (raw === undefined || raw.trim() === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new ModeFileError(`MODE.md tools is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(value)) throw new ModeFileError("MODE.md tools must be a JSON array");
	if (value.length > PROJECT_TOOLS_MAX) throw new ModeFileError(`MODE.md declares ${value.length} tools; at most ${PROJECT_TOOLS_MAX}`);
	const seen = new Set<string>();
	return value.map((tool, i) => {
		const where = `MODE.md tool ${i + 1}`;
		if (!isRecord(tool)) throw new ModeFileError(`${where} must be an object`);
		for (const key of Object.keys(tool)) if (!["name", "description", "params", "command", "timeoutS"].includes(key)) throw new ModeFileError(`${where}: unknown field "${key}"`);
		const { name, description, params, command, timeoutS } = tool;
		if (typeof name !== "string" || name.length > PROJECT_TOOL_NAME_MAX || !TOOL_NAME_RE.test(name)) throw new ModeFileError(`${where}: name must be lowercase letters, digits and single underscores, at most ${PROJECT_TOOL_NAME_MAX} characters`);
		if (seen.has(name)) throw new ModeFileError(`${where}: name "${name}" given twice`);
		seen.add(name);
		const label = `MODE.md tool "${name}"`;
		if (typeof description !== "string" || description.trim() === "") throw new ModeFileError(`${label} needs a description`);
		if (params !== undefined && (!isRecord(params) || params.type !== "object")) throw new ModeFileError(`${label}: params must be a JSON schema with "type": "object"`);
		if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string")) throw new ModeFileError(`${label}: command must be a non-empty array of strings`);
		const program = command[0] as string;
		if (!program.startsWith("./") && !/^[A-Za-z0-9._+-]+$/.test(program)) throw new ModeFileError(`${label}: command[0] must be a program name or a ./path in the mode folder`);
		// A tool runs only code from its own folder (covered by approval) or a program of the machine (a bare name):
		// any argument naming a path must be a `./` path inside the mode folder.
		for (const arg of command as string[]) if (arg.includes("/") && !isFolderPath(arg)) throw new ModeFileError(`${label}: "${arg}" must be a ./path inside the mode folder (a tool can't run files from elsewhere in the project)`);
		if (timeoutS !== undefined && (typeof timeoutS !== "number" || !Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > PROJECT_TOOL_TIMEOUT_MAX_S)) throw new ModeFileError(`${label}: timeoutS must be a whole number from 1 to ${PROJECT_TOOL_TIMEOUT_MAX_S}`);
		return {
			name,
			description: description.trim(),
			params: (params as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
			command: [...(command as string[])],
			timeoutS: (timeoutS as number | undefined) ?? PROJECT_TOOL_TIMEOUT_DEFAULT_S,
		};
	});
}

/** A `./…` argv element that stays in its folder: no empty, `.` or `..` segment after the leading `./`, no backslash. */
export function isFolderPath(arg: string): boolean {
	if (!arg.startsWith("./") || arg.includes("\\")) return false;
	const segments = arg.slice(2).split("/");
	return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The `./…` files a tool list names (sorted, deduped): each must exist in the mode folder. */
export function toolFiles(tools: readonly ProjectModeTool[]): string[] {
	return [...new Set(tools.flatMap((tool) => tool.command.filter((arg) => arg.startsWith("./"))))].sort();
}

/** Most files, and most bytes in all, a mode folder with tools may hold: past either it is broken. */
export const PROJECT_MODE_FILES_MAX = 1000;
export const PROJECT_MODE_BYTES_MAX = 50 * 1024 * 1024;

/**
 * The text toolsHash digests: the declared tools as canonical JSON, then EVERY file in the mode folder but its
 * top-level MODE.md (recursively, dotfiles too), as `./<path> <sha256 hex>` lines sorted by path. A program
 * sourcing a sibling, a script importing a helper, a reference file: any change to any of them asks for approval
 * again; MODE.md's own tool declarations are the first line, and its body is instructions (q2: never re-asks).
 * `folderShas` comes from project-discovery.ts folderFileShas. Both halves (discovery, the call-time check) hash
 * through here.
 */
export function toolsHashInput(tools: readonly ProjectModeTool[], folderShas: Readonly<Record<string, string>>): string {
	const declared = JSON.stringify(tools.map((tool) => canonical(tool)));
	return [declared, ...Object.keys(folderShas).sort().map((file) => `${file} ${folderShas[file]}`)].join("\n");
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `projectModes` from a mode entry or note details: well-formed refs only, first of each id kept. */
export function normalizeProjectModeRefs(value: unknown): ProjectModeRef[] {
	if (!Array.isArray(value)) return [];
	const out: ProjectModeRef[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isProjectModeId(item.id) || typeof item.sha !== "string" || !/^[0-9a-f]{64}$/.test(item.sha)) continue;
		if (!out.some((ref) => ref.id === item.id)) out.push({ id: item.id, sha: item.sha });
	}
	return out;
}

/** Checks a value is a ProjectModeSnapshot (as read back from a branch entry). */
export function isProjectModeSnapshot(value: unknown): value is ProjectModeSnapshot {
	if (!isRecord(value)) return false;
	return (
		value.v === 1 &&
		isProjectModeId(value.id) &&
		typeof value.dir === "string" &&
		typeof value.description === "string" &&
		typeof value.workers === "boolean" &&
		Array.isArray(value.tools) &&
		typeof value.text === "string" &&
		typeof value.sha === "string" &&
		typeof value.toolsHash === "string"
	);
}
