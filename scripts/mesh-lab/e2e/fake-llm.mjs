#!/usr/bin/env node
// A scripted model for the lab, so a real turn runs with no API key. It answers pi's openai-completions
// calls on 127.0.0.1:11434, where pi-config/models.json already has the `ollama` provider with its
// dummy key, so `ollama/qwen3:4b` runs a real turn: pi, tools, events, proxy, page. Only the words are fake.
//
//   node scripts/mesh-lab/e2e/fake-llm.mjs start a,b,c      copy it into those hosts and serve there
//
// What it does, from the last user message:
//   FAKE-TOOLS [{"name":…,"args":{…}},…]    those tool calls in order, one per step
//   run exactly `<cmd>`                     one bash call
//   link_send tool, text exactly: <word>    one link_send call
// then a reply: the word after "single word", else "ok", streamed a piece at a time.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FAKE_MODEL = "ollama/qwen3:4b";
const PORT = 11434;
const IN_HOST = "/tmp/fake-llm.mjs";

const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join("\n") : "");

/** What this step does, from the conversation so far. */
export function nextStep(messages) {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const said = textOf(messages[lastUser]);
  const done = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  let tools = [];
  const scripted = /FAKE-TOOLS (\[.*\])/s.exec(said);
  const cmd = /run exactly `([^`]+)`/.exec(said);
  const linkWord = /link_send tool, text exactly: ([\w-]+)/.exec(said);
  if (scripted) tools = JSON.parse(scripted[1]);
  else if (cmd) tools = [{ name: "bash", args: { command: cmd[1] } }];
  else if (linkWord) tools = [{ name: "link_send", args: { text: linkWord[1] } }];
  if (done < tools.length) return { tool: tools[done], id: `call_${lastUser}_${done}` };
  return { text: /single word:? ([\w-]+)/.exec(said)?.[1] ?? "ok" };
}

function chunk(res, delta, finish = null) {
  res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

async function answer(res, step) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  chunk(res, { role: "assistant", content: "" });
  if (step.tool) {
    chunk(res, { tool_calls: [{ index: 0, id: step.id, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] });
    chunk(res, {}, "tool_calls");
  } else {
    for (const piece of step.text.match(/.{1,4}/gs) ?? []) {
      chunk(res, { content: piece });
      await new Promise((r) => setTimeout(r, 20));
    }
    chunk(res, {}, "stop");
  }
  res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function serve() {
  createServer((req, res) => {
    if (req.method === "GET") return res.end("fake-llm\n");
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      answer(res, nextStep(JSON.parse(raw).messages ?? [])).catch((e) => res.destroy(e));
    });
  }).listen(PORT, "127.0.0.1");
}

/** Serve on these lab hosts; a host already serving is left alone (`lab swap` is what ends one). */
export function start(hosts) {
  const me = import.meta.filename;
  for (const h of hosts) {
    const c = `sovamesh-${h}`;
    if (spawnSync("docker", ["exec", c, "curl", "-sf", "-m", "2", `http://127.0.0.1:${PORT}/`]).status === 0) continue;
    const cp = spawnSync("docker", ["cp", me, `${c}:${IN_HOST}`], { encoding: "utf8" });
    if (cp.status !== 0) throw new Error(`fake-llm: copy to ${h}: ${cp.stderr}`);
    const run = spawnSync("docker", ["exec", "-d", c, "node", IN_HOST, "serve"], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`fake-llm: start on ${h}: ${run.stderr}`);
    const up = spawnSync("docker", ["exec", c, "sh", "-c", `for i in $(seq 1 100); do curl -sf -m 1 http://127.0.0.1:${PORT}/ >/dev/null && exit 0; done; exit 1`]);
    if (up.status !== 0) throw new Error(`fake-llm: not answering on ${h}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [cmd, list] = process.argv.slice(2);
  if (cmd === "serve") serve();
  else if (cmd === "start") start((list ?? "a,b,c").split(","));
  else {
    console.error("usage: fake-llm.mjs start a,b,c | serve");
    process.exit(2);
  }
}
