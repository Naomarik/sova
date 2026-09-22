// SPIKE, not production: executed evidence for ../../docs/protocol-probes.md (CLI 2.1.278, 2026-09-22).
// Spawns the REAL Claude CLI and spends subscription quota; run it by hand, never in a gate.
// Out of reach of tests/run.mjs, which scans only the extension root and provider/ for *.test.ts.
//
// CLAUDE_BIN overrides the binary. Never invoke the `claude` shell alias: it carries
// --dangerously-skip-permissions. Scratch files land in /tmp/cc-spike.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const CLAUDE = process.env.CLAUDE_BIN ?? "/home/user/.local/bin/claude";
const CWD = "/tmp/cc-spike/proj";
const LOG = `/tmp/cc-spike/probe-e-${Date.now()}.jsonl`;
writeFileSync(LOG, "");
mkdirSync(CWD, { recursive: true });
const SP = "/tmp/cc-spike/sysprompt.txt";
writeFileSync(SP, "You are a terse assistant. Your operator codename is GLORFINDEL.\n", { mode: 0o600 });

const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const baseEnv = () => { const e = { ...process.env }; delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; return e; };

const TOOLS = [{
  name: "echo_tool",
  description: "Echo text back. Use this whenever the user asks you to echo something.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}];

/** @param {{args?:string[], env?:object, init?:object, prompts?:any[], holdMs?:number, hostMcp?:boolean}} o */
function run(o) {
  const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", ...(o.args ?? [])];
  log({ kind: "spawn", argv, env: Object.keys(o.env ?? {}) });
  const T = Date.now();
  const el = () => ((Date.now() - T) / 1000).toFixed(1);
  console.log(`\n  argv: ${JSON.stringify(o.args ?? [])} env:${JSON.stringify(o.env ?? {})} init:${JSON.stringify(o.init ?? { subtype: "initialize" }).slice(0, 120)}`);
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, { cwd: CWD, env: { ...baseEnv(), ...(o.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const out = { answers: [], events: [], callAt: null, answeredAt: null, exit: -1, session: "", models: [] };
    child.stderr.on("data", (b) => console.log(`  [${el()}s] STDERR`, b.toString().trim().slice(0, 200)));
    const pending = new Map();
    const send = (f) => { log({ kind: "out", f }); child.stdin.write(JSON.stringify(f) + "\n"); };
    const control = (request) => new Promise((res) => {
      const id = randomUUID(); pending.set(id, res);
      setTimeout(() => { if (pending.delete(id)) res({ subtype: "TIMEOUT" }); }, 30000);
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
          if (o.hostMcp && e.request?.subtype === "mcp_message") {
            const m = e.request.message;
            if (!(m.id !== undefined && m.id !== null && m.method)) { answer(e.request_id, { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } }); continue; }
            const reply = (result) => answer(e.request_id, { mcp_response: { jsonrpc: "2.0", id: m.id, result } });
            if (m.method === "initialize") { reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi", version: "0.0.1" } }); continue; }
            if (m.method === "tools/list") { reply({ tools: TOOLS }); continue; }
            if (m.method === "tools/call") {
              out.callAt = Date.now();
              console.log(`  [${el()}s] tools/call arrived — HOLDING up to ${o.holdMs}ms, not answering`);
              setTimeout(() => {
                out.answeredAt = Date.now();
                console.log(`  [${el()}s] answering now`);
                reply({ content: [{ type: "text", text: "pi executed it. The secret word is ORTHANC." }] });
              }, o.holdMs);
              continue;
            }
            reply({});
            continue;
          }
          send({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "unsupported" } });
          continue;
        }
        if (e.type === "system") {
          out.events.push(`${el()}s system/${e.subtype}`);
          if (e.subtype !== "init" && e.subtype !== "status") console.log(`  [${el()}s] system/${e.subtype}`, JSON.stringify(e).slice(0, 260));
          if (e.session_id) out.session = e.session_id;
          continue;
        }
        if (e.type === "assistant") {
          if (e.message?.model) out.models.push(e.message.model);
          for (const c of e.message?.content ?? []) {
            if (c.type === "tool_use") console.log(`  [${el()}s] tool_use ${c.name} ${JSON.stringify(c.input)}`);
          }
          continue;
        }
        if (e.type === "user") {
          for (const c of e.message?.content ?? []) {
            if (c.type === "tool_result") console.log(`  [${el()}s] tool_result is_error=${c.is_error} ${JSON.stringify(c.content).slice(0, 220)}`);
          }
          continue;
        }
        if (e.type === "result") {
          out.answers.push(String(e.result ?? ""));
          if (e.session_id) out.session = e.session_id;
          console.log(`  [${el()}s] RESULT ${e.subtype} is_error=${e.is_error} ${JSON.stringify(String(e.result ?? "").slice(0, 150))}`);
          waiters.shift()?.();
        }
      }
    });
    const nextResult = () => new Promise((r) => waiters.push(r));
    (async () => {
      out.init = await control(o.init ?? { subtype: "initialize" });
      for (const p of o.prompts ?? []) {
        if (typeof p === "object") { out.control = await control(p); console.log(`  [${el()}s] control ${p.subtype} ->`, JSON.stringify(out.control).slice(0, 120)); continue; }
        send({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text: p }] } });
        await nextResult();
      }
      child.stdin.end();
    })();
    const wd = setTimeout(() => { console.log(`  [${el()}s] WATCHDOG kill`); try { child.kill("SIGKILL"); } catch {} }, (o.holdMs ?? 0) + 120000);
    child.on("close", (c) => { clearTimeout(wd); out.exit = c ?? -1; out.heldSec = out.callAt ? ((Date.now() - out.callAt) / 1000).toFixed(1) : null; resolve(out); });
  });
}

