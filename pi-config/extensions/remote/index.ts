/**
 * remote — run a session's tools on a target from ~/.pi/agent/targets.json.
 *
 * Activation: the string flag `target` (`pi --target acme-prod`, or pi-web's per-runtime
 * `extensionFlagValues`). Without it this extension registers no tools and changes nothing (the
 * `/remote` command only says so).
 *
 * With it, bash (and `!` commands), read, write, edit, ls, find and grep are replaced by versions
 * that run through the target's argv (argv.ts: ssh / aws-ssm / via × docker / incus). grep is
 * re-implemented whole (GrepOperations can't run a search); the others use pi's operations hooks.
 * An unknown or invalid target fails closed: every tool errors instead of running locally.
 *
 * Paths: pi-web opens target sessions in a local placeholder,
 * <agentDir>/pi-web/targets/<name>/<remote/abs/path>, which maps back to /remote/abs/path. From any
 * other directory (the CLI case) the local cwd maps to the target's cwd (or the far login dir).
 *
 * Every file operation goes through `Remote.run()`: the pinned channel (channel.ts) when it is up
 * and idle, else a per-call ssh. The connection status goes out as a pair of setStatus keys: `remote`
 * (prose, the TUI status bar) and `remote-status` (RemoteStatus JSON, pi-web's chip).
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
import { buildTargetArgv, hangupGuard, parseTargetsFile, placeholderRoot, shPath, shQuote, type Target, targetsFilePath, toRemotePath } from "./argv.ts";
import { buildChannelArgv, Channel } from "./channel.ts";
import { type RunOptions, type RunResult, runArgv } from "./exec.ts";

const FLAG = "target";
/** Kill switch for the pinned channel (also PI_REMOTE_CHANNEL=0). */
const NO_CHANNEL_FLAG = "no-channel";
/**
 * The status goes out as a pair, from `publish()` only: "remote" = the human line for the TUI status
 * bar (never JSON), "remote-status" = RemoteStatus JSON, the only key pi-web's chip reads.
 */
const STATUS_KEY = "remote-status";
const PREFLIGHT_TIMEOUT_MS = 20_000;
/** A failed preflight is re-tried after this long; until then tools fail at once with the cached error. */
const RETRY_AFTER_MS = 15_000;
const OP_TIMEOUT_MS = 120_000;
const MARKER = "@@pi-remote@@";
/** Far exit codes of the folded readability check in front of `cat` (readFile). */
const EXIT_NO_FILE = 66;
const EXIT_UNREADABLE = 67;
/** The pinned channel: skip it for CHANNEL_COOLDOWN_MS after CHANNEL_MAX_FAILURES failures within CHANNEL_FAILURE_WINDOW_MS. */
const CHANNEL_MAX_FAILURES = 2;
const CHANNEL_FAILURE_WINDOW_MS = 60_000;
const CHANNEL_COOLDOWN_MS = 60_000;
/**
 * Every channel open is a fresh ssh login (its own TCP connection), and hosts rate-limit those
 * (acme-prod: ~6 per 30 s per source IP, shared with the master, per-call fallbacks and the
 * user's own shells). So: no reopen within CHANNEL_REOPEN_AFTER_MS of an abort/timeout/poison
 * teardown, and a start refused by the host backs off CHANNEL_RATE_LIMIT_BACKOFF_MS.
 */
const CHANNEL_REOPEN_AFTER_MS = 30_000;
const CHANNEL_RATE_LIMIT_BACKOFF_MS = 45_000;
const RATE_LIMITED_RE = /Connection refused/;
/** While a command runs, the status is re-emitted this often with `runningMs`. */
const STATUS_TICK_MS = 5_000;
/** How long a file access() fetched waits for the readFile() that follows it. */
const PREFETCH_TTL_MS = 2_000;
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

/**
 * The connection status, published as a pair (see `publish`): `setStatus("remote", <prose>)` for the
 * TUI status bar, and `setStatus("remote-status", JSON.stringify(<this>))`, which pi-web's chip renders.
 */
