/**
 * One session's connection to a target: the probe, the status, and THE choke point every far
 * command goes through — the pinned channel (channel.ts) when it is up and idle, else a per-call
 * ssh, with the channel's whole policy (lazy warm, hold after a teardown, failure cooldown, login
 * rate-limit backoff) in one place.
 *
 * This is index.ts's `Remote` minus everything local: no cwd, no path mapping, no pi tool
 * operations. `Remote extends Connection` adds those; remote/mcp-server.ts (the workers' MCP server)
 * uses Connection directly, which is why this file must stay:
 *  - pi-runtime-free — node builtins, argv.ts, exec.ts and channel.ts only, NEVER
 *    @earendil-works/pi-coding-agent (hence `agentDir` as a dep instead of pi's `getAgentDir()`);
 *  - loadable by `node <file>.ts` (strip-only type stripping), like channel.ts: no parameter
 *    properties, enums or namespaces.
 *
 * The far working directory is given once, by the caller (`farCwd`): the extension derives it from
 * the session's local cwd (the placeholder), a worker's MCP server gets it in its identity.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { buildTargetArgv, hangupGuard, shQuote, type Target } from "./argv.ts";
import { buildChannelArgv, Channel } from "./channel.ts";
import { type RunOptions, type RunResult, runArgv } from "./exec.ts";

const PREFLIGHT_TIMEOUT_MS = 20_000;
/** A failed preflight is re-tried after this long; until then tools fail at once with the cached error. */
const RETRY_AFTER_MS = 15_000;
const OP_TIMEOUT_MS = 120_000;
const MARKER = "@@pi-remote@@";
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
/** Scripts larger than this go per call: they are sent whole in one request. */
const CHANNEL_MAX_SCRIPT = 100 * 1024;

export interface FarInfo {
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

/** Where targets.json lives when the caller didn't say (pi's own default, spelled out: `getAgentDir()` is runtime-only). */
export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * The connection status, published as a pair by the extension (see index.ts `publish`):
 * `setStatus("remote", <prose>)` for the TUI status bar, and
 * `setStatus("remote-status", JSON.stringify(<this>))`, which pi-web's chip renders.
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

/** What a Connection needs from the pinned channel (channel.ts, adapted by `channelOver`). */
export interface ChannelLike {
	readonly state: ChannelState;
	/** Rejects when the channel could not start; `refused: true` on the error = the host refused the login (rate limit). */
	start(): Promise<void>;
	/** Resolves with a RunResult (stdout and stderr apart; aborted/timedOut set); rejects when the channel broke. */
	run(command: string, opts: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }): Promise<RunResult>;
	/** Idle close delay in ms (0 = never); optional — a fake channel in a test need not have it. */
	idleClose?(ms: number): void;
	close(): void;
}

export type ChannelFactory = (onState: (s: ChannelState) => void) => ChannelLike;

export interface ConnectionDeps {
	/** Per-call spawn (exec.ts runArgv); tests swap it for a counter. */
	exec?: (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;
	/**
	 * The pinned channel: a factory, or `false` for none (the `--no-channel` kill switch, a target
	 * with no ssh hop). Omitted = the target's own channel, built here.
	 */
	channel?: ChannelFactory | false;
	/** The clock (default Date.now); tests move it. */
	now?: () => number;
	/** Status re-emit period while a command runs (default STATUS_TICK_MS). */
	statusTickMs?: number;
	/** Called on every emit (the extension's `publish` forwards it to both setStatus keys). */
	onStatus?: (s: RemoteStatus) => void;
	/** Connection events worth a toast: first loss, recovery. */
	onEvent?: (text: string, level: "info" | "error") => void;
	/** pi's agent dir (targets.json, placeholder roots); default $PI_CODING_AGENT_DIR or ~/.pi/agent. */
	agentDir?: string;
}

/** Adapt channel.ts's Channel, spawned from `argv`, to what a Connection needs. */
export function channelOver(argv: readonly string[]): ChannelFactory {
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
			run: (command, { signal, timeoutMs, cwd }) => ch.exec(command, { signal, timeoutMs, cwd }),
			idleClose: (ms: number) => ch.idleClose(ms),
			close: () => ch.kill(),
		};
	};
}

