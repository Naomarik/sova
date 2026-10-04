#!/usr/bin/env node
// End-to-end chat checks against a running Sova server (Node vs Bun verification).
//   node scripts/bun-verify-e2e.mjs <port> <agentDir> <modelRef> [checks=tool,steer,abort,image] [cwd=/tmp/sova-verify-cwd]
// Creates one throwaway session, sets the model before the first prompt, runs the checks,
// archives the session (unless VERIFY_KEEP=1), prints a JSON result.
// Checks: tool, steer, abort, image (verify.md #1 on a pi model, #2 on claude-code-cli/opus[1m]);
// workers (#3: one pi + one claude-code worker, then a pi+claude team pinging over team_msg; run
// on a pi model, with VERIFY_PS_ROOT=<server pid> to list which runtime each helper ran on);
// custom (VERIFY_PROMPT). Env: VERIFY_MINOR=spec (minor modes before the first prompt),
// VERIFY_SANDBOX=1 (/api/sandbox on), VERIFY_PS_ROOT / VERIFY_PS_ENV / VERIFY_PS_MS (sampler).
import { readFileSync, mkdirSync, writeFileSync, readdirSync, readlinkSync } from "node:fs";
import { deflateSync } from "node:zlib";
import WebSocket from "ws";

const [portArg, agentDir, modelRef, checksArg = "tool,steer,abort,image", cwdArg] = process.argv.slice(2);
const PORT = Number(portArg);
const TOKEN = readFileSync(`${agentDir}/sova/auth-token`, "utf8").trim();
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-sova-token": TOKEN, Host: `127.0.0.1:${PORT}` };
const CWD = cwdArg ?? "/tmp/sova-verify-cwd";
mkdirSync(CWD, { recursive: true });
// the tool check's fixture: three files to `ls`, only ever in a throwaway /tmp dir
if (CWD.startsWith("/tmp/")) for (const f of ["alpha.txt", "beta.txt", "gamma.txt"]) writeFileSync(`${CWD}/${f}`, f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { ...H, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
}

/** A solid-colour PNG, 32x32 RGB. */
function png(r, g, b) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const W = 32; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(W * (1 + W * 3)); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (1 + W * 3) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

class Chat {
  constructor(path) { this.path = path; this.msgs = []; this.waiters = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?path=${encodeURIComponent(this.path)}`, { headers: { ...H, Origin: BASE } });
      this.ws.on("message", (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        this.msgs.push(m);
        if (m.type === "hello") res();
        for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
      });
      this.ws.on("error", rej);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 180000, label = "wait") {
    return new Promise((res, rej) => {
      const w = { pred, res: (m) => { clearTimeout(t); res(m); } };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error(`timeout: ${label}`)); }, ms);
      this.waiters.push(w);
    });
  }
  mark() { return this.msgs.length; }
  since(i) { return this.msgs.slice(i); }
}
const ev = (t) => (m) => m.type === "event" && m.event?.type === t;
const errMsg = (m) => m.type === "error";

/** The assistant text of the last agent_end's messages, and any errorMessage. */
function endInfo(end) {
  const msgs = end.event.messages ?? [];
  const as = msgs.filter((x) => x.role === "assistant");
  const last = as.at(-1);
  const text = as.flatMap((x) => (x.content ?? []).filter((c) => c.type === "text").map((c) => c.text)).join("\n");
  const lastText = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  return { text: text.slice(0, 300), last: lastText.slice(-200), stopReason: last?.stopReason, error: last?.errorMessage };
}

const R = { port: PORT, model: modelRef, checks: {} };

// VERIFY_PS_ROOT=<server pid>: sample the server's descendants every 150 ms and record each
// distinct (exe, argv) — which runtime the worker host, the team MCP server, hooks, etc. ran on.
const seen = new Map();
if (process.env.VERIFY_PS_ROOT) {
  const root = Number(process.env.VERIFY_PS_ROOT);
  setInterval(() => {
    const parent = new Map();
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try { const st = readFileSync(`/proc/${d}/stat`, "utf8"); parent.set(Number(d), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])); } catch {}
    }
    for (const pid of parent.keys()) {
      let p = pid, depth = 0;
      while (p > 1 && p !== root && depth++ < 30) p = parent.get(p) ?? 0;
      if (pid === root || pid === process.pid) continue;
      let tagged = false;
      if (p !== root && process.env.VERIFY_PS_ENV) try { tagged = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(process.env.VERIFY_PS_ENV); } catch {}
      if (p !== root && !tagged) continue;
      try {
        const exe = readlinkSync(`/proc/${pid}/exe`);
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).map((a) => a.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/")).join(" ").slice(0, 220);
        if (argv.includes("server/index.ts")) continue;
        const key = `${exe} :: ${argv}`;
        if (!seen.has(key)) seen.set(key, { pid, child: p === root, exe, argv });
      } catch {}
    }
  }, Number(process.env.VERIFY_PS_MS ?? 150)).unref();
}
const created = await api("POST", "/api/sessions", { cwd: CWD });
if (created.status !== 201 && created.status !== 200) { console.log(JSON.stringify({ ...R, createError: created }, null, 2)); process.exit(1); }
R.session = created.body.path ?? created.body;
const chat = new Chat(created.body.path);
await chat.open();
if (process.env.VERIFY_MINOR) {
  const r = await api("POST", `/api/mode?path=${encodeURIComponent(created.body.path)}`, { minorModes: process.env.VERIFY_MINOR.split(",") });
  R.mode = r.body;
}
if (process.env.VERIFY_SANDBOX) {
  const r = await api("POST", `/api/sandbox?path=${encodeURIComponent(created.body.path)}`, { on: true });
  R.sandbox = r.body;
}
chat.send({ type: "set_model", ref: modelRef });
const mm = await chat.wait((m) => m.type === "model" || errMsg(m), 30000, "set_model");
R.modelSet = mm.type === "model" ? mm.model : `ERROR ${mm.message}`;
const errorsDuring = (i) => chat.since(i).filter(errMsg).map((m) => m.message);

async function turn(name, fn) {
  const i = chat.mark(); const t0 = Date.now();
  try { R.checks[name] = { ...(await fn(i)), ms: Date.now() - t0 }; }
  catch (e) { R.checks[name] = { pass: false, err: String(e.message ?? e), ms: Date.now() - t0 }; }
  const errs = errorsDuring(i); if (errs.length) R.checks[name].wsErrors = errs;
  // let the session settle before the next check
  for (let k = 0; k < 50 && chat.msgs.slice(-1)[0]?.event?.type === "agent_start"; k++) await sleep(100);
  await sleep(1500);
}

const checks = checksArg.split(",");
if (checks.includes("tool")) await turn("tool", async (i) => {
  chat.send({ type: "prompt", text: "Use the bash tool to run `ls` in the current directory, then reply with only the number of files listed.", clientId: "c-tool" });
  const end = await chat.wait(ev("agent_end"), 180000, "agent_end");
  const tools = chat.since(i).filter(ev("tool_execution_end")).map((m) => `${m.event.toolName}${m.event.isError ? "(err)" : ""}`);
  const info = endInfo(end);
  return { pass: tools.some((t) => t === "bash") && /3/.test(info.last), tools, ...info, text: undefined };
});
if (checks.includes("steer")) await turn("steer", async (i) => {
  // pi delivers a steer at the next turn boundary (after the running tool call), so the turn
  // must be a chain of slow tool calls for the steer to land mid-run
  chat.send({ type: "prompt", text: "Run the bash command `sleep 4` five times, as five separate bash tool calls one after another. Then reply DONE.", clientId: "c-steer-p" });
  await chat.wait(ev("tool_execution_start"), 120000, "first tool call");
  chat.send({ type: "steer", text: "Stop counting now. Reply with only the word PINEAPPLE.", clientId: "c-steer" });
  const end = await chat.wait(ev("agent_end"), 240000, "agent_end");
  // a steer delivered after the turn's last message runs as its own follow-up turn
  let info = endInfo(end);
  if (!/PINEAPPLE/i.test(info.last)) { const end2 = await chat.wait(ev("agent_end"), 120000, "agent_end 2").catch(() => null); if (end2) info = endInfo(end2); }
  const steerRow = chat.since(i).some((m) => (m.type === "append" || m.type === "history") && JSON.stringify(m).includes("PINEAPPLE"));
  const sleeps = chat.since(i).filter(ev("tool_execution_end")).length;
  return { pass: /PINEAPPLE/i.test(info.last) && sleeps < 5, toolCallsBeforeStop: sleeps, steerRow, ...info, text: undefined };
});
if (checks.includes("abort")) await turn("abort", async (i) => {
  chat.send({ type: "prompt", text: "Write a 600 word essay about rivers. No tools.", clientId: "c-abort" });
  await chat.wait((m) => ev("message_update")(m) && m.event.assistantMessageEvent?.type === "text_delta", 120000, "first text delta");
  const t = Date.now();
  chat.send({ type: "abort" });
  const end = await chat.wait(ev("agent_end"), 30000, "agent_end after abort");
  const info = endInfo(end);
  return { pass: info.stopReason === "aborted", abortToEndMs: Date.now() - t, ...info, text: info.text.slice(0, 60) };
});
if (checks.includes("image")) await turn("image", async () => {
  chat.send({ type: "prompt", text: "What is the single colour of the attached image? Reply with one word.", images: [{ data: png(220, 20, 20), mimeType: "image/png" }], clientId: "c-img" });
  const end = await chat.wait(ev("agent_end"), 240000, "agent_end");
  const info = endInfo(end);
  return { pass: /red/i.test(info.last), ...info, text: undefined };
});
if (checks.includes("workers")) await turn("workers", async () => {
  chat.send({ type: "prompt", clientId: "c-workers", text: [
    "This is an automated infrastructure test; follow the steps exactly and keep everything minimal.",
    '1. Call agent_spawn with agents = [{"name":"piw","model":"zai/glm-5.3","prompt":"Reply with exactly: PIW-OK"},{"name":"ccw","backend":"claude-code","model":"sonnet","prompt":"Reply with exactly: CCW-OK"}]. Then call agent_wait until both have settled.',
    '2. Call team_create with name "vt", objective "ping-pong test", defaults {"coordinator": false, "monitor": false}, and two members: role "a" on backend pi, model zai/glm-5.3, whose prompt is "Use team_msg to send the text ping to role b. Then call team_inbox until a reply from b arrives (at most 6 tries). End with the reply text." and role "b" on backend claude-code, model sonnet, whose prompt is "Call team_inbox until a message from a arrives (at most 6 tries). Then use team_msg to send pong to role a. End with the word DONE." Then call agent_wait until both members settle.',
    "3. Reply with one line per worker: its name/role, its status, and its final text (or error).",
  ].join("\n") });
  const end = await chat.wait(ev("agent_end"), 600000, "agent_end");
  const tools = chat.msgs.filter(ev("tool_execution_end")).map((m) => `${m.event.toolName}${m.event.isError ? "(err)" : ""}`);
  const info = endInfo(end);
  const all = (info.text + "\n" + info.last);
  return { pass: /PIW-OK/.test(all) && /CCW-OK/.test(all) && /pong/i.test(all) && /DONE/.test(all), tools, ...info, text: undefined, last: info.last.slice(-1200) };
});
if (checks.includes("custom")) await turn("custom", async () => {
  chat.send({ type: "prompt", text: process.env.VERIFY_PROMPT, clientId: "c-custom" });
  const end = await chat.wait(ev("agent_end"), Number(process.env.VERIFY_TIMEOUT ?? 600000), "agent_end");
  const tools = chat.msgs.filter(ev("tool_execution_end")).map((m) => `${m.event.toolName}${m.event.isError ? "(err)" : ""}`);
  return { pass: true, tools, ...endInfo(end), text: endInfo(end).text.slice(0, 1500) };
});

chat.ws.close();
if (seen.size) R.processes = [...seen.values()];
if (!process.env.VERIFY_KEEP) R.archived = (await api("POST", "/api/sessions/archive", { path: created.body.path, archived: true })).status;
console.log(JSON.stringify(R, null, 2));
process.exit(0);
