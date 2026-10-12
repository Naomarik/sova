#!/usr/bin/env node
// chat-runtime-trial: al_3 stage 2 end to end (.agent/sova-runtime/stage2-design.md §8.2, §8.3), on a
// hermetic server whose ordinary chats run in their own processes. Never sova-runtime.service, never
// sova-chats.slice, never ~/.pi. It builds a scratch agent dir like dev:hermetic's, starts the mock
// LLM (mock-llm.mjs, its own process, so it outlives every server restart) and drives the server over
// its sockets as a browser would. Each check boots its own server (same agent dir, fresh chat) and
// stops it and every chat process it started before the next.
//
//   node scripts/chat-runtime-trial/run.mjs [checks...] [options]
//
//   checks (default: all, in this order)
//     t1        a long reply survives a server restart: same chat pid, the reconnect's hello carries
//               the reply so far, one assistant entry, no resume text, no ledger entry, no resume
//     t1b       a bash call (sleep 8) runs across the restart; its result arrives once
//     t1c       a dialog open across the restart is re-sent and its answer reaches the tool
//     t1d       a steer queued before the restart is delivered once
//     t1e       a restart mid-compaction: the compaction completes and is written once
//     t1f       a worker runs across the restart: same worker pid, its completion delivered once
//     t2        kill -9 of the chat mid-reply: the pane's error, a new process, the crash "continue"
//               once; a second kill during that resume is not resumed again
//     t3        idle stop (SOVA_CHAT_IDLE_MIN=0.05): not while a client is attached or a run is in
//               flight; then the process exits (no death) and reopens on the next attach
//     t4        new code (SOVA_BUILD a → b): "older" in the pane, Reload now, automatic reload at a
//               quiet moment, never mid-reply; the new process reports b
//     t4fail    a replacement that fails to boot: the rollout halts, the old process stays, "failed"
//     t5        the switch off: today's behaviour (the restart cuts the reply off; one "continue")
//     t6        with the switch on, the Overseer's chat stays in the server
//     t7        q5: a server-hosted action cut by a restart reports "outcome unknown" and ran once
//     t8        two servers on different agent dirs never adopt or stop each other's chats
//     real      (only with --model) t1 on a real model
//
//   --driver <d>      detached (default with --mode child) or systemd (default with --mode unit)
//   --mode <m>        unit: the server runs as a stand-in unit sova-trial-server-<tag>.service
//                     (KillMode=control-group, as the live unit), restarted with systemctl; child: a
//                     plain child, restarted by SIGTERM and a new start (no user bus needed).
//                     Default: unit when the user manager answers, else child
//   --port <n>        the server's port (default: a free one)
//   --scratch <dir>   scratch root (default $TMPDIR/chat-runtime-trial-<tag>); never under ~/.pi
//   --slice <name>    stand-in slice for chat units (default sova-chats-test-<tag>.slice)
//   --model <ref>     add the `real` check on this model (e.g. zai/glm-5.3; needs --auth)
//   --auth <file>     an auth.json copied into the scratch agent dir
//   --keep            leave the scratch agent dir even when everything passed
//
// Writes <scratch>/results.json (every check, pass/fail, details) and keeps server-*.log and
// mock.jsonl beside it. Exit 0 when every check passed, 1 when one failed, 2 on a setup problem.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_RESUME_TEXT,
  KNOBS,
  RESUME_TEXT,
  assistantTexts,
  buildAgentDir,
  chat,
  client,
  freePort,
  healthy,
  mockLog,
  recorder,
  sc,
  server,
  serverEnv,
  show,
  sleep,
  startMock,
  tokenOf,
  userBus,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const ALL = ["t1", "t1b", "t1c", "t1d", "t1e", "t1f", "t2", "t3", "t4", "t4fail", "t5", "t6", "t7", "t8"];
