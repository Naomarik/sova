// The speech-server supervisor (§chat.voice/runtime): spawned on demand at a free loopback port,
// requests serialized with dictation ahead of calibration, unloaded after 15 idle minutes,
// restarted with backoff after a crash and given up on after 3 crashes in a minute. Never started
// at Sova boot. Two engines sit behind it: whisper.cpp's whisper-server, and transcribe.cpp
// through sova-transcribe-host (server/voice/transcribe-host.c), which answers the same
// /health and /inference.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { dirname } from "node:path";

export type EngineId = "whisper" | "transcribe";

export interface RuntimeConfig {
  /** Absent: whisper. */
  engine?: EngineId;
  binary: string;
  model: string;
  /** A CPU install: `--no-gpu`. */
  cpu: boolean;
  /** whisper: the Silero model for `-vm`, when installed (a request with `vad` fails without it). */
  vadModel?: string;
}

/** How one engine is launched and asked. */
export interface Engine {
  args(cfg: RuntimeConfig, port: number, threads: number): string[];
  /** The /inference request for one clip; `fields` are whisper's per-request form fields. */
  request(wav: Uint8Array, fields: Record<string, string>): { body: BodyInit; headers?: Record<string, string> };
}

export const ENGINES: Record<EngineId, Engine> = {
  whisper: {
    args(cfg, port, threads) {
      const args = ["--host", "127.0.0.1", "--port", String(port), "-m", cfg.model, "-t", String(threads), "--inference-path", "/inference"];
      if (cfg.vadModel) args.push("-vm", cfg.vadModel);
      if (cfg.cpu) args.push("--no-gpu");
      return args;
    },
    request(wav, fields) {
      const fd = new FormData();
      fd.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "clip.wav");
      fd.append("temperature", "0");
      fd.append("response_format", "json");
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return { body: fd };
    },
  },
  transcribe: {
    args(cfg, port, threads) {
      const args = ["--host", "127.0.0.1", "--port", String(port), "-m", cfg.model, "-t", String(threads), "--inference-path", "/inference"];
      if (cfg.cpu) args.push("--no-gpu");
      return args;
    },
    // No prompt, beam or VAD: the WAV is the whole request.
    request(wav) {
      return { body: new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), headers: { "Content-Type": "audio/wav" } };
    },
  },
};

/** What one clip asks for. A bare string is a prompt with every other setting at its default. */
export interface TranscribeRequest {
  /** whisper's per-request form fields beyond temperature and response_format. */
  fields?: Record<string, string>;
  /** dictation goes before any waiting calibration clip, and only dictation counts toward the queue cap. */
  lane?: "dictation" | "sweep";
  timeoutMs?: number;
}

export interface RuntimeDeps {
  spawn?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  /** Where the child's output goes, appended; truncated at each start. */
  logFile: string;
  /** The pid file a later boot reads to kill a leftover child. */
  runtimeFile: string;
  idleMs?: number;
  healthTimeoutMs?: number;
  backoffMs?: number[];
  env?: NodeJS.ProcessEnv;
}

