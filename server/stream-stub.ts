import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

/**
 * A stub OpenAI-compatible chat-completions endpoint that streams a runaway tool call, for the
 * stream guard's tests and the SIGTERM check (server/stream-guard-runtime.test.ts). Registered
 * through a test `models.json` (`api: "openai-completions"`), so pi's real provider, SSE decoder,
 * JSON repair and abort path are the ones exercised.
 *
 * The first request of a scenario opens `tool_calls[0]` and streams argument characters — endless,
 * or up to `limit` and then a proper end — honouring backpressure ('drain'). Every later request
 * of the scenario (the turn after the tool's result) gets a one-line text reply.
 *
 * Two transports, one body: `startStreamStub` listens on 127.0.0.1 (the integration tests, and the
 * standalone run below); `inProcessStreamStub` answers its own base URL through `fetch` with no
 * socket (unit tests), its body produced only as the reader pulls it.
 *
 * Run standalone: `node --import tsx server/stream-stub.ts [port]` prints `{"port":N}` on stdout.
 */

export interface StubScenario {
  /** Raw whitespace (`\t\t  \t\t`…) inside a JSON string, or plain letters. */
  payload: "whitespace" | "letters";
  /** Argument characters per SSE event. */
  perDelta: number;
  /** Stop after this many argument characters and finish the call; endless when absent. */
  limit?: number;
  /** The tool the call names. */
  tool?: string;
  /** A pause after each batch of 16 events: a slow stream rather than a flood. */
  pauseMs?: number;
  /** Hold the response this long before its first byte (a model slow to answer). */
  holdMs?: number;
  /** The call's whole arguments (JSON text), sent at once and finished: a scripted tool call rather
      than a runaway one (`payload`, `perDelta` and `limit` are then unused). */
  args?: string;
}
export interface StubStats {
  requests: number;
  /** Argument characters written to the runaway stream. */
  argChars: number;
  startedAt: number | null;
  /** When the runaway response's connection closed (the client's abort reached the socket). */
  closedAt: number | null;
  /** Whether the runaway stream ran to its own end (`limit`) rather than being cut off. */
  finished: boolean;
}

export interface StreamStub {
  /** The listening port (0 for the in-process stub, which has none). */
  port: number;
  /** What a models.json `baseUrl` names. */
  baseUrl: string;
  stats: StubStats;
  /** A new scenario: stats start again. */
  reset(s: StubScenario): void;
  /** Resolves once the current scenario's runaway response is closed (cut off, or ended). */
  closed(): Promise<void>;
  close(): Promise<void>;
}

const PREFIX = '{"updates":[{"personId":"p","field":"voice","to":"x","quote":"';
const SUFFIX = '"}]}';
const DONE = "data: [DONE]\n\n";

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => sse({ id: "stub-1", object: "chat.completion.chunk", created: 0, model: "runaway", choices: [{ index: 0, delta, finish_reason: finish }] });
const argChunk = (args: string) => chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
const opening = (sc: StubScenario, args: string) => chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_stub", type: "function", function: { name: sc.tool ?? "write_profile_updates", arguments: args } }] });
/** Every request after the scenario's first: a one-line text reply. */
const REPLY = chunk({ role: "assistant", content: "Done." }) + chunk({}, "stop") + DONE;

