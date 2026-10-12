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
//     t6        (T6', stage 3) with the switch on, the Overseer, a project overseer, a baton and a
//               powers chat each run in a process (a unit) of their own; a worker's session does not
//     t7        q5: a server-hosted action cut by a restart reports "outcome unknown" and ran once
//     t8        two servers on different agent dirs never adopt or stop each other's chats
//     t9        an outside SIGTERM to a chat process with a pane attached: the pane gets a quiet
//               reloaded (no crash text), reconnects within seconds and gets a fresh hello
//     stage 3 (stage3-design.md §10.2):
//     t10       the Overseer out: sova_list_sessions, read, edit (applied; a bad one refused), sova_note, sova_idea explore (the explorer a
//               child of its process); the run note in the file
//     t11       a restart mid an Overseer's served tool: unknown, ran once; a message queued before the
//               restart reaches the next server's limits (reset)
//     t11b      a restart while an Overseer's sova_note waits after acting (SOVA_CHAT_TEST_ACT_DELAY_AT
//               after): unknown, one act-wait, the note once, never re-sent
//     t11c      the same for a project overseer, waiting before acting: unknown, no note
//     t12a      a baton: a participant's message through the share hub; record_decision's owner area in
//               the roster's spelling, its quote checked
//     t12b      a restart mid baton reply: it finishes; one reply/writing, one reply/ended
//     t12c      take-back mid reply: "(taken back)" in the file when the route answers; one reply/ended
//     t12d      the model hands off (hand_to): one hand-to row, one hand-off entry, one reply/ended
//     t13       a project overseer's look across a restart: one look message, one turn, recorded cut off
//     t14       a brief while the Overseer reloads (the test tick route): one brief turn
//     t15       kill -9 of a baton mid-reply: the pane's error, reply/ended once, no "continue"
//     t16       a powers chat's session_send to another process (hop header); a restart mid-send
//               delivers at most once
//     real      (only with --model) t1 on a real model
//     plumbing  (only when asked) the trial's stage-3 steps work: an Overseer tool call, an org with a
//               baton, a project overseer and a look now
//
//   --driver <d>      detached (default with --mode child) or systemd (default with --mode unit)
//   --mode <m>        unit: the server runs as a stand-in unit sova-trial-server-<tag>.service
//                     (KillMode=control-group, as the live unit), restarted with systemctl; child: a
//                     plain child, restarted by SIGTERM and a new start (no user bus needed).
//                     Default: unit when the user manager answers, else child
//   --port <n>        the server's port (default: a free one)
//   --scratch <dir>   scratch root (default $TMPDIR/chat-runtime-trial-<tag>); never under ~/.pi
//   --slice <name>    stand-in slice for chat units (default sovatrial<tag>.slice, top-level)
//   --model <ref>     add the `real` check on this model (e.g. zai/glm-5.3; needs --auth)
//   --auth <file>     an auth.json copied into the scratch agent dir
//   --keep            leave the scratch agent dir even when everything passed
//
// Writes <scratch>/results.json (every check, pass/fail, details) and keeps server-*.log and
// mock.jsonl beside it. Exit 0 when every check passed, 1 when one failed, 2 on a setup problem.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const ALL = ["t1", "t1b", "t1c", "t1d", "t1e", "t1f", "t2", "t3", "t4", "t4fail", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t11b", "t11c", "t12a", "t12b", "t12c", "t12d", "t13", "t14", "t15", "t16"];
const valued = new Set(["--port", "--scratch", "--slice", "--model", "--auth", "--mode", "--driver"]);
const asked = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
for (const a of asked) if (![...ALL, "plumbing", "real", "all"].includes(a)) (console.error(`unknown check ${a}; checks: ${ALL.join(" ")} real`), process.exit(2));
const checks = asked.length && !asked.includes("all") ? asked : [...ALL, ...(opt("model") ? ["real"] : [])];
const tag = `${process.pid}`;
const mode = opt("mode", userBus() ? "unit" : "child");
const driver = opt("driver", mode === "unit" ? "systemd" : "detached");
if (driver === "systemd" && !userBus()) (console.error("--driver systemd needs the systemd user manager (none answers here)"), process.exit(2));
const fixedPort = opt("port") ? Number(opt("port")) : null;
const scratch = opt("scratch", join(process.env.TMPDIR || tmpdir(), `chat-runtime-trial-${tag}`));
// No dash before the tag: a dash nests a slice under its prefix (sova-chats-test-1.slice sits inside
// sova-chats.slice); this one is a top-level slice of its own.
const slice = opt("slice", `sovatrial${tag}.slice`);
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
/** The chat process's in-flight marker (<stateRoot>/chats/inflight/<sessionId>.json). */
const hasMarker = (path) => existsSync(join(sova, "chats", "inflight", `${entries(path)[0]?.id}.json`));
const inLedger = (path) => Object.keys(readJson(join(sova, "runs-in-flight.json"))?.runs ?? {}).some((p) => baseName(p) === baseName(path));
const deaths = (path) => readLines(join(sova, "chats", "deaths.jsonl")).filter((d) => JSON.stringify(d).includes(baseName(path).replace(/\.jsonl$/, "")) || baseName(d.sessionPath ?? d.session ?? d.path) === baseName(path));
const fmtDecisions = (ds) => ds.map((a) => `${a.outcome}${a.error ? `: ${a.error}` : ""}`).join("; ") || "none";

// ── one server per check ─────────────────────────────────────────────────────────────────────────