const valued = new Set(["--port", "--scratch", "--slice", "--model", "--auth", "--mode", "--driver"]);
const asked = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
for (const a of asked) if (![...ALL, "real", "all"].includes(a)) (console.error(`unknown check ${a}; checks: ${ALL.join(" ")} real`), process.exit(2));
const checks = asked.length && !asked.includes("all") ? asked : [...ALL, ...(opt("model") ? ["real"] : [])];
const tag = `${process.pid}`;
const mode = opt("mode", userBus() ? "unit" : "child");
const driver = opt("driver", mode === "unit" ? "systemd" : "detached");
if (driver === "systemd" && !userBus()) (console.error("--driver systemd needs the systemd user manager (none answers here)"), process.exit(2));
const fixedPort = opt("port") ? Number(opt("port")) : null;
const scratch = opt("scratch", join(process.env.TMPDIR || tmpdir(), `chat-runtime-trial-${tag}`));
const slice = opt("slice", `sova-chats-test-${tag}.slice`);
mkdirSync(scratch, { recursive: true });
const R = recorder(join(scratch, "results.json"));
console.log(`chat-runtime-trial: server as ${mode}, chats on the ${driver} driver${driver === "systemd" ? ` in ${slice}` : ""}; scratch ${scratch}`);

const mock = await startMock({ port: await freePort(), log: join(scratch, "mock.jsonl"), step: 400 });
const { agent, proj } = buildAgentDir(scratch, { mockPort: mock.port, auth: opt("auth") });
const sova = join(agent, "sova");

