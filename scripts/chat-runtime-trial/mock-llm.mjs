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
//              is the tag's optional `#id` ([long 40 #a1]); the trial waits for that line. While its
//              #id is held (POST /trial/hold {"tag": id, "on": true}; {"on": false} releases it), the
//              reply keeps streaming "held." parts after its N, and ends only once released
//   [spawn]    first a call to agent_spawn starting one pi worker on trial/m1 whose prompt is
//              "[long 60 #worker] worker", then (once the tool answered) a short text
//   [ask]      first a call to the trial_ask tool (trial-dialog.ts: it opens a confirm dialog), then
//              a text quoting the tool's answer
//   [bash N]   first a bash call `sleep N; echo BASH-DONE`, then a text quoting its output
//   [served]   first a call to the test-only server-hosted tool trial_served_sleep (a server test hook
//              registers it; it sleeps 10 s), then a text quoting its result
//   [served-late]  10 text parts first, then a call to trial_served_sleep {ms:1000}: a call the chat makes
//              while the trial holds the server down
//   [served-quick]  a call to trial_served_sleep {ms:500}
//   [call NAME {json}]  a call to the tool NAME with those arguments, then the closing text: any tool
//              the chat has, such as an Overseer's server-state tools. Several [call …] tags are made
//              one after another, the next once the previous one's result came back. When a [call …]
//              is the message's first tag it wins over any tag inside its arguments (a worker's
//              prompt in agent_spawn's, say); tags nested in a call's arguments are not calls of
//              their own
//   [spawn N L #tag]  (stage 4; N, L and #tag optional) agent_spawn with N pi workers on trial/m1:
//              one is "[long L #tag] worker" named trial-<tag> (L 60; tag worker, named trial-worker,
//              as [spawn]); more are "[long L #tag-i] worker i" named trial-<tag>-i
//   [spawn-claude S #tag]  agent_spawn with one claude-code worker (scripts/fake-claude.mjs answers
//              it), named trial-claude, its prompt "[fake-slow S] claude worker #tag" (S ms, default 20000)
//   [explain S]  (in /explain's topic) the child, whose prompt names the store: S text parts first (default 0), then the page written to the
//              index.html its prompt names, then its meta.json (summary "EXPLAIN-SUMMARY"), then
//              "EXPLAIN-DONE"
//   [handoff S]  /compact-handoff's child (or any prompt asking for a <handoff> block): S parts
//              (default 5), then "<handoff>HANDOFF-NOTE</handoff>"
//   [btw #tag]  "BTW-ANSWER tag"
// Every log line names the caller's pid (`pid`, from /proc or lsof, procs.mjs: the process whose socket made the
// request; 0 when it can't be found), so a trial can tell which chat process asked.
//   [compact]  (pi's compaction request, by its prompt's shape) a summary streamed
//              over 15 steps, ending "COMPACT-SUMMARY"
//   [big N]    N thousand characters of text at once (history enough for a compaction to cut)
//   the crash-resume text: as [long 20 #resume]
//   no tag: the tags last set with POST /trial/plain {"text": "[long 30 #look]"} ("" clears them),
//              so a message the server writes (a look, a brief, an explorer's seed) can be scripted
//   anything else: "ok"
// A request whose newest message is a tool result gets the scenario's closing text.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { socketOwner } from "./procs.mjs";

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
/** The pid whose TCP socket has local port `port` and talks to this mock (0 if unknown). */
const callerPid = (port) => socketOwner(port, server.address().port);
let n = 0;
const TAGGED = /\[(long|bash|big|call|served|served-late|served-quick|spawn|spawn-claude|ask|explain|handoff|btw)\b/;


/** Every [call NAME {json}] in text, in order; a call's arguments may hold further tags (skipped). */
function parseCalls(text) {
  const out = [];
  const re = /\[call ([\w-]+) \{/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1;
    let done = false;
    for (let end = text.indexOf("}]", start); end >= 0; end = text.indexOf("}]", end + 1)) {
      try {
        out.push({ name: m[1], args: JSON.parse(text.slice(start, end + 1)) });
        re.lastIndex = end + 2;
        done = true;
        break;
      } catch {}
    }
    if (!done) out.push({ name: m[1], args: {} });
  }
  return out;
}
/** The tags an untagged message gets ("" none): set with POST /trial/plain {text}. */
let plainAs = "";
/** The [long … #id] ids whose replies don't end until released: set with POST /trial/hold {tag, on}. */
const held = new Set();

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url === "/trial/plain") {
    try {
      plainAs = String(JSON.parse(body).text ?? "");
    } catch {}
    if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), event: "plain", text: plainAs }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  if (req.url === "/trial/hold") {
    let h = {};
    try {
      h = JSON.parse(body);
    } catch {}
    const tag = String(h.tag ?? "");
    if (tag) h.on === false ? held.delete(tag) : held.add(tag);
    if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), event: "hold", tag, on: h.on !== false }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
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
  // The turn's own user messages (the last user message and those right before it) and how many
  // tool results came back since: what a multi-step scenario ([call …] [call …], [explain]) reads
  // once a tool answered, when no user message trails.
  const lastUser = msgs.findLastIndex((m) => m.role === "user");
  let firstUser = lastUser;
  while (firstUser > 0 && msgs[firstUser - 1].role === "user") firstUser--;
  const turnText = lastUser >= 0 ? msgs.slice(firstUser, lastUser + 1).map((m) => textOf(m.content)).join("\n") : "";
  const stepNo = lastUser >= 0 ? msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length : 0;
  const anyResume = msgs.some((m) => m.role === "user" && /server restarted|process stopped unexpectedly/i.test(textOf(m.content)));
  const id = ++n;
  // pi's summarization request: its older prompt names a "context checkpoint summary"; the current
  // one sends the conversation serialized under "# Conversation" with "# Instructions" after it.
  const compact = msgs.some((m) => /context checkpoint summary/i.test(textOf(m.content))) || /^# Conversation\n[\s\S]*\n# Instructions\n/.test(userText);
  // A crash resume ("This chat's process stopped unexpectedly…") gets a 20-part reply tagged resume,
  // so a trial can kill the process again while the resume runs.
  // It comes first: a process killed mid-reply wrote no reply, so the cut-off prompt is still among
  // the trailing user messages.
  // A message the server writes (a look, a brief, an explorer's seed) carries no tag: it gets the
  // tags the trial set with POST /trial/plain, if any.
  const src = afterTool ? turnText : userText;
  const tags = TAGGED.test(src) || !plainAs ? src : `${src}\n${plainAs}`;
  const resume = /process stopped unexpectedly and cut off/.test(tags);
  const firstTag = TAGGED.exec(tags)?.[1];
  const long = resume ? [null, "20", "resume"] : /\[long (\d+)(?: #([\w-]+))?\]/.exec(tags);
  const bash = /\[bash (\d+)\]/.exec(tags);
  const big = /\[big (\d+)\]/.exec(tags);
  const calls = /\[call [\w-]+ \{/.test(tags) ? parseCalls(tags) : [];
  // A [call …] sequence still running: the newest user message holding [call …] tags, after which
  // every assistant message made tool calls (none closed the turn with text). A message that arrives
  // meanwhile with no tag of its own (a steer, a teammate's message) does not end it: the next call
  // is made all the same, as a model would carry on with its task.
  const seqAt = msgs.findLastIndex((m) => m.role === "user" && /\[call [\w-]+ \{/.test(textOf(m.content)));
  const seqTail = seqAt >= 0 ? msgs.slice(seqAt + 1) : [];
  const seqOpen = seqAt >= 0 && seqAt < lastUser && seqTail.some((m) => m.role === "assistant") && seqTail.every((m) => m.role !== "assistant" || m.tool_calls?.length > 0);
  const seqCalls = seqOpen ? parseCalls(textOf(msgs[seqAt].content)) : [];
  const seqStep = seqTail.filter((m) => m.role === "tool").length;
  const carryOn = seqOpen && !TAGGED.test(src) && seqStep < seqCalls.length;
  const spawnN = /\[spawn(?: (\d+))?(?: (\d+))?(?: #([\w-]+))?\]/.exec(tags);
  const spawnClaude = /\[spawn-claude(?: (\d+))?(?: #([\w-]+))?\]/.exec(tags);
  const explain = /Where the page goes/.test(tags) ? /\[explain(?: (\d+))?\]/.exec(tags) : null;
  const handoff = /\[handoff(?: (\d+))?\]/.exec(tags) ?? (/End your reply with the note inside <handoff>/.test(tags) ? [null, null] : null);
  const btw = /\[btw(?: #([\w-]+))?\]/.exec(tags);
  const scenario = compact ? "compact" : resume ? "long" : carryOn || firstTag === "call" ? "call" : big ? "big" : long ? "long" : bash ? "bash" : calls.length ? "call" : /\[served-late\]/.test(tags) ? "served-late" : /\[served-quick\]/.test(tags) ? "served-quick" : /\[served\]/.test(tags) ? "served" : spawnClaude ? "spawn-claude" : spawnN ? "spawn" : /\[ask\]/.test(tags) ? "ask" : explain ? "explain" : handoff ? "handoff" : btw ? "btw" : "plain";
  let pid = 0;
  try {
    pid = callerPid(req.socket.remotePort);
  } catch {}
  // Code markers in the tools' descriptions (T25 edits one into an extension in its checkout).
  const marks = [...new Set(JSON.stringify(ask.tools ?? []).match(/GEN-MARK-\w+/g) ?? [])];
  const entry = { n: id, at: new Date().toISOString(), pid, scenario, tag: scenario === "long" ? (long?.[2] ?? null) : null, afterTool, step: stepNo, toolText: toolText.slice(0, 1000), anyResume, userText: userText.slice(0, 300), hashes: [...new Set([...tags.matchAll(/#([\w-]+)\]/g)].map((m) => m[1]))], ...(afterTool ? { turnText: turnText.slice(0, 300) } : {}), messages: msgs.length, tools: (ask.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean).length, ...(marks.length ? { marks } : {}) };
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
  let started = false;
  const call = (name, args) => {
    if (!started) chunk({ role: "assistant", content: "" });
    chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name, arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
    chunk({}, { finish_reason: "tool_calls" });
    usage(500, 20);
  };
  /** k text parts, one every step ms, opening the reply; false (logged cut-off) when the caller left. */
  const parts = async (k) => {
    if (k <= 0) return true;
    chunk({ role: "assistant", content: "" });
    started = true;
    for (let i = 1; i <= k && !closed; i++) {
      chunk({ content: `part ${i}/${k}. ` });
      await sleep(step);
    }
    if (closed && log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "cut-off", scenario }) + "\n");
    return !closed;
  };

  if (scenario === "long" && !afterTool) {
    const parts = Number(long[1]);
    chunk({ role: "assistant", content: "" });
    for (let i = 1; i <= parts && !closed; i++) {
      chunk({ content: `part ${i}/${parts}. ` });
      await sleep(step);
    }
    while (!closed && long[2] && held.has(long[2])) {
      chunk({ content: "held. " });
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
  } else if (scenario === "call" && carryOn) {
    call(seqCalls[seqStep].name, seqCalls[seqStep].args);
  } else if (scenario === "call" && stepNo < calls.length) {
    call(calls[stepNo].name, calls[stepNo].args);
  } else if (scenario === "served-quick" && !afterTool) {
    call("trial_served_sleep", { ms: 500 });
  } else if (scenario === "served" && !afterTool) {
    call("trial_served_sleep", { ms: 10000 });
  } else if (scenario === "spawn" && !afterTool) {
    const [count, parts, tag] = [Number(spawnN[1] ?? 1), Number(spawnN[2] ?? 60), spawnN[3] ?? "worker"];
    const name = tag === "worker" ? "trial-worker" : `trial-${tag}`;
    if (count === 1) call("agent_spawn", { prompt: `[long ${parts} #${tag}] worker`, model: "trial/m1", name });
    else call("agent_spawn", { agents: Array.from({ length: count }, (_, i) => ({ prompt: `[long ${parts} #${tag}-${i + 1}] worker ${i + 1}`, model: "trial/m1", name: `${name}-${i + 1}` })) });
  } else if (scenario === "spawn-claude" && !afterTool) {
    call("agent_spawn", { prompt: `[fake-slow ${spawnClaude[1] ?? 20000}] claude worker #${spawnClaude[2] ?? "claude"}`, backend: "claude-code", name: "trial-claude" });
  } else if (scenario === "explain" && stepNo < 2) {
    if (stepNo === 0 && !(await parts(Number(explain[1] ?? 0)))) return;
    const index = /`([^`\s]+\/index\.html)`/.exec(tags)?.[1];
    const metaPath = /`([^`\s]+\/meta\.json)`/.exec(tags)?.[1];
    if (stepNo === 0) {
      call("write", { path: index ?? "index.html", content: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Trial</title></head><body><h1>Trial</h1><p>EXPLAIN-PAGE</p></body></html>\n' });
    } else {
      let meta = {};
      try {
        meta = JSON.parse(/```json\n(\{[\s\S]*?\})\n```/.exec(tags)?.[1] ?? "{}");
      } catch {}
      call("write", { path: metaPath ?? "meta.json", content: JSON.stringify({ ...meta, summary: "EXPLAIN-SUMMARY" }, null, 2) });
    }
  } else if (scenario === "explain") {
    text("EXPLAIN-DONE");
  } else if (scenario === "handoff" && !afterTool) {
    if (!(await parts(Number(handoff[1] ?? 5)))) return;
    chunk({ content: "<handoff>HANDOFF-NOTE</handoff>" });
    chunk({}, { finish_reason: "stop" });
    usage(500, 40);
    if (log) appendFileSync(log, JSON.stringify({ n: id, at: new Date().toISOString(), event: "done", scenario }) + "\n");
  } else if (scenario === "btw" && !afterTool) {
    text(`BTW-ANSWER ${btw[1] ?? ""}`.trim());
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