let srv = null;
let base = "";
/** The share listener of the current server (baton links' pages: /api/h/<token>/...). */
let shareBase = "";
let c = null;
let n = 0;
async function boot(o = {}) {
  const port = o.agent ? await freePort() : (fixedPort ?? (await freePort()));
  const url = `http://127.0.0.1:${port}`;
  // A fixed build unless the check sets one: the worktree is edited while the trial runs, and a build
  // taken from the dirty tree would move between restarts and reload chats mid-check.
  // A share listener of its own on loopback, so a trial can post as a baton's participant.
  const sharePort = await freePort();
  const extra = { SOVA_SHARE_HOST: "127.0.0.1", SOVA_SHARE_PORT: String(sharePort), ...(o.extra ?? {}) };
  const env = serverEnv({ agent: o.agent ?? agent, port, on: o.on ?? true, driver, slice: driver === "systemd" ? slice : undefined, idleMs: o.idleMs, build: o.build ?? "trial-fixed", failBoot: o.failBoot, extra });
  const s = server({ tag: `${tag}-${++n}`, env, mode, log: join(scratch, `server-${n}.log`) });
  s.up();
  await healthy(url);
  const cl = client(url, tokenOf(o.agent ?? agent));
  if (!o.agent) {
    shareBase = `http://127.0.0.1:${sharePort}`;
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
const post = (path, body, cl = c) => cl.api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
/** Opens a chat the server names (the Overseer's, a project overseer's, a baton's) on the mock model. */
async function openOn(path, model = "trial/m1", cl = c) {
  const s = await chat(cl, path);
  s.send({ type: "set_model", ref: model });
  await s.until((m) => m.type === "model" || m.type === "error", 15000, "set_model answer");
  return { path, s };
}
/** The Overseer's chat, as the page opens it. */
async function overseer(cl = c) {
  const st = await cl.api("/api/overseer");
  const path = st?.path ?? st?.current?.path ?? st?.session?.path;
  if (!path) throw new Error(`no Overseer session: ${JSON.stringify(st)?.slice(0, 160)}`);
  return path;
}
let orgs = 0;
/** An org in the scratch dir with one project (the trial's proj) and one person. */
async function orgSetup(cl = c) {
  const org = await post("/api/orgs", { name: `Trial ${++orgs}`, dir: join(scratch, `ws-${orgs}`) }, cl);
  // One project per folder: each org's project gets a folder of its own.
  const root = join(scratch, `proj-${orgs}`);
  mkdirSync(root, { recursive: true });
  const pg = await post(`/api/orgs/${org.id}/projects`, { name: "Portal", root }, cl);
  const pp = await post(`/api/orgs/${org.id}/people`, { name: "Dana", role: "Staff", decides: ["Billing"] }, cl);
  return { orgId: org.id, projectId: pg.projectList[0].id, personId: pp.roster.find((x) => x.name === "Dana").id, ws: org.dir };
}
/** The project's overseer, created if it has none: {path, id, ...}. */
const projectOverseer = (projectId, cl = c) => post(`/api/projects/${projectId}/overseer`, {}, cl);
/** A look at the project now (what the schedule fires). */
const lookNow = (projectId, cl = c) => post(`/api/projects/${projectId}/overseer/run`, {}, cl);
/** A baton handed to `to`: {path, sessionId, link}. */
const startBaton = (o, cl = c) => post("/api/baton", { orgId: o.orgId, projectId: o.projectId, to: o.personId, publicTitle: "Trial", goal: "trial goal" }, cl);
const prompt = (s, text) => s.send({ type: "prompt", text, clientId: `trial-${Date.now()}` });
const isEvent = (t) => (m) => m.type === "event" && m.event?.type === t;
const settled = (s, from = 0, ms = 180000) => s.until(isEvent("run.settled"), ms, "run.settled", from);
const delta = (re) => (m) => m.type === "event" && m.event?.type === "part.delta" && re.test(m.event.delta ?? "");
const liveText = (hello) => (hello.live?.message?.parts ?? []).filter((p) => (p.kind ?? p.type) === "text").map((p) => p.text ?? "").join("");
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
  R.check(hasMarker(path), `${label}: the in-flight marker is still there mid-run, after the restart`);
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
  R.check(!hasMarker(path), `${label}: the in-flight marker is gone after the reply settled`);
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

/** The trial_ask confirm (other ui_requests are fire-and-forget status lines). */
const isConfirm = (m) => m.type === "ui_request" && m.request?.method === "confirm";
async function t1c() {
  const { path, s } = await newChat();
  prompt(s, "[ask] ask me");
  const req = await s.until(isConfirm, 60000, "the dialog");
  const pid1 = chatPid(path);
  // The browser stays attached: the restart drops it (a broker drop). Closing it first would be a
  // plain detach, which resolves open dialogs with their defaults, as today.
  await restart();
  s.close();
  sameProcess(path, pid1, "t1c");
  const s2 = await chat(c, path);
  const again = await s2.until(isConfirm, 15000, "the dialog after the restart").catch(() => null);
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
  // History past pi's kept-recent window (~20k tokens), so /compact has something to cut.
  for (const k of [0, 1]) {
    const from = s.got.length;
    prompt(s, "[big 60] history");
    await settled(s, from, 60000);
  }
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
  R.check(!hasMarker(path), "t2: no in-flight marker is left after the deaths were handled");
  const s2 = await chat(c, path);
  R.check(chatPid(path) && chatPid(path) !== pid2, "t2: reconnecting spawns a new process");
  s2.close();
}

async function t3() {
  // A fresh server with a 3 s idle stop.
  await teardown();
  await boot({ idleMs: 3000 });
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
/** Waits (up to 90 s: a replacement boots under whatever load the machine has) until the chat runs in a
    new process on build b; between the old process's exit and the new record there is no pid. */
async function waitReloaded(path, oldPid) {
  for (let i = 0; i < 180; i++) {
    const p = chatPid(path);
    if (p && p !== oldPid && record(path)?.build === "trial-b") return;
    await sleep(500);
  }
}
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
  // Chat C: idle, nobody attached, never asked: the automatic reload alone moves it.
  const C = await newChat();
  prompt(C.s, "say ok");
  await settled(C.s, 0, 60000);
  const pidC = chatPid(C.path);
  C.s.close();
  // A's browser stays attached: the restart drops it (its pane is kept as an orphan) and it comes
  // straight back, as a page does.
  B.s.close();
  await restart({ [KNOBS.build]: "trial-b" });
  A.s.close();
  const a2 = await chat(c, A.path);
  const older = await a2.until((m) => m.type === "code", 15000, "A's code state").catch(() => null);
  R.check(older?.state === "older", `t4: an attached chat on the old build shows "older" (${JSON.stringify(older)})`);
  // Reload now on B while its reply runs: pending, never a cut.
  const b2 = await chat(c, B.path);
  const bf = b2.got.length;
  b2.send({ type: "reload_code" });
  const pend = await b2.until((m) => m.type === "code" && m.pending, 10000, "pending", bf).catch(() => null);
  R.check(pend?.state === "older" && pend.pending === true, `t4: Reload now during a reply answers {older, pending} (${JSON.stringify(pend)})`);
  b2.close();
  // B must not reload while its reply runs.
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.event === "done" && e.tag === "t4b"); i++) {
    if (chatPid(B.path) !== pidB) break;
    await sleep(500);
  }
  R.check(mockLog(mock.log).some((e) => e.event === "done" && e.tag === "t4b") && turnAssistants(B.path, "[long 30 #t4b]").length === 1, "t4: B's reply ran to its end, never cut by a reload");
  await waitReloaded(B.path, pidB);
  const recB = record(B.path);
  R.check(chatPid(B.path) && chatPid(B.path) !== pidB && recB?.build === "trial-b", `t4: B (Reload now while busy) reloaded at its quiet moment (pid ${pidB} → ${chatPid(B.path)}, build ${recB?.build})`);
  await waitReloaded(C.path, pidC);
  R.check(chatPid(C.path) && chatPid(C.path) !== pidC && record(C.path)?.build === "trial-b", `t4: an idle unattended chat reloaded by itself (pid ${pidC} → ${chatPid(C.path)}, build ${record(C.path)?.build})`);
  // A: attached, so it waits for the dwell; Reload now reloads at once.
  R.check(chatPid(A.path) === pidA, "t4: A, attached, did not reload by itself");
  const from = a2.got.length;
  a2.send({ type: "reload_code" });
  const reloaded = await a2.until((m) => m.type === "error" && m.code === "reloaded", 40000, "the reloaded notice", from).catch(() => null);
  R.check(reloaded, "t4: Reload now reloaded the chat (an error frame with code reloaded)");
  await waitReloaded(A.path, pidA);
  const a3 = await chat(c, A.path);
  await sleep(2000);
  R.check(chatPid(A.path) !== pidA && record(A.path)?.build === "trial-b", `t4: A runs a new process on build b (pid ${pidA} → ${chatPid(A.path)})`);
  R.check(codeMsgs(a3).every((m) => m.state !== "older"), "t4: the reloaded chat shows no badge");
  // Reload now on a current chat answers "current", never an error, and reloads nothing.
  const f2 = a3.got.length;
  const pidA2 = chatPid(A.path);
  a3.send({ type: "reload_code" });
  const answer = await a3.until((m) => m.type === "code" || m.type === "error", 10000, "the answer", f2).catch(() => null);
  await sleep(2000);
  const errs = a3.got.slice(f2).filter((m) => m.type === "error");
  R.check(answer?.type === "code" && answer.state === "current" && !errs.length && chatPid(A.path) === pidA2, `t4: Reload now on a current chat answers {code: current} and reloads nothing (${JSON.stringify(answer)})`);
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

async function t7() {
  // Needs the server's test-only served tool (trial_served_sleep, on with SOVA_CHAT_TEST_SERVED=1).
  await teardown();
  await boot({ extra: { SOVA_CHAT_TEST_SERVED: "1" } });
  const { path, s } = await newChat();
  prompt(s, "[served] run it");
  await s.until(isEvent("tool.start"), 60000, "the served call starts");
  await sleep(2000);
  s.close();
  await restart();
  const s2 = await chat(c, path);
  // The unknown outcome lands as soon as the chat hears from the new server, often before this
  // browser is back: read the session, not the stream.
  for (let i = 0; i < 120 && !entries(path).some((e) => e.type === "message" && e.message?.role === "assistant" && /TOOL-ANSWERED/.test(textOfMsg(e.message))); i++) await sleep(500);
  await sleep(1500);
  const results = entries(path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
  R.check(results.length === 1 && /outcome is unknown/.test(JSON.stringify(results[0])), `t7: the chat's tool result is the unknown-outcome text (${JSON.stringify(results[0]?.message?.content)?.slice(0, 160)})`);
  const runs = readLines(join(sova, "chats", "test-served.jsonl")).filter((e) => e.event === "start");
  R.check(runs.length === 1, `t7: the action ran once (${runs.length} starts)`);
  // A new call from the adopted chat, after the restart: the new server serves its tools too.
  const before = entries(path).filter((e) => e.message?.role === "toolResult").length;
  prompt(s2, "[served-quick] again");
  for (let i = 0; i < 40 && entries(path).filter((e) => e.message?.role === "toolResult").length === before; i++) await sleep(500);
  const quick = entries(path).filter((e) => e.message?.role === "toolResult").slice(before);
  R.check(quick.length === 1 && /SERVED-DONE/.test(JSON.stringify(quick[0])), `t7: an adopted chat's new server-hosted call runs on the new server (${JSON.stringify(quick[0]?.message?.content)?.slice(0, 120)})`);
  s2.close();
  // An undelivered call: the chat makes it while the server is down; it runs once the server is back.
  const late = await newChat();
  prompt(late.s, "[served-late] run it later");
  await late.s.until(delta(/part 2\//), 30000, "streaming");
  late.s.close();
  await srv.down();
  await sleep(8000);
  srv.up();
  await healthy(base);
  for (let i = 0; i < 60 && !entries(late.path).some((e) => e.type === "message" && e.message?.role === "assistant" && /TOOL-ANSWERED/.test(textOfMsg(e.message))); i++) await sleep(500);
  const lateResult = entries(late.path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
  R.check(lateResult.length === 1 && /SERVED-DONE/.test(JSON.stringify(lateResult[0])), `t7: a call made while the server was down ran once it came back (${JSON.stringify(lateResult[0]?.message?.content)?.slice(0, 120)})`);
  const all = readLines(join(sova, "chats", "test-served.jsonl"));
  R.check(all.filter((e) => e.event === "start").length === 3 && all.filter((e) => e.event === "end").length === 2, `t7: the late call ran exactly once, to its end (${all.map((e) => e.event).join(", ")})`);
  await teardown();
  await boot();
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

async function t9() {
  const { path, s } = await newChat();
  prompt(s, "say ok");
  await settled(s, 0, 60000);
  const pid1 = chatPid(path);
  if (!R.check(pid1, "t9: the chat's process is found")) return;
  const from = s.got.length;
  const closed = new Promise((r) => s.ws.once("close", (code) => r(code)));
  process.kill(pid1, "SIGTERM");
  R.note(`t9: SIGTERM to chat process ${pid1}`);
  const bye = await s.until((m) => m.type === "error", 10000, "the pane's notice", from).catch(() => null);
  R.check(bye?.code === "reloaded" && !/stopped unexpectedly/.test(bye?.message ?? ""), `t9: the pane got a quiet reloaded, no crash text (${JSON.stringify(bye)})`);
  const code = await Promise.race([closed, sleep(10000).then(() => "still open")]);
  R.check(code !== "still open", `t9: the pane's socket was closed so the browser reconnects (${code})`);
  const t0 = Date.now();
  const s2 = await chat(c, path, 10000).catch((e) => (R.note(String(e)), null));
  R.check(s2?.hello && Date.now() - t0 < 10000, `t9: the reconnect got a fresh hello within seconds (${Date.now() - t0} ms)`);
  R.check(s2 && JSON.stringify(s2.hello.items).includes("ok"), "t9: the hello shows the chat's history");
  const pid2 = chatPid(path);
  R.check(pid2 && pid2 !== pid1, `t9: a new process hosts the chat (pid ${pid1} → ${pid2 || "none"})`);
  R.check(deaths(path).length === 0, "t9: an outside SIGTERM is no death");
  s2?.close();
}

// ── stage 3: the Overseer, project overseers, batons and powers chats (stage3-design.md §10.2) ───

/** Waits until `cond()` holds (true) or `ms` passed (false). */
async function waitFor(cond, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}
const toolResults = (path) => entries(path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
const resultText = (e) => JSON.stringify(e?.message?.content ?? "").slice(0, 200);
/** Where the chat runs: "process" (a live chat process of its own, not the server) or "server". */
const whereOf = (path) => {
  const pid = chatPid(path);
  return pid && pid !== srv.pid() ? "process" : "server";
};
/** A user prompt into an open chat, waited for until its run settled; the tool results it added. */
async function turn(o, text, ms = 60000) {
  const from = o.s.got.length;
  const before = toolResults(o.path).length;
  prompt(o.s, text);
  await settled(o.s, from, ms);
  await sleep(500);
  return toolResults(o.path).slice(before);
}
/** A fresh ordinary chat given session powers (an inline profile: read, message, all sessions). */
async function powersChat() {
  const { path } = await post("/api/sessions", { cwd: proj });
  await post("/api/sessions/profile", { path, profile: { remove: [], grant: ["sessions.read", "sessions.message", "sessions.all"] } });
  return openOn(path);
}
/** The org's statechart log rows (portable and host-local), oldest first. */
function orgLog(o) {
  const dirs = [join(o.ws, "statecharts", "log"), join(sova, "statecharts", o.orgId, "log")];
  const rows = [];
  for (const d of dirs) {
    let files = [];
    try {
      files = readdirSync(d).filter((f) => f.endsWith(".jsonl"));
    } catch {}
    for (const f of files) rows.push(...readLines(join(d, f)));
  }
  return rows.sort((a, b) => a.at - b.at);
}
/** Rows of `event` on the baton session `sid` since `t0`, taken (not refused). */
const batonRows = (o, sid, event, t0 = 0) => orgLog(o).filter((r) => r.event === event && String(r.session ?? "").includes(sid) && r.at >= t0 && !r.refused);
/** A participant's message through the share hub (the baton link's page). */
async function participantSays(link, text) {
  const token = String(link).split("/").pop();
  const res = await fetch(`${shareBase}/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  return { status: res.status, body: await res.text() };
}
/** An org and a baton held by Dana, its chat on the mock. */
async function batonSetup() {
  const o = await orgSetup();
  const b = await startBaton(o);
  return { o, b, sid: b.sessionId, path: b.path };
}

// T6': with the switch on, the Overseer, a project overseer, a baton and a powers chat each run in a
// process of their own; a worker's session file stays in the server.
async function t6() {
  const ov = await openOn(await overseer());
  await turn(ov, "say ok");
  const o = await orgSetup();
  const po = await projectOverseer(o.projectId);
  const poc = await openOn(po.path);
  await turn(poc, "say ok");
  const b = await startBaton(o);
  const bc = await chat(c, b.path);
  await waitFor(() => chatPid(b.path), 15000);
  const pw = await powersChat();
  await turn(pw, "say ok");
  const w = await newChat();
  prompt(w.s, "[spawn] start a worker");
  await w.s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  await sleep(2000);
  const kinds = [["the Overseer", ov.path], ["a project overseer", po.path], ["a baton", b.path], ["a powers chat", pw.path], ["an ordinary chat", w.path]];
  for (const [label, path] of kinds) R.check(whereOf(path) === "process", `t6: ${label} runs in a process of its own (pid ${chatPid(path) || "none"}, server ${srv.pid()})`);
  const pids = kinds.map(([, p]) => chatPid(p)).filter(Boolean);
  R.check(new Set(pids).size === kinds.length, `t6: each in a process of its own (${pids.join(", ")})`);
  if (driver === "systemd") {
    const units = kinds.map(([, p]) => record(p)?.unit).filter(Boolean);
    R.check(new Set(units).size === kinds.length, `t6: each in a unit of its own (${units.join(", ")})`);
    for (const [label, p] of kinds.slice(0, 4)) {
      const cg = (() => {
        try {
          return readFileSync(`/proc/${chatPid(p)}/cgroup`, "utf8").trim();
        } catch {
          return "";
        }
      })();
      R.check(cg.includes(`/${slice}/`), `t6: ${label}'s cgroup is under the stand-in slice (${cg})`);
    }
  }
  // The worker's own session file: no chat process of its own (stage 4).
  const known = new Set(kinds.map(([, p]) => baseName(p)));
  const others = allRecords().filter((r) => !known.has(baseName(r.sessionPath)) && alive(r.pid));
  R.check(others.length === 0, `t6: no other chat process (a worker's session stays in the server) (${others.map((r) => baseName(r.sessionPath)).join(", ") || "none"})`);
  for (const x of [ov, poc, pw, w]) x.s.close();
  bc.close();
}

// T10: the Overseer in its own process: a served read tool, a served file tool, an acting tool and an
// explorer (its worker a child of the Overseer's process); the run note is in the file.
async function t10() {
  writeFileSync(join(proj, "trial-read.txt"), "READ-ME-TRIAL\n");
  const ov = await openOn(await overseer());
  await turn(ov, "say ok");
  const pid = chatPid(ov.path);
  R.check(whereOf(ov.path) === "process", `t10: the Overseer runs in a process of its own (pid ${pid || "none"})`);
  const r1 = await turn(ov, "[call sova_list_sessions {}]");
  R.check(r1.length === 1 && !r1[0].message.isError, `t10: sova_list_sessions answered (${resultText(r1[0])})`);
  const r2 = await turn(ov, `[call read {"path":"${join(proj, "trial-read.txt")}"}]`);
  R.check(r2.length === 1 && /READ-ME-TRIAL/.test(JSON.stringify(r2[0])), `t10: the read file tool answered with the file (${resultText(r2[0])})`);
  // edit, served: pi validates its arguments against the schema as it crossed the socket (plain
  // JSON, TypeBox's Symbol keys dropped), and the edit lands.
  const editArgs = { path: join(proj, "trial-read.txt"), edits: [{ oldText: "READ-ME-TRIAL", newText: "EDITED-TRIAL" }] };
  const r2b = await turn(ov, `[call edit ${JSON.stringify(editArgs)}]`);
  const edited = readFileSync(join(proj, "trial-read.txt"), "utf8");
  R.check(r2b.length === 1 && !r2b[0].message.isError, `t10: the edit file tool answered, no error (${resultText(r2b[0])})`);
  R.check(edited === "EDITED-TRIAL\n", `t10: the edit applied to the file (${JSON.stringify(edited)})`);
  // Arguments the schema refuses (edits missing): a validation error, the file untouched.
  const r2c = await turn(ov, `[call edit ${JSON.stringify({ path: join(proj, "trial-read.txt") })}]`);
  R.check(r2c.length === 1 && r2c[0].message.isError && readFileSync(join(proj, "trial-read.txt"), "utf8") === edited, `t10: an edit the schema refuses is an error and changes nothing (${resultText(r2c[0])})`);
  const r3 = await turn(ov, '[call sova_note {"op":"append","text":"TRIAL-NOTE one"}]');
  const notes = (await c.api("/api/overseer/notes"))?.text ?? "";
  R.check(r3.length === 1 && !r3[0].message.isError && notes.split("TRIAL-NOTE one").length === 2, `t10: sova_note (attended) wrote the note once (${resultText(r3[0])})`);
  await turn(ov, '[call sova_idea {"op":"add","id":"§trial/explore","title":"Trial explore","text":"Explore it."}]');
  await mock.plain("[long 40 #explorer]");
  const r5 = await turn(ov, '[call sova_idea {"op":"explore","id":"§trial/explore"}]');
  R.check(r5.length === 1 && /Launched/.test(JSON.stringify(r5[0])), `t10: sova_idea explore launched the explorer (${resultText(r5[0])})`);
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "explorer"), 30000);
  await sleep(1500);
  const workers = pid ? tree(pid).filter((p) => p.pid !== pid && /--mode rpc/.test(p.cmd)) : [];
  R.check(workers.length === 1, `t10: the explorer is a child of the Overseer's process (${workers.map((w) => w.pid).join(", ") || "none"})`);
  await mock.plain("");
  const runNotes = entries(ov.path).filter((e) => JSON.stringify(e).includes("[now] It is")).length;
  R.check(runNotes >= 1, `t10: the run note is in the file (${runNotes})`);
  ov.s.close();
}

// T11: a server restart mid served tool of the Overseer: outcome unknown, ran once; a message queued
// before the restart enters while no server runs, and its run facts reach the next server (the limits
// reset is in the file).
async function t11() {
  await teardown();
  await boot({ extra: { SOVA_CHAT_TEST_SERVED: "1" } });
  const servedFrom = readLines(join(sova, "chats", "test-served.jsonl")).length;
  const ov = await openOn(await overseer());
  await turn(ov, "say ok");
  prompt(ov.s, "[served] run it");
  await ov.s.until(isEvent("tool.start"), 60000, "the served call starts");
  await sleep(1500);
  prompt(ov.s, "TRIAL-B say ok");
  await sleep(500);
  ov.s.close();
  await srv.down();
  await sleep(8000);
  // The counters as a brief would have left them: only a user message's run facts reset them.
  const turnFile = join(sova, "overseer-turn.json");
  writeFileSync(turnFile, `${JSON.stringify({ version: 1, used: { create: 2, prompt: 1, archive: 0, explore: 0, link: 0, org: 0, gather: 0 } })}\n`);
  srv.up();
  await healthy(base);
  R.note(`t11: server down 8 s, back as pid ${srv.pid()}`);
  await waitFor(() => mockLog(mock.log).some((e) => /TRIAL-B/.test(e.userText ?? "")), 90000);
  await waitFor(() => readJson(turnFile)?.used?.create === 0, 30000);
  await sleep(1500);
  const results = toolResults(ov.path).filter((e) => /trial_served_sleep|outcome is unknown|SERVED-DONE/.test(JSON.stringify(e)));
  R.check(results.length === 1 && /outcome is unknown/.test(JSON.stringify(results[0])), `t11: the tool result is the unknown-outcome text (${resultText(results[0])})`);
  const starts = readLines(join(sova, "chats", "test-served.jsonl")).slice(servedFrom).filter((e) => e.event === "start").length;
  R.check(starts === 1, `t11: the action ran once (${starts} starts)`);
  R.check(mockLog(mock.log).filter((e) => /TRIAL-B/.test(e.userText ?? "") && !e.afterTool).length === 1, "t11: the queued message ran once");
  R.check(userEntriesWith(ov.path, "TRIAL-B") === 1, `t11: the queued message is in the file once (${userEntriesWith(ov.path, "TRIAL-B")})`);
  R.check(readJson(turnFile)?.used?.create === 0, `t11: the user message's run facts reached the next server: the limits were reset (${JSON.stringify(readJson(turnFile)?.used)})`);
  R.check(whereOf(ov.path) === "process", "t11: the Overseer still runs in its process");
  await teardown();
  await boot();
}

// T12a: a participant's message through the share hub; record_decision with a case variant of an owner
// area is recorded in the roster's spelling, its quote checked.
async function t12a() {
  const { o, b, path } = await batonSetup();
  const quote = "We will bill through Stripe from May";
  const args = { area: "invoicing", ownerArea: "billing", statement: "Bill through Stripe from May.", quote };
  const sent = await participantSays(b.link, `${quote}.\n[call record_decision ${JSON.stringify(args)}]`);
  R.check(sent.status < 300, `t12a: the share hub took the participant's message (${sent.status} ${sent.body.slice(0, 120)})`);
  await waitFor(() => toolResults(path).length > 0, 60000);
  await sleep(2000);
  R.check(whereOf(path) === "process", `t12a: the baton runs in a process of its own (pid ${chatPid(path) || "none"})`);
  const res = toolResults(path).find((e) => /record_decision/.test(JSON.stringify(e)) || e.message?.toolName === "record_decision");
  R.check(res && !res.message.isError, `t12a: record_decision succeeded (${resultText(res)})`);
  const dec = entries(path).filter((e) => e.customType === "sova-baton-decision" || /sova-baton-decision/.test(e.customType ?? ""));
  const all = JSON.stringify(dec);
  R.check(dec.length >= 1 && /"ownerArea":"Billing"/.test(all), `t12a: the owner area is the roster's spelling, Billing (${all.slice(0, 200)})`);
  // The quote check is the org history's evidence (<workspace>/history/events/<yyyy-mm>.jsonl).
  const hist = (() => {
    try {
      return readdirSync(join(o.ws, "history", "events")).flatMap((f) => readLines(join(o.ws, "history", "events", f)));
    } catch {
      return [];
    }
  })();
  const checks = [...JSON.stringify(hist).matchAll(/"check":"([a-z-]+)"/g)].map((m) => m[1]);
  R.check(checks.length === 1 && checks[0] === "checked", `t12a: the quote check is checked (${checks.join(", ") || "none"})`);
}

// T12b: a server restart mid baton reply: the reply finishes; one reply/writing and one reply/ended;
// the boot sweep ended nothing. Then a restart mid the baton's served test tool (design §10.3 A):
// outcome unknown, ran once.
async function t12b() {
  await teardown();
  await boot({ extra: { SOVA_CHAT_TEST_SERVED: "1" } });
  const { o, b, sid, path } = await batonSetup();
  const t0 = Date.now();
  await participantSays(b.link, "[long 30 #b12b] reply at length");
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "b12b"), 30000);
  await sleep(3000);
  const pid1 = chatPid(path);
  await restart();
  R.check(pid1 && chatPid(path) === pid1, `t12b: the baton's process survived the restart (${pid1} → ${chatPid(path)})`);
  await waitFor(() => mockLog(mock.log).some((e) => e.event === "done" && e.tag === "b12b"), 60000);
  await waitFor(() => batonRows(o, sid, "reply/ended", t0).length > 0, 20000);
  await sleep(3000);
  const msgs = turnAssistants(path, "[long 30 #b12b]");
  R.check(msgs.length === 1 && textOfMsg(msgs[0]).includes("REPLY-DONE b12b"), `t12b: the reply finished, one assistant entry (${msgs.map((m) => m.stopReason).join(", ")})`);
  const writing = batonRows(o, sid, "reply/writing", t0);
  const ended = batonRows(o, sid, "reply/ended", t0);
  R.check(writing.length === 1, `t12b: one reply/writing in the org log (${writing.length})`);
  R.check(ended.length === 1, `t12b: one reply/ended in the org log (${ended.length}: ${ended.map((r) => r.by).join(", ")})`);
  const refused = orgLog(o).filter((r) => r.event === "reply/ended" && String(r.session ?? "").includes(sid) && r.at >= t0 && r.refused);
  R.check(refused.length === 0, `t12b: the boot sweep ended nothing for it (${refused.length} refused reply/ended)`);
  // The served test tool, cut by a restart.
  const before = toolResults(path).length;
  const servedFrom = servedLog().length;
  const sent = await participantSays(b.link, "[served] run it");
  R.check(sent.status < 300, `t12b: the participant's second message was taken (${sent.status} ${sent.body.slice(0, 100)})`);
  await waitFor(() => servedLog().slice(servedFrom).some((e) => e.event === "start"), 30000, 250);
  await sleep(1500);
  await restart();
  await waitFor(() => toolResults(path).length > before, 60000);
  await sleep(2000);
  const cut = toolResults(path).slice(before);
  R.check(cut.length === 1 && /outcome is unknown/.test(JSON.stringify(cut[0])), `t12b: the baton's cut served call reports outcome unknown (${resultText(cut[0])})`);
  const starts = servedLog().slice(servedFrom).filter((e) => e.event === "start").length;
  R.check(starts === 1, `t12b: the served call ran once (${starts} starts)`);
  await teardown();
  await boot();
}

// T12c: take-back while the baton replies: when the route answers, "(taken back)" is in the
// transcript; one reply/ended.
async function t12c() {
  const { o, b, sid, path } = await batonSetup();
  const t0 = Date.now();
  await participantSays(b.link, "[long 40 #b12c] reply at length");
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "b12c"), 30000);
  await sleep(2000);
  R.check(whereOf(path) === "process", `t12c: the baton runs in a process of its own (pid ${chatPid(path) || "none"})`);
  await post(`/api/baton/${sid}/take`);
  const taken = entries(path).filter((e) => JSON.stringify(e).includes('"question":"(taken back)"')).length;
  R.check(taken === 1, `t12c: when the route answered, the "(taken back)" entry was in the transcript (${taken})`);
  await sleep(6000);
  const ended = batonRows(o, sid, "reply/ended", t0);
  R.check(ended.length === 1, `t12c: one reply/ended (${ended.length})`);
  // A take-back during a reply is held (pending-move, stop-reply) and delivered again once the reply
  // ended (envelope sova/pending): one row that moved the baton to the operator, at most one held.
  const takes = orgLog(o).filter((r) => /take-back/.test(r.event) && String(r.session ?? "").includes(sid) && r.at >= t0 && !r.refused);
  const moved = takes.filter((r) => (r.after ?? []).includes("with-operator") && !(r.before ?? []).includes("with-operator"));
  R.check(moved.length === 1 && takes.length - moved.length <= 1, `t12c: one take-back moved the baton, at most one held before it (${takes.map((r) => `${r.event}${r.envelope?.["sova/pending"] ? " (pending)" : ""}`).join(", ")})`);
  const all = entries(path).filter((e) => JSON.stringify(e).includes('"question":"(taken back)"')).length;
  R.check(all === 1, `t12c: exactly one "(taken back)" entry (${all})`);
  const stopped = turnAssistants(path, "[long 40 #b12c]");
  R.check(stopped.length === 1 && stopped[0].stopReason === "aborted", `t12c: the reply stays whole as a stopped reply (${stopped.map((m) => m.stopReason).join(", ")})`);
}

