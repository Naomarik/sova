/**
 * The seven tool definitions the sandbox registers: `stockDefinitions` (pi's own factories with the
 * SDK's options, for OFF after ON) and `confinedDefinitions` (ON).
 *
 * Confined tools are the stock definitions with different operations underneath, so the name,
 * label, description, parameters, prompt snippet and guidelines are pi's own, byte for byte: the
 * model sees no difference, and a toggle changes neither the tool list nor the system prompt
 * (BRIEF F1). The sandbox shows only in tool results.
 *
 * - bash: the command runs through `Backend.confine` (bwrap on Linux) with the scrubbed env.
 * - read/write/edit/ls: pi's operations hooks, each path canonicalised and checked against the
 *   policy before the real fs call; writes open the checked canonical path with O_NOFOLLOW.
 * - find/grep: pi spawns fd/rg itself (no hook), so the search root is checked and resolved up
 *   front, and output lines under hidden paths are dropped.
 *
 * Every execute takes one snapshot of the sandbox (`deps.snapshot()`) at its start, so a flip
 * reaches the next call and never a running one. A failed snapshot refuses: nothing runs.
 */
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	type EditOperations,
	getShellConfig,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type Backend, checkWrite, classifyRun, DENIAL_NOTE, type Policy } from "./backend.ts";
import { canonicalize, hiddenBelow, isWithin, readDenial, type ResolvedPolicy, writeDenial } from "./policy.ts";

export const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

// biome-ignore lint/suspicious/noExplicitAny: the seven definitions have different schemas.
export type AnyToolDefinition = ToolDefinition<any, any, any>;

/** The options pi's SDK builds its built-ins with (`agent-session.js` `_buildRuntime`). */
export interface StockOptions {
	autoResizeImages?: boolean;
	commandPrefix?: string;
	shellPath?: string;
}

/**
 * pi's own built-ins, from the same factories and options the SDK uses (`createAllToolDefinitions`
 * builds this object name by name). Registered for OFF after ON, since pi cannot unregister.
 */
