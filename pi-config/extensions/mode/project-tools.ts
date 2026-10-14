/**
 * Project mode tools: the one runner for the command-line tools a project minor mode declares in its
 * MODE.md (project-format.ts `ProjectModeTool`). No plugin code is loaded into the agent process: a
 * call spawns the declared program, hands it the arguments as JSON on stdin, and returns its stdout,
 * stderr and exit code.
 *
 * Node builtins and the format/discovery siblings only, no pi import (the harness registers the
 * definitions; Sova's server may import this file). The mode extension (index.ts) registers
 * `projectToolDefinitions` once per snapshot (never active by registration) and moves their names in
 * and out of the active set as the mode goes on and off; a `direct` tool outside the active set is
 * neither declared to the model nor callable from scripts. A Claude Code chat reaches them like any
 * registered tool: its bridge lists pi's active tools each turn and restarts its CLI child when that
 * set changes.
 *
 * The command (project-format.ts): argv[0] is a program on PATH (a bare name: the machine's own
 * program, which approval doesn't cover) or `./path` in the mode folder. Any element holding a `/`
 * must be a `./` mode-folder path, passed as its absolute path; the runner refuses any other (a
 * `scripts/x.js`, an absolute path, a `../`) and a `./` file whose real path leaves the folder (a
 * symlink out). What a call may run is approved as the whole mode folder (project-discovery.ts
 * `toolsHashOf`: the declared tools plus every file in the folder but MODE.md), so a helper a tool
 * sources or imports is covered as much as the program it names. The program runs in the
 * session's cwd, in its own process group, with SOVA_MODE_ID, SOVA_MODE_DIR, SOVA_PROJECT_ROOT and
 * SOVA_TOOL_NAME set.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { toolsHashOf } from "./project-discovery.ts";
import { isFolderPath, isProjectModeSnapshot, projectToolName, PROJECT_TOOL_TIMEOUT_DEFAULT_S, PROJECT_TOOL_TIMEOUT_MAX_S, type ProjectModeSnapshot, type ProjectModeTool } from "./project-format.ts";

/** How much of each stream a call keeps; the rest is dropped and the result says so. */
export const PROJECT_TOOL_OUTPUT_MAX = 256 * 1024;
/** The cap on the arguments JSON a call hands the program. */
export const PROJECT_TOOL_ARGS_MAX = 1024 * 1024;
/** Kill grace: SIGTERM to the group first, SIGKILL this long after. */
export const PROJECT_TOOL_KILL_GRACE_MS = 2000;

/** The argv a tool's command runs, with every `./` element made absolute; or why it can't run. */
export function resolveCommand(dir: string, command: readonly string[]): { argv: string[] } | { error: string } {
	if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))) {
		return { error: "its command is not a non-empty list of strings" };
	}
	const root = resolve(dir);
	let realRoot = root;
	try {
		realRoot = realpathSync(root);
	} catch {
		// The folder is gone: the `./` files below fail to resolve, and the spawn reports it.
	}
	const argv: string[] = [];
	for (const [i, part] of command.entries()) {
		if (!part.startsWith("./")) {
			if (part.includes("/")) return { error: i === 0 ? `"${part}" must be a program name or a ./path in the mode folder` : `"${part}" holds a / but is not a ./path in the mode folder` };
			argv.push(part);
			continue;
		}
		if (!isFolderPath(part)) return { error: `"${part}" must stay inside the mode folder` };
		const abs = join(root, part.slice(2));
		let real: string | undefined;
		try {
			real = realpathSync(abs);
		} catch {
			real = undefined; // Missing: the hash check or the spawn says so.
		}
		if (real !== undefined && !inside(real, realRoot)) return { error: `"${part}" links outside the mode folder` };
		argv.push(abs);
	}
	return { argv };
}