// T13: a project overseer's look across a server restart: one look message, reported once, no second
// look turn.
async function t13() {
  const o = await orgSetup();
  const po = await projectOverseer(o.projectId);
  await mock.plain("[long 30 #look]");
  const t0 = Date.now();
  await lookNow(o.projectId);
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "look"), 30000);
  await sleep(3000);
  R.check(whereOf(po.path) === "process", `t13: the project overseer runs in a process of its own (pid ${chatPid(po.path) || "none"})`);
  const pid1 = chatPid(po.path);
  await restart();
  R.check(pid1 && chatPid(po.path) === pid1, `t13: the project overseer's process survived (${pid1} → ${chatPid(po.path)})`);
  await waitFor(() => mockLog(mock.log).some((e) => e.event === "done" && e.tag === "look"), 60000);
  // How the look ended (the ruling): the engine cuts running invocations off at resume, so the watch's
  // sova/resumed names the sova/look run in its cutOff and takes last-run.outcome to cut-off; the look
  // is never reported (no look/finished or look/stopped), re-run or adopted.
  const isCut = (r) => r.event === "sova/resumed" && JSON.stringify(r.envelope?.cutOff ?? []).includes("sova/look") && r.changed?.["last-run.outcome"]?.[1] === "cut-off";
  const finished = () => orgLog(o).filter((r) => String(r.session ?? "").startsWith("watch/") && (r.event === "look/finished" || r.event === "look/stopped" || isCut(r)) && r.at >= t0);
  await waitFor(() => finished().length > 0, 30000);
  await sleep(5000);
  await mock.plain("");
  const users = entries(po.path).filter((e) => e.type === "message" && e.message?.role === "user");
  R.check(users.length === 1, `t13: one look message in the file (${users.length})`);
  R.check(mockLog(mock.log).filter((e) => e.tag === "look" && e.scenario).length === 1, "t13: the model was asked for the look once (no second sova/look turn)");
  const f = finished();
  const ends = f.filter((r) => !isCut(r));
  const cuts = f.filter(isCut);
  R.check(cuts.length === 1 && !ends.length, `t13: the watch recorded the look cut off at resume, once, and never reported it (${f.map((r) => r.event).join(", ") || "none"})`);
  const answers = users[0] ? entries(po.path).filter((e) => e.type === "message" && e.message?.role === "assistant").length : 0;
  R.check(answers === 1, `t13: one assistant turn answered it (${answers})`);
}

