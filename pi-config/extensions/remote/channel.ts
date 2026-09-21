/**
 * The pinned command channel: one long-lived far `sh` over its OWN ssh connection, serving one
 * command at a time, so a tool call pays one round trip instead of an ssh login.
 *
 * Its own connection, never the ControlMaster: a channel riding the master dies when anything runs
 * `ssh -O exit` on it (stdin write raised EPIPE), and ControlPersist can expire under it.
 *
 * Wire protocol (both directions survive arbitrary bytes):
 *   request   `<id> <byte-length>\n` + exactly that many bytes of script + `\n`. Length-prefixed,
 *             never marker-delimited: the script may contain anything but NUL.
 *   response  base64 of the command's stdout+stderr (so the only raw `\n@@pi-ch@@ ` on the wire is
 *             ours), then `\n@@pi-ch@@ <id> <rc>\n`.
 * Any framing mismatch POISONS the channel: it is torn down and never reused, and the outstanding
 * request is rejected so the caller can fall back to the per-call path. Abort and timeout also tear
 * it down: a killed command's late output would otherwise be attributed to the next request.
 *
 * Node builtins + argv.ts only (and exec.ts's RunResult type). It must also stay loadable by
 * `node <file>.ts` (strip-only type stripping, how workers' MCP servers are launched): no
 * parameter properties, enums or namespaces here, or in anything it imports.
 */
import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { awsSsmProxyCommand, buildTargetArgv, shPath, shQuote, type Target } from "./argv.ts";
import type { RunResult } from "./exec.ts";

export const CHANNEL_MARKER = "@@pi-ch@@";
const READY_LINE = `${CHANNEL_MARKER} ready\n`;
const TERM_PREFIX = `\n${CHANNEL_MARKER} `;
/** `<id> <rc>`, then in "separate" mode ` <base64 of the first 64 KB of stderr>`. */
const TERM_RE = /^@@pi-ch@@ (\S+) (\d+)(?: ([A-Za-z0-9+/=]*))?$/;
/** The terminator line is short (plus the stderr it may carry); anything longer before its `\n` is garbage. */
const TERM_MAX = 96 * 1024;
const NOISE_MAX = 64 * 1024;
const STDERR_CAP = 16 * 1024;
/** Far stderr kept in "separate" mode (exec.ts keeps the same). */
export const CHANNEL_STDERR_CAP = 64 * 1024;

export const CHANNEL_IDLE_MS = 120_000;
/** ssh's ConnectTimeout (10 s) + 5 s for the far loop to print its ready line. */
export const CHANNEL_START_TIMEOUT_MS = 15_000;
export const CHANNEL_WRITE_TIMEOUT_MS = 5_000;
export const CHANNEL_MAX_OUTPUT = 16 * 1024 * 1024;

/**
 * The far loop (POSIX sh; dash-safe). fd 3 keeps the channel's stdin for the watchdog, fd 4 the
 * channel's stdout for base64, fd 5 carries the exit code out of the pipeline's subshell, fd 6 is
 * the command's stderr: the response pipe ("m", merged) or a far file ("s", separate, sent base64
 * on the terminator line).
 *
 * The script goes to a file in a private temp dir, not into `sh -c`: a single argv string is capped
 * at 128 KB on Linux, and `write`'s content travels inside the script.
 *
 * The watchdog replaces argv.ts's `hangupGuard` here: that guard watches ITS stdin for EOF, which in
 * the channel is either /dev/null (fires at once) or the request stream (would steal requests). This
 * one reads the channel's stdin only while a command runs, when the client sends nothing, so it
 * wakes only on EOF (the ssh client was killed) and kills the command's process group. It is killed
 * and reaped before the terminator is printed, so it can never consume the next request.
 *
 * The request's trailing newline is left in the pipe, not read by the loop: `head -c` may over-read
 * on some hosts (busybox reads through stdio) and swallow it, and a blocking read for it would then
 * eat the next header. Empty lines are skipped by both the header read and the watchdog instead.
 */