// ── state the trial reads (the server's and the chat processes' own records) ────────────────────

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const baseName = (p) => String(p ?? "").split("/").pop();
/** The supervisor's record of this chat: {chatId, sessionPath, unit, pid, startedAt, build, sock, epoch}. */
function record(path, agentDir = agent) {
  const dir = join(agentDir, "sova", "chats", "registry");
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {}
  return files.map((f) => readJson(join(dir, f))).find((r) => r && baseName(r.sessionPath) === baseName(path)) ?? null;
}
const allRecords = (agentDir = agent) => {
  const dir = join(agentDir, "sova", "chats", "registry");
  try {
    return readdirSync(dir).map((f) => readJson(join(dir, f))).filter(Boolean);
  } catch {
    return [];
  }
};
const alive = (pid) => !!pid && existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z");
/** The chat's process now: its record's pid when that process lives. */
const chatPid = (path, agentDir) => {
  const r = record(path, agentDir);
  return r && alive(r.pid) ? r.pid : 0;
};
/** pid and every descendant, with each one's command line. */
function tree(pid) {
  const parent = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const [c, p] of parent) if (p === out[i]) out.push(c);
  return out.map((p) => {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {}
    return { pid: p, cmd };
  });
}
/** The session file's entries. */
const entries = (path) => readLines(path);
/** Assistant messages after the user message holding `marker` (that turn's), with their stop reasons. */
function turnAssistants(path, marker) {
  const es = entries(path).filter((e) => e.type === "message");
  const at = es.findIndex((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes(marker));
  if (at < 0) return [];
  const out = [];
  for (const e of es.slice(at + 1)) {
    if (e.message?.role === "user") break;
    if (e.message?.role === "assistant") out.push(e.message);
  }
  return out;
}
const textOfMsg = (m) => (Array.isArray(m?.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("") : String(m?.content ?? ""));
/** How many user entries of the session hold `text`. */
const userEntriesWith = (path, text) => entries(path).filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes(text)).length;
/** The server's auto-resume decisions on this chat (overseer-actions.jsonl). */
const resumeDecisions = (path) => readLines(join(sova, "overseer-actions.jsonl")).filter((a) => a.tool === "auto_resume" && baseName(a.args?.path) === baseName(path));
const inLedger = (path) => Object.keys(readJson(join(sova, "runs-in-flight.json"))?.runs ?? {}).some((p) => baseName(p) === baseName(path));
const deaths = (path) => readLines(join(sova, "chats", "deaths.jsonl")).filter((d) => JSON.stringify(d).includes(baseName(path).replace(/\.jsonl$/, "")) || baseName(d.sessionPath ?? d.session ?? d.path) === baseName(path));
const fmtDecisions = (ds) => ds.map((a) => `${a.outcome}${a.error ? `: ${a.error}` : ""}`).join("; ") || "none";

// ── one server per check ─────────────────────────────────────────────────────────────────────────

let srv = null;
let base = "";
let c = null;
let n = 0;
async function boot(o = {}) {
  const port = o.agent ? await freePort() : (fixedPort ?? (await freePort()));
  const url = `http://127.0.0.1:${port}`;
  const env = serverEnv({ agent: o.agent ?? agent, port, on: o.on ?? true, driver, slice: driver === "systemd" ? slice : undefined, idleMin: o.idleMin, build: o.build, failBoot: o.failBoot, extra: o.extra });
  const s = server({ tag: `${tag}-${++n}`, env, mode, log: join(scratch, `server-${n}.log`) });
  s.up();
  await healthy(url);
  const cl = client(url, tokenOf(o.agent ?? agent));
  if (!o.agent) {
    srv = s;
    c = cl;
    base = url;
  }
  return { s, c: cl, base: url };
}
async function restart(changes) {
  const before = srv.pid();
  await srv.restart(changes);
  await sleep(1000);
  await healthy(base);
  R.note(`server restarted: pid ${before} → ${srv.pid()}${changes ? ` (${JSON.stringify(changes)})` : ""}`);
}
/** Stops the server and every chat process of the agent dir (records, units of the stand-in slice). */
async function teardown(s = srv, agentDir = agent) {
  if (s) await s.down();
  for (const r of allRecords(agentDir)) {
    if (driver === "systemd" && r.unit) {
      try {
        sc("stop", r.unit.endsWith(".service") ? r.unit : `${r.unit}.service`);
      } catch {}
    } else if (alive(r.pid)) {
      try {
        process.kill(r.pid, "SIGTERM");
      } catch {}
    }
  }
  await sleep(1500);
  for (const r of allRecords(agentDir))
    if (alive(r.pid))
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {}
}
async function newChat(model = "trial/m1", cl = c) {
  const { path } = await cl.api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: proj }) });
  const s = await chat(cl, path);
  s.send({ type: "set_model", ref: model });
  await s.until((m) => m.type === "model" || m.type === "error", 15000, "set_model answer");
  return { path, s };
}
const prompt = (s, text) => s.send({ type: "prompt", text, clientId: `trial-${Date.now()}` });
const isEvent = (t) => (m) => m.type === "event" && m.event?.type === t;
const settled = (s, from = 0, ms = 180000) => s.until(isEvent("run.settled"), ms, "run.settled", from);
const delta = (re) => (m) => m.type === "event" && m.event?.type === "part.delta" && re.test(m.event.delta ?? "");
const liveText = (hello) => (hello.live?.message?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
/** The common restart assertions of T1 and its variants: same pid, no resume of any kind, ledger clear. */
function noResume(path, label) {
  R.check(userEntriesWith(path, RESUME_TEXT) === 0 && userEntriesWith(path, CRASH_RESUME_TEXT) === 0, `${label}: no user entry holds a "continue" text`);
  R.check(!inLedger(path), `${label}: runs-in-flight.json does not list the chat`);
  R.check(resumeDecisions(path).length === 0, `${label}: no auto-resume decision about the chat (${fmtDecisions(resumeDecisions(path))})`);
}
function sameProcess(path, pid1, label) {
  const pid2 = chatPid(path);
  R.check(pid1 && pid2 === pid1, `${label}: the chat process survived the restart (pid ${pid1} → ${pid2 || "none"})`);
  if (driver === "systemd" && pid1) {
    const cg = (() => {
      try {
        return readFileSync(`/proc/${pid1}/cgroup`, "utf8").trim();
      } catch {
        return "";
      }
    })();
    R.check(cg.includes(`/${slice}/`), `${label}: the chat's cgroup is under the stand-in slice, not the server's (${cg})`);
    const unit = record(path)?.unit;
    if (unit) R.check(show(unit.endsWith(".service") ? unit : `${unit}.service`, "KillMode") === "mixed", `${label}: the chat unit has KillMode=mixed`);
  }
}

// ── checks ──────────────────────────────────────────────────────────────────────────────────────

async function t1(model) {
  const label = model ? `real ${model}` : "t1";
  const marker = model ? "REPLY-DONE real" : "[long 50 #t1]";
  const { path, s } = await newChat(model);
  prompt(s, model ? "Write about 1500 words on the history of the printing press. End with a line that reads exactly: REPLY-DONE real" : `${marker} a long reply`);
  if (model) await s.until(isEvent("part.delta"), 120000, "the real model streams").then(() => sleep(5000));
  else await s.until(delta(/part 12\//), 60000, "about 5 s of streaming");
  const pid1 = chatPid(path);
  R.check(pid1, `${label}: the chat runs in its own process (record ${JSON.stringify(record(path))?.slice(0, 200)})`);
  s.close();
  await restart();
  sameProcess(path, pid1, label);
  const s2 = await chat(c, path);
  R.check(s2.hello.isStreaming === true, `${label}: the reconnect's hello says a reply is in progress`);
  const sofar = liveText(s2.hello);
  R.check(sofar.length > 0, `${label}: the hello carries live.message.parts (${sofar.length} chars: "${sofar.slice(0, 40)}…")`);
  await settled(s2, 0);
  await sleep(1500);
  const msgs = turnAssistants(path, model ? "REPLY-DONE real" : marker);
  const final = msgs.map(textOfMsg).join("");
  R.check(sofar && final.startsWith(sofar), `${label}: the reply so far is a prefix of the final reply`);
  R.check(msgs.length === 1 && msgs[0].stopReason !== "aborted" && msgs[0].stopReason !== "error", `${label}: exactly one assistant entry for the turn, not cut off (${msgs.map((m) => m.stopReason).join(", ")})`);
  R.check(final.includes(model ? "REPLY-DONE real" : "REPLY-DONE t1"), `${label}: the reply completed`);
  if (!model) R.check(mockLog(mock.log).filter((e) => e.tag === "t1" && e.scenario).length === 1, `${label}: the model was asked for the reply once`);
  noResume(path, label);
  s2.close();
}

async function t1b() {
  const { path, s } = await newChat();
  prompt(s, "[bash 8] run it");
  await s.until(isEvent("tool.start"), 60000, "the bash call starts");
  await sleep(1500);
  const pid1 = chatPid(path);
  s.close();
  await restart();
  sameProcess(path, pid1, "t1b");
  const s2 = await chat(c, path);
  await settled(s2, 0, 60000);
  await sleep(1500);
  const results = entries(path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
  R.check(results.length === 1 && JSON.stringify(results[0]).includes("BASH-DONE"), `t1b: the bash result arrived once, complete (${results.length})`);
  R.check(mockLog(mock.log).filter((e) => e.afterTool && /BASH-DONE/.test(e.toolText ?? "")).length === 1, "t1b: the model got the result once");
  noResume(path, "t1b");
  s2.close();
}

async function t1c() {
  const { path, s } = await newChat();
  prompt(s, "[ask] ask me");
  const req = await s.until((m) => m.type === "ui_request", 60000, "the dialog");
  const pid1 = chatPid(path);
  s.close();
  await restart();
  sameProcess(path, pid1, "t1c");
  const s2 = await chat(c, path);
  const again = await s2.until((m) => m.type === "ui_request", 15000, "the dialog after the restart").catch(() => null);
  R.check(again, `t1c: the dialog was re-sent after the restart (id ${req.id} → ${again?.id})`);
  if (again) {
    s2.send({ type: "ui_response", id: again.id, value: true });
    await settled(s2, 0, 60000);
    await sleep(1500);
    const { texts } = await assistantTexts(c, path);
    R.check(texts.some((t) => t.includes("DIALOG-ANSWER yes")), "t1c: the answer (yes, not the default) reached the tool");
  }
  noResume(path, "t1c");
  s2.close();
}

async function t1d() {
  const { path, s } = await newChat();
  prompt(s, "[long 40 #t1d] a long reply");
  await s.until(delta(/part 3\//), 60000, "streaming");
  s.send({ type: "steer", text: "STEER-ONE please note", clientId: `trial-steer-${Date.now()}` });
  await sleep(1000);
  const pid1 = chatPid(path);
  s.close();
  await restart();
  sameProcess(path, pid1, "t1d");
  const s2 = await chat(c, path);
  // The steer runs a second turn after the reply: wait until the model has seen it and settled.
  for (let i = 0; i < 120 && !mockLog(mock.log).some((e) => /STEER-ONE/.test(e.userText ?? "")); i++) await sleep(500);
  await sleep(3000);
  R.check(userEntriesWith(path, "STEER-ONE") === 1, `t1d: the steer is in the session once (${userEntriesWith(path, "STEER-ONE")})`);
  R.check(mockLog(mock.log).filter((e) => /STEER-ONE/.test(e.userText ?? "")).length === 1, "t1d: the model got the steer once");
  noResume(path, "t1d");
  s2.close();
}

async function t1e() {
  const { path, s } = await newChat();
  prompt(s, "say ok");
  await settled(s, 0, 60000);
  prompt(s, "/compact");
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.scenario === "compact"); i++) await sleep(500);
  await sleep(2000);
  const pid1 = chatPid(path);
  s.close();
  await restart();
  sameProcess(path, pid1, "t1e");
  const s2 = await chat(c, path);
  for (let i = 0; i < 60 && !entries(path).some((e) => e.type === "compaction"); i++) await sleep(500);
  await sleep(1500);
  const comps = entries(path).filter((e) => e.type === "compaction");
  R.check(comps.length === 1 && JSON.stringify(comps[0]).includes("COMPACT-SUMMARY"), `t1e: the compaction completed and was written once (${comps.length})`);
  R.check(mockLog(mock.log).filter((e) => e.event === "cut-off" && e.scenario === "compact").length === 0, "t1e: the summary request was never cut off");
  noResume(path, "t1e");
  s2.close();
}

async function t1f() {
  const { path, s } = await newChat();
  prompt(s, "[spawn] start a worker");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.tag === "worker"); i++) await sleep(500);
  await sleep(2000);
  const pid1 = chatPid(path);
  const workers1 = tree(pid1).filter((p) => p.pid !== pid1 && /--mode rpc/.test(p.cmd));
  R.check(workers1.length === 1, `t1f: one worker process under the chat (${workers1.map((w) => w.pid).join(", ") || "none"})`);
  s.close();
  await restart();
  sameProcess(path, pid1, "t1f");
  const wpid = workers1[0]?.pid;
  R.check(wpid && alive(wpid), `t1f: the worker process survived (pid ${wpid})`);
  const s2 = await chat(c, path);
  const w = await s2.until((m) => m.type === "workers" && m.workers?.some((x) => x.outcome), 120000, "the worker ends").catch(() => null);
  const worker = w?.workers?.find((x) => x.name === "trial-worker") ?? w?.workers?.[0];
  R.check(worker?.outcome === "success", `t1f: the worker finished on its own (outcome ${worker?.outcome})`);
  const log = mockLog(mock.log);
  R.check(log.filter((e) => e.event === "done" && e.tag === "worker").length === 1 && !log.some((e) => e.event === "cut-off" && e.tag === "worker"), "t1f: the worker's reply streamed to its end once");
  // Its completion wakes the parent once: one user entry carrying the worker's result.
  await sleep(5000);
  const wakes = entries(path).filter((e) => e.type === "message" && e.message?.role === "user" && /REPLY-DONE worker/.test(JSON.stringify(e.message.content))).length;
  const custom = entries(path).filter((e) => e.type !== "message" && /REPLY-DONE worker/.test(JSON.stringify(e))).length;
  R.check(wakes + custom === 1, `t1f: the worker's completion was delivered to the chat once (${wakes} user, ${custom} other)`);
  noResume(path, "t1f");
  s2.close();
}

async function t2() {
  const { path, s } = await newChat();
  prompt(s, "[long 40 #t2] a long reply");
  await s.until(delta(/part 5\//), 60000, "streaming");
  const pid1 = chatPid(path);
  if (!R.check(pid1, "t2: the chat's process is found")) return;
  const from = s.got.length;
  const closed = new Promise((r) => s.ws.once("close", (code) => r(code)));
  process.kill(pid1, "SIGKILL");
  R.note(`t2: killed chat process ${pid1}`);
  const err = await s.until((m) => m.type === "error" && /stopped unexpectedly/.test(m.message ?? ""), 20000, "the pane's error", from).catch(() => null);
  R.check(err?.code === "internal", `t2: the pane got the stopped-unexpectedly error ("${err?.message?.slice(0, 120)}")`);
  const code = await Promise.race([closed, sleep(10000).then(() => "none")]);
  R.check(code === 4500, `t2: the socket closed with 4500 (${code})`);
  R.check(deaths(path).length === 1, `t2: one death recorded in chats/deaths.jsonl (${deaths(path).length})`);
  // The resume reopens the chat in a new process and sends the crash text once.
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.tag === "resume"); i++) await sleep(500);
  const pid2 = chatPid(path);
  R.check(pid2 && pid2 !== pid1, `t2: a new process hosts the chat (pid ${pid1} → ${pid2 || "none"})`);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1 && userEntriesWith(path, RESUME_TEXT) === 0, `t2: the crash "continue" was sent once (${userEntriesWith(path, CRASH_RESUME_TEXT)}), never the restart text`);
  // A second kill while the resume runs: never resumed again.
  await sleep(2000);
  if (pid2) process.kill(pid2, "SIGKILL");
  R.note(`t2: killed the resuming process ${pid2}`);
  await sleep(15000);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1, `t2: the cut-off resume was not resumed a second time (${userEntriesWith(path, CRASH_RESUME_TEXT)})`);
  R.check(mockLog(mock.log).filter((e) => e.tag === "resume" && e.scenario).length === 1, "t2: the model was asked to continue once");
  const s2 = await chat(c, path);
  R.check(chatPid(path) && chatPid(path) !== pid2, "t2: reconnecting spawns a new process");
  s2.close();
}