// T14: a brief while the Overseer's process reloads (design §10.4): Reload now on an older Overseer,
// then the test tick route inside the swap: one brief in the file, a second tick briefs nothing.
async function t14() {
  await teardown();
  const ovFile = join(sova, "overseer.json");
  const ovSettings = readJson(ovFile);
  writeFileSync(ovFile, JSON.stringify({ ...ovSettings, proactivity: "brief" }));
  try {
    await boot({ build: "trial-a", extra: { SOVA_CHAT_TEST_SERVED: "1" } });
    const ov = await openOn(await overseer());
    await turn(ov, "say ok");
    ov.s.close();
    await restart({ [KNOBS.build]: "trial-b" });
    const pidA = chatPid(ov.path);
    // A server's first check only takes the blockers standing then as told (briefDecision): one now,
    // so the blocker below is new.
    R.note(`t14: first tick ${JSON.stringify(await post("/api/test/overseer/tick", {}).catch((e) => ({ error: String(e.message ?? e) })))}`);
    // The blocker: a chat waiting on a dialog (its pane stays attached, so the dialog stays open).
    const blocker = await newChat();
    prompt(blocker.s, "[ask] ask me");
    await blocker.s.until(isConfirm, 60000, "the dialog");
    const ov2 = await chat(c, ov.path);
    ov2.send({ type: "reload_code" });
    // Tick inside the swap: until a tick briefs, at most 20 tries.
    const ticks = [];
    for (let i = 0; i < 20; i++) {
      const r = await post("/api/test/overseer/tick", {}).catch((e) => ({ error: String(e.message ?? e) }));
      ticks.push(r);
      if (r?.briefed?.length) break;
      await sleep(250);
    }
    R.note(`t14: ticks ${JSON.stringify(ticks).slice(0, 300)}`);
    await waitFor(() => userEntriesWith(ov.path, "[overseer-brief]") > 0, 60000);
    await sleep(5000);
    R.check(chatPid(ov.path) && chatPid(ov.path) !== pidA, `t14: the Overseer reloaded (pid ${pidA} → ${chatPid(ov.path)})`);
    const briefs = userEntriesWith(ov.path, "[overseer-brief]");
    R.check(briefs === 1, `t14: one brief in the Overseer's file (${briefs})`);
    const again = await post("/api/test/overseer/tick", {}).catch((e) => ({ error: String(e.message ?? e) }));
    R.check(Array.isArray(again?.briefed) && again.briefed.length === 0, `t14: a second tick briefs nothing (${JSON.stringify(again)})`);
    R.check(mockLog(mock.log).filter((e) => /\[overseer-brief\]/.test(e.userText ?? "") && !e.afterTool).length === 1, "t14: the model was asked for the brief once");
    ov2.close();
    blocker.s.close();

  } finally {
    writeFileSync(ovFile, JSON.stringify(ovSettings));
    await teardown();
    await boot();
  }
}