export const CHANNEL_PROGRAM = [
	`D=$(mktemp -d 2>/dev/null) || { D=\${TMPDIR:-/tmp}/pi-ch.$$ && mkdir -m 700 "$D"; } || exit 126`,
	`trap 'rm -rf "$D"' EXIT`,
	`trap 'rm -rf "$D"; exit 129' HUP`,
	`trap 'rm -rf "$D"; exit 141' PIPE`,
	`trap 'rm -rf "$D"; exit 143' TERM`,
	`exec 3<&0 4>&1`,
	`printf x | base64 -w0 >/dev/null 2>&1 && printf xy | head -c 1 >/dev/null 2>&1 || { echo 'pi channel: the far side needs base64 -w0 and head -c' >&2; exit 127; }`,
	`if command -v setsid >/dev/null 2>&1; then S=setsid; else S=; fi`,
	`printf '%s ready\\n' '${CHANNEL_MARKER}'`,
	`while IFS=' ' read -r id n m; do`,
	`  [ -z "$id" ] && continue`,
	`  case $n in ''|*[!0-9]*) echo 'pi channel: bad request header' >&2; exit 2;; esac`,
	`  head -c "$n" >"$D/s" || exit 2`,
	`  rc=$( { { if [ "$m" = s ]; then exec 6>"$D/e"; else exec 6>&1; fi`,
	`    $S sh "$D/s" </dev/null 2>&6 3<&- 4>&- 5>&- 6>&- & p=$!`,
	`    { while IFS= read -r t <&3 && [ -z "$t" ]; do :; done; kill -TERM -$p 2>/dev/null || kill -TERM $p 2>/dev/null; } >/dev/null 2>&1 4>&- 5>&- 6>&- &`,
	`    w=$!`,
	`    wait $p; r=$?`,
	`    kill $w 2>/dev/null; wait $w 2>/dev/null`,
	`    echo $r >&5; } | base64 -w0 >&4; } 5>&1 )`,
	`  if [ "$m" = s ]; then printf '\\n%s %s %s ' '${CHANNEL_MARKER}' "$id" "$rc"; head -c ${CHANNEL_STDERR_CAP} "$D/e" | base64 -w0; printf '\\n'`,
	`  else printf '\\n%s %s %s\\n' '${CHANNEL_MARKER}' "$id" "$rc"; fi`,
	`done`,
].join("\n");

// ---------------------------------------------------------------------------
// argv

function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** The target whose ssh block carries `target` (itself, or the first ssh hop along `via`). */
function sshHop(target: Target, registry: readonly Target[] | undefined): Target | undefined {
	const seen = new Set<string>();
	let t: Target | undefined = target;
	while (t && !t.ssh && t.via && !seen.has(t.name)) {
		seen.add(t.name);
		t = registry?.find((x) => x.name === t!.via);
	}
	return t?.ssh ? t : undefined;
}

/**
 * The channel's own ssh connection. Ours go first because ssh takes the FIRST value of an option:
 * ControlMaster/ControlPath can't be overridden by the entry (its Control* options are dropped),
 * ConnectTimeout and ServerAlive* can.
 */
function channelSshPrefix(t: Target): string[] {
	const s = t.ssh!;
	const argv = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
	for (const o of s.options ?? []) {
		if (/^Control(Master|Path|Persist)[= ]/i.test(o)) continue;
		if (/^ProxyCommand[= ]/i.test(o) && t.proxy) continue;
		argv.push("-o", o);
	}
	if (t.proxy) argv.push("-o", `ProxyCommand=${awsSsmProxyCommand(t.proxy, s.key)}`);
	argv.push("-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2");
	if (s.port) argv.push("-p", String(s.port));
	if (s.key) argv.push("-i", expandHome(s.key));
	argv.push("--", s.user ? `${s.user}@${s.host}` : s.host);
	return argv;
}

/**
 * Spawn argv for a target's channel, or null when the target isn't reached over ssh (local docker
 * or incus: nothing to save). The far side is exactly what `buildTargetArgv` builds (environment
 * layers, `env`, `via` nesting) running CHANNEL_PROGRAM; only the ssh hop is swapped for our own.
 */
