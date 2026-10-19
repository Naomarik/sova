#!/usr/bin/env node
// harness-wire-e2e-mock-llm: a scripted OpenAI-compatible chat endpoint, so scripts/harness-wire-e2e.mjs
// can drive a turn with no credentials and no network. Loopback only; it keeps no state but a counter.
//
//   node scripts/harness-wire-e2e-mock-llm.mjs [port]     # default 48732; 0 takes a free port
//
// Once listening it prints `mock llm on http://127.0.0.1:<port>/v1`, then `listening <port>` with
// the port it bound (the one to read when it was started on 0: server/testing/hermetic-server.ts).
//
// Then give the server under test a provider for it, in its agent dir's models.json (a hermetic one,
// never ~/.pi/agent):
//   { "providers": { "mock": { "baseUrl": "http://127.0.0.1:48732/v1", "api": "openai-completions",
//     "apiKey": "mock", "models": [{ "id": "m1", "contextWindow": 100000, "maxTokens": 4000 }] } } }
// and pass `--model mock/m1` to the e2e script. A request whose history has no tool result gets a short
// text and a `read` call on package.json; one that has a tool result gets a three-part text reply. Both
// report usage, so the reply carries a context fill.
//
// Opt-in, for a test that needs a reply still streaming (server/chat-actions.integration.test.ts): a
// request whose last user message contains `[[slow]]` gets a text-only reply in 60 parts, 500 ms
// apart (half a minute), and stops writing when the caller hangs up. Every other request is
// answered exactly as above.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 48732);
let n = 0;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  let ask = {};
  try {
    ask = body ? JSON.parse(body) : {};
  } catch {
    // not JSON: answered as a first request
  }
  const toolDone = (ask.messages ?? []).some((m) => m.role === "tool");
  const lastUser = [...(ask.messages ?? [])].reverse().find((m) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
  const usage = (prompt, completion) => res.write(`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", created: 1, model: "m1", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`);
  n++;
  if (lastUserText.includes("[[slow]]")) {
    let gone = false;
    res.on("close", () => (gone = true));
    for (let i = 0; i < 60 && !gone; i++) {
      chunk({ content: `part ${i + 1} ` });
      await new Promise((r) => setTimeout(r, 500));
    }
    if (gone) return;
    chunk({}, { finish_reason: "stop" });
    usage(1000, 60);
    res.end("data: [DONE]\n\n");
    return;
  }
  if (!toolDone) {
    chunk({ role: "assistant", content: "Reading it." });
    chunk({ tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "read", arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"package.json"}' } }] });
    chunk({}, { finish_reason: "tool_calls" });
    usage(900, 20);
  } else {
    for (const part of ["The package ", "name is in ", "package.json."]) chunk({ content: part });
    chunk({}, { finish_reason: "stop" });
    usage(1000, 12);
  }
  res.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  console.log(`mock llm on http://127.0.0.1:${bound}/v1`);
  console.log(`listening ${bound}`);
});
