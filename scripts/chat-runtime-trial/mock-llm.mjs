#!/usr/bin/env node
// chat-runtime-trial mock LLM: a scripted OpenAI-compatible chat endpoint that outlives the server
// under test, so a reply can stream across a server restart with no credentials and no network.
// Loopback only. Every request is appended to a JSON-lines log, which is what the trial counts: how
// many times a reply was asked for, and whether any request carried the "server restarted" resume
// text (it must not, for a chat whose process survived).
//
//   node scripts/chat-runtime-trial/mock-llm.mjs --port <n> --log <file.jsonl>
//
// Give the server under test a provider for it in its (hermetic) agent dir's models.json, as
// lib.mjs modelsJson(port) builds, and use the model `trial/m1`.
//
// The newest user message's text picks the answer (tags may sit anywhere in it):
//   [long N]   N text parts, one every --step ms (default 500), then "REPLY-DONE <id>" where <id>
//              is the tag's optional `#id` ([long 40 #a1]); the trial waits for that line
//   [spawn]    first a call to agent_spawn starting one pi worker on trial/m1 whose prompt is
//              "[long 60 #worker] worker", then (once the tool answered) a short text
//   [ask]      first a call to the trial_ask tool (trial-dialog.ts: it opens a confirm dialog), then
//              a text quoting the tool's answer
//   anything else: "ok"
// A request whose newest message is a tool result gets the scenario's closing text.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const port = Number(opt("port", "48740"));
const log = opt("log", "");
const step = Number(opt("step", "500"));

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  let ask = {};
  try {
    ask = body ? JSON.parse(body) : {};
  } catch {}
  const msgs = ask.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser?.content);
  const last = msgs[msgs.length - 1];
  const afterTool = last?.role === "tool";
  const toolText = afterTool ? textOf(last.content) : "";
  const anyResume = msgs.some((m) => m.role === "user" && /server restarted/i.test(textOf(m.content)));
  const id = ++n;
  const long = /\[long (\d+)(?: #([\w-]+))?\]/.exec(userText);
  const scenario = long ? "long" : /\[spawn\]/.test(userText) ? "spawn" : /\[ask\]/.test(userText) ? "ask" : "plain";
  const entry = { n: id, at: new Date().toISOString(), scenario, tag: long?.[2] ?? null, afterTool, anyResume, userText: userText.slice(0, 300), messages: msgs.length };
  if (log) appendFileSync(log, JSON.stringify(entry) + "\n");

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let closed = false;
  res.on("close", () => (closed = true));
  const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
  const usage = (prompt, completion) => res.write(`data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 1, model: "m1", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`);
  const text = (t) => {
    chunk({ role: "assistant", content: t });
    chunk({}, { finish_reason: "stop" });
    usage(500, 10);
  };
  const call = (name, args) => {
    chunk({ role: "assistant", content: "" });
    chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name, arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
    chunk({}, { finish_reason: "tool_calls" });
    usage(500, 20);
  };

  if (scenario === "long" && !afterTool) {
    const parts = Number(long[1]);
    chunk({ role: "assistant", content: "" });
    for (let i = 1; i <= parts && !closed; i++) {
      chunk({ content: `part ${i}/${parts}. ` });
      await sleep(step);
    }
    if (closed) {
      if (log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "cut-off" }) + "\n");
      return;
    }
    chunk({ content: `REPLY-DONE ${long[2] ?? id}` });
    chunk({}, { finish_reason: "stop" });
    usage(500, parts * 4);
    if (log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "done", tag: long[2] ?? null }) + "\n");
  } else if (scenario === "spawn" && !afterTool) {
    call("agent_spawn", { prompt: "[long 60 #worker] worker", model: "trial/m1", name: "trial-worker" });
  } else if (scenario === "ask" && !afterTool) {
    call("trial_ask", { question: "Keep going?" });
  } else if (afterTool) {
    text(`TOOL-ANSWERED ${toolText.slice(0, 120)}`);
  } else {
    text("ok");
  }
  res.end("data: [DONE]\n\n");
});

server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
