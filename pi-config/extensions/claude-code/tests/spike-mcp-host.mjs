// SPIKE ARTIFACT (2026-09-22, CLI 2.1.278) — evidence for docs/protocol-probes.md, not library code.
// Run by hand; NOT picked up by tests/run.mjs (which imports only *.test.ts). It spawns the REAL
// Claude CLI and spends subscription usage. Scratch files land in /tmp/cc-spike.
//   node spike-<name>.mjs
// CLAUDE_BIN overrides the binary. Never invoke the `claude` shell alias: it carries
// --dangerously-skip-permissions.
// Probe (a): host an in-process MCP server over the CLI's control channel and prove pi can
// execute every tool call — including holding the JSON-RPC open while the CLI waits.
//
//   node probe-a.mjs [variant]      variant: sdkMcpServers (default) | configs | manifests
//
// Never uses the `claude` shell alias (it carries --dangerously-skip-permissions): the real
// binary only. CLAUDECODE / CLAUDE_CODE_ENTRYPOINT are stripped like models.ts does.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";

const VARIANT = process.argv[2] ?? "sdkMcpServers";
const CLAUDE = process.env.CLAUDE_BIN ?? "/home/user/.local/bin/claude";
const SERVER = "pi";
const HOLD_MS = 6000;
const LOG = `/tmp/cc-spike/probe-a-${VARIANT}-${Date.now()}.jsonl`;
writeFileSync(LOG, "");

const log = (dir, obj) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), dir, obj }) + "\n");
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();

const TOOLS = [
  {
    name: "pi_echo",
    description: "Echo text back. Use this whenever the user asks you to echo something.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "pi_shot",
    description: "Return a tiny picture.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const argv = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--include-partial-messages", "--replay-user-messages",
  "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  "--permission-mode", "dontAsk", "--permission-prompts", "none",
  "--allowedTools", `mcp__${SERVER}`,
  "--model", "sonnet",
];
say("argv:", CLAUDE, argv.map((a) => (a === "" ? "''" : a)).join(" "));

const child = spawn(CLAUDE, argv, { cwd: "/tmp/cc-spike", env, stdio: ["pipe", "pipe", "pipe"], shell: false });
child.stderr.on("data", (b) => say("STDERR:", b.toString().trim()));

function send(frame) {
  log("out", frame);
  child.stdin.write(JSON.stringify(frame) + "\n");
}

const pendingControls = new Map(); // our request_id -> resolve
function control(request) {
  const request_id = randomUUID();
  return new Promise((resolve) => {
    pendingControls.set(request_id, resolve);
    send({ type: "control_request", request_id, request });
  });
}

/** Answer a CLI-sent control_request. */
function answer(request_id, response) {
  send({ type: "control_response", response: { subtype: "success", request_id, response } });
}

// ---- the in-process "pi" MCP server ------------------------------------------------------
let sawToolsList = false;
let toolCalls = 0;
const toolCallLog = [];

async function handleMcpMessage(req) {
  const msg = req.request.message;
  log("mcp<-cli", msg);
  const isRequest = msg.id !== undefined && msg.id !== null && msg.method !== undefined;
  if (!isRequest) {
    say(`MCP notification: ${msg.method}`);
    answer(req.request_id, { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } });
    return;
  }
  const reply = (result) => {
    const mcp_response = { jsonrpc: "2.0", id: msg.id, result };
    log("mcp->cli", mcp_response);
    answer(req.request_id, { mcp_response });
  };

  if (msg.method === "initialize") {
    say("MCP initialize, client asks protocolVersion =", msg.params?.protocolVersion);
    reply({
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER, version: "0.0.1" },
    });
    return;
  }
  if (msg.method === "tools/list") {
    sawToolsList = true;
    say("MCP tools/list -> 2 fake tools");
    reply({ tools: TOOLS });
    return;
  }
  if (msg.method === "tools/call") {
    toolCalls += 1;
    const n = toolCalls;
    const name = msg.params?.name;
    toolCallLog.push({ name, args: msg.params?.arguments });
    say(`MCP tools/call #${n}: name=${JSON.stringify(name)} args=${JSON.stringify(msg.params?.arguments)}`);
    if (n === 1) {
      say(`  HOLDING the JSON-RPC open for ${HOLD_MS}ms (CLI must block, tool_use already emitted)…`);
      await new Promise((r) => setTimeout(r, HOLD_MS));
      say("  …releasing hold, answering with a plain text result");
      reply({ content: [{ type: "text", text: "pi executed the tool. The secret word is ORTHANC." }] });
      return;
    }
    if (name?.endsWith("pi_shot")) {
      say("  answering with an IMAGE content block");
      reply({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });
      return;
    }
    say("  answering with isError: true");
    reply({ content: [{ type: "text", text: "pi refused: disk on fire" }], isError: true });
    return;
  }
  say("MCP unhandled method:", msg.method);
  answer(req.request_id, { mcp_response: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } } });
}