export function stockDefinitions(cwd: string, opts: StockOptions): AnyToolDefinition[] {
	return [
		createReadToolDefinition(cwd, { autoResizeImages: opts.autoResizeImages }),
		createBashToolDefinition(cwd, { commandPrefix: opts.commandPrefix, shellPath: opts.shellPath }),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
}

/** Everything one tool call runs under. Taken once at the start of each execute. */
export type Snapshot =
	| { ok: true; policy: ResolvedPolicy; backendPolicy: Policy; backend: Backend; enforcement: "full" | "partial"; reasons?: string[] }
	/** `message`, when set, is the whole tool error; otherwise the unavailable copy wraps `reason`. */
	| { ok: false; reason: string; message?: string };

export interface ConfineDeps {
	snapshot(): Promise<Snapshot>;
}

/** The copy-deck refusal when the sandbox cannot enforce: the tool errors and nothing runs. */
export function unavailableMessage(reason: string): string {
	return `Sandbox unavailable: ${reason}. Nothing ran. Turn the sandbox off to run tools unconfined.`;
}

/** A refused path: an ordinary tool failure the model reads, naming the sandbox. */
export class SandboxDenial extends Error {
	constructor(why: string) {
		super(`${why}. ${DENIAL_NOTE}`);
		this.name = "SandboxDenial";
	}
}

async function take(deps: ConfineDeps): Promise<Extract<Snapshot, { ok: true }>> {
	let s: Snapshot;
	try {
		s = await deps.snapshot();
	} catch (e) {
		s = { ok: false, reason: (e as Error).message };
	}
	if (!s.ok) throw new Error(s.message ?? unavailableMessage(s.reason));
	return s;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi's `resolveToCwd` (not exported): unicode spaces, a leading `@`, `~`, `file://`, then resolve. */
export function resolveLikePi(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * bash sees the session tmp as /tmp, so the file tools do too: a path under /tmp maps into the
 * session tmp, unless a writable root is bound over it there (a workspace under /tmp stays where it
 * is, as it does inside bwrap). For reads a host /tmp path the session tmp lacks stays as it is
 * (pi's own truncated-output files live there).
 */
export function mapTmp(abs: string, policy: Pick<ResolvedPolicy, "tmpDir" | "writable">, mode: "read" | "write"): string {
	if (process.platform !== "linux") return abs;
	if (abs !== "/tmp" && !abs.startsWith("/tmp/")) return abs;
	if (isWithin(abs, policy.tmpDir) || policy.writable.some((w) => w !== policy.tmpDir && isWithin(abs, w))) return abs;
	const mapped = join(policy.tmpDir, abs.slice("/tmp".length));
	if (mode === "write" || existsSync(mapped)) return mapped;
	return abs;
}

/**
 * Where the sandbox's view of `abs` really lives, canonical: /tmp mapped (mapTmp), then a shadowed
 * path (a host cache) to its private source, as the OS backend mounts it. `view` is the canonical
 * path as the sandbox names it, `real` the host path the file tool touches.
 */
export function sandboxView(abs: string, policy: Pick<ResolvedPolicy, "tmpDir" | "writable" | "shadowed">, mode: "read" | "write"): { view: string; real: string } {
	const view = canonicalize(mapTmp(abs, policy, mode));
	const sh = policy.shadowed.filter((s) => isWithin(view, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
	// A real writable root inside the shadowed path (a workspace under ~/.cache) is bound over the shadow: it stays real.
	if (!sh || policy.writable.some((w) => isWithin(view, w) && w.length > sh.path.length)) return { view, real: view };
	return { view, real: canonicalize(join(sh.source, relative(sh.path, view))) };
}

/** The real canonical path a read may use, or a thrown denial. */
function checkedRead(policy: ResolvedPolicy, abs: string): string {
	const { view, real } = sandboxView(abs, policy, "read");
	const why = readDenial(policy, view) ?? readDenial(policy, real);
	if (why) throw new SandboxDenial(why);
	return real;
}

/** The real canonical path a write may use, or a thrown denial: this policy's verdict and the backend's. */
function checkedWrite(s: Extract<Snapshot, { ok: true }>, abs: string): string {
	const { view, real } = sandboxView(abs, s.policy, "write");
	const why = writeDenial(s.policy, real, { creating: !existsSync(real) });
	if (why) throw new SandboxDenial(why);
	// The OS backend's own rules (git paths of worktrees, deeper roots) judge the path as the sandbox names it.
	const b = checkWrite(s.backendPolicy, view);
	if (!b.ok) throw new SandboxDenial(b.reason);
	return real;
}

/** Write through the checked canonical path; O_NOFOLLOW so a link swapped in after the check is not followed. */
async function writeNoFollow(path: string, content: string): Promise<void> {
	const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
	try {
		await fh.writeFile(content, "utf-8");
	} finally {
		await fh.close();
	}
}

function readOps(deps: ConfineDeps): ReadOperations {
	return {
		access: async (p) => access(checkedRead((await take(deps)).policy, p), constants.R_OK),
		readFile: async (p) => readFile(checkedRead((await take(deps)).policy, p)),
		detectImageMimeType: async (p) => detectSupportedImageMimeTypeFromFile(checkedRead((await take(deps)).policy, p)),
	};
}

function writeOps(deps: ConfineDeps): WriteOperations {
	return {
		mkdir: async (dir) => {
			const s = await take(deps);
			if (existsSync(sandboxView(dir, s.policy, "write").real)) return; // nothing is created; the file itself is checked next
			await mkdir(checkedWrite(s, dir), { recursive: true });
		},
		writeFile: async (p, content) => writeNoFollow(checkedWrite(await take(deps), p), content),
	};
}

function editOps(deps: ConfineDeps): EditOperations {
	return {
		access: async (p) => {
			const s = await take(deps);
			checkedRead(s.policy, p);
			await access(checkedWrite(s, p), constants.R_OK | constants.W_OK);
		},
		readFile: async (p) => readFile(checkedRead((await take(deps)).policy, p)),
		writeFile: async (p, content) => writeNoFollow(checkedWrite(await take(deps), p), content),
	};
}

function lsOps(policy: ResolvedPolicy): LsOperations {
	return {
		exists: (p) => existsSync(checkedRead(policy, p)),
		stat: (p) => stat(checkedRead(policy, p)),
		readdir: async (p) => {
			const dir = checkedRead(policy, p);
			const names = await readdir(dir);
			return names.filter((n) => !readDenial(policy, canonicalize(join(dir, n))));
		},
	};
}

/**
 * Drop output lines of find/grep that name a path under a hidden one. Lines are `rel`, `rel/`,
 * `rel:N: text` or `rel-N- text`, relative to the search root.
 */
export function filterHidden(text: string, root: string, hidden: string[]): { text: string; dropped: number } {
	const rels = hidden.map((h) => relative(root, h).split("\\").join("/")).filter((r) => r && !r.startsWith(".."));
	if (!rels.length) return { text, dropped: 0 };
	let dropped = 0;
	const lines = text.split("\n").filter((line) => {
		const hit = rels.some((r) => line === r || line.startsWith(`${r}/`) || line.startsWith(`${r}:`) || new RegExp(`^${escapeRe(r)}-\\d+- `).test(line));
		if (hit) dropped++;
		return !hit;
	});
	return { text: lines.join("\n"), dropped };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** find/grep: check and pin the search root, run pi's own tool on it, filter hidden paths out. */
function searchTool(def: AnyToolDefinition, cwd: string, deps: ConfineDeps): AnyToolDefinition {
	return {
		...def,
		execute: async (id, params: { path?: string }, signal, onUpdate, ctx) => {
			const { policy } = await take(deps);
			const abs = resolveLikePi(params.path || ".", ctx?.cwd || cwd);
			const { view, real } = sandboxView(abs, policy, "read");
			const why = readDenial(policy, view) ?? readDenial(policy, real);
			if (why) throw new SandboxDenial(why);
			// Search the real location (a shadow's source); lines stay relative to it.
			const mapped = real === view ? mapTmp(abs, policy, "read") : real;
			const root = real;
			// An absolute path resolves to itself in pi, so the tool searches exactly what was checked.
			const result = await def.execute(id, { ...params, path: mapped }, signal, onUpdate, ctx);
			const hidden = hiddenBelow(policy, root);
			if (!hidden.length) return result;
			let dropped = 0;
			const content = (result.content ?? []).map((c) => {
				if (c.type !== "text") return c;
				// Lines are relative to the root as pi spelled it; rg and fd follow no links, so the
				// relative spelling below the canonical root is the same.
				const f = filterHidden(c.text, root, hidden);
				dropped += f.dropped;
				return { ...c, text: f.text };
			});
			if (dropped > 0) content.push({ type: "text", text: `\n[sandbox: ${dropped} result line(s) under hidden paths were omitted]` });
			return { ...result, content };
		},
	};
}

/** Run a confined argv like pi's local shell runs its own: streamed, process-group kill on abort/timeout. */
function runConfined(argv: string[], env: Record<string, string>, cwd: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }, tail: { text: string }): Promise<number | null> {
	return new Promise((resolveRun, reject) => {
		if (o.signal?.aborted) return reject(new Error("aborted"));
		const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const onAbort = () => kill();
		o.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = o.timeout && o.timeout > 0 ? setTimeout(() => ((timedOut = true), kill()), o.timeout * 1000) : undefined;
		const onData = (d: Buffer) => {
			tail.text = (tail.text + d.toString("utf8")).slice(-65536);
			o.onData(d);
		};
		child.stdout!.on("data", onData);
		child.stderr!.on("data", onData);
		const done = () => {
			if (timer) clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", (err) => {
			done();
			reject(new Error(`sandbox runner failed, the command did not run: ${err.message}`));
		});
		child.on("close", (code, sig) => {
			done();
			if (o.signal?.aborted) return reject(new Error("aborted"));
			if (timedOut) return reject(new Error(`timeout:${o.timeout}`));
			resolveRun(code ?? (sig ? 128 + 9 : 1));
		});
	});
}

/** What pi's bash sets per call (`bash.js` resolveSpawnContext), plus its PATH. Nothing else crosses. */
const PER_CALL_ENV = new Set(["PATH", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]);

function bashOps(deps: ConfineDeps, shellPath: string | undefined): BashOperations {
	return {
		exec: async (command, cwd, o) => {
			const s = await take(deps);
			const shell = getShellConfig(shellPath);
			if (shell.commandTransport === "stdin") throw new Error(unavailableMessage("this shell takes its command on stdin, which the sandbox does not support"));
			// pi's per-call env: its PATH (with the managed bin dir for rg/fd) and the session variables it sets.
			const perCall: Record<string, string> = {};
			for (const [k, v] of Object.entries(o.env ?? {})) if (v !== undefined && PER_CALL_ENV.has(k)) perCall[k] = v;
			const res = await s.backend.confine({ argv: [shell.shell, ...shell.args, command], cwd, policy: s.backendPolicy, env: perCall });
			if (!res.ok) throw new Error(unavailableMessage(res.reason));
			const c = res.confined;
			const tail = { text: "" };
			try {
				const exitCode = await runConfined(c.argv, c.env, cwd, o, tail);
				const k = classifyRun(c, { exitCode, output: tail.text });
				if (k.kind === "runner-failure") throw new Error(k.message);
				if (k.kind === "denied") o.onData(Buffer.from(`\n${k.note}\n`));
				return { exitCode };
			} finally {
				await c.cleanup?.().catch(() => {});
			}
		},
	};
}

/**
 * The confined seven. Built from pi's factories, so every model-visible field is the stock one;
 * only `execute` (through operations, or a thin wrapper for find/grep) differs.
 */
export function confinedDefinitions(cwd: string, opts: StockOptions, deps: ConfineDeps): AnyToolDefinition[] {
	const ls = createLsToolDefinition(cwd);
	return [
		createReadToolDefinition(cwd, { autoResizeImages: opts.autoResizeImages, operations: readOps(deps) }),
		createBashToolDefinition(cwd, { commandPrefix: opts.commandPrefix, shellPath: opts.shellPath, operations: bashOps(deps, opts.shellPath) }),
		createEditToolDefinition(cwd, { operations: editOps(deps) }),
		createWriteToolDefinition(cwd, { operations: writeOps(deps) }),
		searchTool(createGrepToolDefinition(cwd), cwd, deps),
		searchTool(createFindToolDefinition(cwd), cwd, deps),
		{
			...ls,
			// ls wants synchronous-capable ops bound to one policy, so build them per call.
			execute: async (...args: Parameters<typeof ls.execute>) => {
				const { policy } = await take(deps);
				return createLsToolDefinition(cwd, { operations: lsOps(policy) }).execute(...args);
			},
		},
	] as AnyToolDefinition[];
}

/** Claude Code rule spelling of an absolute path: `//abs` (PROBE.md). */
const rulePath = (abs: string) => `/${abs}`;
/** A rule for a path that may be a file or a directory: both spellings. */
const rules = (tool: "Read" | "Edit", paths: readonly string[]) => paths.flatMap((p) => [`${tool}(${rulePath(p)})`, `${tool}(${rulePath(p)}/**)`]);

/**
 * The Claude Code CLI's own settings for a worker under this policy (PROBE.md, F4 decided). Bash
 * runs in the CLI's OS sandbox; Read/Write/Edit are held by permission rules, which bind only
 * under `--permission-mode dontAsk` (never bypassPermissions: it skips them), so the state event
 * carries `claudePermissionMode`. Only `Edit(...)` rules are matched for file tools (`Write(...)`
 * is ignored by the CLI), and `//abs` is an absolute path. Opaque to subagents and the transport.
 */
export function claudeSettingsFor(policy: ResolvedPolicy): string {
	// The resolved policy already holds the git paths of every writable root (resolvePolicy `git`).
	const writable = policy.level === "read-only" ? [] : policy.writable;
	const protectedPaths = [...new Set([...policy.readOnlyWithinWritable, ...policy.hidden])];
	const permissions =
		policy.level === "read-only"
			? { allow: ["Read"], deny: ["Edit(//**)", ...rules("Read", policy.hidden)] }
			: {
					allow: ["Read", ...writable.map((w) => `Edit(${rulePath(w)}/**)`)],
					deny: [...rules("Read", policy.hidden), ...rules("Edit", protectedPaths)],
				};
	return JSON.stringify({
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			excludedCommands: [],
			network: { allowUnixSockets: [], allowLocalBinding: false, allowedDomains: policy.proxyAllow },
			filesystem: { allowWrite: writable, denyRead: policy.hidden, denyWrite: protectedPaths },
		},
		permissions,
	});
}
