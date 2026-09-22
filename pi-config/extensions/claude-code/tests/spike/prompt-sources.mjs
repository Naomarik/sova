// SPIKE, not production: executed evidence for ../../docs/protocol-probes.md (CLI 2.1.278, 2026-09-22).
// Spawns the REAL Claude CLI and spends subscription quota; run it by hand, never in a gate.
// Out of reach of tests/run.mjs, which scans only the extension root and provider/ for *.test.ts.
//
// CLAUDE_BIN overrides the binary. Never invoke the `claude` shell alias: it carries
// --dangerously-skip-permissions. Scratch files land in /tmp/cc-spike.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const CWD = "/tmp/cc-spike/proj";
const LOG = `/tmp/cc-spike/probe-d-${Date.now()}.jsonl`;
writeFileSync(LOG, "");
mkdirSync(CWD, { recursive: true });
writeFileSync(`${CWD}/CLAUDE.md`, "# Project notes\n\nThe project codename is BARLIMAN. Always remember it.\n");
const SP = "/tmp/cc-spike/sysprompt.txt";
writeFileSync(SP, "You are a terse assistant. Your operator codename is GLORFINDEL.\n", { mode: 0o600 });

const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const TOOLS = [{
  name: "pi_echo",
  description: "Echo text back. Use this whenever the user asks you to echo something.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}];

function run({ args, init, prompts, hostMcp = false }) {
  const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages", "--strict-mcp-config", "--permission-mode", "dontAsk",
    "--permission-prompts", "none", ...args];
  log({ kind: "spawn", argv });
  console.log("\n  argv:", JSON.stringify(args), "| init:", JSON.stringify(init).slice(0, 160));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const out = { answers: [], toolCalls: [], thinking: [], inits: [], exit: -1, stderr: "" };
    child.stderr.on("data", (b) => { out.stderr += b.toString(); });
    const pending = new Map();
    const send = (f) => { log({ kind: "out", f }); child.stdin.write(JSON.stringify(f) + "\n"); };
    const control = (request) => new Promise((res) => {
      const id = randomUUID(); pending.set(id, res);
      setTimeout(() => { if (pending.delete(id)) res({ subtype: "TIMEOUT" }); }, 20000);
      send({ type: "control_request", request_id: id, request });
    });
    const answer = (request_id, response) => send({ type: "control_response", response: { subtype: "success", request_id, response } });

    let buf = ""; const waiters = [];
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "stream_event") continue;
        log({ kind: "in", e });
        if (e.type === "control_response") { const r = pending.get(e.response?.request_id); if (r) { pending.delete(e.response.request_id); r(e.response); } continue; }
        if (e.type === "control_request") {
          if (hostMcp && e.request?.subtype === "mcp_message") {
            const m = e.request.message;
            const isReq = m.id !== undefined && m.id !== null && m.method !== undefined;
            if (!isReq) { answer(e.request_id, { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } }); continue; }
            const reply = (result) => answer(e.request_id, { mcp_response: { jsonrpc: "2.0", id: m.id, result } });
            if (m.method === "initialize") { reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi", version: "0.0.1" } }); continue; }
            if (m.method === "tools/list") { reply({ tools: TOOLS }); continue; }
            if (m.method === "tools/call") { out.toolCalls.push(m.params); reply({ content: [{ type: "text", text: "pi executed it. The secret word is ORTHANC." }] }); continue; }
            reply({});
            continue;
          }
          send({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "unsupported" } });
          continue;
        }
        if (e.type === "system" && e.subtype === "init") { out.inits.push({ model: e.model, tools: e.tools, mcp: e.mcp_servers }); continue; }
        if (e.type === "assistant") {
          for (const c of e.message?.content ?? []) {
            if (c.type === "thinking") out.thinking.push(String(c.thinking ?? "").length);
            if (c.type === "redacted_thinking") out.thinking.push(-1);
          }
          continue;
        }
        if (e.type === "result") { out.answers.push(String(e.result ?? "")); out.usage = e.usage; waiters.shift()?.(); }
      }
    });
    const nextResult = () => new Promise((r) => waiters.push(r));
    (async () => {
      out.init = await control(init);
      for (const p of prompts) {
        if (typeof p === "object") { out.control = await control(p); continue; }
        send({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text: p }] } });
        await nextResult();
      }
      child.stdin.end();
    })();
    const wd = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 150000);
    child.on("close", (c) => { clearTimeout(wd); out.exit = c ?? -1; resolve(out); });
  });
}

const show = (o, extra = {}) => console.log(JSON.stringify({ exit: o.exit, init: o.init?.subtype, answers: o.answers.map((a) => a.slice(0, 200)), ...extra }, null, 1));

console.log("\n######## CLAUDE.md attribution ########");
console.log("\n--- d1: --setting-sources '' (what we ship)");
show(await run({ args: ["--tools", "", "--setting-sources", "", "--model", "haiku"], init: { subtype: "initialize" }, prompts: ["In one line: what is the project codename?"] }));

console.log("\n--- d2: --setting-sources project (CLAUDE.md should load)");
show(await run({ args: ["--tools", "", "--setting-sources", "project", "--model", "haiku"], init: { subtype: "initialize" }, prompts: ["In one line: what is the project codename?"] }));

console.log("\n--- d3: --setting-sources project + --system-prompt-file (REPLACE): does CLAUDE.md survive a replaced prompt?");
show(await run({ args: ["--tools", "", "--setting-sources", "project", "--system-prompt-file", SP, "--model", "haiku"], init: { subtype: "initialize" }, prompts: ["In one line: what is the project codename, and your operator codename?"] }));

console.log("\n######## b5-real: REPLACED prompt + hosted MCP tool ########");
const b5 = await run({
  args: ["--tools", "", "--setting-sources", "", "--system-prompt-file", SP, "--allowedTools", "mcp__pi", "--model", "sonnet"],
  init: { subtype: "initialize", sdkMcpServers: ["pi"] },
  prompts: ["Call the pi_echo tool with text \"hi\", then tell me the secret word and nothing else."],
  hostMcp: true,
});
show(b5, { toolCalls: b5.toolCalls, toolsAtInit: b5.inits[0]?.tools, mcp: b5.inits[0]?.mcp });

console.log("\n######## c3-real: set_max_thinking_tokens observable effect (sonnet) ########");
const c3a = await run({
  args: ["--tools", "", "--setting-sources", "", "--model", "sonnet"],
  init: { subtype: "initialize" },
  prompts: ["How many times does the letter r appear in 'strawberry raspberry'? Think it through."],
});
show(c3a, { thinkingBlocks: c3a.thinking, note: "no set_max_thinking_tokens" });

const c3b = await run({
  args: ["--tools", "", "--setting-sources", "", "--model", "sonnet"],
  init: { subtype: "initialize" },
  prompts: [{ subtype: "set_max_thinking_tokens", max_thinking_tokens: 8000 }, "How many times does the letter r appear in 'strawberry raspberry'? Think it through."],
});
show(c3b, { thinkingBlocks: c3b.thinking, control: c3b.control, note: "max_thinking_tokens=8000" });

const c3c = await run({
  args: ["--tools", "", "--setting-sources", "", "--model", "sonnet"],
  init: { subtype: "initialize" },
  prompts: [{ subtype: "set_max_thinking_tokens", max_thinking_tokens: 8000, thinking_display: "highlights" }, "How many times does the letter r appear in 'strawberry raspberry'? Think it through."],
});
show(c3c, { thinkingBlocks: c3c.thinking, control: c3c.control, note: "+ thinking_display=highlights" });

console.log("\nlog:", LOG);
