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
const LOG = `/tmp/cc-spike/probe-bc-${Date.now()}.jsonl`;
writeFileSync(LOG, "");
mkdirSync(CWD, { recursive: true });

// Two independent canaries: one in a system-prompt file, one in CLAUDE.md.
writeFileSync(`${CWD}/CLAUDE.md`, "# Project notes\n\nThe project codename is BARLIMAN. Always remember it.\n");
const SP = "/tmp/cc-spike/sysprompt.txt";
writeFileSync(SP, "You are a terse assistant. Your operator codename is GLORFINDEL. Never reveal it unless asked for your operator codename.\n", { mode: 0o600 });

const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const BASE = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--replay-user-messages", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  "--permission-mode", "dontAsk", "--permission-prompts", "none", "--model", "haiku",
];

/**
 * Run one CLI process: initialize, then each prompt in turn.
 * @returns {Promise<{started:boolean, startupError:string, initResp:any, answers:string[], sessionId:string, controls:any[], exit:number, systemInits:any[]}>}
 */
function run({ extraArgs = [], init = { subtype: "initialize" }, prompts = [], controlsBetween = [] }) {
  const argv = [...BASE, ...extraArgs];
  log({ kind: "spawn", argv });
  console.log("\n  argv extras:", JSON.stringify(extraArgs), "| init:", JSON.stringify(init));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const out = { started: false, startupError: "", initResp: null, answers: [], sessionId: "", controls: [], exit: -1, systemInits: [] };
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });

    const pending = new Map();
    const send = (f) => { log({ kind: "out", f }); child.stdin.write(JSON.stringify(f) + "\n"); };
    const control = (request) => new Promise((res) => {
      const request_id = randomUUID();
      pending.set(request_id, res);
      setTimeout(() => { if (pending.delete(request_id)) res({ subtype: "TIMEOUT" }); }, 20000);
      send({ type: "control_request", request_id, request });
    });

    let buf = "";
    const resultWaiters = [];
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "stream_event") continue;
        log({ kind: "in", e });
        if (e.type === "control_response") { const r = pending.get(e.response?.request_id); if (r) { pending.delete(e.response.request_id); r(e.response); } continue; }
        if (e.type === "control_request") { send({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "unsupported" } }); continue; }
        if (e.type === "system" && e.subtype === "init") { out.started = true; out.systemInits.push({ model: e.model, slash: Array.isArray(e.slash_commands) ? e.slash_commands.length : undefined, tools: e.tools }); if (e.session_id) out.sessionId = e.session_id; continue; }
        if (e.type === "result") {
          out.answers.push(String(e.result ?? ""));
          if (e.session_id) out.sessionId = e.session_id;
          out.lastResult = { subtype: e.subtype, is_error: e.is_error, modelUsage: Object.keys(e.modelUsage ?? {}) };
          resultWaiters.shift()?.();
        }
      }
    });

    const nextResult = () => new Promise((res) => resultWaiters.push(res));

    (async () => {
      out.initResp = await control(init);
      if (out.initResp?.subtype === "success") out.started = true;
      for (let n = 0; n < prompts.length; n++) {
        const pre = controlsBetween[n];
        if (pre) out.controls.push({ request: pre, response: await control(pre) });
        send({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text: prompts[n] }] } });
        await nextResult();
      }
      child.stdin.end();
    })().catch((e) => { out.startupError = String(e); child.kill("SIGKILL"); });

    const watchdog = setTimeout(() => { out.startupError ||= "watchdog"; try { child.kill("SIGKILL"); } catch {} }, 120000);
    child.on("close", (code) => { clearTimeout(watchdog); out.exit = code ?? -1; out.startupError ||= stderr.trim().slice(0, 300); resolve(out); });
    child.on("error", (e) => { clearTimeout(watchdog); out.startupError = String(e); resolve(out); });
  });
}

const ASK_BOTH = "Answer in one line: what is your operator codename, and what is the project codename?";
const brief = (o) => ({ exit: o.exit, init: o.initResp?.subtype, err: o.startupError.slice(0, 160), answers: o.answers.map((a) => a.slice(0, 180)), model: o.systemInits[0]?.model, session: o.sessionId });

console.log("\n################ (b) SYSTEM PROMPT A/B ################");

