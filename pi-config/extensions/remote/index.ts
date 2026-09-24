/**
 * remote — run a session's tools on a target from ~/.pi/agent/targets.json.
 *
 * Activation: the string flag `target` (`pi --target acme-prod`, or Sova's per-runtime
 * `extensionFlagValues`). Without it this extension registers no tools and changes nothing (the
 * `/remote` command only says so).
 *
 * With it, bash (and `!` commands), read, write, edit, ls, find and grep are replaced by versions
 * that run through the target's argv (argv.ts: ssh / aws-ssm / via × docker / incus). grep is
 * re-implemented whole (GrepOperations can't run a search); the others use pi's operations hooks.
 * An unknown or invalid target fails closed: every tool errors instead of running locally.
 *
 * Paths: Sova opens target sessions in a local placeholder,
 * <agentDir>/sova/targets/<name>/<remote/abs/path>, which maps back to /remote/abs/path. From any
 * other directory (the CLI case) the local cwd maps to the target's cwd (or the far login dir).
 *
 * Every file operation goes through `Remote.run()`: the pinned channel (channel.ts) when it is up
 * and idle, else a per-call ssh. That transport — the probe, the status, the channel policy — is
 * `Connection` (connection.ts), which `Remote` extends and the workers' MCP server (mcp-server.ts)
 * shares; this file is the local half: path mapping and pi's tool operations. The connection
 * status goes out as a pair of setStatus keys: `remote` (prose, the TUI status bar) and
 * `remote-status` (RemoteStatus JSON, Sova's chip).
 *
 * The session announces itself on `pi.events` (REMOTE_SESSION_EVENT, workers.ts) so the subagents
 * extension can put this session's workers on the target too: our flag is invisible to it.
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
	withFileMutationQueue,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { parseTargetsFile, placeholderRoot, shPath, shQuote, type Target, targetsFilePath, toRemotePath } from "./argv.ts";
import {
	channelFactory,
	Connection,
	type ConnectionDeps,
	type ConnectionRunOptions,
	describeTarget,
	type FarInfo,
	type RemoteStatus,
} from "./connection.ts";
import type { RunResult } from "./exec.ts";
import { REMOTE_DISCOVER_EVENT, REMOTE_SESSION_EVENT, type RemoteSessionEvent } from "./workers.ts";

export { channelOver, describeTarget, type ChannelLike, type ChannelState, type FarInfo, type RemoteStatus } from "./connection.ts";

const FLAG = "target";
/** Kill switch for the pinned channel (also PI_REMOTE_CHANNEL=0). */
const NO_CHANNEL_FLAG = "no-channel";
/**
 * The status goes out as a pair, from `publish()` only: "remote" = the human line for the TUI status
 * bar (never JSON), "remote-status" = RemoteStatus JSON, the only key Sova's chip reads.
 */
const STATUS_KEY = "remote-status";
/** Far exit codes of the folded readability check in front of `cat` (readFile). */
const EXIT_NO_FILE = 66;
const EXIT_UNREADABLE = 67;
/** How long a file access() fetched waits for the readFile() that follows it. */
const PREFETCH_TTL_MS = 2_000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

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

/** Everything Remote needs beyond a Connection: nothing today; the extension's dep type, kept for its callers and tests. */
export type RemoteDeps = ConnectionDeps;

/**
 * A session's Connection plus everything local: the placeholder path mapping and pi's tool
 * operations. The transport, the probe, the status and the channel policy all live in Connection
 * (connection.ts), which the workers' MCP server shares.
 */
export class Remote extends Connection {
	readonly localCwd: string;
	readonly root: string;

	constructor(target: Target, registry: Target[], localCwd: string, deps: RemoteDeps = {}) {
		// Everything the far cwd depends on is computed before super(): `this` is off limits until then.
		const agentDir = deps.agentDir ?? getAgentDir();
		const root = placeholderRoot(agentDir, target.name);
		/** The far cwd known without a round trip (the placeholder, or the entry's cwd). */
		const farCwd = localCwd === root || localCwd.startsWith(root + "/") ? toRemotePath(localCwd, root) : target.cwd;
		// `channel` keeps the extension's older meaning here — omitted = none (the --no-channel kill
		// switch passes nothing); only direct Connection users (the workers' MCP server) get the
		// target's channel by default.
		super(target, registry, farCwd, { ...deps, agentDir, channel: deps.channel ?? false });
		this.localCwd = localCwd;
		this.root = root;
	}