async function t3() {
  // A fresh server with a 3 s idle stop.
  await teardown();
  await boot({ idleMin: 0.05 });
  const { path, s } = await newChat();
  prompt(s, "say ok");
  await settled(s, 0, 60000);
  const pid1 = chatPid(path);
  await sleep(9000);
  R.check(chatPid(path) === pid1, `t3: with a client attached the process stays (pid ${pid1} → ${chatPid(path)})`);
  prompt(s, "[long 25 #t3] a long reply");
  await s.until(delta(/part 2\//), 30000, "streaming");
  s.close();
  await sleep(6000);
  R.check(chatPid(path) === pid1, "t3: with a run in flight and no client, the process stays");
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.event === "done" && e.tag === "t3"); i++) await sleep(500);
  for (let i = 0; i < 40 && alive(pid1); i++) await sleep(500);
  R.check(!alive(pid1), `t3: after the run, with nobody attached, the process stopped (${alive(pid1) ? "still alive" : "gone"})`);
  R.check(deaths(path).length === 0, "t3: an idle stop is no death");
  const s2 = await chat(c, path);
  const pid2 = chatPid(path);
  R.check(pid2 && pid2 !== pid1, `t3: attaching reopens it in a new process (pid ${pid2})`);
  R.check(JSON.stringify(s2.hello.items).includes("REPLY-DONE t3"), "t3: the reopened chat shows its history");
  prompt(s2, "say ok again");
  await settled(s2, 0, 60000);
  R.check(true, "t3: a new turn ran after the reopen");
  s2.close();
  await teardown();
  await boot();
}

