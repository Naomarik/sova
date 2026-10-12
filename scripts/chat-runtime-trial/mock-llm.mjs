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
//   [bash N]   first a bash call `sleep N; echo BASH-DONE`, then a text quoting its output
//   [served]   first a call to the test-only server-hosted tool trial_served_sleep (a server test hook
//              registers it; it sleeps 10 s), then a text quoting its result
//   [served-late]  10 text parts first, then a call to trial_served_sleep {ms:1000}: a call the chat makes
//              while the trial holds the server down
//   [compact]  (pi's compaction request, by its prompt's shape) a summary streamed
//              over 15 steps, ending "COMPACT-SUMMARY"
//   [big N]    N thousand characters of text at once (history enough for a compaction to cut)
//   the crash-resume text: as [long 20 #resume]
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
  // The trailing user messages (the prompt, and anything the server adds beside it, such as an
  // instance note) after the last assistant message: the tag is in one of them.
  const since = msgs.slice(msgs.findLastIndex((m) => m.role === "assistant") + 1).filter((m) => m.role === "user");
  const userText = since.map((m) => textOf(m.content)).join("\n");
  const last = msgs[msgs.length - 1];
  const afterTool = last?.role === "tool";
  const toolText = afterTool ? textOf(last.content) : "";
  const anyResume = msgs.some((m) => m.role === "user" && /server restarted|process stopped unexpectedly/i.test(textOf(m.content)));
  const id = ++n;
  // pi's summarization request: its older prompt names a "context checkpoint summary"; the current
  // one sends the conversation serialized under "# Conversation" with "# Instructions" after it.
  const compact = msgs.some((m) => /context checkpoint summary/i.test(textOf(m.content))) || /^# Conversation\n[\s\S]*\n# Instructions\n/.test(userText);
  // A crash resume ("This chat's process stopped unexpectedly…") gets a 20-part reply tagged resume,
  // so a trial can kill the process again while the resume runs.
  // It comes first: a process killed mid-reply wrote no reply, so the cut-off prompt is still among
  // the trailing user messages.
  const long = /process stopped unexpectedly and cut off/.test(userText) ? [null, "20", "resume"] : /\[long (\d+)(?: #([\w-]+))?\]/.exec(userText);
  const bash = /\[bash (\d+)\]/.exec(userText);
  const big = /\[big (\d+)\]/.exec(userText);
  const scenario = compact ? "compact" : big ? "big" : long ? "long" : bash ? "bash" : /\[served-late\]/.test(userText) ? "served-late" : /\[served\]/.test(userText) ? "served" : /\[spawn\]/.test(userText) ? "spawn" : /\[ask\]/.test(userText) ? "ask" : "plain";
  const entry = { n: id, at: new Date().toISOString(), scenario, tag: long?.[2] ?? null, afterTool, toolText: toolText.slice(0, 300), anyResume, userText: userText.slice(0, 300), messages: msgs.length };
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
  } else if (scenario === "compact") {
    chunk({ role: "assistant", content: "" });
    for (let i = 1; i <= 15 && !closed; i++) {
      chunk({ content: `summary step ${i}. ` });
      await sleep(step);
    }
    if (closed) {
      if (log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "cut-off", scenario }) + "\n");
      return;
    }
    chunk({ content: "COMPACT-SUMMARY" });
    chunk({}, { finish_reason: "stop" });
    usage(500, 60);
    if (log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "done", scenario }) + "\n");
  } else if (scenario === "big" && !afterTool) {
    const words = "history ".repeat(Math.ceil((Number(big[1]) * 1000) / 8));
    chunk({ role: "assistant", content: "" });
    for (let i = 0; i < words.length; i += 8000) chunk({ content: words.slice(i, i + 8000) });
    chunk({}, { finish_reason: "stop" });
    usage(500, Math.round(words.length / 4));
  } else if (scenario === "bash" && !afterTool) {
    call("bash", { command: `sleep ${bash[1]}; echo BASH-DONE` });
  } else if (scenario === "served-late" && !afterTool) {
    chunk({ role: "assistant", content: "" });
    for (let i = 1; i <= 10 && !closed; i++) {
      chunk({ content: `part ${i}/10. ` });
      await sleep(step);
    }
    chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: "trial_served_sleep", arguments: JSON.stringify({ ms: 1000 }) } }] });
    chunk({}, { finish_reason: "tool_calls" });
    usage(500, 40);
  } else if (scenario === "served" && !afterTool) {
    call("trial_served_sleep", { ms: 10000 });
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
