#!/usr/bin/env node
// A scripted OpenAI-compatible stand-in model for the Release e2e: a test tells it which tool calls a chat makes,
// so a real release chat reports its steps through its own tools (al_1 q10) with no real model. Loopback only.
//
//   node scripts/e2e-release/scripted-model.mjs [port]      # 0 takes a free port; prints `listening <port>`
//
// Point a hermetic agent dir's models.json provider at http://127.0.0.1:<port>/v1 (api openai-completions).
//
// Control (JSON over HTTP on the same port):
//   POST /script  {match?: "<substring>", actions: [{tool: "<tool name or substring>", args: {...}} | {text: "..."}]}
//                 appends actions to the queue for chats whose request text (system + messages) contains `match`
//                 (no match: any chat). Each model request pops ONE action from the first queue that matches it:
//                 a tool action answers with that tool call (the chat runs it and asks again), a text action ends
//                 the turn with that text. With nothing queued the turn ends with "Nothing to do yet."
//   GET  /log     every request so far: [{at, match, tools: [names], last: "<last message text>", toolResults: [...],
//                 action}] (toolResults: the text of each tool result message, newest last)
//   POST /reset   clears queues and log.
// The tool named in an action is resolved against the request's `tools` list: an exact name first, then the first
// name containing it (so `project_verbs` finds `sova_project_verbs`). A tool the chat doesn't have is reported in
// the log (`missing`) and answered as text "no tool <name>", never silently dropped.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
let n = 0;
/** @type {{match: string, actions: any[]}[]} */
let queues = [];
/** @type {any[]} */
let log = [];

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : JSON.stringify(c ?? ""));

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, o) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (url.pathname === "/script" && req.method === "POST") {
    const o = JSON.parse(body || "{}");
    const match = o.match ?? "";
    let q = queues.find((x) => x.match === match);
    if (!q) queues.push((q = { match, actions: [] }));
    q.actions.push(...(o.actions ?? []));
    return json(200, { ok: true, queued: q.actions.length });
  }
  if (url.pathname === "/log") return json(200, log);
  if (url.pathname === "/reset" && req.method === "POST") {
    queues = [];
    log = [];
    return json(200, { ok: true });
  }

  let ask = {};
  try {
    ask = body ? JSON.parse(body) : {};
  } catch {}
  const messages = ask.messages ?? [];
  const all = messages.map((m) => text(m.content)).join("\n");
  const tools = (ask.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
  const last = text(messages.at(-1)?.content);
  const toolResults = messages.filter((m) => m.role === "tool").map((m) => text(m.content));
  const q = queues.find((x) => x.actions.length && all.includes(x.match));
  const action = q ? q.actions.shift() : null;
  const entry = { at: Date.now(), match: q?.match ?? null, tools, last: last.slice(0, 4000), toolResults: toolResults.slice(-3).map((t) => t.slice(0, 4000)), action };
  log.push(entry);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `c${n++}`;
  const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
  const usage = () => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "m1", choices: [], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } })}\n\n`);
  const say = (t) => {
    chunk({ role: "assistant", content: t });
    chunk({}, { finish_reason: "stop" });
    usage();
    res.end("data: [DONE]\n\n");
  };
  if (!action) return say("Nothing to do yet.");
  if (action.text !== undefined) return say(String(action.text));
  const name = tools.find((t) => t === action.tool) ?? tools.find((t) => t.includes(action.tool));
  if (!name) {
    entry.missing = action.tool;
    return say(`no tool ${action.tool}`);
  }
  entry.called = name;
  chunk({ role: "assistant", content: "" });
  chunk({ tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: "" } }] });
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(action.args ?? {}) } }] });
  chunk({}, { finish_reason: "tool_calls" });
  usage();
  res.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  console.log(`scripted model on http://127.0.0.1:${bound}/v1`);
  console.log(`listening ${bound}`);
});