const codeMsgs = (s, from = 0) => s.got.slice(from).filter((m) => m.type === "code");
async function t4() {
  await teardown();
  await boot({ build: "trial-a" });
  // Chat A: attached the whole time, reloaded with Reload now.
  const A = await newChat();
  prompt(A.s, "say ok");
  await settled(A.s, 0, 60000);
  // Chat B: mid-reply at the restart, nobody attached: reloads by itself once the reply ends.
  const B = await newChat();
  prompt(B.s, "[long 30 #t4b] a long reply");
  await B.s.until(delta(/part 3\//), 30000, "B streams");
  const pidA = chatPid(A.path);
  const pidB = chatPid(B.path);
  A.s.close();
  B.s.close();
  await restart({ [KNOBS.build]: "trial-b" });
  const a2 = await chat(c, A.path);
  const older = await a2.until((m) => m.type === "code", 15000, "A's code state").catch(() => null);
  R.check(older?.state === "older", `t4: an attached chat on the old build shows "older" (${JSON.stringify(older)})`);
  // B must not reload while its reply runs.
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.event === "done" && e.tag === "t4b"); i++) {
    if (chatPid(B.path) !== pidB) break;
    await sleep(500);
  }
  R.check(mockLog(mock.log).some((e) => e.event === "done" && e.tag === "t4b") && turnAssistants(B.path, "[long 30 #t4b]").length === 1, "t4: B's reply ran to its end, never cut by a reload");
  for (let i = 0; i < 60 && chatPid(B.path) === pidB; i++) await sleep(500);
  const recB = record(B.path);
  R.check(chatPid(B.path) && chatPid(B.path) !== pidB && recB?.build === "trial-b", `t4: B reloaded by itself at the quiet moment (pid ${pidB} → ${chatPid(B.path)}, build ${recB?.build})`);
  // A: attached, so it waits for the dwell; Reload now reloads at once.
  R.check(chatPid(A.path) === pidA, "t4: A, attached, did not reload by itself");
  const from = a2.got.length;
  a2.send({ type: "reload_code" });
  const reloaded = await a2.until((m) => m.type === "reloaded", 40000, "reloaded", from).catch(() => null);
  R.check(reloaded, "t4: Reload now reloaded the chat (a 'reloaded' message)");
  for (let i = 0; i < 40 && chatPid(A.path) === pidA; i++) await sleep(500);
  const a3 = await chat(c, A.path);
  await sleep(2000);
  R.check(chatPid(A.path) !== pidA && record(A.path)?.build === "trial-b", `t4: A runs a new process on build b (pid ${pidA} → ${chatPid(A.path)})`);
  R.check(codeMsgs(a3).every((m) => m.state !== "older"), "t4: the reloaded chat shows no badge");
  // Reload now on a current chat is refused.
  const f2 = a3.got.length;
  a3.send({ type: "reload_code" });
  const refusal = await a3.until((m) => m.type === "error", 10000, "the refusal", f2).catch(() => null);
  R.check(/already runs the current code/.test(refusal?.message ?? ""), `t4: Reload now on a current chat is refused ("${refusal?.message}")`);
  a2.close();
  a3.close();
  await teardown();
  await boot();
}