export class RuntimeError extends Error {
  constructor(
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
/** One request in flight plus 2 waiting; the next is refused. */
const MAX_ACTIVE = 3;

export const IDLE_MS = 15 * 60_000;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** What the child's log said about the GPU: the device ggml found and whether whisper used it. */
export function gpuFromLog(lines: string[]): { device?: string; gpu: boolean } {
  let device: string | undefined;
  let gpu = false;
  for (const l of lines) {
    const dev = /ggml_(?:vulkan|cuda|metal)[^:]*: (?:0 = |found device: |GPU name:\s*)(.+?)(?: \(|\s*\||$)/.exec(l);
    if (dev && !device) device = dev[1]!.trim();
    if (/use gpu\s*=\s*1/.test(l)) gpu = true;
    if (/using (?:Vulkan|CUDA|Metal)\d* backend|ggml_metal_init: found device/i.test(l)) gpu = true;
  }
  return device ? { device, gpu } : { gpu };
}

export class WhisperRuntime {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  /** Children we killed on purpose: their exit is not a crash. */
  private readonly expected = new WeakSet<ChildProcess>();
  private crashes: number[] = [];
  private crashedOut = false;
  /** Dictation clips queued or running. */
  private active = 0;
  private readonly queue: { lane: "dictation" | "sweep"; run: () => Promise<void> }[] = [];
  private busy = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private tail: string[] = [];
  private runningEngine: EngineId = "whisper";
  private lastMs: number | undefined;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: () => RuntimeConfig | null,
    private readonly deps: RuntimeDeps,
  ) {
    this.spawnImpl = deps.spawn ?? nodeSpawn;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status() {
    const s: { running: boolean; starting: boolean; lastMs?: number; crashedOut: boolean } = {
      running: !!this.child && !this.starting,
      starting: !!this.starting,
      crashedOut: this.crashedOut,
    };
    if (this.lastMs !== undefined) s.lastMs = this.lastMs;
    return s;
  }

  /** The child's recent output lines (for the self-test's GPU check and failure messages). */
  logTail(): string[] {
    return [...this.tail];
  }

  /** After a repair or reinstall: crashes before it no longer count. */
  reset(): void {
    this.crashes = [];
    this.crashedOut = false;
  }

  /** Start loading now, while the user speaks; failures surface on the transcribe that follows. */
  warm(): void {
    this.touch();
    this.ensure().catch(() => {});
  }

  /** A dictation clip is waiting or running: a calibration sweep shows "paused for dictation". */
  dictationWaiting(): boolean {
    return this.active > 0;
  }

  /** The engine of the running (or next) child. */
  engine(): EngineId {
    return this.config()?.engine ?? "whisper";
  }

  async transcribe(wav: Uint8Array, request: string | TranscribeRequest, timeoutMs?: number): Promise<{ text: string; ms: number }> {
    const req: TranscribeRequest = typeof request === "string" ? { fields: request ? { prompt: request } : {} } : request;
    const lane = req.lane ?? "dictation";
    const timeout = timeoutMs ?? req.timeoutMs ?? 120_000;
    if (!this.config()) throw new RuntimeError(409, "Voice isn't set up on this host.");
    if (lane === "dictation" && this.active >= MAX_ACTIVE) throw new RuntimeError(503, "Two clips are already waiting. Try again in a moment.");
    if (lane === "dictation") this.active++;
    return new Promise((resolve, reject) => {
      this.queue.push({ lane, run: () => this.infer(wav, req.fields ?? {}, timeout, lane).then(resolve, reject) });
      this.pump();
    });
  }

  /** Restart the child at its next idle moment, behind any waiting dictation: after Silero first
      arrives, so the next start carries `-vm`. Nothing running: nothing to do. */
  restartWhenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ lane: "sweep", run: () => this.stop().then(resolve, resolve) });
      this.pump();
    });
  }

  /** Run the next clip: any dictation first, then calibration's. One at a time. */
  private pump(): void {
    if (this.busy) return;
    const at = this.queue.findIndex((q) => q.lane === "dictation");
    const [next] = this.queue.splice(at >= 0 ? at : 0, 1);
    if (!next) return;
    this.busy = true;
    void next.run().finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private async infer(wav: Uint8Array, fields: Record<string, string>, timeoutMs: number, lane: "dictation" | "sweep"): Promise<{ text: string; ms: number }> {
    try {
      await this.ensure();
      const engine = ENGINES[this.runningEngine];
      const { body, headers } = engine.request(wav, fields);
      const t0 = performance.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body, headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timedOut = (err as Error).name === "TimeoutError";
        // A calibration clip stuck in a fallback loop would hold the server's lock past its
        // timeout, and dictation behind it: restart the child instead (an expected stop).
        if (timedOut && lane === "sweep") await this.stop();
        throw new RuntimeError(503, timedOut ? "whisper-server didn't answer in time." : "whisper-server stopped unexpectedly.");
      }
      const answer = await res.text().catch(() => "");
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new RuntimeError(503, `whisper-server answered ${res.status}: ${answer.replace(/\s+/g, " ").slice(0, 200)}`);
      let json: { text?: unknown; error?: unknown };
      try {
        json = JSON.parse(answer) as typeof json;
      } catch {
        throw new RuntimeError(503, "whisper-server answered with something other than JSON.");
      }
      if (typeof json.error === "string") throw new RuntimeError(503, `whisper-server: ${json.error}`);
      if (lane === "dictation") this.lastMs = ms;
      return { text: String(json.text ?? ""), ms };
    } finally {
      if (lane === "dictation") this.active--;
      this.touch();
    }
  }

  /** Stop the child (idle unload, uninstall, shutdown). */
  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) return;
    this.expected.add(child);
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(t);
  }

  /** Synchronous last resort for process exit. */
  killNow(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      // gone
    }
  }

  /** A child a previous server left behind: killed only when its command line is our binary. */
  killOrphan(readCmdline: (pid: number) => string | null = procCmdline): boolean {
    let rec: { pid?: number; binary?: string } = {};
    try {
      rec = JSON.parse(readFileSync(this.deps.runtimeFile, "utf8")) as typeof rec;
    } catch {
      return false;
    }
    rmSync(this.deps.runtimeFile, { force: true });
    if (!rec.pid || !rec.binary || rec.pid === process.pid) return false;
    const cmd = readCmdline(rec.pid);
    if (!cmd || !cmd.includes(rec.binary)) return false;
    try {
      process.kill(rec.pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active === 0 && !this.busy && this.queue.length === 0) void this.stop();
    }, this.deps.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  private ensure(): Promise<void> {
    if (this.child && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.crashedOut) return Promise.reject(new RuntimeError(503, "whisper-server stopped 3 times in a minute. Repair to try again."));
    const cfg = this.config();
    if (!cfg) return Promise.reject(new RuntimeError(409, "Voice isn't set up on this host."));
    this.starting = this.start(cfg).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(cfg: RuntimeConfig): Promise<void> {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    const backoff = this.deps.backoffMs ?? [1000, 2000, 4000];
    const n = this.crashes.length;
    if (n > 0) await new Promise((r) => setTimeout(r, backoff[Math.min(n, backoff.length) - 1]));
    const port = await freePort();
    const threads = Math.max(1, Math.min(8, cpus().length));
    const args = ENGINES[cfg.engine ?? "whisper"].args(cfg, port, threads);
    mkdirSync(dirname(this.deps.logFile), { recursive: true });
    writeFileSync(this.deps.logFile, `# ${new Date().toISOString()} ${cfg.binary} ${args.join(" ")}\n`);
    this.tail = [];
    const child = this.spawnImpl(cfg.binary, args, { stdio: ["ignore", "pipe", "pipe"], env: this.deps.env ?? process.env, shell: false });
    this.child = child;
    this.port = port;
    this.runningEngine = cfg.engine ?? "whisper";
    const onData = (d: Buffer) => {
      const text = d.toString("utf8");
      try {
        appendFileSync(this.deps.logFile, text);
      } catch {
        // the log is best effort
      }
      for (const line of text.split("\n")) if (line.trim()) this.tail.push(line);
      if (this.tail.length > 300) this.tail.splice(0, this.tail.length - 300);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let exitedEarly = false;
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      rmSync(this.deps.runtimeFile, { force: true });
      exitedEarly = true;
      if (!this.expected.has(child)) {
        this.crashes.push(Date.now());
        this.crashes = this.crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
        if (this.crashes.length >= CRASH_LIMIT) this.crashedOut = true;
      }
    });
    if (child.pid) writeFileSync(this.deps.runtimeFile, JSON.stringify({ pid: child.pid, binary: cfg.binary, port, startedAt: Date.now() }));
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (spawnError) throw new RuntimeError(503, `whisper-server couldn't start: ${(spawnError as Error).message}`);
      if (exitedEarly) throw new RuntimeError(503, `whisper-server exited while loading. ${this.tail.slice(-2).join(" ").slice(0, 300)}`.trim());
      try {
        const res = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel().catch(() => {});
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.expected.add(child);
    child.kill("SIGKILL");
    if (this.child === child) this.child = null;
    throw new RuntimeError(503, "whisper-server didn't load the model within a minute.");
  }
}

function procCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return null;
  }
}
