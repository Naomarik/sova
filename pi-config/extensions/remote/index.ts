/**
 * remote — run a session's tools on a target from ~/.pi/agent/targets.json.
 *
 * Activation: the string flag `target` (`pi --target acme-prod`, or pi-web's per-runtime
 * `extensionFlagValues`). Without it this extension registers nothing and changes nothing.
 *
 * With it, bash (and `!` commands), read, write, edit, ls, find and grep are replaced by versions
 * that run through the target's argv (argv.ts: ssh / aws-ssm / via × docker / incus). grep is
 * re-implemented whole (GrepOperations can't run a search); the others use pi's operations hooks.
 * An unknown or invalid target fails closed: every tool errors instead of running locally.
 *
 * Paths: pi-web opens target sessions in a local placeholder,
 * <agentDir>/pi-web/targets/<name>/<remote/abs/path>, which maps back to /remote/abs/path. From any
 * other directory (the CLI case) the local cwd maps to the target's cwd (or the far login dir).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve as resolveLocal } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type ExtensionAPI,
	type FindOperations,
	formatSize,
	getAgentDir,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { buildTargetArgv, hangupGuard, parseTargetsFile, placeholderRoot, shPath, shQuote, type Target, targetsFilePath, toRemotePath } from "./argv.ts";
import { type RunOptions, type RunResult, runArgv } from "./exec.ts";

const FLAG = "target";
const PREFLIGHT_TIMEOUT_MS = 20_000;
/** A failed preflight is re-tried after this long; until then tools fail at once with the cached error. */
const RETRY_AFTER_MS = 15_000;
const OP_TIMEOUT_MS = 120_000;
const MARKER = "@@pi-remote@@";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

interface FarInfo {
	user: string;
	hostname: string;
	home: string;
	cwd: string;
}

/** One-line description of how a target is reached, for errors and the prompt. */
export function describeTarget(t: Target): string {
	const env = t.kind === "docker" && t.docker ? `docker ${t.docker.container}` : t.kind === "incus-cell" && t.incus ? `incus cell ${t.incus.cell}` : "";
	const hop = t.ssh ? `${t.ssh.user ? `${t.ssh.user}@` : ""}${t.ssh.host}${t.ssh.port && t.ssh.port !== 22 ? `:${t.ssh.port}` : ""}` : t.via ? `via ${t.via}` : "this machine";
	return env ? `${env} on ${hop}` : hop;
}

function loadTarget(name: string): { target?: Target; registry: Target[]; error?: string } {
	const file = targetsFilePath(getAgentDir());
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { registry: [], error: `no ${file}` };
	}
	try {
		const { targets, invalid } = parseTargetsFile(text);
		const target = targets.find((t) => t.name === name);
		if (target) return { target, registry: targets };
		const bad = invalid.find((i) => i.name === name);
		return { registry: targets, error: bad ? `entry "${name}" is invalid: ${bad.errors.join("; ")}` : `no target named "${name}" in ${file}` };
	} catch (e) {
		return { registry: [], error: `${file}: ${(e as Error).message}` };
	}
}

class Remote {
	readonly root: string;
	private info?: FarInfo;
	private pending?: Promise<FarInfo>;
	private failure?: { error: Error; at: number };

	constructor(
		readonly target: Target,
		readonly registry: Target[],
		readonly localCwd: string,
	) {
		this.root = placeholderRoot(getAgentDir(), target.name);
	}

	get label(): string {
		return this.target.label || this.target.name;
	}

	/** The far cwd known without a round trip (placeholder path, or the entry's cwd). */
	private staticFarCwd(): string | undefined {
		if (this.localCwd === this.root || this.localCwd.startsWith(this.root + "/")) return toRemotePath(this.localCwd, this.root);
		return this.target.cwd;
	}