	/** Local path (as pi resolved it) → far path: the placeholder mapping, then cwd-relative, then `~`. */
	toFar(p: string): string {
		if (p === this.root || p.startsWith(this.root + "/")) return toRemotePath(p, this.root);
		const farCwd = this.farInfo?.cwd ?? this.farCwd;
		if (farCwd && (p === this.localCwd || p.startsWith(this.localCwd + "/"))) return farCwd + p.slice(this.localCwd.length);
		const home = homedir();
		if (this.farInfo && (p === home || p.startsWith(home + "/"))) return this.farInfo.home + p.slice(home.length);
		return p;
	}

	/**
	 * The key pi's per-file mutation queue uses for a far file. It lives under a namespace that never
	 * exists locally, so it cannot collide with the local-path key pi's write/edit already hold
	 * (a far path can equal a local one), and two local spellings of one far file share it.
	 */
	mutationKey(localPath: string): string {
		return `/@pi-remote/${this.target.name}${posix.normalize(`/${this.toFar(localPath)}`)}`;
	}

	/** pi's bash operations: the user's command, in the far spelling of the tool's cwd. */
	bashOps(): BashOperations {
		return {
			exec: (command, cwd, { onData, signal, timeout }) => this.bash(command, this.toFar(cwd), { onData, signal, timeoutSec: timeout }),
		};
	}