async function t4fail() {
  await teardown();
  await boot({ build: "trial-a" });
  const A = await newChat();
  prompt(A.s, "say ok");
  await settled(A.s, 0, 60000);
  const B = await newChat();
  prompt(B.s, "say ok");
  await settled(B.s, 0, 60000);
  const pidA = chatPid(A.path);
  const pidB = chatPid(B.path);
  A.s.close();
  B.s.close();
  await restart({ [KNOBS.build]: "trial-b", [KNOBS.failBoot]: "trial-b" });
  await sleep(45000);
  const kept = [chatPid(A.path) === pidA, chatPid(B.path) === pidB];
  R.check(kept[0] && kept[1], `t4fail: both old processes are kept (A ${pidA} → ${chatPid(A.path)}, B ${pidB} → ${chatPid(B.path)})`);
  const a2 = await chat(c, A.path);
  const b2 = await chat(c, B.path);
  await sleep(2000);
  const states = [codeMsgs(a2).at(-1)?.state, codeMsgs(b2).at(-1)?.state];
  R.check(states.includes("failed") && states.filter((x) => x === "failed").length === 1, `t4fail: exactly one chat shows "failed", the rollout halted before the other (${states.join(", ")})`);
  R.check(states.every((x) => x === "older" || x === "failed"), "t4fail: the other stays on older code");
  a2.close();
  b2.close();
  await teardown();
  await boot();
}