function inside(child: string, root: string): boolean {
	const rel = relative(root, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface ProjectToolRun {
	/** The program's exit code; null when it was killed or never started. */
	exitCode: number | null;
	/** The signal that ended it, when one did. */
	signal: string | null;
	stdout: string;
	stderr: string;
	/** It ran past its time limit and its process group was killed. */
	timedOut: boolean;
	/** The call was aborted (the turn stopped) and its process group killed. */
	aborted: boolean;
	/** Which streams went past the output cap and were cut. */
	truncated: { stdout: boolean; stderr: boolean };
	/** Why it never started (a missing or non-executable program, a bad command). */
	spawnError?: string;
	durationMs: number;
}

export interface RunProjectToolOptions {
	/** The mode folder (the snapshot's `dir`). */
	dir: string;
	modeId: string;
	/** The checkout the mode comes from (handed to the program as SOVA_PROJECT_ROOT). */
	projectRoot: string;
	/** The session's cwd: the program runs there. */
	cwd: string;
	tool: ProjectModeTool;
	args: unknown;
	/** Overrides the tool's `timeoutS` (tests). */
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

/** A tool's time limit in ms: its declared `timeoutS`, clamped to 1–600 s. */
export function toolTimeoutMs(tool: Pick<ProjectModeTool, "timeoutS">): number {
	const s = typeof tool.timeoutS === "number" && Number.isFinite(tool.timeoutS) ? tool.timeoutS : PROJECT_TOOL_TIMEOUT_DEFAULT_S;
	return Math.min(Math.max(1, s), PROJECT_TOOL_TIMEOUT_MAX_S) * 1000;
}

/**
 * Run one tool call: spawn the declared program (no shell) in its own process group with the
 * session's cwd, write the arguments as JSON to its stdin, and collect stdout and stderr up to the
 * cap each. Past the time limit, or on abort, the whole group gets SIGTERM, then SIGKILL. Never
 * rejects: a program that can't start resolves with `spawnError`.
 */
export function runProjectTool(opts: RunProjectToolOptions): Promise<ProjectToolRun> {
	const started = Date.now();
	const cap = Math.max(1, opts.maxOutputBytes ?? PROJECT_TOOL_OUTPUT_MAX);
	const timeoutMs = Math.max(1, opts.timeoutMs ?? toolTimeoutMs(opts.tool));
	const base = (over: Partial<ProjectToolRun>): ProjectToolRun => ({
		exitCode: null,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		aborted: false,
		truncated: { stdout: false, stderr: false },
		durationMs: Date.now() - started,
		...over,
	});
	const resolved = resolveCommand(opts.dir, opts.tool.command);
	if ("error" in resolved) return Promise.resolve(base({ spawnError: resolved.error }));
	let input: string;
	try {
		input = JSON.stringify(opts.args ?? {});
	} catch {
		return Promise.resolve(base({ spawnError: "the arguments are not plain JSON" }));
	}
	if (Buffer.byteLength(input) > PROJECT_TOOL_ARGS_MAX) return Promise.resolve(base({ spawnError: `the arguments are larger than ${PROJECT_TOOL_ARGS_MAX} bytes` }));
	if (opts.signal?.aborted) return Promise.resolve(base({ aborted: true }));

	return new Promise<ProjectToolRun>((done) => {
		const [program, ...rest] = resolved.argv as [string, ...string[]];
		const env = {
			...(opts.env ?? process.env),
			SOVA_MODE_ID: opts.modeId,
			SOVA_MODE_DIR: resolve(opts.dir),
			SOVA_PROJECT_ROOT: opts.projectRoot,
			SOVA_TOOL_NAME: opts.tool.name,
		};
		const detached = process.platform !== "win32";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(program, rest, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached, windowsHide: true });
		} catch (error) {
			done(base({ spawnError: spawnMessage(program, error) }));
			return;
		}
		lowerPriority(child.pid);
		const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
		const size = { stdout: 0, stderr: 0 };
		const truncated = { stdout: false, stderr: false };
		const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
			const room = cap - size[stream];
			if (room <= 0) {
				truncated[stream] = true;
				return;
			}
			const keep = chunk.length > room ? chunk.subarray(0, room) : chunk;
			if (keep.length < chunk.length) truncated[stream] = true;
			chunks[stream].push(keep);
			size[stream] += keep.length;
		};
		child.stdout?.on("data", collect("stdout"));
		child.stderr?.on("data", collect("stderr"));
		child.stdin?.on("error", () => {}); // A program that never reads stdin closes it: EPIPE is fine.
		child.stdin?.end(input);

		let timedOut = false;
		let aborted = false;
		let spawnError: string | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const kill = () => {
			killGroup(child, detached, "SIGTERM");
			if (!killTimer) {
				killTimer = setTimeout(() => killGroup(child, detached, "SIGKILL"), PROJECT_TOOL_KILL_GRACE_MS);
				killTimer.unref?.();
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			spawnError = spawnMessage(program, error);
		});
		child.on("close", (code, sig) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			// The group may hold children that outlived the program; they go with it.
			if (detached && child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// No group left.
				}
			}
			opts.signal?.removeEventListener("abort", onAbort);
			done(
				base({
					exitCode: code,
					signal: sig,
					stdout: Buffer.concat(chunks.stdout).toString("utf8"),
					stderr: Buffer.concat(chunks.stderr).toString("utf8"),
					timedOut,
					aborted,
					truncated,
					...(spawnError ? { spawnError } : {}),
				}),
			);
		});
	});
}