// ---- output stream ------------------------------------------------------------------------
let buf = "";
const results = [];
let toolUseSeenAt = null;
const assistantToolUses = [];

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { say("UNPARSEABLE:", line.slice(0, 200)); continue; }
    onEvent(e);
  }
});

function onEvent(e) {
  if (e.type === "stream_event") return; // partial deltas: too noisy for the transcript
  log("in", e);
  if (e.type === "control_response") {
    const r = pendingControls.get(e.response?.request_id);
    if (r) { pendingControls.delete(e.response.request_id); r(e.response); }
    return;
  }
  if (e.type === "control_request") {
    if (e.request?.subtype === "mcp_message") { void handleMcpMessage(e); return; }
    say("CLI control_request (unhandled):", e.request?.subtype);
    send({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "unsupported" } });
    return;
  }
  if (e.type === "system") { say(`system/${e.subtype}`, e.subtype === "init" ? `tools=${JSON.stringify(e.tools)} mcp=${JSON.stringify(e.mcp_servers)}` : ""); return; }
  if (e.type === "assistant") {
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use") {
        if (toolUseSeenAt === null) toolUseSeenAt = Date.now();
        assistantToolUses.push(c.name);
        say(`assistant tool_use: name=${c.name} input=${JSON.stringify(c.input)}`);
      } else if (c.type === "text" && c.text.trim()) say("assistant text:", JSON.stringify(c.text.slice(0, 160)));
    }
    return;
  }
  if (e.type === "user") {
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_result") say(`tool_result echoed back: is_error=${c.is_error} content=${JSON.stringify(c.content).slice(0, 160)}`);
    }
    return;
  }
  if (e.type === "result") { results.push(e); say(`RESULT subtype=${e.subtype} is_error=${e.is_error} turns=${e.num_turns} text=${JSON.stringify(String(e.result ?? "").slice(0, 200))}`); return; }
  say("event:", e.type, e.subtype ?? "");
}

function nextResult() {
  const before = results.length;
  return new Promise((resolve) => {
    const t = setInterval(() => { if (results.length > before) { clearInterval(t); resolve(results[results.length - 1]); } }, 50);
  });
}

function userMessage(text) {
  send({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text }] } });
}

// ---- run -----------------------------------------------------------------------------------
const init = { subtype: "initialize", sdkMcpServers: [SERVER] };
if (VARIANT === "configs") init.sdkMcpServerConfigs = { [SERVER]: {} };
if (VARIANT === "manifests") {
  init.sdkMcpServerManifests = {
    [SERVER]: {
      initializeResult: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: SERVER, version: "0.0.1" } },
      toolsListResult: { tools: TOOLS },
    },
  };
}

say(`initialize variant=${VARIANT}:`, JSON.stringify(init).slice(0, 300));
const initResp = await control(init);
say("initialize response subtype:", initResp?.subtype, initResp?.error ? `error=${initResp.error}` : "");
log("initialize-response", initResp);
if (initResp?.subtype === "success") {
  const keys = Object.keys(initResp.response ?? {});
  say("initialize response keys:", keys.join(", "));
  const commands = initResp.response?.commands;
  if (Array.isArray(commands)) say("  (commands:", commands.length, "entries)");
}

say("--- turn 1: force a tool call, hold the JSON-RPC ---");
userMessage("Call the pi_echo tool with text \"hello\". Then tell me the secret word it returns, and nothing else.");
const r1 = await nextResult();

say("--- turn 2: image content block ---");
userMessage("Call the pi_shot tool with no arguments, then say DONE.");
const r2 = await nextResult();

say("--- turn 3: is_error result ---");
userMessage("Call the pi_echo tool with text \"boom\". Report exactly what the tool said went wrong.");
const r3 = await nextResult();

say("closing stdin");
child.stdin.end();
await new Promise((resolve) => child.on("close", (code, sig) => { say("child close", code, sig); resolve(); }));

console.log("\n===== VERDICT =====");
console.log("variant                :", VARIANT);
console.log("tools/list served      :", sawToolsList);
console.log("tools/call count       :", toolCalls, JSON.stringify(toolCallLog));
console.log("assistant tool_use names   :", JSON.stringify(assistantToolUses));
console.log("results                :", results.map((r) => `${r.subtype}/is_error=${r.is_error}`).join(", "));
console.log("final texts            :", JSON.stringify([r1, r2, r3].map((r) => String(r?.result ?? "").slice(0, 200))));
console.log("log                    :", LOG);