function fill(payload: StubScenario["payload"], n: number): string {
  const unit = payload === "whitespace" ? "\t\t  \t\t" : "abcdefghij";
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

const fresh = (): StubStats => ({ requests: 0, argChars: 0, startedAt: null, closedAt: null, finished: false });

/** The runaway response's body, one write at a time, counted into `st` as it goes: `null` once it
    ended. `pause`: the write was a batch of events, after which the scenario may pause. */
function runawayBody(st: StubStats, sc: StubScenario): () => { text: string; pause: boolean } | null {
  let at: "open" | "body" | "ended" = "open";
  const piece = argChunk(fill(sc.payload, sc.perDelta));
  return () => {
    if (at === "ended") return null;
    if (sc.args !== undefined) {
      at = "ended";
      st.argChars = sc.args.length;
      st.finished = true;
      return { text: opening(sc, "") + argChunk(sc.args) + chunk({}, "tool_calls") + DONE, pause: false };
    }
    if (at === "open") {
      at = "body";
      return { text: opening(sc, PREFIX), pause: false };
    }
    if (sc.limit !== undefined && st.argChars >= sc.limit) {
      at = "ended";
      st.finished = true;
      return { text: argChunk(SUFFIX) + chunk({}, "tool_calls") + DONE, pause: false };
    }
    // A batch per write keeps the stub cheap; each event is still its own delta.
    let batch = "";
    for (let i = 0; i < 16 && (sc.limit === undefined || st.argChars < sc.limit); i++) {
      batch += piece;
      st.argChars += sc.perDelta;
    }
    return { text: batch, pause: true };
  };
}

/** Scenario and stats, shared by both transports. */
function stubState(initial: StubScenario) {
  let scenario = initial;
  let stats = fresh();
  let waiters: (() => void)[] = [];
  return {
    get scenario() {
      return scenario;
    },
    get stats() {
      return stats;
    },
    reset(s: StubScenario) {
      scenario = s;
      stats = fresh();
    },
    /** The runaway response of `st` closed. */
    closedNow(st: StubStats) {
      st.closedAt ??= Date.now();
      if (st !== stats) return;
      for (const w of waiters.splice(0)) w();
    },
    closed(): Promise<void> {
      return stats.closedAt !== null ? Promise.resolve() : new Promise((r) => waiters.push(r));
    },
  };
}

export async function startStreamStub(initial: StubScenario, port = 0): Promise<StreamStub> {
  const state = stubState(initial);

  const runaway = (res: ServerResponse, st: StubStats, sc: StubScenario) => {
    st.startedAt = Date.now();
    res.on("close", () => state.closedNow(st));
    const next = runawayBody(st, sc);
    const pump = () => {
      while (!res.destroyed) {
        const w = next();
        if (!w) return void res.end();
        if (!res.write(w.text)) return void res.once("drain", pump);
        if (w.pause && sc.pauseMs) return void setTimeout(pump, sc.pauseMs);
      }
    };
    pump();
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      const st = state.stats;
      st.requests++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const sc = state.scenario;
      if (st.requests === 1) return sc.holdMs ? void setTimeout(() => !res.destroyed && runaway(res, st, sc), sc.holdMs) : runaway(res, st, sc);
      res.end(REPLY);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    baseUrl: `http://127.0.0.1:${bound}/v1`,
    get stats() {
      return state.stats;
    },
    reset: (s) => state.reset(s),
    closed: () => state.closed(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * The same stub with no socket: while it is open, `globalThis.fetch` answers its base URL (a
 * `.invalid` host, so nothing could reach a network) with a streamed Response whose body is made
 * only as the reader pulls it, and passes every other URL on. The client's abort, or its cancel of
 * the body, is the socket's close. `close()` puts the previous fetch back.
 */
export function inProcessStreamStub(initial: StubScenario): StreamStub {
  const state = stubState(initial);
  const baseUrl = "http://stream-stub.invalid/v1";
  const encoder = new TextEncoder();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const answer = (url: string, method: string, signal: AbortSignal | null | undefined): Response => {
    if (method !== "POST" || !url.endsWith("/chat/completions")) return new Response(null, { status: 404 });
    const st = state.stats;
    st.requests++;
    const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
    if (st.requests !== 1) return new Response(REPLY, { headers });
    const sc = state.scenario;
    let next: ReturnType<typeof runawayBody> | null = null;
    let open = true;
    const shut = () => {
      if (!open) return;
      open = false;
      state.closedNow(st);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async start(controller) {
          if (sc.holdMs) await sleep(sc.holdMs);
          if (signal?.aborted) return void (open = false); // gone while held: never started, as over HTTP
          st.startedAt = Date.now();
          next = runawayBody(st, sc);
          signal?.addEventListener(
            "abort",
            () => {
              shut();
              try {
                controller.error(signal.reason);
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        },
        async pull(controller) {
          // Each write arrives as a socket read would, on its own turn of the event loop: a body
          // made of microtasks alone would starve every timer (and the abort) until it ended.
          await new Promise((r) => setImmediate(r));
          if (!open || !next) return;
          const w = next();
          if (!w) {
            shut();
            return controller.close();
          }
          controller.enqueue(encoder.encode(w.text));
          if (w.pause && sc.pauseMs) await sleep(sc.pauseMs);
        },
        cancel: shut,
      },
      { highWaterMark: 1 },
    );
    return new Response(body, { headers });
  };

  const real = globalThis.fetch;
  const routed = ((input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    if (!url.startsWith(baseUrl)) return real(input, init);
    return Promise.resolve(answer(url, (init?.method ?? req?.method ?? "GET").toUpperCase(), init?.signal ?? req?.signal));
  }) as typeof fetch;
  globalThis.fetch = routed;
  return {
    port: 0,
    baseUrl,
    get stats() {
      return state.stats;
    },
    reset: (s) => state.reset(s),
    closed: () => state.closed(),
    close: async () => {
      if (globalThis.fetch === routed) globalThis.fetch = real;
    },
  };
}

/** The `models.json` that registers the stub as provider `stub`, model `runaway`: by its port, or its base URL. */
export const stubModelsJson = (at: number | string) => ({
  providers: {
    stub: {
      baseUrl: typeof at === "number" ? `http://127.0.0.1:${at}/v1` : at,
      api: "openai-completions",
      apiKey: "stub",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "runaway", contextWindow: 131072, maxTokens: 8192 }],
    },
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startStreamStub({ payload: "whitespace", perDelta: 6 }, Number(process.argv[2] ?? 0));
  console.log(JSON.stringify({ port: stub.port }));
  setInterval(() => console.error(JSON.stringify(stub.stats)), 1000).unref();
  process.on("SIGTERM", () => void stub.close().then(() => process.exit(0)));
}
