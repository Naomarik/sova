/**
 * How a pi worker is started: which binary, with which leading arguments. Builtins only.
 *
 * Resolved ONCE per process, from the host's own code and environment, never from a worker's cwd.
 * A bare `pi` spawned in the worker's cwd went through PATH, where a mise shim picks the node
 * version per directory: in a project whose mise config selected another node (one without pi
 * installed) the shim exited 1 before pi ever ran ("No version is set for shim: pi").
 *
 * Order:
 *   1. `SOVA_PI_CLI`: an explicit pi entry. A script (.js/.mjs/.cjs/.ts) runs on the runtime below;
 *      anything else is executed as it is.
 *   2. This process IS pi (argv[1] belongs to pi's package): re-run that script on this runtime.
 *   3. This process is not a generic runtime (a compiled pi binary): re-run it.
 *   4. pi's package as the host's own code resolves it (node_modules walking up from this file, then
 *      from argv[1]): its `bin.pi` script, run on Bun.
 *   5. Last resort: `pi` looked up once on the host's PATH (a mise shim resolved from the host's cwd).
 *
 * The runtime for a script is Bun: this process when it is Bun, else `$SOVA_BUN`, else `bun` on
 * PATH (a mise shim resolved once from the host's cwd); with no Bun, this process's own runtime.
 * On Bun the worker never reads its cwd's `bunfig.toml` or `.env` (node doesn't either): a
 * project's preload would otherwise run inside pi, and its `.env` would change pi's environment.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** pi's own package name: the package `process.argv[1]` must belong to before it may be re-invoked. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Names an explicit pi entry (a script run on Bun, or an executable). */
export const PI_CLI_ENV = "SOVA_PI_CLI";

export interface PiLaunch {
	command: string;
	/** Arguments before pi's own (runtime flags, the script). */
	prefix: string[];
	/** Which rule chose it. */
	via: "override" | "pi-host" | "pi-binary" | "package" | "path" | "bare";
}

/** Everything the resolver reads from the host, injectable for tests. */
export interface PiLaunchHost {
	env: NodeJS.ProcessEnv;
	execPath: string;
	/** `process.versions.bun`: set when this process is Bun. */
	bunVersion?: string;
	/** `process.argv[1]`. */
	currentScript?: string;
	/** The directory module resolution starts from (this file's own). */
	moduleDir: string;
	/** The host's cwd, where a mise shim is resolved. */
	cwd: string;
	/** `mise which <name>` run in `cwd` with `mise` the given binary; undefined when it fails. */
	miseWhich?: (mise: string, name: string, cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
}

const SCRIPT_EXT = /\.(c|m)?js$|\.ts$/i;

/** Flags that keep a Bun worker from reading its cwd's project files. */
export function bunGuardFlags(): string[] {
	return ["--no-env-file", `--config=${os.devNull}`, "--no-install"];
}

function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function realpath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
}

/** The first executable `name` on the env's PATH, absolute. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir || !path.isAbsolute(dir)) continue;
		for (const ext of exts) {
			const file = path.join(dir, name + ext);
			if (isExecutable(file)) return file;
		}
	}
	return undefined;
}

/** A mise shim is a link to the mise binary itself. */
function isMiseShim(file: string): boolean {
	return /^mise(\.exe)?$/i.test(path.basename(realpath(file)));
}

function defaultMiseWhich(mise: string, name: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		const out = execFileSync(mise, ["which", name], { cwd, env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out && path.isAbsolute(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

/** `name` on PATH as an absolute binary that does not depend on the cwd it is started in. */
function lookUp(name: string, host: PiLaunchHost): string | undefined {
	const found = whichOnPath(name, host.env);
	if (!found || !isMiseShim(found)) return found;
	const real = (host.miseWhich ?? defaultMiseWhich)(realpath(found), name, host.cwd, host.env);
	return real && isExecutable(real) ? real : undefined;
}

/**
 * The `name` of the package.json nearest to `script`, or null when it has none (and "" for an
 * unreadable or nameless one). Walks up from the script's own directory.
 */
export function owningPackageName(script: string): string | null {
	let dir = path.dirname(path.resolve(script));
	for (;;) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
			return typeof pkg.name === "string" ? pkg.name : "";
		} catch {
			// No package.json here (or unreadable/unparseable): keep walking up.
		}
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/** pi's `bin.pi` script as Node's resolution finds the package from `fromDir`, real path. */
export function findPiCli(fromDir: string): string | undefined {
	let dir = realpath(fromDir);
	for (;;) {
		const pkgDir = path.join(dir, "node_modules", ...PI_PACKAGE.split("/"));
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { name?: unknown; bin?: unknown };
			const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.pi;
			if (pkg.name === PI_PACKAGE && typeof bin === "string") {
				const cli = path.resolve(pkgDir, bin);
				if (fs.existsSync(cli)) return realpath(cli);
			}
		} catch {
			// Not here: keep walking up.
		}
		const up = path.dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

/** The runtime a pi script runs on, with its leading flags: Bun when there is one. */
function scriptRuntime(host: PiLaunchHost): { command: string; flags: string[] } {
	if (host.bunVersion) return { command: host.execPath, flags: bunGuardFlags() };
	const configured = host.env.SOVA_BUN;
	if (configured && isExecutable(configured)) return { command: path.resolve(configured), flags: bunGuardFlags() };
	const bun = lookUp("bun", host);
	if (bun) return { command: bun, flags: bunGuardFlags() };
	return { command: host.execPath, flags: [] };
}

function isGenericRuntime(execPath: string): boolean {
	return /^(node|bun)(\.exe)?$/.test(path.basename(execPath).toLowerCase());
}

export function resolvePiLaunch(host: PiLaunchHost): PiLaunch {
	const override = host.env[PI_CLI_ENV];
	if (override) {
		const entry = path.resolve(host.cwd, override);
		if (!SCRIPT_EXT.test(entry)) return { command: entry, prefix: [], via: "override" };
		const runtime = scriptRuntime(host);
		return { command: runtime.command, prefix: [...runtime.flags, entry], via: "override" };
	}
	const script = host.currentScript;
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script) && owningPackageName(script) === PI_PACKAGE) {
		return { command: host.execPath, prefix: [...(host.bunVersion ? bunGuardFlags() : []), script], via: "pi-host" };
	}
	if (!isGenericRuntime(host.execPath)) return { command: host.execPath, prefix: [], via: "pi-binary" };
	const cli = findPiCli(host.moduleDir) ?? (script ? findPiCli(path.dirname(path.resolve(host.cwd, script))) : undefined);
	if (cli) {
		const runtime = scriptRuntime(host);
		return { command: runtime.command, prefix: [...runtime.flags, cli], via: "package" };
	}
	const pi = lookUp("pi", host);
	return pi ? { command: pi, prefix: [], via: "path" } : { command: "pi", prefix: [], via: "bare" };
}

let cached: PiLaunch | undefined;

/** This process's pi launch, resolved on first use and kept. */
export function piLaunch(): PiLaunch {
	cached ??= resolvePiLaunch({
		env: process.env,
		execPath: process.execPath,
		bunVersion: process.versions.bun,
		currentScript: process.argv[1],
		moduleDir: path.dirname(fileURLToPath(import.meta.url)),
		cwd: process.cwd(),
	});
	return cached;
}

/** @internal Tests: forget the cached launch. */
export function resetPiLaunch(): void {
	cached = undefined;
}

/** How to start pi with `args`, the same from every worker cwd. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const launch = piLaunch();
	return { command: launch.command, args: [...launch.prefix, ...args] };
}