function spawnMessage(program: string, error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return `program not found: ${program}`;
	if (code === "EACCES") return `program is not executable: ${program} (chmod +x it)`;
	return `could not start ${program}: ${error instanceof Error ? error.message : String(error)}`;
}

function killGroup(child: ReturnType<typeof spawn>, group: boolean, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		if (group) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// Gone already.
	}
}

/** A hosting server lowers its tool commands' priority (§app.load-priority/workers); in the TUI, nothing. */
function lowerPriority(pid: number | undefined): void {
	if (pid === undefined) return;
	const lower = (globalThis as Record<symbol, unknown>)[Symbol.for("sova:lower-worker")];
	try {
		if (typeof lower === "function") lower(pid);
	} catch {
		// Best-effort.
	}
}

/** The model-facing text of a finished call: how it ended, then each stream, cut marks included. */
export function formatToolRun(run: ProjectToolRun, timeoutMs: number, cap = PROJECT_TOOL_OUTPUT_MAX): string {
	if (run.spawnError) return `The tool did not run: ${run.spawnError}.`;
	const lines: string[] = [];
	if (run.aborted) lines.push("Stopped: the call was aborted.");
	else if (run.timedOut) lines.push(`Stopped: the program ran past its ${Math.round(timeoutMs / 1000)} s limit.`);
	else if (run.exitCode !== null) lines.push(`Exit code ${run.exitCode}.`);
	else if (run.signal) lines.push(`Ended by signal ${run.signal}.`);
	const cut = (stream: "stdout" | "stderr") => (run.truncated[stream] ? `\n[${stream} cut at ${Math.round(cap / 1024)} KB]` : "");
	if (run.stdout) lines.push(`stdout:\n${run.stdout}${cut("stdout")}`);
	if (run.stderr) lines.push(`stderr:\n${run.stderr}${cut("stderr")}`);
	if (!run.stdout && !run.stderr) lines.push("(no output)");
	return lines.join("\n\n");
}

/** What a call's `details` hold. */
export interface ProjectToolDetails {
	mode: string;
	tool: string;
	exitCode: number | null;
	signal: string | null;
	truncated: { stdout: boolean; stderr: boolean };
	durationMs: number;
}

/** What the extension hands `projectToolDefinitions` besides the snapshot. */
export interface ProjectToolOptions {
	/** The session's cwd now: the program runs there. */
	cwd(): string;
	/** Whether the session's sandbox is on now: project tools run outside it, so they refuse. */
	sandboxOn(): boolean;
	/** Whether the mode is on in this chat now (default: always). An off mode's tools refuse even if still active. */
	isOn?(modeId: string): boolean;
	/** Test overrides of the tool's limits. */
	timeoutMs?: number;
	maxOutputBytes?: number;
}

/** The text of a call refused because the mode's tools or any file in its folder (MODE.md aside) changed since approval (t18). */
export function changedText(toolName: string, modeId: string): string {
	return `${toolName} wasn't run: the files of ${modeId} changed since it was approved. Ask the user to approve ${modeId} again in the mode menu.`;
}

/** The text of a call refused while the session's sandbox is on. */
export function sandboxText(toolName: string, modeId: string): string {
	return `${toolName} wasn't run: project mode tools don't run while the sandbox is on. Ask the user to turn the sandbox off to use ${modeId}'s tools.`;
}

/** The checkout a mode folder belongs to: `<root>/.sova/minor-modes/<id>` minus three segments. */
export function projectRootOfModeDir(dir: string): string {
	return resolve(dir, "..", "..", "..");
}

/**
 * Why a call of one of this mode's tools must not run now, or undefined. In order: the mode is off;
 * the sandbox is on; the declared tools and the mode folder's files on disk (every one but MODE.md)
 * no longer hash to the snapshot's `toolsHash`, which is what was approved when the chat turned the
 * mode on (t18). A reference file's edit refuses too: the whole folder is what was approved.
 */
export function refuseCall(snapshot: Pick<ProjectModeSnapshot, "id" | "dir" | "tools" | "toolsHash">, toolName: string, opts: Pick<ProjectToolOptions, "sandboxOn" | "isOn">): string | undefined {
	if (opts.isOn && !opts.isOn(snapshot.id)) return `${toolName} wasn't run: project mode ${snapshot.id} is off.`;
	if (opts.sandboxOn()) return sandboxText(toolName, snapshot.id);
	if (toolsHashOf(snapshot.dir, snapshot.tools) !== snapshot.toolsHash) return changedText(toolName, snapshot.id);
	return undefined;
}

