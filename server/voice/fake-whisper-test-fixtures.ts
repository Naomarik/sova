// Tests: the whisper-server supervisor's child and its HTTP surface, in-process (RuntimeDeps' spawn,
// fetchImpl and port). It behaves as scripts/fake-whisper-server.mjs does (whose own contract, and the
// supervisor with real children: runtime.integration.test.ts), but every wait is the test's to end:
// a held inference answers when released, never after a delay.
import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface FakeWhisperOptions {
  /** "transcribe": the Parakeet host's surface (raw WAV body, no fields). */
  engine?: "whisper" | "transcribe";
  /** /health answers 503 "loading model" this many times first. */
  loadingChecks?: number;
  /** "start": exit 1 at once · "inference": each child exits 1 on its first /inference. */
  crash?: "start" | "inference";
  /** "health": never answer /health · "inference": never answer /inference (until aborted). */
  hang?: "health" | "inference";
  /** Hold every /inference until the test releases it. */
  held?: boolean;
}

export interface FakeRequest {
  argv: string[];
  fields: Record<string, string>;
  bytes: number;
  contentType: string;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  /** /inference requests this child answered (or crashed on). */
  inferences = 0;
  killed = false;
  constructor(
    readonly pid: number,
    readonly argv: string[],
  ) {
    super();
  }
  /** Ends now: its 'exit' lands on the next turn, as a real child's does. */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.killed) return false;
    this.killed = true;
    setImmediate(() => this.exit(null, signal));
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit("exit", code, signal);
  }
  get alive(): boolean {
    return this.exitCode === null && !this.killed;
  }
}

const refused = () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });

/** Deps for WhisperRuntime that answer in-process, and what the "server" saw. */
export function fakeWhisper(o: FakeWhisperOptions = {}) {
  const children: FakeChild[] = [];
  const byPort = new Map<number, FakeChild>();
  const requests: FakeRequest[] = [];
  const waiting: Array<() => void> = [];
  let nextPort = 51_000;
  let nextPid = 900_000;

  let loadingLeft = o.loadingChecks ?? 0;

  const spawn = ((_bin: string, args: readonly string[]) => {
    const argv = [...args];
    const child = new FakeChild(nextPid++, argv);
    children.push(child);
    const at = argv.indexOf("--port");
    if (at >= 0) byPort.set(Number(argv[at + 1]), child);
    setImmediate(() => {
      if (o.crash === "start") {
        child.stderr.write("fake whisper-server: crashing at start\n");
        setImmediate(() => child.exit(1));
        return;
      }
      child.stderr.write(`whisper_init_with_params_no_state: use gpu    = ${argv.includes("--no-gpu") ? 0 : 1}\n`);
    });
    return child;
  }) as unknown as typeof nodeSpawn;

  const untilAborted = (signal: AbortSignal | null | undefined) =>
    new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const child = byPort.get(Number(url.port));
    // A child that crashes at start never listens: nothing answers it, as for the real one.
    if (!child?.alive || o.crash === "start") throw refused();
    if (url.pathname === "/health") {
      if (o.hang === "health") return untilAborted(init?.signal);
      if (loadingLeft > 0) {
        loadingLeft--;
        return Response.json({ status: "loading model" }, { status: 503 });
      }
      return Response.json({ status: "ok" });
    }
    if (req.method === "POST" && url.pathname === "/inference") {
      child.inferences++;
      const contentType = req.headers.get("content-type") ?? "";
      const engine = o.engine ?? "whisper";
      let fields: Record<string, string> = {};
      let bytes = 0;
      if (engine === "transcribe") bytes = (await req.arrayBuffer()).byteLength;
      else if (contentType.startsWith("multipart/form-data")) {
        for (const [k, v] of await req.formData()) {
          if (typeof v === "string") fields[k] = v;
          else bytes = v.size;
        }
      }
      requests.push({ argv: child.argv, fields, bytes, contentType });
      if (o.crash === "inference" && child.inferences === 1) {
        child.stderr.write("fake whisper-server: crashing on inference\n");
        child.exit(1); // gone before its answer: the connection resets
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      if (o.hang === "inference") return untilAborted(init?.signal);
      if (engine === "transcribe" && !contentType.startsWith("audio/wav")) return Response.json({ error: "a WAV body with a Content-Length is required" }, { status: 400 });
      const vad = child.argv.includes("-vm") || child.argv.includes("--vad-model");
      if (engine === "whisper" && fields.vad === "true" && !vad) return Response.json({ error: "failed to process audio" }, { status: 500 });
      if (o.held) {
        let go!: () => void;
        const answered = new Promise<void>((r) => (go = r));
        waiting.push(go);
        // An aborted request (its limit) is no longer held: it leaves the queue.
        await Promise.race([answered, untilAborted(init?.signal)]).finally(() => {
          const at = waiting.indexOf(go);
          if (at >= 0) waiting.splice(at, 1);
        });
      }
      if (!child.alive) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      const text = engine === "transcribe" ? "Open sofa and run the type check in the work tree." : "Open Sova, and run the type check in the worktree.";
      return Response.json({ text: ` ${text}\n` });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    deps: { spawn, fetchImpl, port: async () => nextPort++ },
    children,
    requests,
    /** Held inferences waiting for their answer. */
    held: () => waiting.length,
    /** Let the oldest held inference answer. */
    release: () => waiting.shift()?.(),
  };
}