	/**
	 * `cat`, with the readability check folded into the same far command: one round trip, and the
	 * missing / unreadable distinction still reaches the user.
	 */
	private async fetch(p: string, signal?: AbortSignal, writable = false): Promise<Buffer> {
		const far = this.toFar(p);
		const q = shPath(far);
		const r = await this.run(
			`if [ ! -e ${q} ]; then exit ${EXIT_NO_FILE}; elif [ ! -r ${q}${writable ? ` ] || [ ! -w ${q}` : ""} ]; then exit ${EXIT_UNREADABLE}; fi; cat -- ${q}`,
			{ allowFail: true, signal },
		);
		if (r.exitCode === EXIT_NO_FILE) throw new Error(`ENOENT: no such file on ${this.label}: ${far}`);
		if (r.exitCode === EXIT_UNREADABLE) throw new Error(`EACCES: not ${writable ? "readable and writable" : "readable"} on ${this.label}: ${far}`);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `${this.label}: exit code ${r.exitCode}`);
		return r.stdout;
	}

	/**
	 * pi's read and edit call access() then readFile() at once. access() starts the one fetch (so its
	 * errors keep the shape pi wraps them in) and readFile() takes the result. A fetch left behind by
	 * an aborted call expires after PREFETCH_TTL_MS; a readFile with nothing prefetched fetches itself.
	 */
	private prefetchOps(writable: boolean): Pick<ReadOperations, "access" | "readFile"> {
		const prefetched = new Map<string, { data: Buffer; at: number }>();
		return {
			access: async (p) => {
				prefetched.delete(p);
				prefetched.set(p, { data: await this.fetch(p, undefined, writable), at: Date.now() });
			},
			readFile: async (p) => {
				const hit = prefetched.get(p);
				prefetched.delete(p);
				if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) return hit.data;
				return this.fetch(p);
			},
		};
	}

	readOps(): ReadOperations {
		return { ...this.prefetchOps(false), detectImageMimeType: async (p) => IMAGE_TYPES[posix.extname(p).toLowerCase()] ?? null };
	}

	writeOps(): WriteOperations {
		return {
			// mkdir -p and the write in one far command: pi calls mkdir(dir) then writeFile(path), and
			// the parent is always dirname(path), so mkdir costs nothing on its own.
			writeFile: async (p, content) => {
				const far = this.toFar(p);
				await this.run(`mkdir -p -- ${shPath(posix.dirname(far))} && cat > ${shPath(far)}`, { input: content });
			},
			mkdir: async () => {},
		};
	}

	editOps(): EditOperations {
		return { ...this.prefetchOps(true), writeFile: this.writeOps().writeFile };
	}

	/** ls: one far command per directory; the listing answers exists/stat/readdir and the per-entry stats. */
	lsOps(): LsOperations {
		const kinds = new Map<string, "d" | "f">();
		/** Directory → its entries, or the far error when it could not be listed. */
		const listings = new Map<string, string[] | Error>();
		const probe = async (p: string) => {
			if (!kinds.has(p)) {
				const q = shPath(this.toFar(p));
				const r = await this.run(
					`if [ -d ${q} ]; then if cd -- ${q} 2>/dev/null; then echo d; else echo D; exit 0; fi; ` +
						`for f in * .[!.]* ..?*; do if [ -d "$f" ]; then printf 'd%s\\0' "$f"; elif [ -e "$f" ] || [ -L "$f" ]; then printf 'f%s\\0' "$f"; fi; done; ` +
						`elif [ -e ${q} ]; then echo f; else echo none; fi`,
				);
				const out = r.stdout.toString("utf8");
				const nl = out.indexOf("\n");
				const k = (nl < 0 ? out : out.slice(0, nl)).trim();
				if (k === "d" || k === "D" || k === "f") kinds.set(p, k === "f" ? "f" : "d");
				if (k === "D") listings.set(p, new Error(`permission denied: ${this.toFar(p)}`));
				if (k === "d") {
					const names: string[] = [];
					for (const rec of out.slice(nl + 1).split("\0")) {
						if (!rec) continue;
						const name = rec.slice(1);
						kinds.set(posix.join(p, name), rec[0] === "d" ? "d" : "f");
						names.push(name);
					}
					listings.set(p, names);
				}
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
				await probe(p);
				const names = listings.get(p) ?? new Error(`ENOTDIR: ${this.toFar(p)}`);
				if (names instanceof Error) throw names;
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
export function remoteGrep(remote: Remote) {
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

/** Where pi's write/edit resolve a path argument (resolveToCwd isn't exported): `@` stripped, `~` = the local home. */
function localPathOf(path: string, cwd: string): string {
	const p = path.replace(/^@/, "");
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolveLocal(homedir(), p.slice(2));
	return resolveLocal(cwd, p);
}

/**
 * write/edit, serialized per FAR file in pi's mutation queue: pi's own queue is keyed on the local
 * path, which several spellings of one far file don't share. Not `executionMode: "sequential"`:
 * that serializes the whole batch a write is in (reads included), and this queue is the fix.
 */
export function mutating<D extends { execute: (...args: any[]) => Promise<any> }>(def: D, remote: Remote, cwd: string): D {
	return {
		...def,
		execute: (id: string, params: { path: string }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd?: string } | undefined) =>
			withFileMutationQueue(remote.mutationKey(localPathOf(params.path, ctx?.cwd || cwd)), () => def.execute(id, params, signal, onUpdate, ctx)),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG, { description: "Run this session's tools on a target from ~/.pi/agent/targets.json", type: "string" });
	pi.registerFlag(NO_CHANNEL_FLAG, { description: "remote: never pin a command channel; every tool call spawns its own ssh (also PI_REMOTE_CHANNEL=0)", type: "boolean" });

	let remote: Remote | undefined;
	let loadError: string | undefined;
	/**
	 * The session's target, for extensions that cannot see our flag (subagents, which must run this
	 * session's workers on the target too). Announced on session_start — first with the far cwd we
	 * know without a round trip, then again with the probe's answer — and re-announced whenever
	 * someone asks, so load order never matters. Nothing waits for it: it is a plain notification.
	 */
	let announcement: RemoteSessionEvent | undefined;
	const announce = (e: RemoteSessionEvent) => {
		announcement = e;
		pi.events?.emit(REMOTE_SESSION_EVENT, e);
	};
	// Someone loaded after us (or restarted its listener) asking who we are.
	pi.events?.on(REMOTE_DISCOVER_EVENT, () => {
		if (announcement) pi.events?.emit(REMOTE_SESSION_EVENT, announcement);
	});

	pi.registerCommand("remote", {
		description: "Remote target connection: `/remote check` (fresh probe), `/remote reconnect` (drop the channel and re-probe) or `/remote status` (re-publish the status)",
		getArgumentCompletions: (prefix) => ["check", "reconnect", "status"].filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const r = remote;
			const sub = args.trim() || "check";
			// Sent silently by Sova on every socket hello: never a round trip, never a toast.
			if (sub === "status") return r?.republish();
			if (!r) {
				if (ctx.hasUI) ctx.ui.notify(loadError ? `remote: ${loadError}` : "remote: this session has no --target", loadError ? "error" : "info");
				return;
			}
			if (sub !== "check" && sub !== "reconnect") {
				if (ctx.hasUI) ctx.ui.notify("usage: /remote check | /remote reconnect | /remote status", "error");
				return;
			}
			const s = sub === "check" ? await r.check() : await r.reconnect();
			if (ctx.hasUI && s.state === "online") ctx.ui.notify(`remote: ${r.label} online (${s.host}, ${s.latencyMs} ms)`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const name = pi.getFlag(FLAG);
		if (typeof name !== "string" || !name.trim()) return;
		const { target, registry, error } = loadTarget(name.trim());
		if (!target) {
			loadError = error;
			refusingTools(pi, ctx.cwd, error ?? "unknown target");
			// Workers must refuse too: a session whose target failed to load has no far side at all.
			announce({ version: 1, target: name.trim(), error: error ?? "unknown target" });
			if (ctx.hasUI) ctx.ui.notify(`remote: ${error}`, "error");
			return;
		}
		remote?.dispose();
		const channelOff = process.env.PI_REMOTE_CHANNEL === "0" || pi.getFlag(NO_CHANNEL_FLAG) === true;
		/** The one place status reaches the UI: both keys, together. */
		const publish = (s: RemoteStatus) => {
			if (!ctx.hasUI) return;
			const tail = s.state === "unreachable" ? " · unreachable" : s.channelState === "rate-limited" ? " · ssh rate-limited" : s.pinned ? " · pinned" : "";
			ctx.ui.setStatus("remote", `⇄ ${r.label}${s.host ? ` · ${s.host}` : ""}${tail}`);
			ctx.ui.setStatus(STATUS_KEY, JSON.stringify(s));
		};
		const r = new Remote(target, registry, ctx.cwd, {
			channel: channelOff ? undefined : channelFactory(target, registry),
			onStatus: publish,
			onEvent: (text, level) => ctx.hasUI && ctx.ui.notify(text, level),
		});
		remote = r;
		const cwd = ctx.cwd;
		pi.registerTool(createBashToolDefinition(cwd, { operations: r.bashOps() }));
		pi.registerTool(createReadToolDefinition(cwd, { operations: r.readOps() }));
		// write/edit: remote fetch/write, serialized per FAR file (see `mutating`).
		pi.registerTool(mutating(createWriteToolDefinition(cwd, { operations: r.writeOps() }), r, cwd));
		pi.registerTool(mutating(createEditToolDefinition(cwd, { operations: r.editOps() }), r, cwd));
		pi.registerTool(createFindToolDefinition(cwd, { operations: r.findOps() }));
		// ls stats every entry; the ops' cache must be per call, so build the definition per call.
		const lsBase = createLsToolDefinition(cwd);
		pi.registerTool({ ...lsBase, execute: (...args) => createLsToolDefinition(cwd, { operations: r.lsOps() }).execute(...args) });
		pi.registerTool(remoteGrep(r));
		r.emit();
		const session = (farCwd: string | undefined): RemoteSessionEvent => ({
			version: 1,
			target: target.name,
			...(farCwd ? { farCwd } : {}),
			...(target.label ? { label: target.label } : {}),
			...(channelOff ? { channelOff: true } : {}),
		});
		// What we know without a round trip (the placeholder mapping, else the entry's cwd);
		// `farCwd` stays absent when even that is unknown, which readers treat as "remote, unresolved".
		announce(session(r.farCwd));
		// The preflight answers → noteOk → the channel starts warming in the background.
		r.preflight().then(
			// The far side's own `pwd`: the authority, and the first announcement's farCwd may have been absent.
			(info) => announce(session(info.cwd)),
			() => {},
		);
	});

	pi.on("session_shutdown", () => {
		remote?.dispose();
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