export interface RemoteStatus {
	state: "online" | "unreachable" | "unknown";
	/** Target name. */
	target: string;
	/** `user@hostname` once the preflight has answered. */
	host?: string;
	/** Wall ms of the last successful per-call probe (the preflight or `/remote check`). */
	latencyMs?: number;
	/** The pinned channel is up (idle or busy): the next idle call skips the ssh setup. */
	pinned: boolean;
	/** "rate-limited": the host refused the channel's login; calls go per call through the master until channelRetryAt. */
	channelState?: ChannelState | "rate-limited";
	/** Epoch ms after which the next tool call may try the channel again; set only while rate-limited. */
	channelRetryAt?: number;
	/** Epoch ms of the last invocation the target answered; 0 = never. */
	lastOkAt: number;
	/** Elapsed ms of the oldest command still running; present only once one has run for STATUS_TICK_MS. */
	runningMs?: number;
	/** First line of the last failure: when unreachable, or ssh's refusal while the channel is rate-limited. */
	error?: string;
	/** Epoch ms this status was produced. */
	at: number;
}

export type ChannelState = "off" | "warming" | "idle" | "busy" | "dead";

/** What Remote needs from the pinned channel (channel.ts, adapted by `channelFactory`). */
export interface ChannelLike {
	readonly state: ChannelState;
	/** Rejects when the channel could not start; `refused: true` on the error = the host refused the login (rate limit). */
	start(): Promise<void>;
	/** Resolves with a RunResult (stdout and stderr apart; aborted/timedOut set); rejects when the channel broke. */
	run(command: string, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult>;
	close(): void;
}

/** Scripts larger than this go per call: they are sent whole in one request. */
const CHANNEL_MAX_SCRIPT = 100 * 1024;

export interface RemoteDeps {
	/** Per-call spawn (exec.ts runArgv); tests swap it for a counter. */
	exec?: (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;
	/** Builds the pinned channel; undefined = no channel (kill switch, or a target with no ssh hop). */
	channel?: (onState: (s: ChannelState) => void) => ChannelLike;
	/** The clock (default Date.now); tests move it. */
	now?: () => number;
	/** Status re-emit period while a command runs (default STATUS_TICK_MS). */
	statusTickMs?: number;
	/** Called on every emit (the extension's `publish` forwards it to both setStatus keys). */
	onStatus?: (s: RemoteStatus) => void;
	/** Connection events worth a toast: first loss, recovery. */
	onEvent?: (text: string, level: "info" | "error") => void;
}

export class Remote {
	readonly root: string;
	private info?: FarInfo;
	private pending?: Promise<FarInfo>;
	private failure?: { error: Error; at: number };
	private readonly exec: NonNullable<RemoteDeps["exec"]>;
	private channel?: ChannelLike;
	private channelFailures: number[] = [];
	private channelSkipUntil = 0;
	/** No reopen before this (abort/timeout/poison teardown + CHANNEL_REOPEN_AFTER_MS). */
	private channelHoldUntil = 0;
	/** Set while the host refuses channel logins: {until, the ssh line}. */
	private rateLimited?: { until: number; error: string };
	/** `/remote reconnect`: the next warm ignores the hold and the rate-limit backoff, once. */
	private bypassOnce = false;
	private lastOkAt = 0;
	private latencyMs?: number;
	private readonly running = new Map<number, number>();
	private runSeq = 0;
	private tick?: NodeJS.Timeout;
	private showRunning = false;
	/** Last state we told the user about (toasts only on transitions). */
	private announced: RemoteStatus["state"] = "unknown";