/** The test hook's lines (<stateRoot>/chats/test-served.jsonl). */
const servedLog = () => readLines(join(sova, "chats", "test-served.jsonl"));
/**
 * T11b/T11c (design §10.3 B): a restart while a real act waits (SOVA_CHAT_TEST_ACT_DELAY_MS), `at`
 * after (the act happened, its result never reached the chat) or before (it never ran). `who`: the
 * Overseer, or a project overseer. The act is sova_note in an attended run.
 */
async function slowAct(label, at, who) {
  await teardown();
  await boot({ extra: { SOVA_CHAT_TEST_SERVED: "1", SOVA_CHAT_TEST_ACT_DELAY_MS: "10000", SOVA_CHAT_TEST_ACT_DELAY_AT: at } });
  let o = null;
  let target;
  if (who === "overseer") target = await openOn(await overseer());
  else {
    o = await orgSetup();
    const po = await projectOverseer(o.projectId);
    target = await openOn(po.path);
  }
  const notesNow = async () => (who === "overseer" ? ((await c.api("/api/overseer/notes"))?.text ?? "") : (() => {
    try {
      return readFileSync(join(o.ws, "projects", o.projectId, "overseer", "notes.md"), "utf8");
    } catch {
      return "";
    }
  })());
  const actionsFile = who === "overseer" ? join(sova, "overseer-actions.jsonl") : join(o.ws, "projects", o.projectId, "overseer", "actions.jsonl");
  await turn(target, "say ok");
  R.check(whereOf(target.path) === "process", `${label}: the ${who === "overseer" ? "Overseer" : "project overseer"} runs in a process of its own (pid ${chatPid(target.path) || "none"})`);
  const note = `TRIAL-SLOW-${at}`;
  const servedFrom = servedLog().length;
  prompt(target.s, `[call sova_note {"op":"append","text":"${note}"}]`);
  await waitFor(() => servedLog().slice(servedFrom).some((e) => e.event === "act-wait"), 30000, 250);
  await sleep(1000);
  const wait = servedLog().slice(servedFrom).find((e) => e.event === "act-wait");
  target.s.close();
  const logFile = join(scratch, `server-${n}.log`);
  const logFrom = readFileSync(logFile).length;
  await restart();
  await waitFor(() => toolResults(target.path).length > 0, 60000);
  await sleep(3000);
  const results = toolResults(target.path).filter((e) => e.message?.toolCallId === wait?.toolCallId || JSON.stringify(e).includes(wait?.toolCallId ?? "\u0000"));
  R.check(results.length === 1 && /outcome is unknown/.test(JSON.stringify(results[0])), `${label}: one tool result for the call, the unknown-outcome text (${results.length}: ${resultText(results[0])})`);
  const lines = servedLog().filter((e) => e.effectId === wait?.effectId);
  R.check(lines.filter((e) => e.event === "act-wait").length === 1 && !lines.some((e) => e.event === "act-done"), `${label}: one act-wait and no act-done for the effect (${lines.map((e) => e.event).join(", ")})`);
  const notes = await notesNow();
  const times = notes.split(note).length - 1;
  const logged = readLines(actionsFile).filter((a) => a.toolCallId === wait?.toolCallId && a.outcome === "ok").length;
  const want = at === "after" ? 1 : 0;
  R.check(times === want, `${label}: the note is in the notes ${want}× (${times})`);
  R.check(logged === want, `${label}: the action log has ${want} ok line(s) for the call (${logged})`);
  const resent = readFileSync(logFile).subarray(logFrom).toString("utf8").split("\n").filter((l) => wait?.effectId && l.includes(wait.effectId)).length;
  R.check(resent === 0, `${label}: the next server never saw the effect id (${resent} log lines)`);
  await teardown();
  await boot();
}
const t11b = () => slowAct("t11b", "after", "overseer");
const t11c = () => slowAct("t11c", "before", "po");