export function buildChannelArgv(target: Target, registry?: readonly Target[]): string[] | null {
	const hop = sshHop(target, registry);
	if (!hop) return null;
	const argv = buildTargetArgv(target, { command: CHANNEL_PROGRAM, cwd: "", registry });
	if (argv[0] !== "ssh") return null;
	return [...channelSshPrefix(hop), argv[argv.length - 1]!];
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const INPUT_END = "@PI_CH_IN@"; // '@' and '_' are outside the base64 alphabet

/**
 * The far script for one request: optional exports, `cd` into the far cwd, then the command (shell
 * code by design). `cwd` is a FAR path (`~/…` expands to the far $HOME). `env` is exported verbatim,
 * so pass only what you mean to send, never the local process.env. `input` becomes the command's
 * stdin (a base64 here-document, decoded on the far side); without it stdin is /dev/null.
 */
export function composeChannelScript(command: string, cwd?: string, env?: Record<string, string | undefined>, input?: Buffer | string): string {
	if (command.includes("\0")) throw new Error("NUL byte in command");
	let script = "";
	for (const [k, v] of Object.entries(env ?? {})) {
		if (v === undefined) continue;
		if (!ENV_KEY_RE.test(k)) throw new Error(`invalid environment variable name: ${k}`);
		script += `export ${k}=${shQuote(v)}\n`;
	}
	if (cwd) script += `cd -- ${shPath(cwd)} || exit 1\n`;
	if (input === undefined) return script + command;
	const lines = Buffer.from(input).toString("base64").replace(/.{1,76}/g, "$&\n");
	return `${script}base64 -d <<'${INPUT_END}' | {\n${lines}${INPUT_END}\n${command}\n}`;
}

/** One request on the wire; `separate` = stderr comes back on the terminator line, not in the stream. */
export function encodeRequest(id: string, script: string, separate = false): Buffer {
	const body = Buffer.from(script, "utf8");
	return Buffer.concat([Buffer.from(`${id} ${body.length} ${separate ? "s" : "m"}\n`), body, Buffer.from("\n")]);
}

// ---------------------------------------------------------------------------
// response parser

const B64 = new Uint8Array(256);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") B64[c.charCodeAt(0)] = 1;

export interface ResponseParserEvents {
	onData(data: Buffer): void;
	/** `stderr` is set in separate mode ("" when there was none). */
	onDone(rc: number, stderr?: Buffer): void;
	onPoison(why: string): void;
}

/**
 * Parses ONE response. The payload is base64, which has no `\n`, so the first non-base64 byte must
 * be the `\n` opening the terminator; the terminator is held (never emitted as data) until its own
 * `\n` arrives, so a marker split across reads is safe by construction. Base64 is decoded in
 * 4-byte-aligned slices and flushed to `onData` as it arrives.
 */
export class ResponseParser {
	private quads = "";
	private tail: string | null = null;
	private padded = false;
	private total = 0;
	private finished = false;

	private readonly id: string;
	private readonly events: ResponseParserEvents;
	private readonly maxOutput: number;
	private readonly separate: boolean;

	// Plain fields, not parameter properties: this file is loaded by children started as
	// `node <file>.ts`, and node's strip-only type stripping rejects parameter properties.
	constructor(id: string, events: ResponseParserEvents, maxOutput = CHANNEL_MAX_OUTPUT, separate = false) {
		this.id = id;
		this.events = events;
		this.maxOutput = maxOutput;
		this.separate = separate;
	}

	private poison(why: string): void {
		this.finished = true;
		this.events.onPoison(why);
	}

	feed(chunk: Buffer): void {
		if (this.finished) {
			if (chunk.length) this.poison("output after the terminator");
			return;
		}
		let i = 0;
		if (this.tail === null) {
			let j = 0;
			while (j < chunk.length && B64[chunk[j]!]) j++;
			if (j > 0 && !this.payload(chunk.toString("latin1", 0, j))) return;
			if (j === chunk.length) return;
			if (chunk[j] !== 0x0a) return this.poison(`non-base64 byte 0x${chunk[j]!.toString(16).padStart(2, "0")} in the response`);
			this.tail = "";
			i = j;
		}
		this.tail += chunk.toString("latin1", i);
		const nl = this.tail.indexOf("\n", 1);
		if (nl < 0) {
			const n = Math.min(this.tail.length, TERM_PREFIX.length);
			if (this.tail.slice(0, n) !== TERM_PREFIX.slice(0, n)) return this.poison("malformed terminator");
			if (this.tail.length > TERM_MAX) return this.poison("terminator too long");
			return;
		}
		const m = TERM_RE.exec(this.tail.slice(1, nl));
		const rest = this.tail.slice(nl + 1);
		if (!m) return this.poison("malformed terminator");
		if (m[1] !== this.id) return this.poison(`terminator for request ${m[1]} while ${this.id} is outstanding`);
		if (this.quads.length) return this.poison("truncated base64 payload");
		if ((m[3] !== undefined) !== this.separate) return this.poison("terminator doesn't match the request's stderr mode");
		this.finished = true;
		this.events.onDone(Number(m[2]), m[3] === undefined ? undefined : Buffer.from(m[3], "base64"));
		if (rest.length) this.poison("output after the terminator");
	}

	/** Base64 characters; false once poisoned. */
	private payload(chars: string): boolean {
		for (let k = 0; k < chars.length; k++) {
			const eq = chars.charCodeAt(k) === 0x3d;
			if (this.padded && !eq) {
				this.poison("base64 data after padding");
				return false;
			}
			if (eq) this.padded = true;
		}
		this.quads += chars;
		const whole = this.quads.length - (this.quads.length % 4);
		if (!whole) return true;
		const decoded = Buffer.from(this.quads.slice(0, whole), "base64");
		this.quads = this.quads.slice(whole);
		this.total += decoded.length;
		if (this.total > this.maxOutput) {
			this.poison(`output over ${Math.round(this.maxOutput / 1024 / 1024)} MB`);
			return false;
		}
		if (decoded.length) this.events.onData(decoded);
		return true;
	}
}

// ---------------------------------------------------------------------------
// the channel

export type ChannelState = "warming" | "idle" | "busy" | "dead";

/**
 * Why a run was refused or lost. `sent` = the request may have reached the far side, so the command
 * may have (partly) run: a caller re-running it over the per-call path should only do so when that
 * is acceptable (always for `sent: false`).
 */
export type ChannelErrorReason = "busy" | "not-ready" | "aborted" | "timeout" | "poisoned" | "lost" | "killed";

export class ChannelError extends Error {
	/** Mid-command loss reports no exit code. */
	readonly exitCode = null;
	readonly reason: ChannelErrorReason;
	readonly sent: boolean;
	constructor(reason: ChannelErrorReason, message: string, sent: boolean) {
		super(message);
		this.name = "ChannelError";
		this.reason = reason;
		this.sent = sent;
	}
}

export interface ChannelRunOptions {
	/** Shell code, run by `sh` on the far side in its own session. */
	command: string;
	/** FAR working directory; omitted/"" = the far login directory. */
	cwd?: string;
	/** Decoded output as it arrives: stdout and stderr merged, or stdout only with `separateStderr`. */
	onData?: (data: Buffer) => void;
	/** Keep stderr apart: it comes back (first 64 KB) in the result instead of the stream. */
	separateStderr?: boolean;
	/** The command's stdin (default /dev/null). */
	input?: Buffer | string;
	signal?: AbortSignal;
	/** Tear the channel down (and reject) after this many ms; 0/undefined = none. */
	timeoutMs?: number;
	/** Exported on the far side verbatim; see composeChannelScript. */
	env?: Record<string, string | undefined>;
}

export interface ChannelRunResult {
	/** A signal death is already 128 + signal (sh reports it that way). */
	exitCode: number;
	/** With `separateStderr`; otherwise "". */
	stderr: string;
}

export interface ChannelDeath {
	reason: ChannelErrorReason | "start-failed" | "idle";
	message: string;
	/**
	 * The connection itself was refused at start (ssh: "Connection refused"). On a reachable host that
	 * is its rate limit on new logins (ufw `limit`-style): back off 30-60 s without retrying, and don't
	 * count it as a broken channel. Per-call ssh over an existing ControlMaster keeps working meanwhile.
	 */
	refused?: boolean;
}

export type ChannelStateListener = (state: ChannelState, death?: ChannelDeath) => void;

export type ChannelSpawn = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface ChannelOptions {
	/** From buildChannelArgv (tests: a local `sh -c CHANNEL_PROGRAM`). */
	argv: readonly string[];
	spawn?: ChannelSpawn;
	idleMs?: number;
	startTimeoutMs?: number;
	writeTimeoutMs?: number;
	maxOutputBytes?: number;
	onState?: ChannelStateListener;
}

interface Outstanding {
	id: string;
	resolve: (r: ChannelRunResult) => void;
	reject: (e: ChannelError) => void;
	sent: boolean;
	cleanup: () => void;
}

/**
 * One pinned far shell. Lifecycle: new → start() → warming → idle ⇄ busy → dead. Dead is final:
 * make a new Channel to reconnect.
 */
export class Channel {
	private child: ChildProcessWithoutNullStreams | undefined;
	private _state: ChannelState | "new" = "new";
	private _death: ChannelDeath | undefined;
	private starting: Promise<void> | undefined;
	private startSettle: { resolve: () => void; reject: (e: Error) => void } | undefined;
	private startTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private idleMs: number;
	private noise = Buffer.alloc(0);
	private stderr = "";
	private seq = 0;
	private current: Outstanding | undefined;
	private parser: ResponseParser | undefined;
	private readonly listeners = new Set<ChannelStateListener>();
	private readonly opts: ChannelOptions;

	/** A channel for a target (not started), or null when it isn't reached over ssh. */
	static forTarget(target: Target, registry?: readonly Target[], opts: Omit<ChannelOptions, "argv"> = {}): Channel | null {
		const argv = buildChannelArgv(target, registry);
		return argv ? new Channel({ ...opts, argv }) : null;
	}

	constructor(opts: ChannelOptions) {
		this.opts = opts;
		this.idleMs = opts.idleMs ?? CHANNEL_IDLE_MS;
		if (opts.onState) this.listeners.add(opts.onState);
	}

	/** "new" until start() is called. */
	get state(): ChannelState | "new" {
		return this._state;
	}

	/** Why the channel died (undefined while alive). */
	get death(): ChannelDeath | undefined {
		return this._death;
	}

	/** Subscribe to state transitions; returns the unsubscribe function. */
	onState(listener: ChannelStateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isReady(): boolean {
		return this._state === "idle";
	}

	isBusy(): boolean {
		return this._state === "busy";
	}

	private setState(s: ChannelState): void {
		if (this._state === s) return;
		this._state = s;
		for (const l of this.listeners) l(s, s === "dead" ? this._death : undefined);
	}

	/** Spawn and wait for the far ready line. Idempotent; rejects if the channel dies first. */
	start(): Promise<void> {
		if (this.starting) return this.starting;
		this.starting = new Promise<void>((resolve, reject) => {
			this.startSettle = { resolve, reject };
		});
		this.starting.catch(() => {}); // callers that only watch state shouldn't see an unhandled rejection
		this.setState("warming");
		let child: ChildProcessWithoutNullStreams;
		try {
			child = (this.opts.spawn ?? ((f, a) => nodeSpawn(f, a, { stdio: ["pipe", "pipe", "pipe"] })))(this.opts.argv[0]!, this.opts.argv.slice(1));
		} catch (e) {
			this.teardown("start-failed", `channel spawn failed: ${(e as Error).message}`);
			return this.starting;
		}
		this.child = child;
		this.startTimer = setTimeout(
			() => this.teardown("start-failed", `channel not ready within ${(this.opts.startTimeoutMs ?? CHANNEL_START_TIMEOUT_MS) / 1000}s`),
			this.opts.startTimeoutMs ?? CHANNEL_START_TIMEOUT_MS,
		);
		child.stdout.on("data", (d: Buffer) => this.onStdout(d));
		// The loss is reported on "close" (all stdio drained), so ssh's stderr ("Connection refused", …)
		// is in the message; "end"/"exit" can fire before stderr is read. The timer covers a close that
		// never comes (a grandchild holding stderr open).
		let lostMsg: string | undefined;
		let lostTimer: NodeJS.Timeout | undefined;
		const lostSoon = (message: string) => {
			lostMsg ??= message;
			lostTimer ??= setTimeout(() => this.lost(lostMsg!), 250);
		};
		child.stdout.on("end", () => lostSoon("channel closed"));
		child.stderr.on("data", (d: Buffer) => {
			if (this.stderr.length < STDERR_CAP) this.stderr += d.toString("utf8");
		});
		child.stdin.on("error", (e) => this.teardown(this.current ? "lost" : "poisoned", `channel write failed: ${e.message}`));
		child.on("error", (e) => this.lost(`channel process error: ${e.message}`));
		child.on("exit", (code, sig) => lostSoon(`channel exited (${sig ?? `code ${code}`})`));
		child.on("close", (code, sig) => {
			if (lostTimer) clearTimeout(lostTimer);
			this.lost(code === null && sig === null ? (lostMsg ?? "channel closed") : `channel exited (${sig ?? `code ${code}`})`);
		});
		return this.starting;
	}

	private lost(message: string): void {
		const why = this.stderr.trim();
		const full = why ? `${message}: ${why}` : message;
		this.teardown(this._state === "warming" ? "start-failed" : this.current ? "lost" : "killed", full);
	}

	private onStdout(d: Buffer): void {
		if (this._state === "dead") return;
		if (this._state === "warming") {
			this.noise = Buffer.concat([this.noise, d]);
			const at = this.noise.indexOf(READY_LINE);
			if (at < 0) {
				if (this.noise.length > NOISE_MAX) this.teardown("start-failed", "no ready line from the far loop");
				return;
			}
			const rest = this.noise.subarray(at + READY_LINE.length);
			this.noise = Buffer.alloc(0);
			if (this.startTimer) clearTimeout(this.startTimer);
			this.startTimer = undefined;
			this.toIdle();
			this.startSettle?.resolve();
			this.startSettle = undefined;
			if (rest.length) this.onStdout(rest);
			return;
		}
		if (!this.parser) return this.teardown("poisoned", "unexpected output while idle");
		this.parser.feed(d);
	}

	private toIdle(): void {
		this.setState("idle");
		this.armIdle();
	}

	private armIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this._state !== "idle" || !(this.idleMs > 0)) return;
		this.idleTimer = setTimeout(() => this.teardown("idle", `closed after ${Math.round(this.idleMs / 1000)}s idle`), this.idleMs);
		this.idleTimer.unref();
	}

	/** Set the idle close delay (default 120 s) and re-arm it if idle now; 0 = never. */
	idleClose(ms: number = CHANNEL_IDLE_MS): void {
		this.idleMs = ms;
		this.armIdle();
	}

	/**
	 * Run one command. Refused (ChannelError "busy" / "not-ready", `sent: false`) unless idle: calls
	 * are never queued. Resolves with the far exit code (a signal death is already 128 + signal).
	 * Abort, timeout, poisoning and loss reject and leave the channel dead.
	 */
	run(o: ChannelRunOptions): Promise<ChannelRunResult> {
		if (this._state === "busy") return Promise.reject(new ChannelError("busy", "channel busy", false));
		if (this._state !== "idle") return Promise.reject(new ChannelError("not-ready", `channel ${this._state}`, false));
		if (o.signal?.aborted) return Promise.reject(new ChannelError("aborted", "aborted", false));
		let script: string;
		try {
			script = composeChannelScript(o.command, o.cwd, o.env, o.input);
		} catch (e) {
			return Promise.reject(e);
		}
		const id = String(++this.seq);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		return new Promise<ChannelRunResult>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			let writeTimer: NodeJS.Timeout | undefined;
			const onAbort = () => this.teardown("aborted", "aborted");
			const cur: Outstanding = {
				id,
				resolve,
				reject,
				sent: false,
				cleanup: () => {
					if (timer) clearTimeout(timer);
					if (writeTimer) clearTimeout(writeTimer);
					o.signal?.removeEventListener("abort", onAbort);
				},
			};
			this.current = cur;
			this.parser = new ResponseParser(
				id,
				{
					onData: (d) => o.onData?.(d),
					onDone: (rc, stderr) => {
						if (this.current !== cur) return;
						cur.cleanup();
						this.current = undefined;
						this.parser = undefined;
						this.toIdle();
						resolve({ exitCode: rc, stderr: stderr?.toString("utf8") ?? "" });
					},
					onPoison: (why) => this.teardown("poisoned", `channel poisoned: ${why}`),
				},
				this.opts.maxOutputBytes ?? CHANNEL_MAX_OUTPUT,
				!!o.separateStderr,
			);
			this.setState("busy");
			o.signal?.addEventListener("abort", onAbort, { once: true });
			if (o.timeoutMs) timer = setTimeout(() => this.teardown("timeout", `timed out after ${o.timeoutMs! / 1000}s`), o.timeoutMs);
			const request = encodeRequest(id, script, !!o.separateStderr);
			// 5 s, plus 1 s per MB for a large `write` payload
			const writeMs = (this.opts.writeTimeoutMs ?? CHANNEL_WRITE_TIMEOUT_MS) + Math.floor(request.length / 1_000_000) * 1000;
			writeTimer = setTimeout(() => this.teardown("poisoned", `request write not flushed within ${writeMs / 1000}s`), writeMs);
			cur.sent = true;
			this.child!.stdin.write(request, (err) => {
				if (writeTimer) clearTimeout(writeTimer);
				writeTimer = undefined;
				if (err) this.teardown("poisoned", `request write failed: ${err.message}`);
			});
		});
	}

	/**
	 * Buffered run shaped like exec.ts's `runArgv` (stdout and stderr apart), so both paths share one
	 * result mapping. Abort and timeout RESOLVE with `aborted`/`timedOut` (the channel is then dead).
	 * Throws ChannelError when refused (`sent: false`) or when the channel is lost or poisoned
	 * mid-command (`sent: true`, dead): the caller falls back to the per-call path.
	 */
	async exec(command: string, opts: { input?: Buffer | string; signal?: AbortSignal; timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
		const out: Buffer[] = [];
		try {
			const r = await this.run({ ...opts, command, separateStderr: true, onData: (d) => out.push(d) });
			return { code: r.exitCode, exitCode: r.exitCode, stdout: Buffer.concat(out), stderr: r.stderr, timedOut: false, aborted: false };
		} catch (e) {
			if (!(e instanceof ChannelError) || (e.reason !== "aborted" && e.reason !== "timeout")) throw e;
			return { code: null, exitCode: null, stdout: Buffer.concat(out), stderr: "", timedOut: e.reason === "timeout", aborted: e.reason === "aborted" };
		}
	}

	/** Tear down now; an outstanding run rejects with "killed". */
	kill(): void {
		this.teardown("killed", "channel killed");
	}

	/** Same as kill(). */
	close(): void {
		this.kill();
	}

	/** The one death path: mark dead, kill the ssh child, reject whatever is outstanding. */
	private teardown(reason: ChannelDeath["reason"], message: string): void {
		if (this._state === "dead") return;
		this._death = { reason, message };
		if (reason === "start-failed" && /Connection refused/i.test(message)) this._death.refused = true;
		if (this.startTimer) clearTimeout(this.startTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.startTimer = this.idleTimer = undefined;
		const child = this.child;
		if (child) {
			child.stdin.destroy();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				const hard = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, 2000);
				hard.unref();
			}
		}
		const cur = this.current;
		this.current = undefined;
		this.parser = undefined;
		this._state = "dead"; // before callbacks, so re-entrant calls see a dead channel
		if (cur) {
			cur.cleanup();
			const r: ChannelErrorReason = reason === "start-failed" || reason === "idle" ? "lost" : reason;
			cur.reject(new ChannelError(r, message, cur.sent));
		}
		this.startSettle?.reject(new ChannelError("not-ready", message, false));
		this.startSettle = undefined;
		for (const l of this.listeners) l("dead", this._death);
	}
}
