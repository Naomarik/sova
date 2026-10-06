#!/usr/bin/env node
// perf-pi mock LLM: a paced, scripted OpenAI-compatible chat endpoint for scripts/perf-pi/run.mjs.
// It is scripts/harness-wire-e2e-mock-llm.mjs with two changes: replies are text only (no tool call, so
// one prompt is one model call), and they stream as --chunks deltas --gap ms apart, so a turn stays open
// long enough to steer into it. Loopback only; deterministic; no state but a counter. Each request's
// arrival time and body size go to stdout as JSON lines, so the harness can tell request-build time
// (prompt → request arrives here) from the rest of the turn.
//
//   node scripts/perf-pi/mock-llm.mjs --port 4879 [--chunks 8] [--gap 15]
//
// A compaction request (pi's summarization prompt) gets a short "## Goal" summary in one chunk.
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const PORT = Number(opt("port", "4879"));
const CHUNKS = Number(opt("chunks", "8"));
const GAP = Number(opt("gap", "15"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
createServer(async (req, res) => {
  // The harness's clock: wall time with sub-ms precision, comparable across the two processes.
  const clock = () => performance.timeOrigin + performance.now();
  const t0 = clock();
  let body = "";
  for await (const c of req) body += c;
  const id = ++n;
  let ask = {};
  try {
    ask = body ? JSON.parse(body) : {};
  } catch {}
  const messages = ask.messages ?? [];
  // pi's compaction asks as "a context summarization assistant" for "a structured summary".
  const text = JSON.stringify(messages.slice(0, 2)).toLowerCase();
  const summary = /summarization assistant|structured summary/.test(text);
  process.stdout.write(`${JSON.stringify({ id, at: t0, readMs: clock() - t0, bytes: body.length, messages: messages.length, summary })}\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
  chunk({ role: "assistant", content: "" });
  if (summary) {
    chunk({ content: "## Goal\nMeasure pi.\n\n## Progress\n- done\n" });
  } else {
    for (let i = 0; i < CHUNKS; i++) {
      chunk({ content: `part ${i} of a scripted reply. ` });
      if (GAP > 0) await sleep(GAP);
    }
  }
  chunk({}, { finish_reason: "stop" });
  res.write(`data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}).listen(PORT, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ ready: `http://127.0.0.1:${PORT}/v1` })}\n`));
