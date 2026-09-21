/**
 * Run a composed target argv (see argv.ts) with no local shell: bounded by a timeout, killed by an
 * AbortSignal, stdin passed through. Node builtins only.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
	/** Written to the child's stdin, then closed. Without it stdin is closed immediately. */
	input?: Buffer | string;
	/** Keep stdin open (and empty) until the child exits: a far `hangupGuard` sees EOF only when the channel dies. */
	holdStdin?: boolean;
	signal?: AbortSignal;
	/** Kill after this many ms (0/undefined = none). */
	timeoutMs?: number;
	/** Stream stdout AND stderr here instead of buffering stdout (stderr is still kept, capped). */
	onData?: (data: Buffer) => void;
}

export interface RunResult {
	code: number | null;
	/** 128 + signal number when killed by a signal, else `code`. */
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

const STDERR_CAP = 64 * 1024;
const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };

export function runArgv(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (opts.signal?.aborted) {
			resolve({ code: null, exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true });
			return;
		}
		const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let hardKill: NodeJS.Timeout | undefined;
		const kill = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			hardKill ??= setTimeout(() => child.kill("SIGKILL"), 2000);
		};
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs)
			: undefined;
		const onAbort = () => {
			aborted = true;
			kill();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : out.push(d)));
		child.stderr.on("data", (d: Buffer) => {
			opts.onData?.(d);
			if (stderr.length < STDERR_CAP) stderr += d.toString("utf8");
		});
		child.stdin.on("error", () => {}); // EPIPE when the far side exits before reading
		if (!opts.holdStdin || opts.input !== undefined) child.stdin.end(opts.input ?? undefined);
		child.on("exit", () => child.stdin.destroy());
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			if (hardKill) clearTimeout(hardKill);
			opts.signal?.removeEventListener("abort", onAbort);
			reject(e);
		});
		child.on("close", (code, sig) => {
			if (timer) clearTimeout(timer);
			if (hardKill) clearTimeout(hardKill);
			opts.signal?.removeEventListener("abort", onAbort);
			const exitCode = code ?? (sig ? 128 + (SIGNALS[sig] ?? 0) : null);
			resolve({ code, exitCode, stdout: Buffer.concat(out), stderr, timedOut, aborted });
		});
	});
}
