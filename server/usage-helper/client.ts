import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * The server's side of the usage helper (§app.insights/usage-ledger): starts the child
 * (server/usage-helper/main.ts) with the server's own runtime, sends it one JSON line per request
 * and hands back its answer's bytes untouched. The only parsing on the server's loop is the
 * frame header (`<id> <status> <length>\n`); the answer itself goes to the HTTP response as is.
 * A dead helper is restarted (1 s, doubling to a minute); meanwhile every request answers 503.
 */

export interface HelperAnswer {
  status: number;
  body: Buffer;
}

export const UNAVAILABLE: HelperAnswer = { status: 503, body: Buffer.from(JSON.stringify({ error: "usage-unavailable" })) };

const REQUEST_TIMEOUT_MS = 60_000;
const ENTRY = path.join(import.meta.dirname, "main.ts");
/** Below the server and the agents' own turns: the helper's work is never urgent. */
const HELPER_NICE = 10;

export interface HelperOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** The command that runs a .ts file under this runtime (tests may point it elsewhere). */
  command?: { exe: string; args: string[] };
}

export interface UsageHelper {
  request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer>;
  /** True while a child is running. */
  running(): boolean;
  pid(): number | null;
  stop(): Promise<void>;
}

/** How this runtime runs a TypeScript entry: bun directly, node through tsx. */
export function runtimeCommand(entry: string): { exe: string; args: string[] } {
  if (process.versions.bun) return { exe: process.execPath, args: [entry] };
  return { exe: process.execPath, args: ["--import", "tsx", entry] };
}

export function startUsageHelper(opts: HelperOptions = {}): UsageHelper {
  const log = opts.log ?? ((l: string) => console.warn(`[usage-helper] ${l}`));
  const cmd = opts.command ?? runtimeCommand(ENTRY);
  let child: ChildProcess | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (a: HelperAnswer) => void; timer: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let backoff = 1_000;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const failAll = () => {
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.resolve(UNAVAILABLE);
      waiting.delete(id);
    }
  };

  const launch = () => {
    restartTimer = null;
    const startedAt = Date.now();
    const c = spawn(cmd.exe, cmd.args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    child = c;
    try {
      if (c.pid) os.setPriority(c.pid, HELPER_NICE);
    } catch {
      // Not allowed here: it runs at the server's priority.
    }
    let pendingBuf: Buffer = Buffer.alloc(0);
    let frame: { id: number; status: number; len: number } | null = null;
    c.stdout!.on("data", (chunk: Buffer) => {
      pendingBuf = pendingBuf.length ? Buffer.concat([pendingBuf, chunk]) : chunk;
      for (;;) {
        if (!frame) {
          const nl = pendingBuf.indexOf(10);
          if (nl < 0) return;
          const [id, status, len] = pendingBuf.subarray(0, nl).toString("latin1").split(" ").map(Number);
          pendingBuf = pendingBuf.subarray(nl + 1);
          frame = { id: id!, status: status!, len: len! };
        }
        if (pendingBuf.length < frame.len) return;
        const body = Buffer.from(pendingBuf.subarray(0, frame.len));
        pendingBuf = pendingBuf.subarray(frame.len);
        const w = waiting.get(frame.id);
        if (w) {
          clearTimeout(w.timer);
          waiting.delete(frame.id);
          w.resolve({ status: frame.status, body });
        }
        frame = null;
      }
    });
    c.stderr!.setEncoding("utf8");
    c.stderr!.on("data", (s: string) => {
      for (const line of s.split("\n")) if (line.trim()) console.warn(line);
    });
    c.stdin!.on("error", () => {});
    c.on("exit", (code, signal) => {
      if (child === c) child = null;
      failAll();
      if (stopped) return;
      // A helper that ran a while starts over at the short delay.
      if (Date.now() - startedAt > 60_000) backoff = 1_000;
      log(`helper exited (${signal ?? code}); restarting in ${Math.round(backoff / 1000)} s`);
      restartTimer = setTimeout(launch, backoff);
      restartTimer.unref?.();
      backoff = Math.min(backoff * 2, 60_000);
    });
    c.on("error", (err) => log(`helper failed to start: ${err.message}`));
  };
  launch();

  return {
    request(op, params = {}) {
      const c = child;
      if (!c || !c.stdin || c.stdin.destroyed) return Promise.resolve(UNAVAILABLE);
      const id = nextId++;
      return new Promise<HelperAnswer>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(UNAVAILABLE);
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        waiting.set(id, { resolve, timer });
        c.stdin!.write(`${JSON.stringify({ ...params, id, op })}\n`);
      });
    },
    running: () => child !== null,
    pid: () => child?.pid ?? null,
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      const c = child;
      if (!c) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const kill = setTimeout(() => c.kill("SIGKILL"), 5_000);
        c.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        c.stdin?.end();
      });
    },
  };
}

let shared: UsageHelper | null = null;

/** The server's helper: started once (server/index.ts), asked by the usage and cost routes. */
export function usageHelper(): UsageHelper | null {
  return shared;
}

export function startSharedUsageHelper(opts?: HelperOptions): UsageHelper {
  shared ??= startUsageHelper(opts);
  return shared;
}

export async function stopSharedUsageHelper(): Promise<void> {
  const h = shared;
  shared = null;
  await h?.stop();
}

/** Ask the shared helper; 503 when it isn't running. */
export function askUsage(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> {
  return shared ? shared.request(op, params) : Promise.resolve(UNAVAILABLE);
}