/**
 * The tool definitions of one active mode's snapshot, plain objects the extension passes to
 * `pi.registerTool`, named `projectToolName(mode, tool)` and registered with `defaultActive: false`
 * (registering never puts a tool in the loadout; the extension adds and removes names itself).
 * Re-registering a name replaces its definition, so a new snapshot of the mode takes over the name.
 * Each execute checks `refuseCall` first, then runs the program. A refusal, a program that never
 * started, a timeout or an abort throws (a failed tool result); a program that ran returns its output
 * whatever its exit code, the code stated first.
 */
export function projectToolDefinitions(snapshot: Pick<ProjectModeSnapshot, "id" | "dir" | "tools" | "toolsHash">, opts: ProjectToolOptions) {
	const projectRoot = projectRootOfModeDir(snapshot.dir);
	return snapshot.tools.map((tool) => {
		const name = projectToolName(snapshot.id, tool.name);
		return {
			name,
			label: `${snapshot.id}: ${tool.name}`,
			description: `${tool.description}\n\n(A tool of the project mode ${snapshot.id}.)`,
			// A plain JSON schema: pi checks the arguments against it (its non-TypeBox path).
			parameters: tool.params as never,
			defaultActive: false,
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; details: ProjectToolDetails }> {
				const refusal = refuseCall(snapshot, name, opts);
				if (refusal) throw new Error(refusal);
				const timeoutMs = opts.timeoutMs ?? toolTimeoutMs(tool);
				const cap = opts.maxOutputBytes ?? PROJECT_TOOL_OUTPUT_MAX;
				const run = await runProjectTool({ dir: snapshot.dir, modeId: snapshot.id, projectRoot, cwd: opts.cwd(), tool, args: params, timeoutMs, maxOutputBytes: cap, signal });
				const text = formatToolRun(run, timeoutMs, cap);
				if (run.spawnError || run.timedOut || run.aborted) throw new Error(text);
				return {
					content: [{ type: "text", text }],
					details: { mode: snapshot.id, tool: tool.name, exitCode: run.exitCode, signal: run.signal, truncated: run.truncated, durationMs: run.durationMs },
				};
			},
		};
	});
}

/**
 * A tool withdrawn: pi can't unregister a tool, so turning a mode off removes its tools from the
 * active set and re-registers each under the same name hidden (unreachable by the model and by
 * scripts), with an execute that refuses.
 */
export function withdrawnDefinition(name: string) {
	return {
		name,
		label: name,
		description: "Unavailable: its project mode is off.",
		parameters: { type: "object", properties: {} } as never,
		exposure: "hidden" as const,
		async execute(): Promise<never> {
			throw new Error("This project mode tool is unavailable: its mode is off.");
		},
	};
}

/** Names the file a worker reads its project modes' copies from (project-tools-worker.ts). */
export const PROJECT_TOOLS_FILE_ENV = "SOVA_PROJECT_TOOLS_FILE";
/** Where `writeWorkerToolsFile` keeps the hand-off files, under the agent dir. */
export const WORKER_TOOLS_DIR = ["sova", "project-tools"] as const;

/**
 * Hand a worker the copies of the parent's project modes that have tools: one file per distinct set,
 * named by the sha256 of its content under `<agentDir>/sova/project-tools/` (written once, atomically,
 * 0600; a resumed worker still finds it). Returns its path for PROJECT_TOOLS_FILE_ENV, or undefined
 * when no copy has tools (the worker then loads nothing).
 */
export function writeWorkerToolsFile(agentDir: string, copies: readonly ProjectModeSnapshot[]): string | undefined {
	const withTools = copies.filter((copy) => copy.tools.length > 0);
	if (withTools.length === 0) return undefined;
	const body = `${JSON.stringify({ v: 1, modes: withTools })}\n`;
	const dir = join(agentDir, ...WORKER_TOOLS_DIR);
	const file = join(dir, `${createHash("sha256").update(body).digest("hex")}.json`);
	try {
		if (readFileSync(file, "utf8") === body) return file;
	} catch {
		// Not written yet.
	}
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, body, { mode: 0o600 });
	renameSync(tmp, file);
	return file;
}

/** The copies a hand-off file holds: well-formed ones with tools only; none for a missing or damaged file. */
export function readWorkerToolsFile(file: string): ProjectModeSnapshot[] {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; modes?: unknown };
		if (data?.v !== 1 || !Array.isArray(data.modes)) return [];
		return data.modes.filter((copy): copy is ProjectModeSnapshot => isProjectModeSnapshot(copy) && copy.tools.length > 0);
	} catch {
		return [];
	}
}