// T12d (design §4.8 A): the model hands off (hand_to) from the baton's process: one hand-to row, one
// hand-off entry, one reply/writing and one reply/ended.
async function t12d() {
  const { o, b, sid, path } = await batonSetup();
  const bob = await post(`/api/orgs/${o.orgId}/people`, { name: "Bob", role: "Staff" });
  const bobId = bob.roster.find((x) => x.name === "Bob").id;
  const t0 = Date.now();
  const args = { person: bobId, question: "Can you confirm the budget?", briefing: "Dana asked for a budget check." };
  await participantSays(b.link, `Please ask Bob.\n[call hand_to ${JSON.stringify(args)}]`);
  await waitFor(() => toolResults(path).length > 0, 60000);
  await waitFor(() => batonRows(o, sid, "reply/ended", t0).length > 0, 20000);
  await sleep(3000);
  R.check(whereOf(path) === "process", `t12d: the baton runs in a process of its own (pid ${chatPid(path) || "none"})`);
  const res = toolResults(path);
  R.check(res.length === 1 && /Handed to Bob/.test(JSON.stringify(res[0])), `t12d: one hand_to result, handed to Bob (${resultText(res[0])})`);
  const moves = orgLog(o).filter((r) => /hand-to/.test(r.event) && String(r.session ?? "").includes(sid) && r.at >= t0 && !r.refused);
  R.check(moves.length === 1, `t12d: one hand-to row in the org log (${moves.map((r) => r.event).join(", ")})`);
  // The baton's start wrote one hand-off (operator → Dana) before: count this move's, to Bob.
  const handoffs = entries(path).filter((e) => e.customType === "sova-baton-handoff" && e.data?.to === bobId);
  R.check(handoffs.length === 1, `t12d: one hand-off entry to Bob (${handoffs.length})`);
  R.check(batonRows(o, sid, "reply/writing", t0).length === 1, `t12d: one reply/writing (${batonRows(o, sid, "reply/writing", t0).length})`);
  R.check(batonRows(o, sid, "reply/ended", t0).length === 1, `t12d: one reply/ended (${batonRows(o, sid, "reply/ended", t0).length})`);
}