async function t5() {
  await teardown();
  await boot({ on: false });
  const { path, s } = await newChat();
  prompt(s, "[long 30 #off] a long reply");
  await s.until(delta(/part 5\//), 60000, "streaming");
  R.check(!record(path), "t5: no chat process was started");
  s.close();
  await restart();
  for (let i = 0; i < 60 && !resumeDecisions(path).length; i++) await sleep(500);
  const ds = resumeDecisions(path);
  R.check(mockLog(mock.log).some((e) => e.event === "cut-off"), "t5: the restart cut the reply off (as today)");
  R.check(ds.length === 1 && ds[0].outcome === "ok", `t5: auto-resume resumed the chat once (${fmtDecisions(ds)})`);
  if (ds[0]?.outcome === "ok") {
    const s2 = await chat(c, path);
    await settled(s2, 0, 60000).catch(() => {});
    await sleep(1500);
    const asked = mockLog(mock.log).filter((e) => e.scenario && /server restarted/i.test(e.userText ?? "")).length;
    R.check(asked === 1 && userEntriesWith(path, RESUME_TEXT) === 1, `t5: the "continue" message was delivered exactly once (model asked ${asked}×, session holds it ${userEntriesWith(path, RESUME_TEXT)}×)`);
    s2.close();
  }
  await teardown();
  await boot();
}

async function t6() {
  // The Overseer's chat: opened as the page opens it, then looked for among the chat processes.
  const st = await c.api("/api/overseer").catch(() => null);
  const path = st?.path ?? st?.current?.path ?? st?.session?.path;
  if (!R.check(path, `t6: the Overseer's session is found (${JSON.stringify(st)?.slice(0, 160)})`)) return;
  const s = await chat(c, path);
  await sleep(2000);
  R.check(!record(path), "t6: the Overseer's chat has no chat process (it stays in the server)");
  s.close();
  // The control: an ordinary chat on the same server does get one.
  const o = await newChat();
  prompt(o.s, "say ok");
  await settled(o.s, 0, 60000);
  R.check(chatPid(o.path), "t6: an ordinary chat on the same server runs in its own process (the switch is on)");
  o.s.close();
}

async function t7() {
  // Needs the server's test-only served tool (trial_served_sleep).
  const { path, s } = await newChat();
  prompt(s, "[served] run it");
  await s.until(isEvent("tool.start"), 60000, "the served call starts");
  await sleep(2000);
  s.close();
  await restart();
  const s2 = await chat(c, path);
  await settled(s2, 0, 120000);
  await sleep(1500);
  const results = entries(path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
  R.check(results.length === 1 && /outcome is unknown/.test(JSON.stringify(results[0])), `t7: the chat's tool result is the unknown-outcome text (${JSON.stringify(results[0]?.message?.content)?.slice(0, 160)})`);
  const runs = readLines(join(sova, "chats", "test-served.jsonl")).filter((e) => e.event === "start");
  R.check(runs.length === 1, `t7: the action ran once (${runs.length} starts)`);
  s2.close();
}

async function t8() {
  // A second server on an agent dir of its own.
  const bAgent = buildAgentDir(join(scratch, "b"), { mockPort: mock.port }).agent;
  const B = await boot({ agent: bAgent });
  const a = await newChat();
  const b = await newChat("trial/m1", B.c);
  prompt(a.s, "say ok");
  prompt(b.s, "say ok");
  await Promise.all([settled(a.s, 0, 60000), settled(b.s, 0, 60000)]);
  const pidA = chatPid(a.path);
  const pidB = chatPid(b.path, bAgent);
  a.s.close();
  b.s.close();
  await restart();
  await sleep(3000);
  R.check(alive(pidB) && chatPid(b.path, bAgent) === pidB, `t8: B's chat is untouched by A's restart (pid ${pidB})`);
  R.check(!allRecords().some((r) => baseName(r.sessionPath) === baseName(b.path)), "t8: A did not adopt B's chat");
  R.check(chatPid(a.path) === pidA, "t8: A re-adopted its own chat");
  await teardown(B.s, bAgent);
  R.check(chatPid(a.path) === pidA, "t8: stopping B left A's chat running");
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

const table = { t1: () => t1(), t1b, t1c, t1d, t1e, t1f, t2, t3, t4, t4fail, t5, t6, t7, t8, real: () => t1(opt("model")) };
let code = 0;
try {
  await boot();
  for (const name of checks) {
    console.log(`\n== ${name}`);
    const t0 = Date.now();
    try {
      await table[name]();
    } catch (e) {
      R.check(false, `${name}: ran to its end`, e instanceof Error ? e.message : String(e));
      // A check that threw may leave anything behind: start the next from a clean server.
      await teardown().catch(() => {});
      await boot().catch((err) => R.note(`reboot failed: ${err}`));
    }
    R.note(`${name}: ${Math.round((Date.now() - t0) / 1000)} s`);
  }
} catch (e) {
  console.error(`chat-runtime-trial: ${e instanceof Error ? e.stack : String(e)}`);
  code = 2;
} finally {
  await teardown().catch(() => {});
  if (driver === "systemd")
    try {
      execFileSync("systemctl", ["--user", "stop", slice]);
    } catch {}
  mock.stop();
  const file = R.save({ asked: checks, mode, driver, slice: driver === "systemd" ? slice : null, knobs: KNOBS });
  console.log(`\nresults: ${file}`);
  if (!argv.includes("--keep") && code === 0 && R.checks.every((x) => x.ok !== false)) rmSync(join(scratch, "agent"), { recursive: true, force: true });
}
const failed = R.checks.filter((x) => x.ok === false).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
process.exit(code || (failed ? 1 : 0));