/** The target's channel factory; undefined when it has no ssh hop (nothing to pin). */
export function channelFactory(target: Target, registry: readonly Target[]): ChannelFactory | undefined {
	const argv = buildChannelArgv(target, registry);
	return argv ? channelOver(argv) : undefined;
}

export interface ConnectionRunOptions extends RunOptions {
	/** Return the RunResult on a non-zero far exit code instead of throwing its stderr. */
	allowFail?: boolean;
}

export class Connection {
	readonly target: Target;
	readonly registry: Target[];
	/** The far working directory this session works in; undefined = the far login directory. */
	readonly farCwd: string | undefined;
	readonly agentDir: string;
	protected readonly deps: ConnectionDeps;
	protected info?: FarInfo;
	private pending?: Promise<FarInfo>;
	private failure?: { error: Error; at: number };
	private readonly execArgv: NonNullable<ConnectionDeps["exec"]>;
	private readonly makeChannel: ChannelFactory | undefined;
	private channel?: ChannelLike;
	private channelFailures: number[] = [];
	private channelSkipUntil = 0;
	/** No reopen before this (abort/timeout/poison teardown + CHANNEL_REOPEN_AFTER_MS). */
	private channelHoldUntil = 0;
	/** Set while the host refuses channel logins: {until, the ssh line}. */
	private rateLimited?: { until: number; error: string };
	/** `/remote reconnect`: the next warm ignores the hold and the rate-limit backoff, once. */
	private bypassOnce = false;
	/** Idle close delay for channels this connection opens; undefined = channel.ts's default. */
	private idleMs?: number;
	private lastOkAt = 0;
	private latencyMs?: number;
	private readonly running = new Map<number, number>();
	private runSeq = 0;
	private tick?: NodeJS.Timeout;
	private showRunning = false;
	/** Last state we told the user about (toasts only on transitions). */
	private announced: RemoteStatus["state"] = "unknown";

	constructor(target: Target, registry: Target[], farCwd: string | undefined, deps: ConnectionDeps = {}) {
		this.target = target;
		this.registry = registry;
		this.farCwd = farCwd;
		this.deps = deps;
		this.agentDir = deps.agentDir ?? defaultAgentDir();
		this.execArgv = deps.exec ?? runArgv;
		// Omitted = this target's own channel; `false` = none at all.
		this.makeChannel = deps.channel === undefined ? channelFactory(target, registry) : deps.channel === false ? undefined : deps.channel;
	}

	protected now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	get label(): string {
		return this.target.label || this.target.name;
	}

	/** The far info once the probe has answered (undefined before, and after a loss). */
	get farInfo(): FarInfo | undefined {
		return this.info;
	}

	argv(command: string, cwd?: string): string[] {
		return buildTargetArgv(this.target, { command, cwd: cwd ?? "", registry: this.registry });
	}

	protected unreachable(r: RunResult | Error): Error {
		const why = r instanceof Error ? r.message : r.timedOut ? `no answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s` : r.stderr.trim() || `exit code ${r.exitCode}`;
		return new Error(`Target "${this.target.name}" (${describeTarget(this.target)}) is unreachable: ${why}`);
	}

	protected get isSsh(): boolean {
		return !!(this.target.ssh || this.target.via);
	}

	// -------------------------------------------------------------------------
	// status