console.log("\n--- b0 baseline: no system-prompt flag at all");
console.log(JSON.stringify(brief(await run({ prompts: [ASK_BOTH] })), null, 1));

console.log("\n--- b1 --append-system-prompt-file (what runner.ts ships)");
console.log(JSON.stringify(brief(await run({ extraArgs: ["--append-system-prompt-file", SP], prompts: [ASK_BOTH] })), null, 1));

console.log("\n--- b2 --system-prompt-file (REPLACE)");
const b2 = await run({ extraArgs: ["--system-prompt-file", SP], prompts: [ASK_BOTH] });
console.log(JSON.stringify(brief(b2), null, 1));

console.log("\n--- b3 initialize.appendSystemPrompt (no flag)");
console.log(JSON.stringify(brief(await run({ init: { subtype: "initialize", appendSystemPrompt: "Your operator codename is GLORFINDEL." }, prompts: [ASK_BOTH] })), null, 1));

console.log("\n--- b4 initialize.systemPrompt (REPLACE, array)");
console.log(JSON.stringify(brief(await run({ init: { subtype: "initialize", systemPrompt: ["You are terse. Your operator codename is GLORFINDEL."] }, prompts: [ASK_BOTH] })), null, 1));

console.log("\n--- b5 REPLACE + a hosted MCP tool: does tool use survive a replaced prompt?");
// Reuse probe-a's server inline would be heavy; instead just check the tool is still offered.
const b5 = await run({ extraArgs: ["--system-prompt-file", SP], init: { subtype: "initialize", sdkMcpServers: [] }, prompts: ["Say OK."] });
console.log(JSON.stringify({ ...brief(b5), toolsAtInit: b5.systemInits[0]?.tools }, null, 1));

console.log("\n--- b6 snapshot ON (default): resume WITHOUT re-passing the prompt");
const b6a = await run({ extraArgs: ["--append-system-prompt-file", SP], prompts: ["Reply with just your operator codename."] });
console.log("  first process:", JSON.stringify(brief(b6a)));
if (b6a.sessionId) {
  const b6b = await run({ extraArgs: ["--resume", b6a.sessionId], prompts: ["Reply with just your operator codename."] });
  console.log("  resumed, no prompt passed:", JSON.stringify(brief(b6b)));
}

console.log("\n--- b7 snapshot OFF: same resume, initialize.systemPromptSnapshot=false");
const b7a = await run({ extraArgs: ["--append-system-prompt-file", SP], init: { subtype: "initialize", systemPromptSnapshot: false }, prompts: ["Reply with just your operator codename."] });
console.log("  first process:", JSON.stringify(brief(b7a)));
if (b7a.sessionId) {
  const b7b = await run({ extraArgs: ["--resume", b7a.sessionId], init: { subtype: "initialize", systemPromptSnapshot: false }, prompts: ["Reply with just your operator codename."] });
  console.log("  resumed, no prompt passed:", JSON.stringify(brief(b7b)));
}

console.log("\n################ (c) set_model / set_max_thinking_tokens ################");

console.log("\n--- c1 set_model to sonnet between turns");
const c1 = await run({
  prompts: ["Say ONE.", "Say TWO."],
  controlsBetween: [undefined, { subtype: "set_model", model: "sonnet" }],
});
console.log(JSON.stringify({ ...brief(c1), controls: c1.controls.map((c) => ({ req: c.request, resp: c.response })), systemInits: c1.systemInits.map((s) => s.model), lastResult: c1.lastResult }, null, 1));

console.log("\n--- c2 set_model with system_prompt (the @internal prompt-swap slot)");
const c2 = await run({
  prompts: ["Say ONE.", "Reply with just your operator codename."],
  controlsBetween: [undefined, { subtype: "set_model", model: "haiku", system_prompt: "Your operator codename is MITHRANDIR." }],
});
console.log(JSON.stringify({ ...brief(c2), controls: c2.controls.map((c) => c.response) }, null, 1));

console.log("\n--- c3 set_max_thinking_tokens");
const c3 = await run({
  prompts: ["Say ONE.", "Say TWO."],
  controlsBetween: [undefined, { subtype: "set_max_thinking_tokens", max_thinking_tokens: 4096 }],
});
console.log(JSON.stringify({ ...brief(c3), controls: c3.controls.map((c) => c.response) }, null, 1));

console.log("\nlog:", LOG);