	/** Local path (as pi resolved it) → far path. */
	toFar(p: string): string {
		if (p === this.root || p.startsWith(this.root + "/")) return toRemotePath(p, this.root);
		const farCwd = this.info?.cwd ?? this.staticFarCwd();
		if (farCwd && (p === this.localCwd || p.startsWith(this.localCwd + "/"))) return farCwd + p.slice(this.localCwd.length);
		const home = homedir();
		if (this.info && (p === home || p.startsWith(home + "/"))) return this.info.home + p.slice(home.length);
		return p;
	}

	argv(command: string, cwd?: string): string[] {
		return buildTargetArgv(this.target, { command, cwd: cwd ?? "", registry: this.registry });
	}

	private unreachable(r: RunResult | Error): Error {
		const why = r instanceof Error ? r.message : r.timedOut ? `no answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s` : r.stderr.trim() || `exit code ${r.exitCode}`;
		return new Error(`Target "${this.target.name}" (${describeTarget(this.target)}) is unreachable: ${why}`);
	}

	/** Bounded probe; resolves the far user/host/home/cwd. Concurrent callers share one probe. */
	preflight(): Promise<FarInfo> {
		if (this.info) return Promise.resolve(this.info);
		if (this.pending) return this.pending;
		const cwd = this.staticFarCwd();
		const command = `printf '%s\\n' ${shQuote(MARKER)}; id -un; hostname; printf '%s\\n' "$HOME"; pwd`;
		this.pending = runArgv(this.argv(command, cwd), { timeoutMs: PREFLIGHT_TIMEOUT_MS })
			.then(
				(r) => {
					const lines = r.stdout.toString("utf8").split("\n");
					const at = lines.lastIndexOf(MARKER);
					if (r.exitCode !== 0 || at < 0 || lines.length < at + 5) throw this.unreachable(r);
					this.info = { user: lines[at + 1]!, hostname: lines[at + 2]!, home: lines[at + 3]!, cwd: lines[at + 4]! };
					this.failure = undefined;
					return this.info;
				},
				(e: Error) => {
					throw this.unreachable(e);
				},
			)
			.catch((e: Error) => {
				this.failure = { error: e, at: Date.now() };
				throw e;
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	/** Ready or throw fast: a recent failure is rethrown without reconnecting. */
	async ready(signal?: AbortSignal): Promise<FarInfo> {
		if (this.info) return this.info;
		if (this.failure && Date.now() - this.failure.at < RETRY_AFTER_MS) throw this.failure.error;
		if (!signal) return this.preflight();
		return await new Promise<FarInfo>((resolve, reject) => {
			const onAbort = () => reject(new Error("aborted"));
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.preflight()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	/** A connection-level failure mid-session: drop the cached probe so the next call re-checks. */
	private noteFailure(r: RunResult) {
		if (r.exitCode === 255 && (this.target.ssh || this.target.via)) {
			this.info = undefined;
			this.failure = { error: this.unreachable(r), at: Date.now() };
		}
	}

	/** Run far shell code for a file operation; throws with the far stderr on failure. */
	async run(command: string, opts: RunOptions & { allowFail?: boolean } = {}): Promise<RunResult> {
		await this.ready(opts.signal);
		const r = await runArgv(this.argv(command), { timeoutMs: OP_TIMEOUT_MS, ...opts });
		if (r.aborted) throw new Error("Operation aborted");
		if (r.timedOut) throw new Error(`${this.label}: timed out after ${(opts.timeoutMs ?? OP_TIMEOUT_MS) / 1000}s`);
		this.noteFailure(r);
		if (r.exitCode === 255 && (this.target.ssh || this.target.via)) throw this.unreachable(r);
		if (r.exitCode !== 0 && !opts.allowFail) throw new Error(r.stderr.trim() || `${this.label}: exit code ${r.exitCode}`);
		return r;
	}

	bashOps(): BashOperations {
		return {
			exec: async (command, cwd, { onData, signal, timeout }) => {
				await this.ready(signal);
				const r = await runArgv(this.argv(hangupGuard(command), this.toFar(cwd)), {
					onData,
					signal,
					timeoutMs: timeout ? timeout * 1000 : undefined,
					holdStdin: true,
				});
				if (r.aborted) throw new Error("aborted");
				if (r.timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode: r.exitCode };
			},
		};
	}

	readOps(): ReadOperations {
		return {
			readFile: async (p) => (await this.run(`cat -- ${shPath(this.toFar(p))}`)).stdout,
			access: async (p) => {
				const far = this.toFar(p);
				const r = await this.run(`test -r ${shPath(far)}`, { allowFail: true });
				if (r.exitCode !== 0) throw new Error(`ENOENT: no such file or not readable on ${this.label}: ${far}`);
			},
			detectImageMimeType: async (p) => IMAGE_TYPES[posix.extname(p).toLowerCase()] ?? null,
		};
	}

	writeOps(): WriteOperations {
		return {
			writeFile: async (p, content) => void (await this.run(`cat > ${shPath(this.toFar(p))}`, { input: content })),
			mkdir: async (dir) => void (await this.run(`mkdir -p -- ${shPath(this.toFar(dir))}`)),
		};
	}

	editOps(): EditOperations {
		const r = this.readOps();
		return { readFile: r.readFile, access: r.access, writeFile: this.writeOps().writeFile };
	}

	/** ls: one listing per directory; the per-entry stats pi makes are served from it. */
	lsOps(): LsOperations {
		const kinds = new Map<string, "d" | "f">();
		const probe = async (p: string) => {
			if (!kinds.has(p)) {
				const q = shPath(this.toFar(p));
				const r = await this.run(`if [ -d ${q} ]; then echo d; elif [ -e ${q} ]; then echo f; else echo none; fi`);
				const k = r.stdout.toString().trim();
				if (k === "d" || k === "f") kinds.set(p, k);
			}
			return kinds.get(p);
		};
		return {
			exists: async (p) => (await probe(p)) !== undefined,
			stat: async (p) => {
				const k = await probe(p);
				if (!k) throw new Error(`ENOENT: ${this.toFar(p)}`);
				return { isDirectory: () => k === "d" };
			},
			readdir: async (p) => {
				const r = await this.run(
					`cd -- ${shPath(this.toFar(p))} || exit 1; for f in * .[!.]* ..?*; do if [ -d "$f" ]; then printf 'd%s\\0' "$f"; elif [ -e "$f" ] || [ -L "$f" ]; then printf 'f%s\\0' "$f"; fi; done`,
				);
				const names: string[] = [];
				for (const rec of r.stdout.toString("utf8").split("\0")) {
					if (!rec) continue;
					const name = rec.slice(1);
					kinds.set(posix.join(p, name), rec[0] === "d" ? "d" : "f");
					names.push(name);
				}
				return names;
			},
		};
	}

	/** find: a far `find` with fd-like glob semantics (basename match unless the pattern has a /). */
	findOps(): FindOperations {
		return {
			exists: async (p) => (await this.run(`test -e ${shPath(this.toFar(p))}`, { allowFail: true })).exitCode === 0,
			glob: async (pattern, cwd, { limit }) => {
				const pat = pattern.replace(/^\.\//, "");
				let cond: string;
				if (!pat.includes("/")) cond = `-name ${shQuote(pat)}`;
				else {
					cond = `-path ${shQuote(`./${pat}`)}`;
					if (pat.startsWith("**/")) cond += ` -o -path ${shQuote(`./${pat.slice(3)}`)}`;
				}
				const r = await this.run(
					`cd -- ${shPath(this.toFar(cwd))} || exit 1; find . \\( -name .git -o -name node_modules \\) -prune -o \\( ${cond} \\) -print 2>/dev/null | head -n ${Math.max(1, Math.floor(limit))}`,
				);
				return r.stdout
					.toString("utf8")
					.split("\n")
					.filter((l) => l && l !== ".")
					.map((l) => l.replace(/^\.\//, ""));
			},
		};
	}

	/** Resolve a tool's path argument the way pi does, but `~` means the FAR home. */
	resolveArg(p: string | undefined, info: FarInfo): string {
		const raw = (p || ".").replace(/^@/, "");
		if (raw === "~") return info.home;
		if (raw.startsWith("~/")) return posix.join(info.home, raw.slice(2));
		return this.toFar(resolveLocal(this.localCwd, raw));
	}
}

const GREP_DEFAULT_LIMIT = 100;

/** grep, run entirely on the far side (rg when installed there, else grep -r). */
function remoteGrep(remote: Remote) {
	const base = createGrepToolDefinition(remote.localCwd);
	return {
		...base,
		description: base.description.replace("Respects .gitignore.", "Respects .gitignore when ripgrep is installed on the target."),
		async execute(
			_id: string,
			params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
			signal: AbortSignal | undefined,
		) {
			const info = await remote.ready(signal);
			const far = remote.resolveArg(params.path, info);
			const ctxN = params.context && params.context > 0 ? Math.floor(params.context) : 0;
			const limit = Math.max(1, Math.floor(params.limit ?? GREP_DEFAULT_LIMIT));
			const rg = ["rg", "-n", "-H", "--null", "--no-heading", "--color=never", "--hidden"];
			const gr = ["grep", "-rnHIZ", "--exclude-dir=.git", "--exclude-dir=node_modules"];
			if (params.ignoreCase) (rg.push("-i"), gr.push("-i"));
			if (params.literal) rg.push("-F");
			gr.push(params.literal ? "-F" : "-E");
			if (params.glob) (rg.push("--glob", shQuote(params.glob)), gr.push(`--include=${shQuote(params.glob.replace(/^(\*\*\/)+/, ""))}`));
			if (ctxN) (rg.push("-C", String(ctxN)), gr.push("-C", String(ctxN)));
			const tail = `-- ${shQuote(params.pattern)} "$@"`;
			const lines = (limit + 1) * (2 * ctxN + 2);
			const script =
				`p=${shPath(far)}; if [ -d "$p" ]; then cd -- "$p" || exit 2; set -- .; ` +
				`elif [ -e "$p" ]; then cd -- "$(dirname -- "$p")" || exit 2; set -- "$(basename -- "$p")"; ` +
				`else echo "Path not found: $p" >&2; exit 2; fi; ` +
				`if command -v rg >/dev/null 2>&1; then ${rg.join(" ")} ${tail}; else ${gr.join(" ")} ${tail}; fi | head -n ${lines}`;
			const r = await remote.run(script, { signal, allowFail: true });
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `grep on ${remote.label} exited ${r.exitCode}`);
			const out: string[] = [];
			let matches = 0;
			let limitReached = false;
			let linesTruncated = false;
			for (const raw of r.stdout.toString("utf8").split("\n")) {
				const nul = raw.indexOf("\0");
				if (nul < 0) continue; // "--" group separators, blank lines
				const file = raw.slice(0, nul).replace(/^\.\//, "");
				const m = /^(\d+)([:-])(.*)$/s.exec(raw.slice(nul + 1));
				if (!m) continue;
				const isMatch = m[2] === ":";
				if (isMatch && matches === limit) {
					limitReached = true;
					break;
				}
				if (isMatch) matches++;
				const t = truncateLine(m[3]!.replace(/\r/g, ""));
				if (t.wasTruncated) linesTruncated = true;
				out.push(isMatch ? `${file}:${m[1]}: ${t.text}` : `${file}-${m[1]}- ${t.text}`);
			}
			if (!matches) {
				if (r.stderr.trim()) throw new Error(r.stderr.trim());
				return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
			}
			const truncation = truncateHead(out.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let text = truncation.content;
			const details: { matchLimitReached?: number; truncation?: typeof truncation; linesTruncated?: boolean } = {};
			const notices: string[] = [];
			if (limitReached) {
				notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				details.matchLimitReached = limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push("Some lines truncated. Use read tool to see full lines");
				details.linesTruncated = true;
			}
			if (notices.length) text += `\n\n[${notices.join(". ")}]`;
			return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
		},
	};
}

/** Tools that refuse to run at all, for a target that could not be loaded: never fall back to local. */
function refusingTools(pi: ExtensionAPI, cwd: string, why: string) {
	const fail = async (): Promise<never> => {
		throw new Error(`remote: ${why}. Refusing to run tools locally for a --target session.`);
	};
	for (const def of [
		createBashToolDefinition(cwd),
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createGrepToolDefinition(cwd),
	] as Parameters<ExtensionAPI["registerTool"]>[0][])
		pi.registerTool({ ...def, execute: fail });
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG, { description: "Run this session's tools on a target from ~/.pi/agent/targets.json", type: "string" });

	let remote: Remote | undefined;
	let loadError: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const name = pi.getFlag(FLAG);
		if (typeof name !== "string" || !name.trim()) return;
		const { target, registry, error } = loadTarget(name.trim());
		if (!target) {
			loadError = error;
			refusingTools(pi, ctx.cwd, error ?? "unknown target");
			if (ctx.hasUI) ctx.ui.notify(`remote: ${error}`, "error");
			return;
		}
		remote = new Remote(target, registry, ctx.cwd);
		const r = remote;
		const cwd = ctx.cwd;
		pi.registerTool(createBashToolDefinition(cwd, { operations: r.bashOps() }));
		pi.registerTool(createReadToolDefinition(cwd, { operations: r.readOps() }));
		pi.registerTool(createWriteToolDefinition(cwd, { operations: r.writeOps() }));
		pi.registerTool(createEditToolDefinition(cwd, { operations: r.editOps() }));
		pi.registerTool(createFindToolDefinition(cwd, { operations: r.findOps() }));
		// ls stats every entry; the ops' cache must be per call, so build the definition per call.
		const lsBase = createLsToolDefinition(cwd);
		pi.registerTool({ ...lsBase, execute: (...args) => createLsToolDefinition(cwd, { operations: r.lsOps() }).execute(...args) });
		pi.registerTool(remoteGrep(r));
		if (ctx.hasUI) ctx.ui.setStatus("remote", `⇄ ${r.label}`);
		r.preflight().then(
			(info) => ctx.hasUI && ctx.ui.setStatus("remote", `⇄ ${r.label} · ${info.user}@${info.hostname}`),
			(e: Error) => {
				if (!ctx.hasUI) return;
				ctx.ui.setStatus("remote", `⇄ ${r.label} · unreachable`);
				ctx.ui.notify(e.message, "error");
			},
		);
	});

	pi.on("user_bash", () => {
		if (remote) return { operations: remote.bashOps() };
		if (loadError) return { result: { output: `remote: ${loadError}`, exitCode: 1, cancelled: false, truncated: false } };
		return undefined;
	});

	pi.on("before_agent_start", async (event) => {
		const opts = event.systemPromptOptions;
		if (!remote) {
			if (loadError) opts.sections["remote-target"] = `This session is bound to a remote target that could not be loaded (${loadError}); every tool will fail. Tell the user.`;
			return;
		}
		const r = remote;
		try {
			const info = await r.ready();
			opts.cwd = info.cwd;
			opts.sections["remote-target"] =
				`All tools (bash, read, write, edit, ls, find, grep, and the user's ! commands) run on the remote target "${r.label}" ` +
				`(${describeTarget(r.target)}; host ${info.hostname}, user ${info.user}) in ${info.cwd}, not on this machine; use that machine's paths.`;
		} catch (e) {
			opts.sections["remote-target"] = `All tools run on the remote target "${r.label}" (${describeTarget(r.target)}), which is currently unreachable: ${(e as Error).message}`;
		}
	});
}