// T15: kill -9 of the baton's process mid-reply: the pane's error, reply/ended once, no "continue";
// reopening spawns a new process.
async function t15() {
  const { o, b, sid, path } = await batonSetup();
  const pane = await chat(c, path);
  const t0 = Date.now();
  await participantSays(b.link, "[long 40 #b15] reply at length");
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "b15"), 30000);
  await sleep(2000);
  const pid1 = chatPid(path);
  if (!R.check(pid1 && whereOf(path) === "process", `t15: the baton runs in a process of its own (pid ${pid1 || "none"})`)) return;
  const from = pane.got.length;
  process.kill(pid1, "SIGKILL");
  const err = await pane.until((m) => m.type === "error" && /stopped unexpectedly/.test(m.message ?? ""), 20000, "the pane's error", from).catch(() => null);
  R.check(err, `t15: the pane got the stopped-unexpectedly error (${err?.message?.slice(0, 100)})`);
  await sleep(8000);
  const ended = batonRows(o, sid, "reply/ended", t0);
  R.check(ended.length === 1, `t15: reply/ended once (${ended.length})`);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 0 && userEntriesWith(path, RESUME_TEXT) === 0, "t15: no continue was sent");
  const again = await chat(c, path);
  await waitFor(() => chatPid(path), 15000);
  R.check(chatPid(path) && chatPid(path) !== pid1, `t15: reopening spawns a new process (${pid1} → ${chatPid(path) || "none"})`);
  again.close();
}

