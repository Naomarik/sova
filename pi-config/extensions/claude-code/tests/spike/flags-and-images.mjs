// SPIKE, not production: executed evidence for ../../docs/protocol-probes.md (CLI 2.1.278, 2026-09-22).
// Spawns the REAL Claude CLI and spends subscription quota; run it by hand, never in a gate.
// Out of reach of tests/run.mjs, which scans only the extension root and provider/ for *.test.ts.
//
// CLAUDE_BIN overrides the binary. Never invoke the `claude` shell alias: it carries
// --dangerously-skip-permissions. Scratch files land in /tmp/cc-spike.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const CLAUDE = process.env.CLAUDE_BIN ?? "/home/user/.local/bin/claude";
const CWD = "/tmp/cc-spike/proj";
const LOG = `/tmp/cc-spike/probe-f-${Date.now()}.jsonl`;
writeFileSync(LOG, "");
mkdirSync(CWD, { recursive: true });
const SP = "/tmp/cc-spike/sysprompt.txt";
writeFileSync(SP, "You are a terse assistant. Your operator codename is GLORFINDEL.\n", { mode: 0o600 });

const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const baseEnv = () => { const e = { ...process.env }; delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; return e; };

/** A solid-red 24x24 PNG, built here so the probe has no fixtures and the answer is checkable. */
function redPng(size = 24) {
  const crcTable = [...Array(256).keys()].map((n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([237, 28, 36])))])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const RED = redPng();

function run({ args = [], prompts = [], init = { subtype: "initialize" } }) {
  const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", ...args];
  log({ kind: "spawn", argv });
  console.log("\n  argv:", JSON.stringify(args));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, { cwd: CWD, env: baseEnv(), stdio: ["pipe", "pipe", "pipe"], shell: false });
    const out = { answers: [], exit: -1, stderr: "", session: "", initResp: null, replays: [] };
    child.stderr.on("data", (b) => { out.stderr += b.toString(); });
    const pending = new Map();
    const send = (f) => { log({ kind: "out", f }); child.stdin.write(JSON.stringify(f) + "\n"); };
    const control = (request) => new Promise((res) => {
      const id = randomUUID(); pending.set(id, res);
      setTimeout(() => { if (pending.delete(id)) res({ subtype: "TIMEOUT" }); }, 30000);
      send({ type: "control_request", request_id: id, request });
    });
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
        if (e.type === "control_request") { send({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "unsupported" } }); continue; }
        if (e.type === "system" && e.session_id) out.session = e.session_id;
        if (e.type === "user") out.replays.push(JSON.stringify(e.message?.content ?? []).slice(0, 220));
        if (e.type === "result") { out.answers.push(String(e.result ?? "")); if (e.session_id) out.session = e.session_id; waiters.shift()?.(); }
      }
    });
    const nextResult = () => new Promise((r) => waiters.push(r));
    (async () => {
      out.initResp = await control(init);
      for (const p of prompts) {
        send({ type: "user", uuid: randomUUID(), message: { role: "user", content: typeof p === "string" ? [{ type: "text", text: p }] : p } });
        await nextResult();
      }
      child.stdin.end();
    })();
    const wd = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 120000);
    child.on("close", (c) => { clearTimeout(wd); out.exit = c ?? -1; resolve(out); });
  });
}

const show = (label, o) => console.log(` ${label}:`, JSON.stringify({ exit: o.exit, init: o.initResp?.subtype, answers: o.answers.map((a) => a.slice(0, 170)), stderr: o.stderr.trim().slice(0, 200) }));

console.log("\n######## (5) --system-prompt-snapshot off + --session-id <uuid> + --effort together ########");
const id1 = randomUUID();
show("f1 all three", await run({
  args: ["--system-prompt-snapshot", "off", "--session-id", id1, "--effort", "low",
    "--append-system-prompt-file", SP, "--model", "haiku"],
  prompts: ["Reply with just your operator codename."],
}));
console.log("   (requested --session-id was", id1, ")");

console.log("\n--- f2 same, --effort high, to confirm the level is not the thing being rejected");
show("f2", await run({
  args: ["--system-prompt-snapshot", "off", "--session-id", randomUUID(), "--effort", "high",
    "--append-system-prompt-file", SP, "--model", "haiku"],
  prompts: ["Reply with just your operator codename."],
}));

console.log("\n######## (6) image content block on an INBOUND stream-json user message ########");
console.log("\n--- f3 Anthropic shape: {type:'image', source:{type:'base64', media_type, data}}");
const f3 = await run({
  args: ["--model", "haiku"],
  prompts: [[
    { type: "image", source: { type: "base64", media_type: "image/png", data: RED } },
    { type: "text", text: "What single colour fills this image? Answer with one word." },
  ]],
});
show("f3", f3);
console.log("   replayed user content:", JSON.stringify(f3.replays).slice(0, 300));

console.log("\n--- f4 MCP/pi shape: {type:'image', data, mimeType} — does the CLI accept it inbound too?");
const f4 = await run({
  args: ["--model", "haiku"],
  prompts: [[
    { type: "image", data: RED, mimeType: "image/png" },
    { type: "text", text: "What single colour fills this image? Answer with one word." },
  ]],
});
show("f4", f4);
console.log("   replayed user content:", JSON.stringify(f4.replays).slice(0, 300));

console.log("\nlog:", LOG);