	status(): RemoteStatus {
		const now = this.now();
		const failed = !!this.failure && !this.info;
		const channelState: RemoteStatus["channelState"] = this.rateLimited ? "rate-limited" : (this.channel?.state ?? (this.makeChannel ? "off" : undefined));
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

	/** `/remote status`: publish the current status again, as is (no round trip, no toast). A reopened client has missed the last emit. */
	republish() {
		this.deps.onStatus?.(this.status());
	}

	/** Publish the status now (every transition, run outcome and running tick calls this); toast on first loss and on recovery. */
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

	private static readonly PROBE = `printf '%s\\n' ${shQuote(MARKER)}; id -un; uname -n 2>/dev/null || echo unknown; printf '%s\\n' "$HOME"; pwd`;

	/** One line per field after the marker; `uname -n` (not `hostname`, absent from minimal images)
	    always yields a line so the positions never shift. */
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
		const t0 = Date.now();
		this.pending = this.execArgv(this.argv(Connection.PROBE, this.farCwd), { timeoutMs: PREFLIGHT_TIMEOUT_MS })
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
			const r = await this.execArgv(this.argv(Connection.PROBE, this.info?.cwd ?? this.farCwd), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
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
		return !!this.makeChannel && this.isSsh && this.now() >= this.channelSkipUntil;
	}

	/** Idle close delay for the channel (0 = never; workers pass 0). Applies to the live one too. */
	idleClose(ms: number): void {
		this.idleMs = ms;
		this.channel?.idleClose?.(ms);
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
		const ch = this.makeChannel!((state) => {
			if (this.channel !== ch) return;
			// "dead" is an abort/timeout/poison/loss teardown (an idle close reads "off"): hold the reopen.
			if (state === "dead") this.channelHoldUntil = this.now() + CHANNEL_REOPEN_AFTER_MS;
			this.emit();
		});
		this.channel = ch;
		if (this.idleMs !== undefined) ch.idleClose?.(this.idleMs);
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
	 * Both lanes run in `farCwd`, so a command cannot behave differently depending on which one served it.
	 */
	private async dispatch(command: string, opts: RunOptions): Promise<RunResult & { viaChannel?: boolean }> {
		const ch = this.channel;
		if (ch && ch.state === "idle" && this.channelUsable() && opts.input === undefined && !opts.onData && !opts.holdStdin && command.length <= CHANNEL_MAX_SCRIPT) {
			try {
				return { ...(await ch.run(command, { signal: opts.signal, timeoutMs: opts.timeoutMs, cwd: this.farCwd })), viaChannel: true };
			} catch {
				if (opts.signal?.aborted) return { code: null, exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true };
				this.channelFailed(ch);
			}
		}
		return this.execArgv(this.argv(command, this.farCwd), opts);
	}

	/** Run far shell code for a file operation; throws with the far stderr on failure. */
	async run(command: string, opts: ConnectionRunOptions = {}): Promise<RunResult> {
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

	/**
	 * The user's shell command, in `cwd` (a FAR path; omitted = this session's farCwd). Always per
	 * call, never the channel: streaming
	 * output and killing the far process group on abort need their own connection (`hangupGuard` +
	 * `holdStdin`). Throws "aborted" / "timeout:<sec>", the two pi's bash operations expect.
	 */
	async bash(command: string, cwd?: string, opts: { onData?: (d: Buffer) => void; signal?: AbortSignal; timeoutSec?: number } = {}): Promise<{ exitCode: number | null }> {
		await this.ready(opts.signal);
		const id = this.begin();
		let r: RunResult;
		try {
			r = await this.execArgv(this.argv(hangupGuard(command), cwd ?? this.farCwd), {
				onData: opts.onData,
				signal: opts.signal,
				timeoutMs: opts.timeoutSec ? opts.timeoutSec * 1000 : undefined,
				holdStdin: true,
			});
		} finally {
			this.end(id);
		}
		if (r.aborted) throw new Error("aborted");
		if (r.timedOut) throw new Error(`timeout:${opts.timeoutSec}`);
		// 255 is also an ordinary exit code of the user's command, so it only marks the target
		// unreachable when ssh said so (stderr), not on the code alone.
		if (!(r.exitCode === 255 && this.isSsh && /^ssh: |Connection (closed|refused|timed out)|Could not resolve/m.test(r.stderr))) this.noteOk();
		return { exitCode: r.exitCode };
	}
}