	constructor(
		readonly target: Target,
		readonly registry: Target[],
		readonly localCwd: string,
		private readonly deps: RemoteDeps = {},
	) {
		this.root = placeholderRoot(getAgentDir(), target.name);
		this.exec = deps.exec ?? runArgv;
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
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

	/**
	 * The key pi's per-file mutation queue uses for a far file. It lives under a namespace that never
	 * exists locally, so it cannot collide with the local-path key pi's write/edit already hold
	 * (a far path can equal a local one), and two local spellings of one far file share it.
	 */
	mutationKey(localPath: string): string {
		return `/@pi-remote/${this.target.name}${posix.normalize(`/${this.toFar(localPath)}`)}`;
	}

	argv(command: string, cwd?: string): string[] {
		return buildTargetArgv(this.target, { command, cwd: cwd ?? "", registry: this.registry });
	}

	private unreachable(r: RunResult | Error): Error {
		const why = r instanceof Error ? r.message : r.timedOut ? `no answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s` : r.stderr.trim() || `exit code ${r.exitCode}`;
		return new Error(`Target "${this.target.name}" (${describeTarget(this.target)}) is unreachable: ${why}`);
	}

	private get isSsh(): boolean {
		return !!(this.target.ssh || this.target.via);
	}

	// -------------------------------------------------------------------------
	// status

	status(): RemoteStatus {
		const now = this.now();
		const failed = !!this.failure && !this.info;
		const channelState: RemoteStatus["channelState"] = this.rateLimited ? "rate-limited" : (this.channel?.state ?? (this.deps.channel ? "off" : undefined));
		const s: RemoteStatus = {
			state: failed ? "unreachable" : this.info ? "online" : "unknown",
			target: this.target.name,
			pinned: channelState === "idle" || channelState === "busy",
			lastOkAt: this.lastOkAt,
			at: now,
		};
		if (this.info) s.host = `${this.info.user}@${this.info.hostname}`;
		if (this.latencyMs !== undefined) s.latencyMs = this.latencyMs;
		if (channelState) s.channelState = channelState;
		if (this.rateLimited) s.channelRetryAt = this.rateLimited.until;
		if (failed) s.error = this.failure!.error.message.split("\n")[0];
		else if (this.rateLimited) s.error = this.rateLimited.error;
		if (this.showRunning && this.running.size) s.runningMs = now - Math.min(...this.running.values());
		return s;
	}

	/** Publish the status now (every transition, run outcome and running tick calls this); toast on first loss and on recovery. */
	/** `/remote status`: publish the current status again, as is (no round trip, no toast). A reopened client has missed the last emit. */
	republish() {
		this.deps.onStatus?.(this.status());
	}

	emit() {
		const s = this.status();
		if (s.state !== this.announced) {
			if (s.state === "unreachable") this.deps.onEvent?.(`remote: ${s.error}`, "error");
			else if (s.state === "online" && this.announced === "unreachable") this.deps.onEvent?.(`remote: ${this.label} reconnected`, "info");
			this.announced = s.state;
		}
		this.deps.onStatus?.(s);
	}

	/** Track an in-flight command so a long one shows its elapsed time. */
	private begin(): number {
		const id = ++this.runSeq;
		this.running.set(id, Date.now());
		this.tick ??= setInterval(() => {
			this.showRunning = true;
			this.emit();
		}, this.deps.statusTickMs ?? STATUS_TICK_MS);
		this.tick.unref?.();
		return id;
	}

	private end(id: number) {
		this.running.delete(id);
		if (this.running.size) return;
		clearInterval(this.tick);
		this.tick = undefined;
		this.showRunning = false;
		this.emit();
	}

	private noteOk(latencyMs?: number) {
		this.lastOkAt = Date.now();
		if (latencyMs !== undefined) this.latencyMs = latencyMs;
		if (this.failure && this.info) this.failure = undefined;
		this.warm();
		this.emit();
	}

	// -------------------------------------------------------------------------
	// preflight

	private static readonly PROBE = `printf '%s\\n' ${shQuote(MARKER)}; id -un; hostname; printf '%s\\n' "$HOME"; pwd`;

	private parseProbe(r: RunResult): FarInfo {
		const lines = r.stdout.toString("utf8").split("\n");
		const at = lines.lastIndexOf(MARKER);
		if (r.exitCode !== 0 || at < 0 || lines.length < at + 5) throw this.unreachable(r);
		return { user: lines[at + 1]!, hostname: lines[at + 2]!, home: lines[at + 3]!, cwd: lines[at + 4]! };
	}

	/** Bounded probe; resolves the far user/host/home/cwd. Concurrent callers share one probe. */
	preflight(): Promise<FarInfo> {
		if (this.info) return Promise.resolve(this.info);
		if (this.pending) return this.pending;
		const cwd = this.staticFarCwd();
		const t0 = Date.now();
		this.pending = this.exec(this.argv(Remote.PROBE, cwd), { timeoutMs: PREFLIGHT_TIMEOUT_MS })
			.then(
				(r) => {
					this.info = this.parseProbe(r);
					this.failure = undefined;
					this.noteOk(Date.now() - t0);
					return this.info;
				},
				(e: Error) => {
					throw this.unreachable(e);
				},
			)
			.catch((e: Error) => {
				this.failure = { error: e, at: Date.now() };
				this.emit();
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

	/** `/remote check`: one fresh per-call probe (never the channel), bypassing the cached failure. */
	async check(): Promise<RemoteStatus> {
		const t0 = Date.now();
		try {
			const r = await this.exec(this.argv(Remote.PROBE, this.info?.cwd ?? this.staticFarCwd()), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
			this.info = this.parseProbe(r);
			this.failure = undefined;
			this.noteOk(Date.now() - t0);
		} catch (e) {
			this.info = undefined;
			this.failure = { error: (e as Error).message.startsWith("Target ") ? (e as Error) : this.unreachable(e as Error), at: Date.now() };
			this.emit();
		}
		return this.status();
	}

	/** `/remote reconnect`: drop the channel and the cached probe, re-probe per call, then re-warm. */
	async reconnect(): Promise<RemoteStatus> {
		this.channel?.close();
		this.channel = undefined;
		this.channelFailures = [];
		this.channelSkipUntil = 0;
		this.bypassOnce = true;
		this.info = undefined;
		this.failure = undefined;
		this.emit();
		await this.preflight().catch(() => {});
		return this.status();
	}

	dispose() {
		this.channel?.close();
		this.channel = undefined;
		clearInterval(this.tick);
		this.tick = undefined;
	}

	// -------------------------------------------------------------------------
	// the pinned channel

	private channelUsable(): boolean {
		return !!this.deps.channel && this.isSsh && this.now() >= this.channelSkipUntil;
	}

	/**
	 * Start the channel in the background (never on a tool call's path). Called after each successful
	 * call, so a reopen always waits for a tool call; a no-op while one is up or warming, within 30 s
	 * of an abort/timeout/poison teardown, and while the host is rate-limiting logins.
	 */
	warm() {
		if (!this.channelUsable() || !this.info) return;
		const st = this.channel?.state;
		if (st === "warming" || st === "idle" || st === "busy") return;
		const now = this.now();
		if (!this.bypassOnce && (now < this.channelHoldUntil || (this.rateLimited && now < this.rateLimited.until))) return;
		this.bypassOnce = false;
		this.rateLimited = undefined;
		const ch = this.deps.channel!((state) => {
			if (this.channel !== ch) return;
			// "dead" is an abort/timeout/poison/loss teardown (an idle close reads "off"): hold the reopen.
			if (state === "dead") this.channelHoldUntil = this.now() + CHANNEL_REOPEN_AFTER_MS;
			this.emit();
		});
		this.channel = ch;
		ch.start().then(
			() => this.emit(),
			(e: Error) => this.channelStartFailed(ch, e),
		);
		this.emit();
	}

	/** A refused login is the host's rate limit, not a channel fault: back off, don't count it. */
	private channelStartFailed(ch: ChannelLike, e: Error) {
		const msg = e?.message ?? String(e);
		if (!(e as { refused?: boolean })?.refused && !RATE_LIMITED_RE.test(msg)) return this.channelFailed(ch);
		ch.close();
		const line = msg.split("\n").find((l) => RATE_LIMITED_RE.test(l)) ?? msg;
		this.rateLimited = { until: this.now() + CHANNEL_RATE_LIMIT_BACKOFF_MS, error: line.trim() };
		this.emit();
	}

	private channelFailed(ch: ChannelLike) {
		const now = this.now();
		this.channelFailures = this.channelFailures.filter((t) => now - t < CHANNEL_FAILURE_WINDOW_MS);
		this.channelFailures.push(now);
		if (this.channelFailures.length >= CHANNEL_MAX_FAILURES) {
			this.channelSkipUntil = now + CHANNEL_COOLDOWN_MS;
			this.channelFailures = [];
		}
		// Kept (dead) so the status says so until warm() replaces it.
		ch.close();
		this.emit();
	}

	/**
	 * THE choke point for file operations: the pinned channel when it is up and idle, else a per-call
	 * spawn (multiplexed by ControlMaster). A busy channel is never queued behind. Writes (stdin) and
	 * huge scripts always go per call. Far commands here are idempotent (cat, test, listings, find,
	 * grep), so a channel that breaks under one is retried per call; abort and timeout are not retried.
	 */
	private async dispatch(command: string, opts: RunOptions): Promise<RunResult & { viaChannel?: boolean }> {
		const ch = this.channel;
		if (ch && ch.state === "idle" && this.channelUsable() && opts.input === undefined && !opts.onData && !opts.holdStdin && command.length <= CHANNEL_MAX_SCRIPT) {
			try {
				return { ...(await ch.run(command, { signal: opts.signal, timeoutMs: opts.timeoutMs })), viaChannel: true };
			} catch {
				if (opts.signal?.aborted) return { code: null, exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true };
				this.channelFailed(ch);
			}
		}
		return this.exec(this.argv(command), opts);
	}

	/** Run far shell code for a file operation; throws with the far stderr on failure. */
	async run(command: string, opts: RunOptions & { allowFail?: boolean } = {}): Promise<RunResult> {
		await this.ready(opts.signal);
		const id = this.begin();
		let r: RunResult & { viaChannel?: boolean };
		try {
			r = await this.dispatch(command, { timeoutMs: OP_TIMEOUT_MS, ...opts });
		} finally {
			this.end(id);
		}
		if (r.aborted) throw new Error("Operation aborted");
		if (r.timedOut) throw new Error(`${this.label}: timed out after ${(opts.timeoutMs ?? OP_TIMEOUT_MS) / 1000}s`);
		// Over the channel a 255 is the far command's own exit code, not ssh's.
		if (!r.viaChannel) {
			this.noteFailure(r);
			if (r.exitCode === 255 && this.isSsh) throw this.unreachable(r);
		}
		this.noteOk();
		if (r.exitCode !== 0 && !opts.allowFail) throw new Error(r.stderr.trim() || `${this.label}: exit code ${r.exitCode}`);
		return r;
	}

	/** A connection-level failure mid-session: drop the cached probe so the next call re-checks. */
	private noteFailure(r: RunResult) {
		if (r.exitCode === 255 && this.isSsh) {
			this.info = undefined;
			this.failure = { error: this.unreachable(r), at: Date.now() };
			this.emit();
		}
	}

	bashOps(): BashOperations {
		return {
			exec: async (command, cwd, { onData, signal, timeout }) => {
				await this.ready(signal);
				const id = this.begin();
				let r: RunResult;
				try {
					// Streaming and far-side kill on abort need their own channel: bash always spawns per call.
					r = await this.exec(this.argv(hangupGuard(command), this.toFar(cwd)), {
						onData,
						signal,
						timeoutMs: timeout ? timeout * 1000 : undefined,
						holdStdin: true,
					});
				} finally {
					this.end(id);
				}
				if (r.aborted) throw new Error("aborted");
				if (r.timedOut) throw new Error(`timeout:${timeout}`);
				// 255 is also an ordinary exit code of the user's command, so it only marks the target
				// unreachable when ssh said so (stderr), not on the code alone.
				if (!(r.exitCode === 255 && this.isSsh && /^ssh: |Connection (closed|refused|timed out)|Could not resolve/m.test(r.stderr))) this.noteOk();
				return { exitCode: r.exitCode };
			},
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

/** The target's channel factory; undefined when it has no ssh hop. */
function channelFactory(target: Target, registry: readonly Target[]): RemoteDeps["channel"] {
	const argv = buildChannelArgv(target, registry);
	return argv ? channelOver(argv) : undefined;
}

/** Adapt channel.ts's Channel, spawned from `argv`, to what Remote needs. */
export function channelOver(argv: readonly string[]): NonNullable<RemoteDeps["channel"]> {
	return (onState) => {
		const ch = new Channel({ argv, onState: () => onState(stateOf()) });
		// An idle close is the channel's normal end, not a failure: shown as "off".
		const stateOf = (): ChannelState => (ch.state === "new" ? "off" : ch.state === "dead" && ch.death?.reason === "idle" ? "off" : ch.state);
		return {
			get state() {
				return stateOf();
			},
			// channel.ts flags a start that ssh refused (the host's login rate limit): pass it on.
			start: () =>
				ch.start().catch((e: Error) => {
					throw Object.assign(e, { refused: ch.death?.refused === true });
				}),
			// stdout and stderr apart; abort/timeout resolve (channel then dead); loss/poison throw → per-call fallback.
			run: (command, { signal, timeoutMs }) => ch.exec(command, { signal, timeoutMs }),
			close: () => ch.kill(),
		};
	};
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

	pi.registerCommand("remote", {
		description: "Remote target connection: `/remote check` (fresh probe), `/remote reconnect` (drop the channel and re-probe) or `/remote status` (re-publish the status)",
		getArgumentCompletions: (prefix) => ["check", "reconnect", "status"].filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const r = remote;
			const sub = args.trim() || "check";
			// Sent silently by pi-web on every socket hello: never a round trip, never a toast.
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
		pi.registerTool(mutating(createWriteToolDefinition(cwd, { operations: r.writeOps() }), r, cwd));
		pi.registerTool(mutating(createEditToolDefinition(cwd, { operations: r.editOps() }), r, cwd));
		pi.registerTool(createFindToolDefinition(cwd, { operations: r.findOps() }));
		// ls stats every entry; the ops' cache must be per call, so build the definition per call.
		const lsBase = createLsToolDefinition(cwd);
		pi.registerTool({ ...lsBase, execute: (...args) => createLsToolDefinition(cwd, { operations: r.lsOps() }).execute(...args) });
		pi.registerTool(remoteGrep(r));
		r.emit();
		// The preflight answers → noteOk → the channel starts warming in the background.
		r.preflight().catch(() => {});
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