// T16: a powers chat in its own process sends to an ordinary chat in another (the hop header arrives);
// a restart mid-send is unknown or delivered, never twice.
async function t16() {
  const target = await newChat();
  await turn({ path: target.path, s: target.s }, "say ok");
  const targetId = entries(target.path)[0]?.id;
  const pw = await powersChat();
  await turn(pw, "say ok");
  R.check(whereOf(pw.path) === "process" && chatPid(pw.path) !== chatPid(target.path), `t16: the powers chat and its target run in processes of their own (${chatPid(pw.path)}, ${chatPid(target.path)})`);
  const r = await turn(pw, `[call session_send {"session":"${targetId}","text":"HOP-ONE hello"}]`);
  R.check(r.length === 1 && !r[0].message.isError, `t16: session_send answered (${resultText(r[0])})`);
  await waitFor(() => userEntriesWith(target.path, "HOP-ONE") > 0, 30000);
  const got = entries(target.path).filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("HOP-ONE"));
  R.check(got.length === 1 && /hop/i.test(JSON.stringify(got[0])), `t16: the message arrived once, with its hop header (${JSON.stringify(got[0]?.message?.content)?.slice(0, 160)})`);
  // A send cut by a restart: the stop lands as the model makes the call.
  const from = pw.s.got.length;
  const before = toolResults(pw.path).length;
  pw.s.send({ type: "prompt", text: `[call session_send {"session":"${targetId}","text":"HOP-TWO hello"}]`, clientId: `trial-${Date.now()}` });
  await pw.s.until(isEvent("tool.start"), 60000, "the send starts", from);
  pw.s.close();
  await restart();
  await waitFor(() => toolResults(pw.path).length > before, 60000);
  await sleep(5000);
  const two = userEntriesWith(target.path, "HOP-TWO");
  const last = toolResults(pw.path).at(-1);
  R.note(`t16: the cut send's result: ${resultText(last)}; HOP-TWO in the target ${two}×`);
  R.check(two <= 1, `t16: one message at most in the target (${two})`);
  // Nothing arrived: the result says so, as an unknown outcome (the send was cut) or as the send's
  // own refusal (it never left the server: "can't take messages now").
  R.check(two === 1 || /outcome is unknown|can't take messages now/.test(JSON.stringify(last)), `t16: when nothing arrived, the result says the outcome is unknown or that it was not sent (${resultText(last)})`);
}

/** The stage-3 steps work on this server, wherever these chats run: an Overseer turn calling one of
    its server-state tools, an org with a project, a person and a baton, a project overseer and a look
    asked for now. Not in the default set: it checks the trial's own plumbing. */
async function plumbing() {
  const ov = await openOn(await overseer());
  prompt(ov.s, '[call sova_todo {"op":"add","text":"TRIAL-TODO one"}] add it');
  await settled(ov.s, 0, 60000);
  const todos = await c.api("/api/overseer/todos");
  R.check(JSON.stringify(todos).split("TRIAL-TODO one").length === 2, `plumbing: the Overseer's sova_todo call added the todo once (${JSON.stringify(todos).slice(0, 160)})`);
  ov.s.close();
  const o = await orgSetup();
  R.check(o.orgId && o.projectId && o.personId, `plumbing: an org with a project and a person (${JSON.stringify(o)})`);
  const b = await startBaton(o);
  R.check(b.path && existsSync(b.path), `plumbing: a baton started (${b.sessionId})`);
  const po = await projectOverseer(o.projectId);
  R.check(po.path, `plumbing: the project has an overseer (${po.id})`);
  const look = await lookNow(o.projectId).then(() => "started", (e) => String(e.message ?? e));
  R.note(`plumbing: a look now: ${look}`);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

const table = { t1: () => t1(), t1b, t1c, t1d, t1e, t1f, t2, t3, t4, t4fail, t5, t6, t7, t8, t9, t10, t11, t11b, t11c, t12a, t12b, t12c, t12d, t13, t14, t15, t16, plumbing, real: () => t1(opt("model")) };
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
