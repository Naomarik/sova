// Tests: the whisper-server supervisor's child and its HTTP surface, in-process (RuntimeDeps' spawn,
// fetchImpl and port). Each child behaves as scripts/fake-whisper-server.mjs does, read from the same
// argv and the same FAKE_WHISPER_* environment its spawn was given (the script's own contract, and the
// supervisor with real children: runtime.integration.test.ts). The options below override that
// environment, and add what only an in-process stand-in can: a held inference answers when the test
// releases it, never after a delay.
import type { spawn as nodeSpawn, SpawnOptions } from "node:child_process";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface FakeWhisperOptions {
  /** "transcribe": the Parakeet host's surface (raw WAV body, no fields). Else FAKE_WHISPER_ENGINE, or a .gguf -m. */
  engine?: "whisper" | "transcribe";
  /** /health answers 503 "loading model" this many times first (FAKE_WHISPER_LOAD_MS: for that long). */
  loadingChecks?: number;
  /** "start": exit 1 at once · "inference": each child exits 1 on its first /inference. Else FAKE_WHISPER_CRASH. */
  crash?: "start" | "inference";
  /** "health": never answer /health · "inference": never answer /inference (until aborted). Else FAKE_WHISPER_HANG. */
  hang?: "health" | "inference";
  /** Hold every /inference until the test releases it. */
  held?: boolean;
}

export interface FakeRequest {
  path: string;
  argv: string[];
  fields: Record<string, string>;
  bytes: number;
  contentType: string;
}

type Knobs = Record<string, string | undefined>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  /** /inference requests this child answered (or crashed on). */
  inferences = 0;
  readonly started = Date.now();
  constructor(
    readonly pid: number,
    readonly argv: string[],
    readonly env: Knobs,
  ) {
    super();
  }
  arg(name: string): string | undefined {
    const i = this.argv.indexOf(name);
    return i >= 0 && i + 1 < this.argv.length ? this.argv[i + 1] : undefined;
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
const reset = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

/** Deps for WhisperRuntime that answer in-process, and what the "server" saw. */
export function fakeWhisper(o: FakeWhisperOptions = {}) {
  const children: FakeChild[] = [];
  const byPort = new Map<number, FakeChild>();
  const requests: FakeRequest[] = [];
  const waiting: Array<() => void> = [];
  let nextPort = 51_000;
  let nextPid = 900_000;
  let loadingLeft = o.loadingChecks ?? 0;

  const engineOf = (c: FakeChild) => o.engine ?? (c.env.FAKE_WHISPER_ENGINE === "transcribe" || /\.gguf$/i.test(c.arg("-m") ?? "") ? "transcribe" : "whisper");
  const crashOf = (c: FakeChild) => o.crash ?? c.env.FAKE_WHISPER_CRASH;
  const hangOf = (c: FakeChild) => o.hang ?? c.env.FAKE_WHISPER_HANG;

  const spawn = ((_bin: string, args: readonly string[], opts?: SpawnOptions) => {
    const argv = [...args];
    const child = new FakeChild(nextPid++, argv, { ...(opts?.env ?? process.env) });
    children.push(child);
    const port = child.arg("--port");
    if (port) byPort.set(Number(port), child);
    setImmediate(() => {
      if (crashOf(child) === "start") {
        child.stderr.write("fake whisper-server: crashing at start\n");
        setImmediate(() => child.exit(1));
        return;
      }
      if (child.env.FAKE_WHISPER_DEVICE) child.stderr.write(`ggml_vulkan: 0 = ${child.env.FAKE_WHISPER_DEVICE} (fake) | uma: 1\n`);
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
    if (!child?.alive || crashOf(child) === "start") throw refused();
    if (url.pathname === "/health") {
      if (hangOf(child) === "health") return untilAborted(init?.signal);
      const loadMs = Number(child.env.FAKE_WHISPER_LOAD_MS ?? 0);
      if (loadingLeft > 0 || Date.now() - child.started < loadMs) {
        if (loadingLeft > 0) loadingLeft--;
        return Response.json({ status: "loading model" }, { status: 503 });
      }
      return Response.json({ status: "ok" });
    }
    if (req.method === "POST" && url.pathname === (child.arg("--inference-path") ?? "/inference")) {
      child.inferences++;
      const contentType = req.headers.get("content-type") ?? "";
      const engine = engineOf(child);
      const fields: Record<string, string> = {};
      let bytes = 0;
      if (engine === "transcribe") bytes = (await req.arrayBuffer()).byteLength;
      else if (contentType.startsWith("multipart/form-data")) {
        for (const [k, v] of await req.formData()) {
          if (typeof v === "string") fields[k] = v;
          else bytes = v.size;
        }
      }
      const seen: FakeRequest = { path: url.pathname, argv: child.argv, fields, bytes, contentType };
      requests.push(seen);
      if (child.env.FAKE_WHISPER_LOG) appendFileSync(child.env.FAKE_WHISPER_LOG, `${JSON.stringify(seen)}\n`);
      if (crashOf(child) === "inference" && child.inferences === 1) {
        child.stderr.write("fake whisper-server: crashing on inference\n");
        child.exit(1); // gone before its answer: the connection resets
        throw reset();
      }
      if (hangOf(child) === "inference") return untilAborted(init?.signal);
      if (engine === "transcribe" && !contentType.startsWith("audio/wav")) return Response.json({ error: "a WAV body with a Content-Length is required" }, { status: 400 });
      const vad = child.arg("-vm") ?? child.arg("--vad-model");
      if (engine === "whisper" && fields.vad === "true" && !vad) return Response.json({ error: "failed to process audio" }, { status: 500 });
      const text =
        engine === "transcribe"
          ? (child.env.FAKE_TRANSCRIBE_TEXT ?? "Open sofa and run the type check in the work tree.")
          : (child.env.FAKE_WHISPER_TEXT ?? "Open Sova, and run the type check in the worktree.");
      const textBy = child.env.FAKE_WHISPER_TEXT_BY ? Object.entries(JSON.parse(child.env.FAKE_WHISPER_TEXT_BY) as Record<string, string>) : [];
      const hit = textBy.find(([k]) => {
        const [f, v] = k.split("=");
        return fields[f!] === v;
      });
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
      const delay = Number(child.env.FAKE_WHISPER_DELAY_MS ?? 0);
      if (delay) await Promise.race([new Promise((r) => setTimeout(r, delay)), untilAborted(init?.signal)]);
      if (!child.alive) throw reset();
      return Response.json({ text: ` ${hit ? String(hit[1]) : text}\n` });
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
