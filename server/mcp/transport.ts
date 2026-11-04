// A server's process and its messages, away from pi: a chat's copy (server/harness/pi/mcp.ts) and a Check
// (server/mcp/check-child.ts) both run a server through this. pi's own stdio transport isn't exported, and it
// can't hand a confined launch its fds.
import { spawn, type ChildProcess } from "node:child_process";

export type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** The basics a program needs. Everything else in Sova's environment stays out. */
export const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP)$/;

export function cleanMcpEnv(source: NodeJS.ProcessEnv, own: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && ENV_ALLOW.test(key)) env[key] = value;
  return { ...env, ...own };
}

export abstract class Events {
  private messages = new Set<(message: JsonRpc) => void>();
  private errors = new Set<(error: Error) => void>();
  private closes = new Set<() => void>();
  private closeSent = false;
  onMessage(listener: (message: JsonRpc) => void) {
    this.messages.add(listener);
    return () => void this.messages.delete(listener);
  }
  onError(listener: (error: Error) => void) {
    this.errors.add(listener);
    return () => void this.errors.delete(listener);
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => void this.closes.delete(listener);
  }
  protected emitMessage(message: JsonRpc) {
    for (const listener of [...this.messages]) listener(message);
  }
  protected emitError(error: Error) {
    for (const listener of [...this.errors]) listener(error);
  }
  protected emitClose() {
    if (this.closeSent) return;
    this.closeSent = true;
    for (const listener of [...this.closes]) listener();
  }
}

export interface Launch {
  argv: string[];
  env: Record<string, string>;
  fds?: { fd: number; data: string }[];
  sandboxed: boolean;
  /** Where it starts, when the launch knows better than the caller. */
  cwd?: string;
  dispose(): Promise<void>;
}

const STDERR_TAIL = 2_000;
const STOP_GRACE_MS = 500;
const live = new Set<number>();
let exitHook = false;

/** One server process on newline-delimited JSON-RPC. pi's own transport can't hand a confined launch its fds. */
export class StdioServer extends Events {
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private ended = false;
  stderr = "";
  constructor(private readonly launch: () => Promise<Launch>, private readonly cwd: string) {
    super();
  }
  get pid() {
    return this.child?.pid;
  }
  sandboxed = false;
  private disposeLaunch: (() => Promise<void>) | undefined;

  async start(): Promise<void> {
    const launch = await this.launch();
    this.sandboxed = launch.sandboxed;
    this.disposeLaunch = launch.dispose;
    const fds = launch.fds ?? [];
    const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"];
    for (const f of fds) {
      while (stdio.length <= f.fd) stdio.push("ignore");
      stdio[f.fd] = "pipe";
    }
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd ?? this.cwd, env: launch.env, stdio, detached: process.platform !== "win32" });
    this.child = child;
    for (const f of fds) (child.stdio[f.fd] as NodeJS.WritableStream | undefined)?.end(f.data);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error) => {
      await this.disposeLaunch?.();
      throw error;
    });
    const pid = child.pid;
    if (pid !== undefined) {
      live.add(pid);
      if (!exitHook) {
        exitHook = true;
        process.once("exit", () => {
          for (const group of live) try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
        });
      }
    }
    child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL); });
    child.stdin!.on("error", () => {});
    child.on("close", () => {
      if (pid !== undefined) live.delete(pid);
      void this.disposeLaunch?.();
      this.child = undefined;
      this.emitClose();
    });
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      try {
        this.emitMessage(JSON.parse(line) as JsonRpc);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async send(message: JsonRpc): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error("the server isn't running");
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve())));
  }

  /** Stdin first, as the spec asks, then the whole process group: wrappers like npx leave the server behind. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* gone */ } };
      const term = setTimeout(() => kill("SIGTERM"), STOP_GRACE_MS);
      const hard = setTimeout(() => kill("SIGKILL"), STOP_GRACE_MS * 4);
      child.once("close", () => {
        clearTimeout(term);
        clearTimeout(hard);
        kill("SIGTERM");
        resolve();
      });
      child.stdin?.end();
    });
  }
}