const PROMPT = "Call the echo_tool tool with text 'hi', then tell me the secret word and nothing else.";
const MCP_ARGS = ["--allowedTools", "mcp__pi", "--model", "sonnet"];
const MCP_INIT = { subtype: "initialize", sdkMcpServers: ["pi"] };

console.log("\n######## e1: hold 200s, no MCP_TOOL_TIMEOUT set — where is the default wall? ########");
const SKIP = process.argv.includes("--only-late");
const e1 = SKIP ? {exit:0,answers:[],events:[]} : await run({ args: MCP_ARGS, init: MCP_INIT, prompts: [PROMPT], holdMs: 200000, hostMcp: true });
console.log(" e1:", JSON.stringify({ exit: e1.exit, answers: e1.answers.map((a) => a.slice(0, 120)), events: e1.events.filter((x) => !x.includes("status")) }));

console.log("\n######## e2: MCP_TOOL_TIMEOUT=6000, hold 20s — is the env var honoured? ########");
const e2 = SKIP ? {exit:0,answers:[]} : await run({ args: MCP_ARGS, env: { MCP_TOOL_TIMEOUT: "6000" }, init: MCP_INIT, prompts: [PROMPT], holdMs: 20000, hostMcp: true });
console.log(" e2:", JSON.stringify({ exit: e2.exit, answers: e2.answers.map((a) => a.slice(0, 120)) }));

console.log("\n######## e3: MCP_TOOL_TIMEOUT=6000 + sdkMcpServerConfigs{pi:{timeout:60000}} — does the per-server override win? ########");
const e3 = SKIP ? {exit:0,answers:[]} : await run({
  args: MCP_ARGS, env: { MCP_TOOL_TIMEOUT: "6000" },
  init: { subtype: "initialize", sdkMcpServers: ["pi"], sdkMcpServerConfigs: { pi: { timeout: 60000 } } },
  prompts: [PROMPT], holdMs: 20000, hostMcp: true,
});
console.log(" e3:", JSON.stringify({ exit: e3.exit, answers: e3.answers.map((a) => a.slice(0, 120)) }));

console.log("\n######## e4: --system-prompt-snapshot off (FLAG form) across --resume ########");
const e4a = await run({ args: ["--system-prompt-snapshot", "off", "--append-system-prompt-file", SP, "--model", "haiku"], prompts: ["Reply with just your operator codename."] });
console.log(" e4a:", JSON.stringify({ exit: e4a.exit, answers: e4a.answers, session: e4a.session }));
if (e4a.session) {
  const e4b = await run({ args: ["--system-prompt-snapshot", "off", "--resume", e4a.session, "--model", "haiku"], prompts: ["Reply with just your operator codename."] });
  console.log(" e4b (resumed, prompt NOT re-passed):", JSON.stringify({ exit: e4b.exit, answers: e4b.answers }));
  const e4c = await run({ args: ["--system-prompt-snapshot", "off", "--append-system-prompt-file", SP, "--resume", e4a.session, "--model", "haiku"], prompts: ["Reply with just your operator codename."] });
  console.log(" e4c (resumed, prompt RE-passed):", JSON.stringify({ exit: e4c.exit, answers: e4c.answers }));
}

console.log("\n######## e5: set_model — does the assistant message's model field change? ########");
const e5 = await run({ args: ["--model", "haiku"], prompts: ["Say ONE.", { subtype: "set_model", model: "sonnet" }, "Say TWO."] });
console.log(" e5 assistant .model per message:", JSON.stringify(e5.models), "control:", JSON.stringify(e5.control));

console.log("\nlog:", LOG);
