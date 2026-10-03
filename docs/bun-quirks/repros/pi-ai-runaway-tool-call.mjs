// For upstream (pi-ai, not Bun): a runaway tool call costs O(n²) and outlives its abort by a whole
// network read.
//
//   PI_AI=<path to @earendil-works/pi-ai> node pi-ai-runaway-tool-call.mjs
//   PI_AI=<path to @earendil-works/pi-ai> bun  pi-ai-runaway-tool-call.mjs
//
// A local OpenAI-compatible endpoint streams one tool call whose arguments are endless whitespace,
// 16 characters per delta. The consumer aborts at the 512th tool-call delta (8 KiB of arguments).
//   1. parseStreamingJson re-parses the WHOLE accumulated argument string on every delta (repairJson,
//      then partial-json): per-delta cost grows with the arguments, so a call costs O(n²).
//   2. After abort(), every event of the network read already in hand is still parsed (each at that
//      O(n)); the signal is only consulted between reads. Node's fetch reads 64 KiB at a time (~75
//      more deltas); Bun 1.4.2's reads 128-256 KiB (~670 more), so the same abort costs ~4x more there.
// Expected: the stream stops within a delta or two of abort(), and per-delta parse cost doesn't
// grow with the argument length.
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_AI;
if (!root) throw new Error("set PI_AI to the @earendil-works/pi-ai package directory");
const { streamSimple } = await import(pathToFileURL(join(root, "dist/api/openai-completions.js")).href);
const { parseStreamingJson } = await import(pathToFileURL(join(root, "dist/utils/json-parse.js")).href);

// 1. The parse cost per delta at growing argument lengths.
for (const n of [1024, 4096, 16384]) {
  const s = `{"text":"${"\t\t  \t\t".repeat(n / 6)}`;
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) parseStreamingJson(s);
  console.log(`parseStreamingJson at ${n} chars: ${((performance.now() - t0) / 100).toFixed(3)} ms per delta`);
}

// 2. Deltas parsed after abort().
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta) => sse({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: null }] });
const server = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: '{"text":"' } }] }));
  const piece = chunk({ tool_calls: [{ index: 0, function: { arguments: "\t\t  \t\t\t\t  \t\t\t\t  \t" } }] });
  const pump = () => {
    if (res.destroyed) return;
    while (res.write(piece.repeat(64)));
    res.once("drain", pump);
  };
  pump();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const model = { id: "m", name: "m", api: "openai-completions", provider: "local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const ac = new AbortController();
let deltas = 0;
let afterAbort = 0;
const t0 = performance.now();
const events = streamSimple(model, { messages: [{ role: "user", content: "go", timestamp: 0 }] }, { apiKey: "x", signal: ac.signal });
for await (const ev of events) {
  if (ev.type !== "toolcall_delta") continue;
  deltas++;
  if (ac.signal.aborted) afterAbort++;
  else if (deltas === 512) ac.abort();
}
console.log(`${deltas} deltas, ${afterAbort} of them after abort(), ${(performance.now() - t0).toFixed(0)} ms`);
server.closeAllConnections();
server.close();
