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

const PREFIX = '{"updates":[{"personId":"p","field":"voice","to":"x","quote":"';
const SUFFIX = '"}]}';

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => sse({ id: "stub-1", object: "chat.completion.chunk", created: 0, model: "runaway", choices: [{ index: 0, delta, finish_reason: finish }] });
const argChunk = (args: string) => chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });

function fill(payload: StubScenario["payload"], n: number): string {
  const unit = payload === "whitespace" ? "\t\t  \t\t" : "abcdefghij";
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

export async function startStreamStub(initial: StubScenario, port = 0): Promise<{
  port: number;
  stats: StubStats;
  /** A new scenario: stats start again. */
  reset(s: StubScenario): void;
  close(): Promise<void>;
}> {
  let scenario = initial;
  const fresh = (): StubStats => ({ requests: 0, argChars: 0, startedAt: null, closedAt: null, finished: false });
  let stats = fresh();

  const runaway = (res: ServerResponse, st: StubStats, sc: StubScenario) => {
    st.startedAt = Date.now();
    res.on("close", () => (st.closedAt ??= Date.now()));
    res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_stub", type: "function", function: { name: sc.tool ?? "write_profile_updates", arguments: PREFIX } }] }));
    const piece = argChunk(fill(sc.payload, sc.perDelta));
    const pump = () => {
      while (!res.destroyed) {
        if (sc.limit !== undefined && st.argChars >= sc.limit) {
          res.write(argChunk(SUFFIX));
          res.write(chunk({}, "tool_calls"));
          res.end("data: [DONE]\n\n");
          st.finished = true;
          return;
        }
        // A batch per write keeps the stub cheap; each event is still its own delta.
        let batch = "";
        for (let i = 0; i < 16 && (sc.limit === undefined || st.argChars < sc.limit); i++) {
          batch += piece;
          st.argChars += sc.perDelta;
        }
        if (!res.write(batch)) return void res.once("drain", pump);
        if (sc.pauseMs) return void setTimeout(pump, sc.pauseMs);
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
      const st = stats;
      st.requests++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const sc = scenario;
      if (st.requests === 1) return sc.holdMs ? void setTimeout(() => !res.destroyed && runaway(res, st, sc), sc.holdMs) : runaway(res, st, sc);
      res.write(chunk({ role: "assistant", content: "Done." }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    get stats() {
      return stats;
    },
    reset(s) {
      scenario = s;
      stats = fresh();
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The `models.json` that registers the stub as provider `stub`, model `runaway`. */
export const stubModelsJson = (port: number) => ({
  providers: {
    stub: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
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
