#!/usr/bin/env node
// chat-runtime-trial: al_3 stages 2–4 end to end (.agent/sova-runtime/stage2-design.md §8.2, §8.3), on a
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
//     t2        kill -9 of the chat mid-reply: the pane's error, a new process, the crash "continue"
//               once; a second kill during that resume is not resumed again
//     t3        idle stop (SOVA_CHAT_IDLE_MIN=0.05): not while a run is in flight; then the process
//               exits (no death), even with a client attached (told "closed"), and nothing starts it
//               until a client connects again, which reopens it
//     t4        new code (SOVA_BUILD a → b): "older" in the pane, Reload now, automatic reload at a
//               quiet moment, never mid-reply; the new process reports b
//     t4fail    a replacement that fails to boot: the rollout halts, the old process stays, "failed"
//     t6        (T6', stage 3) the Overseer, a project overseer, a baton and a
//               powers chat each run in a process (a unit) of their own; a worker's session is a worker
//               chat (stage 4), never opened as an ordinary chat
//     t7        q5: a server-hosted action cut by a restart reports "outcome unknown" and ran once
//     t8        two servers on different agent dirs never adopt or stop each other's chats
//     t9        an outside SIGTERM to a chat process with a pane attached: the pane gets a quiet
//               reloaded (no crash text), reconnects within seconds and gets a fresh hello
//     stage 3 (stage3-design.md §10.2):
//     t10       the Overseer out: sova_list_sessions, read, edit (applied; a bad one refused), sova_note, sova_idea explore (the explorer a worker chat; was a
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
//     stage 4 (stage4-design.md §8; t17 replaces stage 2's t1f):
//     t17       a worker across a server restart: a chat process of its own (a unit in systemd mode),
//               not the parent's descendant; same pid; its reply streamed once; its completion
//               delivered once; no `pi --mode rpc` anywhere
//     t17c      the same for a claude-code worker (scripts/fake-claude.mjs on the server's PATH)
//     t18       the parent reloads (Reload now, build a → b) mid worker run: the worker keeps its pid,
//               agent_list shows it running, a steer after the reload reaches it once, one completion
//     t18b      kill -9 of the parent mid-run: its crash resume; the worker keeps its process; one
//               completion
//     t19       a team across a restart: alpha's team_msg to beta just before it arrives once; a
//               team_ask reaches the parent once; after a parent reload alpha's inbox keeps beta's message
//               (closed automatically by then: listed with `limit`, which shows closed items)
//     t19n      a monitor's wake_nudge set before a parent reload fires once after it (team-defaults.json)
//     t20       kill -9 of a worker mid-run: the continue once, the run finishes, one completion; a
//               second kill during that resume is final ("stopped unexpectedly", last output)
//     t21       /explain, /compact-handoff, /btw each in a process of its own, no model call from the
//               parent, counted in the usage ledger; an /explain across a parent reload settles once
//     t21c      /btw and /explain on a claude-code-cli model (the fake claude): usage under the parent
//     t21h      /compact-handoff on a claude-code-cli parent (the fake claude): the fork resumes its CLI
//               session, the note is saved, it compacts, the fork's usage is under the parent
//     t21l      browser-drive F10/F11: an idle parent's /btw row reaches the open pane live; an idle
//               parent's process restart leaves the pane no "not reachable" alert
//     t21r      F15: a prompt sent as a Reload now's replacement starts makes the drain refuse; the Reload now
//               stays pending and reloads as the reply ends
//     tsend     §chat.transcript/send-while-starting: on a chat closed while quiet, a model switch and a
//               message sent on a socket closed at once still run, the switch first; the same client id
//               on two sockets runs once; frames POSTed by a page that went (/api/chat/frames) run the
//               same way, a repeat once; a refusal (its model turned off, its folder unreachable) with no socket
//               left goes back as the session's saved draft
//     t21rx     F14/F15: Reload now and a prompt at once, either order: refused back by clientId and run once
//               when sent again, or taken first and reloaded at the reply's end; never lost or doubled
//     t23       idle stop of a waiting worker: no death, still waiting, a steer reopens it once
//     t24       llm-inflight: a worker's call counted once on /ws/watch?feed=llm; its tokens stay after
//               it ends
//     stage 5 (stage5-design.md):
//     t25       code generations: a chat runs its own copy of the code; an edit to the checkout never
//               reaches it; a restart moves quiet chats one at a time; a worker of an older chat runs
//               the current copy; unused copies go; new code that fails to boot halts the rollout
//     t27       Part B/C B1: a broken deploy: no last good copy refuses with the reason; else a new chat
//               opens on the last good copy with the failure banner; a reload whose open fails (C refuses
//               opens: SOVA_CHAT_TEST_FAIL_OPEN) starts the chat again on the code it ran before
//     trestart  Part C C1 (--mode unit): with a reply and a worker running, the operator's confirmed Apply on
//               a scratch project's slot 0 adopting the trial's stand-in unit is not refused as busy and
//               restarts the server within seconds; chats and worker keep their processes, nothing resumed
//     tdefault  Part B/C B4/B1: no switch, and a stale SOVA_CHAT_HOST=off: chats and workers still run in processes
//               of their own, never in the server or as its children
//     tserverless  Part B 5e(a): with the server stopped for good, a quiet chat exits after the (shortened)
//               idle time, one mid-reply runs on until its reply ends; the next server sees no death
//     tstopchats  Part B 5e(b): with the server stopped for good, scripts/stop-chats.ts --agent-dir stops every
//               recorded chat (a quiet one, one mid-reply, a parent and its worker); none left, a second run
//               finds none, the next server reads no death
//     hermetic  hermeticity: with HOME a tripwire home, chats, workers (pi, claude-code), /btw, a parent on
//               claude-code-cli, a restart and every page's GET read or write nothing in its ~/.pi/agent,
//               ~/.claude, ~/.codex (bar the Overseer redactor reading four home secrets to mask them) and
//               never run its ~/.local/bin/claude; every claude call reaches the trial's fake
//     real      (only with --model) t1 on a real model
//     plumbing  (only when asked) the trial's stage-3 steps work: an Overseer tool call, an org with a
//               baton, a project overseer and a look now
//     serve     (only when asked) the hermetic server left up for a browser; prints the unlock URL;
//               ^C stops it and everything it started (with --model: new chats start on that model)
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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_RESUME_TEXT,
  KNOBS,
  RESUME_TEXT,
  ROOT,
  assistantTexts,
  buildAgentDir,
  chat,
  chatProcLog,
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
  strays,
  sweep,
  tokenOf,
  userBus,
} from "./lib.mjs";
import { alive, ancestors, cgroupOf, cmdOf, darwin, info, niceOf, tree, withEnv } from "./procs.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const ALL = ["t1", "t1b", "t1c", "t1d", "t1e", "t2", "t3", "t4", "t4fail", "t6", "t7", "t8", "t9", "t10", "t11", "t11b", "t11c", "t12a", "t12b", "t12c", "t12d", "t13", "t14", "t15", "t16", "t17", "t17c", "t18", "t18b", "t19", "t19n", "t20", "t21", "t21c", "t21h", "t21l", "t21r", "t21rx", "tsend", "t23", "t24", "t25", "t27", "trestart", "tdefault", "tserverless", "tstopchats", "hermetic"];
const valued = new Set(["--port", "--scratch", "--slice", "--model", "--auth", "--mode", "--driver"]);
const asked = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
for (const a of asked) if (![...ALL, "plumbing", "serve", "real", "all"].includes(a)) (console.error(`unknown check ${a}; checks: ${ALL.join(" ")} real`), process.exit(2));
const checks = asked.length && !asked.includes("all") ? asked : [...ALL, ...(opt("model") ? ["real"] : [])];
const tag = `${process.pid}`;
/** When this run began: journal reads go no further back. */
const RUN_START = Date.now();
const mode = opt("mode", userBus() ? "unit" : "child");
// darwin: chats on the detached driver whatever the server's mode (no systemd; the server's unit is a launchd
// stand-in, lib.mjs launchdStandIn).
const driver = opt("driver", mode === "unit" && !darwin ? "systemd" : "detached");
if (driver === "systemd" && !userBus()) (console.error("--driver systemd needs the systemd user manager (none answers here)"), process.exit(2));
// T26 (stage5-design.md Part B/C): the server as a unit with sova-runtime.service's own settings and no switch
// (chats out of process by default); run the survival checks under it: run.mjs t1 t1b t1c t1d t1e t7 t17 t19 t21 --mode unit --live-like
const liveLike = argv.includes("--live-like");
if (liveLike && mode !== "unit") (console.error("--live-like needs --mode unit (the server as a stand-in unit)"), process.exit(2));
const fixedPort = opt("port") ? Number(opt("port")) : null;
// darwin: a short real path (/var is a link to /private/var, and deep /private/var/folders paths overrun the
// 104-byte limit of a unix socket path, 104 included).
const scratch = opt("scratch", darwin ? `/private/tmp/sova-t-${tag}` : join(process.env.TMPDIR || tmpdir(), `chat-runtime-trial-${tag}`));
if (darwin) {
  // An ssh or Terminal shell has 256 open files; a server and its chats need more (raise it: ulimit -n 8192).
  const nofile = Number(execFileSync("sh", ["-c", "ulimit -n"], { encoding: "utf8" }).trim());
  if (!(nofile >= 8192)) (console.error(`ulimit -n is ${nofile}: run \`ulimit -n 8192\` first (scripts/chat-runtime-trial/mac/run-mac.sh does)`), process.exit(2));
}
// No dash before the tag: a dash nests a slice under its prefix (sova-chats-test-1.slice sits inside
// sova-chats.slice); this one is a top-level slice of its own.
const slice = opt("slice", `sovatrial${tag}.slice`);
mkdirSync(scratch, { recursive: true });
const R = recorder(join(scratch, "results.json"));
console.log(`chat-runtime-trial: server as ${mode}, chats on the ${driver} driver${driver === "systemd" ? ` in ${slice}` : ""}; scratch ${scratch}`);

const mock = await startMock({ port: await freePort(), log: join(scratch, "mock.jsonl"), step: 400 });
const { agent, proj, claudeBin, claudeLogin } = buildAgentDir(scratch, { mockPort: mock.port, auth: opt("auth") });
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
/** The supervisors' records of every chat process: chats/registry (the chats' own supervisor) and,
    from stage 4, chats/children/registry (workers in child placement). */
const allRecords = (agentDir = agent) =>
  ["registry", join("children", "registry")].flatMap((d) => {
    const dir = join(agentDir, "sova", "chats", d);
    try {
      return readdirSync(dir).map((f) => readJson(join(dir, f))).filter((r) => r && typeof r === "object" && r.sessionPath);
    } catch {
      return [];
    }
  });
/** The supervisor's record of this chat: {chatId, sessionPath, unit, pid, startedAt, build, sock, epoch}. */
const record = (path, agentDir = agent) => allRecords(agentDir).find((r) => baseName(r.sessionPath) === baseName(path)) ?? null;
/** The chat's process now: its record's pid when that process lives. */
const chatPid = (path, agentDir) => {
  const r = record(path, agentDir);
  return r && alive(r.pid) ? r.pid : 0;
};
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
/** The server could not listen on its port (taken between freePort and its bind): its log says so. */
const listenFailed = (log) => {
  try {
    return /\[server\] listen failed: (.*)/.exec(readFileSync(log, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
};
async function boot(o = {}) {
  // freePort's ports are released before the server binds them, so another process (any outgoing
  // connection's source port) may take one first: the server then exits, and it boots again on others.
  for (let attempt = 1; ; attempt++) {
    const port = o.agent ? await freePort() : (fixedPort ?? (await freePort()));
    const url = `http://127.0.0.1:${port}`;
    // A fixed build unless the check sets one: the worktree is edited while the trial runs, and a build
    // taken from the dirty tree would move between restarts and reload chats mid-check.
    // A share listener of its own on loopback, so a trial can post as a baton's participant.
    const sharePort = await freePort();
    const extra = { SOVA_SHARE_HOST: "127.0.0.1", SOVA_SHARE_PORT: String(sharePort), ...(o.extra ?? {}) };
    const env = serverEnv({ agent: o.agent ?? agent, port, driver, liveLike, slice: driver === "systemd" ? slice : undefined, idleMs: o.idleMs, build: "build" in o ? o.build : "trial-fixed", failBoot: o.failBoot, claude: { claudeBin, claudeLogin }, extra });
    const log = join(scratch, `server-${n + 1}.log`);
    const s = server({ tag: `${tag}-${++n}`, env, mode, log, root: o.root, liveLike });
    s.up();
    try {
      await healthy(url, undefined, () => listenFailed(log));
    } catch (err) {
      const why = listenFailed(log);
      if (!why || attempt >= 3 || (fixedPort && !o.agent)) throw err;
      R.note(`the server could not listen (${why}); booting it again on other ports`);
      await s.down();
      continue;
    }
    return booted(o, s, url, sharePort);
  }
}
async function booted(o, s, url, sharePort) {
  if (liveLike && !o.agent) {
    // No switch: chats run in processes of their own, on systemd user units where the user manager
    // answers (the stand-in unit's), else detached (darwin).
    const h = await fetch(`${url}/api/health`).then((r) => r.json()).catch(() => null);
    const want = darwin ? "detached" : driver;
    R.check(h?.chatHost?.driver === want && h?.chatHost?.bun !== false, `live-like: with no switch set, chats run in processes of their own on the ${want} driver (health chatHost ${JSON.stringify(h?.chatHost)?.slice(0, 120)})`);
  }
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
  // What no record names (a worker whose record went first, a tool or fake claude it started): every
  // process of the agent dir. A failed check left such processes running before (report-s4 item 9).
  const left = await sweep(agentDir, { mock: false });
  if (left.length) R.note(`teardown: stopped ${left.length} process(es) no record named: ${left.map((p) => `${p.pid} ${p.cmd.slice(0, 80)}`).join("; ")}`);
}
async function newChat(model = "trial/m1", cl = c, ms = 40000) {
  const { path } = await cl.api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: proj }) });
  const s = await chat(cl, path, ms);
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
/** Sends a prompt; returns its clientId (a refusal names it). */
let prompts = 0;
const prompt = (s, text) => {
  const clientId = `trial-${Date.now()}-${++prompts}`;
  s.send({ type: "prompt", text, clientId });
  return clientId;
};
const isEvent = (t) => (m) => m.type === "event" && m.event?.type === t;
const settled = (s, from = 0, ms = 180000) => s.until(isEvent("run.settled"), ms, "run.settled", from);
const delta = (re) => (m) => m.type === "event" && m.event?.type === "part.delta" && re.test(m.event.delta ?? "");
const liveText = (hello) => (hello.live?.message?.parts ?? []).filter((p) => (p.kind ?? p.type) === "text").map((p) => p.text ?? "").join("");
/** What this chat's processes logged (lib chatProcLog: chats/logs files, or the journal under systemd). */
const procLogOf = (path, { unit, pid } = {}) => chatProcLog({ stateRoot: sova, sessionId: entries(path)[0]?.id ?? "", unit, pid, since: RUN_START });
/** Whether the mock cut off a reply of `tag` (its cut-off record names the request number, not the tag). */
const cutOff = (tag) => {
  const log = mockLog(mock.log);
  const ns = new Set(log.filter((q) => q.scenario && q.tag === tag).map((q) => q.n));
  return log.some((e) => e.event === "cut-off" && ns.has(e.n));
};
/** The common restart assertions of T1 and its variants: same pid, no resume of any kind, ledger clear. */
function noResume(path, label) {
  R.check(userEntriesWith(path, RESUME_TEXT) === 0 && userEntriesWith(path, CRASH_RESUME_TEXT) === 0, `${label}: no user entry holds a "continue" text`);
  R.check(!inLedger(path), `${label}: runs-in-flight.json does not list the chat`);
  R.check(resumeDecisions(path).length === 0, `${label}: no auto-resume decision about the chat (${fmtDecisions(resumeDecisions(path))})`);
}
/** darwin (no cgroups): `pid` is apart from the server: not in its process group, so a stop of the server's
    launchd job (which signals its group) never reaches it. A detached chat is started with setsid and stays the
    server's child by ppid, so ancestry is reported, not compared; so are sessions (ps shows every session as 0
    there). The restart checks prove the survival itself. */
function apartFromServer(pid, label, what = "the chat") {
  const me = info(pid);
  const sv = info(srv.pid());
  R.check(me && sv && me.pgid !== sv.pgid, `${label}: ${what} is apart from the server, outside its process group (pid ${pid} pgid ${me?.pgid} sess ${me?.sid}; server ${sv?.pid} pgid ${sv?.pgid} sess ${sv?.sid}; ${ancestors(pid).includes(sv?.pid) ? "the server's descendant (setsid child)" : "not the server's descendant"})`);
}
function sameProcess(path, pid1, label) {
  const pid2 = chatPid(path);
  R.check(pid1 && pid2 === pid1, `${label}: the chat process survived the restart (pid ${pid1} → ${pid2 || "none"})`);
  if (darwin && pid1) {
    apartFromServer(pid1, label);
    const sock = record(path)?.sock;
    if (sock) R.check(Buffer.byteLength(sock) <= 104, `${label}: the chat's socket path fits a unix socket (${Buffer.byteLength(sock)} bytes, at most 104: ${sock})`);
  }
  if (driver === "systemd" && pid1) {
    const cg = (() => {
      try {
        return cgroupOf(pid1);
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
  // This check's requests only: one mock log serves every check of the run.
  const m0 = mockLog(mock.log).length;
  prompt(s, "/compact");
  for (let i = 0; i < 60 && !mockLog(mock.log).slice(m0).some((e) => e.scenario === "compact"); i++) await sleep(500);
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
  R.check(mockLog(mock.log).slice(m0).filter((e) => e.event === "cut-off" && e.scenario === "compact").length === 0, "t1e: the summary request was never cut off");
  noResume(path, "t1e");
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
  // This check's requests only: one mock log serves every check of the run.
  const m0 = mockLog(mock.log).length;
  process.kill(pid1, "SIGKILL");
  R.note(`t2: killed chat process ${pid1}`);
  const err = await s.until((m) => m.type === "error" && /stopped unexpectedly/.test(m.message ?? ""), 20000, "the pane's error", from).catch(() => null);
  R.check(err?.code === "internal", `t2: the pane got the stopped-unexpectedly error ("${err?.message?.slice(0, 120)}")`);
  const code = await Promise.race([closed, sleep(10000).then(() => "none")]);
  R.check(code === 4500, `t2: the socket closed with 4500 (${code})`);
  R.check(deaths(path).length === 1, `t2: one death recorded in chats/deaths.jsonl (${deaths(path).length})`);
  // The resume reopens the chat in a new process and sends the crash text once.
  for (let i = 0; i < 60 && !mockLog(mock.log).slice(m0).some((e) => e.tag === "resume"); i++) await sleep(500);
  // The model request comes before the session file holds the user entry (pi writes it on its own
  // schedule), so wait for the entry with a deadline; the count is still checked as exactly 1 here
  // and again after the second kill, so a missing or doubled continue fails.
  await waitFor(() => userEntriesWith(path, CRASH_RESUME_TEXT) >= 1, 20000, 200);
  const pid2 = chatPid(path);
  R.check(pid2 && pid2 !== pid1, `t2: a new process hosts the chat (pid ${pid1} → ${pid2 || "none"})`);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1 && userEntriesWith(path, RESUME_TEXT) === 0, `t2: the crash "continue" was sent once (${userEntriesWith(path, CRASH_RESUME_TEXT)}), never the restart text`);
  // A second kill while the resume runs: never resumed again.
  await sleep(2000);
  // Under load the wait above can eat the resume's ~10 s reply; a kill of an idle chat would test nothing.
  R.check(!mockLog(mock.log).slice(m0).some((e) => e.event === "done" && e.tag === "resume"), "t2: the second kill lands while the resume runs");
  if (pid2) process.kill(pid2, "SIGKILL");
  R.note(`t2: killed the resuming process ${pid2}`);
  await sleep(15000);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1, `t2: the cut-off resume was not resumed a second time (${userEntriesWith(path, CRASH_RESUME_TEXT)})`);
  R.check(mockLog(mock.log).slice(m0).filter((e) => e.tag === "resume" && e.scenario).length === 1, "t2: the model was asked to continue once");
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
  prompt(s, "[long 25 #t3] a long reply");
  await s.until(delta(/part 2\//), 30000, "streaming");
  const pid1 = chatPid(path);
  await sleep(6000);
  R.check(chatPid(path) === pid1, "t3: with a run in flight and a client attached, the process stays");
  s.close();
  await sleep(4000);
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
  // Quiet with the client still attached: it closes all the same, and the client is told so
  // (§app.chat-processes/idle-stop), never asked to reconnect.
  const told = await s2.until((m) => m.type === "closed" || m.type === "error", 30000, "closed").catch(() => null);
  R.check(told?.type === "closed" && told.reason === "idle", `t3: a quiet chat with a client attached closes, the client told "closed" (${JSON.stringify(told)})`);
  for (let i = 0; i < 40 && alive(pid2); i++) await sleep(500);
  R.check(!alive(pid2), "t3: its process exited");
  R.check(deaths(path).length === 0, "t3: no death");
  await sleep(5000);
  R.check(!chatPid(path) || !alive(chatPid(path)), `t3: nothing started it again on its own (${chatPid(path)})`);
  s2.close();
  await teardown();
  await boot();
}

/** §chat.transcript/send-while-starting, end to end over real chat processes. */
async function tsend() {
  await teardown();
  await boot({ idleMs: 3000 });
  const draftOf = (path) => (readJson(join(sova, "drafts.json"))?.drafts ?? {})[entries(path)[0]?.id]?.text ?? null;
  /** A chat on m1 with one turn done, then closed for being quiet with no socket. */
  const quietChat = async (cwd) => {
    const { path } = await c.api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: cwd ?? proj }) });
    const s = await chat(c, path);
    s.send({ type: "set_model", ref: "trial/m1" });
    await s.until((m) => m.type === "model" || m.type === "error", 15000, "set_model answer");
    prompt(s, "say ok first");
    await settled(s, 0, 60000);
    const pid = chatPid(path);
    s.close();
    // 3 s idle, but under a loaded test run the quiet check and the exit take longer.
    for (let i = 0; i < 180 && alive(pid); i++) await sleep(500);
    R.check(!alive(pid), `tsend: the chat closed for being quiet (${alive(pid) ? "still alive" : "gone"})`);
    return path;
  };
  /** A socket that sends `msgs` the moment it opens and closes at once, before any hello. */
  const sendAndLeave = async (path, msgs) => {
    const raw = c.socket(`/ws/chat?path=${encodeURIComponent(path)}&wire=2&tail=rest`);
    await raw.opened;
    for (const m of msgs) raw.send(m);
    raw.close();
    return raw;
  };
  const userTurns = (path, text) => userEntriesWith(path, text);

  // (a) A model switch, then a message, on a socket closed before the chat said hello.
  const a = await quietChat();
  const raw = await sendAndLeave(a, [
    { type: "set_model", ref: "trial/m2" },
    { type: "prompt", text: "TSEND-A say ok", clientId: "tsend-a" },
  ]);
  R.check(!raw.got.some((m) => m.type === "hello"), "tsend: the socket closed before the chat's hello");
  for (let i = 0; i < 60 && !turnAssistants(a, "TSEND-A").some((m) => m.stopReason && m.stopReason !== "toolUse"); i++) await sleep(500);
  R.check(userTurns(a, "TSEND-A") === 1, `tsend: the message sent on a socket that left before the hello landed once (${userTurns(a, "TSEND-A")})`);
  const es = entries(a);
  const switchAt = es.findIndex((e) => e.type === "model_change" && e.modelId === "m2");
  const userAt = es.findIndex((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("TSEND-A"));
  R.check(switchAt >= 0 && switchAt < userAt, `tsend: the model switch sent first is applied first (model_change m2 at ${switchAt}, message at ${userAt})`);
  const reply = turnAssistants(a, "TSEND-A")[0];
  R.check(reply?.model === "m2", `tsend: the reply ran on the model switched to first (${reply?.model})`);

  // (b) The same client id on two sockets: one user entry.
  const b = await quietChat();
  const one = c.socket(`/ws/chat?path=${encodeURIComponent(b)}&wire=2&tail=rest`);
  await one.opened;
  one.send({ type: "prompt", text: "TSEND-B say ok", clientId: "tsend-b" });
  await one.until((m) => m.type === "send_ack" && m.clientId === "tsend-b", 30000, "first socket's ack");
  const two = c.socket(`/ws/chat?path=${encodeURIComponent(b)}&wire=2&tail=rest`);
  await two.opened;
  two.send({ type: "prompt", text: "TSEND-B say ok", clientId: "tsend-b" });
  const ack = await two.until((m) => (m.type === "send_ack" && m.clientId === "tsend-b") || (m.type === "error" && m.clientId === "tsend-b"), 30000, "second socket's answer").catch(() => null);
  for (let i = 0; i < 60 && !turnAssistants(b, "TSEND-B").some((m) => m.stopReason && m.stopReason !== "toolUse"); i++) await sleep(500);
  await sleep(2000);
  R.check(userTurns(b, "TSEND-B") === 1, `tsend: one client id on two sockets runs once (${userTurns(b, "TSEND-B")} user entries; second answered ${JSON.stringify(ack)?.slice(0, 80)})`);
  R.check(ack?.type === "send_ack", "tsend: the second socket is answered as taken, not refused");
  two.close();
  one.close();

  // (d) A page that went before its socket opened hands its frames over (POST /api/chat/frames):
  // no socket at all; they run in order, and the same frames posted again run once.
  const d = await quietChat();
  const posted = [
    { type: "set_model", ref: "trial/m2" },
    { type: "prompt", text: "TSEND-D say ok", clientId: "tsend-d" },
  ];
  const q = `/api/chat/frames?path=${encodeURIComponent(d)}`;
  const r1 = await c.api(q, { method: "POST", body: JSON.stringify({ frames: posted }) });
  const r2 = await c.api(q, { method: "POST", body: JSON.stringify({ frames: [posted[1]] }) });
  R.check(r1?.accepted === 2 && r2?.accepted === 1, `tsend: POST /api/chat/frames accepts the frames (${JSON.stringify([r1, r2])})`);
  for (let i = 0; i < 60 && !turnAssistants(d, "TSEND-D").some((m) => m.stopReason && m.stopReason !== "toolUse"); i++) await sleep(500);
  await sleep(2000);
  R.check(userTurns(d, "TSEND-D") === 1, `tsend: frames posted with no socket run, and the same client id posted twice runs once (${userTurns(d, "TSEND-D")})`);
  const ed = entries(d);
  const dSwitch = ed.findIndex((e) => e.type === "model_change" && e.modelId === "m2");
  const dUser = ed.findIndex((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("TSEND-D"));
  R.check(dSwitch >= 0 && dSwitch < dUser, `tsend: posted frames run in order, the switch first (${dSwitch} < ${dUser})`);
  R.check(turnAssistants(d, "TSEND-D")[0]?.model === "m2", "tsend: the posted message ran on the model posted before it");
  let bad = null;
  try {
    await c.api(q, { method: "POST", body: JSON.stringify({ frames: [{ nope: 1 }] }) });
  } catch (e) {
    bad = String(e);
  }
  R.check(!!bad && bad.includes("400"), `tsend: a malformed body is refused (${bad?.slice(0, 60)})`);

  // (c1) Its model turned off in Settings, with no socket left: the text goes back as the draft.
  const c1 = await quietChat();
  await c.api("/api/sessions/draft", { method: "PUT", body: JSON.stringify({ path: c1, text: "earlier draft" }) });
  await c.api("/api/settings/models", { method: "PUT", body: JSON.stringify({ disabledProviders: [], disabledModels: ["trial/m1"], subagentDisabledProviders: [], subagentDisabledModels: [] }) });
  await sendAndLeave(c1, [{ type: "prompt", text: "TSEND-C1 refused", clientId: "tsend-c1" }]);
  for (let i = 0; i < 60 && !(draftOf(c1) ?? "").includes("TSEND-C1"); i++) await sleep(500);
  R.check(draftOf(c1) === "TSEND-C1 refused\n\nearlier draft", `tsend: a message its turned-off model refused goes back ahead of the saved draft (${JSON.stringify(draftOf(c1))})`);
  R.check(userTurns(c1, "TSEND-C1") === 0, "tsend: the refused message never ran");
  await c.api("/api/settings/models", { method: "PUT", body: JSON.stringify({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }) });

  // (c2) A chat that can't start (its folder can't be reached: a folder that is gone opens in the home
  // folder instead), with no socket left: the text goes back as the draft.
  const shut = join(scratch, "tsend-shut");
  const unreachable = join(shut, "repo");
  mkdirSync(unreachable, { recursive: true });
  const c2 = await quietChat(unreachable);
  chmodSync(shut, 0o000);
  try {
    await sendAndLeave(c2, [{ type: "prompt", text: "TSEND-C2 never started", clientId: "tsend-c2" }]);
    for (let i = 0; i < 60 && draftOf(c2) === null; i++) await sleep(500);
  } finally {
    chmodSync(shut, 0o755);
  }
  R.check(draftOf(c2) === "TSEND-C2 never started", `tsend: a message whose chat failed to start goes back as the draft (${JSON.stringify(draftOf(c2))})`);
  const list = await c.api("/api/sessions");
  const rows = Array.isArray(list) ? list : (list?.sessions ?? []);
  const listed = rows.find((x) => baseName(x.path) === baseName(c2)) ?? null;
  R.check(!!listed && (listed.hasDraft === true || !!listed.draftPreview), `tsend: the session list marks its draft (${JSON.stringify({ hasDraft: listed?.hasDraft, draftPreview: listed?.draftPreview })})`);
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
// Each run of t4 tags B's reply on its own (t4 t4 t4 shares one mock log).
let t4runs = 0;
async function t4() {
  const bTag = `t4b${++t4runs}`;
  await teardown();
  await boot({ build: "trial-a" });
  // Chat A: attached the whole time, reloaded with Reload now.
  const A = await newChat();
  prompt(A.s, "say ok");
  await settled(A.s, 0, 60000);
  // Chat B: mid-reply at the restart, nobody attached: reloads by itself once the reply ends.
  const B = await newChat();
  // Held open by the mock until Reload now has been answered: under load the restart and reattach
  // outlasted the reply's 12 s, B (unattended) then reloaded by itself, and no "pending" came.
  await mock.hold(bTag);
  prompt(B.s, `[long 30 #${bTag}] a long reply`);
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
  const bEnded = mockLog(mock.log).some((e) => e.event === "done" && e.tag === bTag);
  await mock.hold(bTag, false);
  R.check(pend?.state === "older" && pend.pending === true, `t4: Reload now during a reply answers {older, pending} (${JSON.stringify(pend)}; reply ended first: ${bEnded}; B pid ${pidB} → ${chatPid(B.path)}; code frames ${JSON.stringify(codeMsgs(b2).slice(-3))})`);
  b2.close();
  // B must not reload while its reply runs.
  for (let i = 0; i < 60 && !mockLog(mock.log).some((e) => e.event === "done" && e.tag === bTag); i++) {
    if (chatPid(B.path) !== pidB) break;
    await sleep(500);
  }
  // The mock's "done" comes as the stream ends; the chat writes its assistant entry a moment later.
  await waitFor(() => turnAssistants(B.path, `[long 30 #${bTag}]`).length > 0, 10000, 200);
  const bMsgs = turnAssistants(B.path, `[long 30 #${bTag}]`);
  R.check(mockLog(mock.log).some((e) => e.event === "done" && e.tag === bTag) && !cutOff(bTag) && bMsgs.length === 1 && bMsgs[0].stopReason !== "aborted", `t4: B's reply ran to its end, never cut by a reload (assistant entries ${bMsgs.map((m) => m.stopReason).join(", ") || "none"})`);
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
  const logFile = join(scratch, `server-${n}.log`);
  const logFrom = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
  const ids = [entries(A.path)[0]?.id, entries(B.path)[0]?.id];
  const rollout = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").slice(logFrom) : "").split("\n").filter((l) => l.includes("[chat-rollout]"));
  await restart({ [KNOBS.build]: "trial-b", [KNOBS.failBoot]: "trial-b" });
  // The rollout's own verdicts, not a fixed sleep: one chat's replacement fails (its waitReady gives up
  // only after readyTimeoutMs, 30 s), the other's automatic reload is skipped. Each starts only once the
  // server took the chat back (up to 60 s, chat-host.ts takeBack). A fixed 45 s ran out under full load
  // with neither verdict in (older, older). Bounded by those limits: 60 + 30 s, plus as much again.
  const verdicts = () => {
    const ls = rollout();
    return { failed: ids.filter((id) => ls.some((l) => l.includes(`${id}: could not start on new code`))), halted: ids.filter((id) => ls.some((l) => l.includes(`${id}: no automatic reload`))) };
  };
  const t0 = Date.now();
  const both = await waitFor(() => {
    const v = verdicts();
    return v.failed.length + v.halted.length >= 2;
  }, 180000);
  R.note(`t4fail: rollout verdicts ${both ? "in" : "not all in"} after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(verdicts())}`);
  const kept = [chatPid(A.path) === pidA, chatPid(B.path) === pidB];
  R.check(kept[0] && kept[1], `t4fail: both old processes are kept (A ${pidA} → ${chatPid(A.path)}, B ${pidB} → ${chatPid(B.path)})`);
  const a2 = await chat(c, A.path);
  const b2 = await chat(c, B.path);
  await sleep(2000);
  const states = [codeMsgs(a2).at(-1)?.state, codeMsgs(b2).at(-1)?.state];
  R.check(states.includes("failed") && states.filter((x) => x === "failed").length === 1, `t4fail: exactly one chat shows "failed", the rollout halted before the other (${states.join(", ")}; rollout: ${JSON.stringify(rollout().slice(-6))})`);
  R.check(states.every((x) => x === "older" || x === "failed"), "t4fail: the other stays on older code");
  a2.close();
  b2.close();
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

// T6': the Overseer, a project overseer, a baton and a powers chat each run in a
// process of their own; a worker's session file stays in the server.
async function t6() {
  // Chats an earlier check left running on this server are not this check's.
  const t6at = Date.now();
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
          return cgroupOf(chatPid(p));
        } catch {
          return "";
        }
      })();
      R.check(cg.includes(`/${slice}/`), `t6: ${label}'s cgroup is under the stand-in slice (${cg})`);
    }
  }
  // Stage 4: any other chat process is a worker chat (the worker's own session), never an ordinary
  // chat: the server records it as a worker, and a browser asking to open its file is refused.
  const known = new Set(kinds.map(([, p]) => baseName(p)));
  const workers = new Set(workerRecords().map((r) => baseName(r.path)));
  const others = allRecords().filter((r) => !known.has(baseName(r.sessionPath)) && alive(r.pid) && new Date(r.startedAt ?? 0).getTime() >= t6at);
  R.check(others.every((r) => workers.has(baseName(r.sessionPath))), `t6: every other chat process is a worker chat (${others.map((r) => `${baseName(r.sessionPath)}${workers.has(baseName(r.sessionPath)) ? "" : " (not a worker)"}`).join(", ") || "none"})`);
  const wr = workerRecords(w.path)[0];
  if (wr) {
    const opened = await chat(c, wr.path, 10000).then((x) => (x.close(), "opened"), (e) => String(e.message ?? e));
    R.check(opened !== "opened", `t6: the worker's own session never opens as an ordinary chat (${opened.slice(0, 160)})`);
  } else R.check(false, "t6: the worker is recorded by the server (chats/workers)");
  for (const x of [ov, poc, pw, w]) x.s.close();
  bc.close();
}

// T10: the Overseer in its own process: a served read tool, a served file tool, an acting tool and an
// explorer (stage 4: a worker chat of the Overseer's, a process of its own); the run note is in the file.
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
  // Stage 4: the explorer is a worker chat of the Overseer's, in a process of its own.
  const ex = workerRecords(ov.path).find((r) => r.kind === "worker");
  const expid = ex && chatPid(ex.path);
  R.check(expid && expid !== pid && mockLog(mock.log).some((e) => e.tag === "explorer" && e.pid === expid), `t10: the explorer is a worker chat of the Overseer's in a process of its own (${expid || "none"}, Overseer ${pid})`);
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

// T13: a project overseer's look across a server restart (the ruling): one look message, one turn, the
// watch's resume records it cut off once and never reports or re-runs it.
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

// ── stage 4: workers, team members and hidden chats as chat processes (stage4-design.md §8) ─────

/** The server's worker records (<stateRoot>/chats/workers/*.json, design §2.4), of one parent chat
    when `parentPath` is given: {chatId, path, kind, parent: {sessionId, path, workerId}, placement, state, ended}. */
function workerRecords(parentPath) {
  const dir = join(sova, "chats", "workers");
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {}
  return files.map((f) => readJson(join(dir, f))).filter((r) => r && (!parentPath || baseName(r.parent?.path) === baseName(parentPath)));
}
/** The first worker record of the parent that `pred` accepts, waited for. */
async function workerOf(parentPath, pred = () => true, ms = 60000) {
  let hit = null;
  await waitFor(() => (hit = workerRecords(parentPath).find(pred) ?? null), ms);
  return hit;
}
/** A worker record whose session file holds `marker` (its task's tag). */
const workerWith = (parentPath, marker, ms) => workerOf(parentPath, (r) => existsSync(r.path) && readFileSync(r.path, "utf8").includes(marker), ms);
/** Every `pi --mode rpc` process of this trial (its environment names the scratch agent dir): stage 4 has none. */
const rpcProcs = () => withEnv("PI_CODING_AGENT_DIR").filter((p) => p.value === agent && /--mode rpc/.test(p.cmd)).map((p) => p.pid);
const noRpc = (label) => R.check(rpcProcs().length === 0, `${label}: no \`pi --mode rpc\` process of this trial exists (${rpcProcs().join(", ") || "none"})`);
/** The mock's requests made by process `pid` (the mock names each caller). */
const askedBy = (pid) => mockLog(mock.log).filter((e) => e.scenario && e.pid === pid);
/** Entries of the parent's file that hold `marker` and are not the parent's own words (its prompt,
    its tool calls, their results): a completion, a wake, a delivered question. */
const deliveredTo = (path, marker) =>
  entries(path).filter((e) => {
    const s = JSON.stringify(e);
    if (!s.includes(marker) || s.includes("[call ") || s.includes("[spawn")) return false;
    return !(e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult"));
  }).length;
/** The parent's completion entries (custom_message subagent-complete) that hold `marker`. */
const completions = (path, workerFile, marker = "") => entries(path).filter((e) => e.customType === "subagent-complete" && JSON.stringify(e).includes(baseName(workerFile)) && JSON.stringify(e).includes(marker)).length;
/** The mock's requests whose newest user text holds `marker`, not a parent's own tool call quoting it. */
const asksWith = (marker) => mockLog(mock.log).filter((e) => e.scenario && (e.userText ?? "").includes(marker) && !(e.userText ?? "").includes("[call "));
/** The parent's agent_list, through the model: its details' agents [{id, name, status, restored, …}]. */
/** A pane whose chat closed for being quiet (its socket told "closed", then closed) connects again,
    as the web app does when it sends: the chat opens in a new process. */
async function reawaken(o) {
  if (!o.s.closed() && !o.s.got.some((m) => m.type === "closed")) return;
  o.s.close();
  o.s = await chat(c, o.path);
}
async function agentList(o) {
  const r = await turn(o, "[call agent_list {}]");
  return r.at(-1)?.message?.details?.agents ?? [];
}
/** The parent's worker pane frames (`workers`) since `from`. */
const workerFrames = (s, from = 0) => s.got.slice(from).filter((m) => m.type === "workers");
const workerDone = (s, name, ms = 180000) => s.until((m) => m.type === "workers" && m.workers?.some((x) => x.name === name && x.outcome), ms, `${name} ends`).then((m) => m.workers.find((x) => x.name === name), () => null);
/** The usage ledger's records (<agent>/usage/v1/<day>/<producer>.jsonl). */
function usageRecords() {
  const root = join(agent, "usage", "v1");
  const out = [];
  let days = [];
  try {
    days = readdirSync(root);
  } catch {}
  for (const d of days) {
    let files = [];
    try {
      files = readdirSync(join(root, d));
    } catch {}
    for (const f of files) out.push(...readLines(join(root, d, f)));
  }
  return out;
}

// T17: a worker survives a server restart: a chat process of its own, never the parent's
// descendant, same pid, its reply streamed once, its completion delivered once, no `--mode rpc`.
// `claude`: the same for a claude-code worker (scripts/fake-claude.mjs answers it).
async function t17(claude = false) {
  const label = claude ? "t17c" : "t17";
  const marker = claude ? "#t17c" : "#t17w";
  const { path, s } = await newChat();
  prompt(s, claude ? "[spawn-claude 30000 #t17c] start a claude worker" : "[spawn 1 60 #t17w] start a worker");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  const w = await workerWith(path, marker);
  if (!R.check(w, `${label}: the server records the worker (chats/workers: ${JSON.stringify(workerRecords(path)).slice(0, 200)})`)) return;
  R.note(`${label}: worker ${w.parent?.workerId} kind ${w.kind}, placement ${w.placement}, state ${w.state}`);
  if (!claude) await waitFor(() => mockLog(mock.log).some((e) => e.tag === "t17w"), 60000);
  await sleep(claude ? 4000 : 2000);
  const ppid = chatPid(path);
  const wpid = chatPid(w.path);
  R.check(wpid && wpid !== ppid && wpid !== srv.pid(), `${label}: the worker runs in a chat process of its own (worker ${wpid || "none"}, parent ${ppid}, server ${srv.pid()})`);
  R.check(wpid && !tree(ppid).some((p) => p.pid === wpid), `${label}: the worker's process is not a descendant of the parent's`);
  if (driver === "systemd") {
    const unit = record(w.path)?.unit;
    R.check(unit && unit !== record(path)?.unit, `${label}: the worker is a unit of its own (${unit})`);
    let cg = "";
    try {
      cg = cgroupOf(wpid);
    } catch {}
    R.check(cg.includes(`/${slice}/`), `${label}: the worker's cgroup is under the stand-in slice (${cg})`);
  }
  if (darwin && wpid) apartFromServer(wpid, label, "the worker");
  if (!claude) R.check(askedBy(wpid).some((e) => e.tag === "t17w"), `${label}: the worker's model call comes from the worker's own process (${wpid})`);
  noRpc(label);
  s.close();
  await restart();
  R.check(wpid && chatPid(w.path) === wpid && alive(wpid), `${label}: the worker's process survived the restart (pid ${wpid} → ${chatPid(w.path) || "none"})`);
  const s2 = await chat(c, path);
  const done = await workerDone(s2, claude ? "trial-claude" : "trial-t17w");
  R.check(done?.outcome === "success", `${label}: the worker finished on its own (outcome ${done?.outcome}${done?.error ? `: ${done.error}` : ""})`);
  if (claude) {
    const answers = entries(w.path).filter((e) => e.type === "message" && e.message?.role === "assistant" && /Fake answer from login/.test(textOfMsg(e.message)));
    R.check(answers.length === 1, `${label}: the worker's reply is in its file once (${answers.length})`);
    // Its usage lands under the parent, as that worker (the Claude Code provider's records).
    const psid = entries(path)[0]?.id;
    await sleep(2000);
    const mine = usageRecords().filter((r) => r.parent === psid && r.worker === w.parent?.workerId);
    R.check(mine.length >= 1, `${label}: the claude worker's usage is recorded under the parent as ${w.parent?.workerId} (${mine.map((r) => `${r.src}/${r.model} out ${r.output}`).join(", ") || "none"})`);
  } else {
    const log = mockLog(mock.log);
    R.check(log.filter((e) => e.event === "done" && e.tag === "t17w").length === 1 && !cutOff("t17w"), `${label}: the worker's reply streamed to its end once`);
    R.check(log.filter((e) => e.tag === "t17w" && e.scenario && !e.afterTool).length === 1, `${label}: the model was asked for the worker's reply once`);
  }
  await sleep(5000);
  const got = completions(path, w.path);
  R.check(got === 1, `${label}: the worker's completion was delivered to the parent once (${got})`);
  noResume(path, label);
  R.check(deaths(w.path).length === 0, `${label}: no death recorded for the worker`);
  noRpc(label);
  s2.close();
}

// T18: the parent reloads (Reload now on new code a → b) while its worker runs: the worker's pid is
// unchanged; the parent's new process reattaches (agent_list: running), the completion arrives once,
// and a steer after the reload reaches the worker once.
async function t18() {
  await teardown();
  await boot({ build: "trial-a" });
  const { path, s } = await newChat();
  prompt(s, "[spawn 1 250 #t18w] start a worker");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  const w = await workerWith(path, "#t18w");
  if (!R.check(w, "t18: the server records the worker")) return;
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "t18w"), 60000);
  const wpid = chatPid(w.path);
  const ppid = chatPid(path);
  s.close();
  await restart({ [KNOBS.build]: "trial-b" });
  const p2 = await chat(c, path);
  const from = p2.got.length;
  p2.send({ type: "reload_code" });
  const reloaded = await p2.until((m) => m.type === "error" && m.code === "reloaded", 40000, "the reloaded notice", from).catch(() => null);
  // The parent is quiet and was unattended across the restart, so the rollout may move it before the pane
  // is back; Reload now then answers "current". Either way it must end on build b in a new process.
  const codes = p2.got.slice(from).filter((m) => m.type === "code");
  const already = codes.some((m) => m.state === "current");
  await waitReloaded(path, ppid);
  R.check(reloaded || (already && record(path)?.build === "trial-b"), `t18: the parent reloaded onto build b (${reloaded ? "by Reload now" : already ? "by the rollout before the pane was back" : "not at all"}; code frames ${JSON.stringify(codes)})`);
  R.check(chatPid(path) && chatPid(path) !== ppid, `t18: the parent runs a new process (pid ${ppid} → ${chatPid(path) || "none"})`);
  R.check(chatPid(w.path) === wpid && alive(wpid), `t18: the worker's process is unchanged by the parent's reload (pid ${wpid} → ${chatPid(w.path) || "none"})`);
  const p3 = { path, s: await chat(c, path) };
  const list = await agentList(p3);
  const me = list.find((a) => a.name === "trial-t18w");
  R.check(me && me.status === "running" && !me.restored, `t18: after the reload agent_list shows the worker running, not restored (${JSON.stringify(me)?.slice(0, 200)})`);
  if (me) await turn(p3, `[call agent_steer ${JSON.stringify({ id: me.id, message: "STEER-T18 please note" })}]`);
  const done = await workerDone(p3.s, "trial-t18w");
  R.check(done?.outcome === "success", `t18: the worker finished (outcome ${done?.outcome})`);
  await waitFor(() => askedBy(chatPid(w.path) || wpid).some((e) => /STEER-T18/.test(e.userText ?? "")), 30000);
  await sleep(5000);
  R.check(userEntriesWith(w.path, "STEER-T18") === 1, `t18: the steer after the reload is in the worker's file once (${userEntriesWith(w.path, "STEER-T18")})`);
  R.check(asksWith("STEER-T18").length === 1, "t18: the worker's model got the steer once");
  R.check(completions(path, w.path) === 1, `t18: the worker's run (its task, the steer taken mid-run) reached the parent as one completion (${completions(path, w.path)})`);
  noRpc("t18");
  p2.close();
  p3.s.close();
  await teardown();
  await boot();
}

// T18b: kill -9 of the parent mid-run while its worker runs: the parent's crash resume reopens it;
// the worker keeps its process; its completion arrives and is announced once.
async function t18b() {
  const { path, s } = await newChat();
  prompt(s, "[spawn 1 90 #t18k] start a worker");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  await settled(s, 0, 60000);
  const w = await workerWith(path, "#t18k");
  if (!R.check(w, "t18b: the server records the worker")) return;
  const wpid = chatPid(w.path);
  const from = s.got.length;
  prompt(s, "[long 40 #t18p] the parent's own long reply");
  await s.until(delta(/part 3\//), 60000, "the parent streams", from);
  const ppid = chatPid(path);
  const asked0 = mockLog(mock.log).length;
  process.kill(ppid, "SIGKILL");
  R.note(`t18b: killed the parent's process ${ppid}`);
  // The parent's crash resume, from its new process (an earlier check's resumes are older lines).
  await waitFor(() => mockLog(mock.log).slice(asked0).some((e) => e.tag === "resume" && e.pid && e.pid !== ppid && e.pid !== wpid), 60000);
  // The model request comes before pi writes the user entry: wait for the entry (bounded).
  await waitFor(() => userEntriesWith(path, CRASH_RESUME_TEXT) >= 1, 20000, 200);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1, `t18b: the parent's crash "continue" was sent once (${userEntriesWith(path, CRASH_RESUME_TEXT)})`);
  R.check(chatPid(w.path) === wpid && alive(wpid), `t18b: the worker kept its process through the parent's crash (pid ${wpid} → ${chatPid(w.path) || "none"})`);
  R.check(userEntriesWith(w.path, CRASH_RESUME_TEXT) === 0, "t18b: the worker was sent no continue");
  const s2 = await chat(c, path);
  const done = await workerDone(s2, "trial-t18k");
  R.check(done?.outcome === "success", `t18b: the worker finished (outcome ${done?.outcome})`);
  await sleep(6000);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 1, `t18b: the parent's crash "continue" is still in its file once after the run settled (${userEntriesWith(path, CRASH_RESUME_TEXT)})`);
  R.check(userEntriesWith(w.path, CRASH_RESUME_TEXT) === 0, `t18b: the worker was still sent no continue after the run settled (${userEntriesWith(w.path, CRASH_RESUME_TEXT)})`);
  R.check(completions(path, w.path) === 1, `t18b: the worker's completion was announced to the parent once (${completions(path, w.path)})`);
  noRpc("t18b");
  s2.close();
}

// T19: a team across a restart: alpha's team_msg to beta, made just before the restart, arrives once;
// alpha's team_ask reaches the parent once; after a parent reload alpha's inbox still lists beta's
// earlier message. Beta's message reached alpha as a one-item wake, which showed it in full, and the
// safety net closed it when that turn ended (§app.teams/inbox-zero), so it is no longer open: the
// default list shows only open items, and `limit` lists the newest whatever their status.
async function t19() {
  const team = {
    name: "t19",
    objective: "trial team",
    defaults: { coordinator: false },
    members: [
      { role: "alpha", model: "trial/m1", prompt: '[call bash {"command":"sleep 8; echo ALPHA-READY"}] [call team_msg {"to":"beta","message":"MSG-T19 from alpha"}] [call team_ask {"question":"ASK-T19 from alpha"}]' },
      { role: "beta", model: "trial/m1", prompt: '[call team_msg {"to":"alpha","message":"HELLO-T19 from beta"}] [call bash {"command":"sleep 40; echo BETA-DONE"}]' },
    ],
  };
  const { path, s } = await newChat();
  const p = { path, s };
  const r = await turn(p, `[call team_create ${JSON.stringify(team)}]`);
  R.check(r.length === 1 && !r[0].message.isError, `t19: team_create answered (${resultText(r[0])})`);
  const alpha = await workerWith(path, "ALPHA-READY");
  const beta = await workerWith(path, "BETA-DONE");
  if (!R.check(alpha && beta, `t19: both members are worker chats (${workerRecords(path).map((x) => x.parent?.workerId).join(", ")})`)) return;
  const apid = chatPid(alpha.path);
  const bpid = chatPid(beta.path);
  R.check(apid && bpid && apid !== bpid && apid !== chatPid(path), `t19: each member in a process of its own (alpha ${apid}, beta ${bpid}, parent ${chatPid(path)})`);
  // The model's answer to alpha's bash result is its team_msg call: restart the server right then.
  await waitFor(() => mockLog(mock.log).some((e) => e.afterTool && /ALPHA-READY/.test(e.toolText ?? "")), 60000);
  s.close();
  await restart();
  R.check(chatPid(alpha.path) === apid && chatPid(beta.path) === bpid, "t19: both members kept their processes");
  await waitFor(() => userEntriesWith(beta.path, "MSG-T19") > 0, 90000);
  await sleep(8000);
  R.check(userEntriesWith(beta.path, "MSG-T19") === 1, `t19: alpha's message reached beta once (${userEntriesWith(beta.path, "MSG-T19")})`);
  R.check(askedBy(bpid).filter((e) => /MSG-T19/.test(e.userText ?? "")).length === 1, "t19: beta's model got the message once");
  await waitFor(() => deliveredTo(path, "ASK-T19") > 0, 60000);
  await sleep(3000);
  R.check(deliveredTo(path, "ASK-T19") === 1, `t19: alpha's team_ask reached the parent once (${deliveredTo(path, "ASK-T19")})`);
  // The parent reloads (an outside SIGTERM: a quiet reload): alpha's inbox still lists beta's message.
  const s2 = await chat(c, path);
  const ppid = chatPid(path);
  process.kill(ppid, "SIGTERM");
  await waitFor(() => chatPid(path) && chatPid(path) !== ppid, 30000);
  s2.close();
  const p3 = { path, s: await chat(c, path) };
  const list = await agentList(p3);
  const a = list.find((x) => x.name === "alpha");
  R.check(a && !a.restored, `t19: after the parent's reload alpha is live again, not restored (${JSON.stringify(a)?.slice(0, 160)})`);
  if (a) await turn(p3, `[call agent_steer ${JSON.stringify({ id: a.id, message: '[call team_inbox {"limit":20}] read your inbox' })}]`);
  const listed = () => askedBy(chatPid(alpha.path)).find((e) => e.afterTool && /HELLO-T19/.test(e.toolText ?? ""))?.toolText ?? "";
  await waitFor(() => listed(), 60000);
  const rows = listed().split("\n").filter((l) => /HELLO-T19/.test(l));
  R.check(rows.length === 1, `t19: after the parent's reload alpha's team_inbox still lists beta's earlier message, once (${JSON.stringify(rows)})`);
  R.check(rows.length === 1 && /\[addressed\]/.test(rows[0]) && /closed automatically/.test(rows[0]), `t19: beta's message is listed as closed automatically, its status kept through the reload (${rows[0]})`);
  noRpc("t19");
  p3.s.close();
}

// T19n: a monitor's wake_nudge set before the parent's reload fires after it (once). The team gets
// a coordinator and a monitor from team-defaults.json; the monitor's standing instruction is the
// nudge; a member keeps working so the nudge is not held.
async function t19n() {
  // A coordinator and a monitor, both pi on the mock. The subagent profile library is seeded from
  // the legacy files the first time a chat reads it: when it exists (an earlier check made it), its
  // default profile gets the teams setting; when not (t19n alone), the legacy team-defaults.json
  // does, and the seed copies it. Both are put back after.
  const teams = {
    coordinator: { enabled: true, role: "coordinator", primary: { backend: "pi", model: "trial/m1" }, fallback: null, instructions: "" },
    monitor: { enabled: true, role: "monitor", primary: { backend: "pi", model: "trial/m1" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: false, pausePct: 90, resumeMarginMinutes: 5 }, instructions: '[call wake_nudge {"action":"schedule","delay":"30s","reason":"NUDGE-T19"}]' },
    handover: { retireTimeoutMinutes: 10 },
  };
  const file = join(agent, "subagent-profiles.json");
  const legacy = join(agent, "team-defaults.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const defaultProfile = (lib) => lib.profiles.find((x) => x.id === readJson(join(agent, "subagent-profiles-default.json"))?.default) ?? lib.profiles[0];
  if (before !== null) {
    const lib = JSON.parse(before);
    defaultProfile(lib).teams = teams;
    writeFileSync(file, JSON.stringify(lib, null, 2));
  } else writeFileSync(legacy, JSON.stringify({ version: 1, ...teams }, null, 2));
  const restore = () => {
    if (before !== null) return writeFileSync(file, before);
    rmSync(legacy, { force: true });
    const lib = readJson(file);
    if (lib?.profiles?.length) {
      defaultProfile(lib).teams = null;
      writeFileSync(file, JSON.stringify(lib, null, 2));
    }
  };
  try {
    const team = { name: "t19n", objective: "trial team", members: [{ role: "worker", model: "trial/m1", prompt: '[call bash {"command":"sleep 75; echo WORKER-T19N"}]' }] };
    const { path, s } = await newChat();
    const r = await turn({ path, s }, `[call team_create ${JSON.stringify(team)}]`);
    R.check(r.length === 1 && !r[0].message.isError, `t19n: team_create answered (${resultText(r[0])})`);
    const mon = await workerWith(path, "NUDGE-T19");
    if (!R.check(mon, "t19n: the monitor is a worker chat")) return;
    await waitFor(() => readFileSync(mon.path, "utf8").includes('"wake_nudge"') && toolResults(mon.path).length > 0, 60000);
    const set = toolResults(mon.path).find((e) => e.message?.toolName === "wake_nudge");
    R.check(set && !set.message.isError, `t19n: the monitor scheduled its nudge (${resultText(set)})`);
    const ppid = chatPid(path);
    process.kill(ppid, "SIGTERM");
    await waitFor(() => chatPid(path) && chatPid(path) !== ppid, 30000);
    s.close();
    const s2 = await chat(c, path);
    await waitFor(() => userEntriesWith(mon.path, "Scheduled wakeup fired") > 0, 60000);
    await sleep(3000);
    R.check(userEntriesWith(mon.path, "Scheduled wakeup fired") === 1, `t19n: the nudge set before the parent's reload fired once after it (${userEntriesWith(mon.path, "Scheduled wakeup fired")})`);
    s2.close();
  } finally {
    restore();
  }
}

// T20: kill -9 of a worker's chat mid-run: the continue goes to it once, its run finishes, the parent
// gets one completion; a second kill during that resume is final ("stopped unexpectedly", the last
// output), never a second continue.
async function t20() {
  const { path, s } = await newChat();
  prompt(s, "[spawn 1 40 #t20a] start a worker");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  const w = await workerWith(path, "#t20a");
  if (!R.check(w, "t20: the server records the worker")) return;
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "t20a"), 60000);
  await sleep(3000);
  const pid1 = chatPid(w.path);
  process.kill(pid1, "SIGKILL");
  R.note(`t20: killed the worker's process ${pid1}`);
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "resume" && e.pid && e.pid !== pid1 && e.pid === chatPid(w.path)), 60000);
  const pid2 = chatPid(w.path);
  R.check(pid2 && pid2 !== pid1, `t20: the worker reopened in a new process (pid ${pid1} → ${pid2 || "none"})`);
  await waitFor(() => userEntriesWith(w.path, CRASH_RESUME_TEXT) >= 1, 20000, 200);
  R.check(userEntriesWith(w.path, CRASH_RESUME_TEXT) === 1, `t20: the crash "continue" went to the worker once (${userEntriesWith(w.path, CRASH_RESUME_TEXT)})`);
  const done = await workerDone(s, "trial-t20a");
  R.check(done?.outcome === "success", `t20: the resumed run finished (outcome ${done?.outcome}${done?.error ? `: ${done.error}` : ""})`);
  await sleep(5000);
  R.check(userEntriesWith(w.path, CRASH_RESUME_TEXT) === 1, `t20: the worker's crash "continue" is still in its file once after its run finished (${userEntriesWith(w.path, CRASH_RESUME_TEXT)})`);
  R.check(completions(path, w.path) === 1, `t20: the parent got one completion (${completions(path, w.path)})`);
  R.check(userEntriesWith(path, CRASH_RESUME_TEXT) === 0, "t20: the parent was sent no continue");
  R.check(resumeDecisions(w.path).length === 1, `t20: one auto_resume decision about the worker (${fmtDecisions(resumeDecisions(w.path))})`);
  // A second worker, killed twice: the second death (during the resume) is final.
  const from = s.got.length;
  prompt(s, "[spawn 1 40 #t20b] start another");
  await s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a second working worker", from);
  const w2 = await workerWith(path, "#t20b");
  if (!R.check(w2, "t20: the second worker is recorded")) return;
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "t20b"), 60000);
  await sleep(3000);
  // A chat process logs nothing while it runs well, so the trial writes a line into its log (the
  // detached driver's file; under systemd, the journal: skipped) before each kill.
  const unit = String(record(w2.path)?.unit ?? "").replace(/\.service$/, "");
  const logDirs = [join(sova, "chats", "logs"), join(sova, "chats", "children", "logs")];
  const logFile = () => logDirs.map((d) => join(d, `${unit}.log`)).find((x) => existsSync(x)) ?? null;
  const mark = (text) => {
    const file = logFile();
    if (file) writeFileSync(file, `${text}\n`, { flag: "a" });
    return file;
  };
  const marked = driver !== "systemd" && unit ? mark("TRIAL-MARK-ONE") : null;
  const k1 = chatPid(w2.path);
  process.kill(k1, "SIGKILL");
  await waitFor(() => chatPid(w2.path) && chatPid(w2.path) !== k1 && askedBy(chatPid(w2.path)).some((e) => e.tag === "resume"), 60000);
  await sleep(2000);
  const k2 = chatPid(w2.path);
  if (marked) mark("TRIAL-MARK-TWO");
  if (k2) process.kill(k2, "SIGKILL");
  R.note(`t20: killed the second worker twice (${k1}, then its resume ${k2})`);
  await s.until((m) => m.type === "workers" && m.workers?.some((x) => x.name === "trial-t20b" && x.outcome === "error"), 60000, "the second worker errors", from).catch(() => null);
  const failed = (await agentList({ path, s })).find((a) => a.name === "trial-t20b");
  R.check(failed?.status === "error" && /stopped unexpectedly/.test(failed?.error ?? ""), `t20: the second death is an error saying the process stopped unexpectedly (${failed?.status}: ${failed?.error?.slice(0, 200)})`);
  if (marked) {
    R.check(/Last output[\s\S]*TRIAL-MARK-TWO/.test(failed?.error ?? ""), `t20: the error carries the last output (the line written to its log before the second kill)`);
    // The first process's log survives the reopen (the line written before the first kill is kept).
    const kept = logDirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((x) => x.startsWith(unit)).map((x) => join(d, x)) : [])).filter((x) => readFileSync(x, "utf8").includes("TRIAL-MARK-ONE"));
    R.check(kept.length >= 1, `t20: the first process's log is kept across the crash reopen (${kept.map(baseName).join(", ") || "lost"})`);
  } else R.note("t20: no log file to mark (systemd journal); the last-output text is unit-tested");
  await sleep(8000);
  R.check(userEntriesWith(w2.path, CRASH_RESUME_TEXT) === 1 && resumeDecisions(w2.path).filter((a) => a.outcome === "ok").length <= 1, `t20: no second continue (${userEntriesWith(w2.path, CRASH_RESUME_TEXT)}; decisions ${fmtDecisions(resumeDecisions(w2.path))})`);
  noRpc("t20");
}

// T21: /explain, /compact-handoff and /btw each run in a chat process of their own; their model calls
// come from that process (none from the parent's), are counted in the usage ledger, and an /explain
// running across a parent reload settles once, never "interrupted".
async function t21() {
  const { path, s } = await newChat();
  const o = { path, s };
  await turn(o, "say ok");
  const sid = entries(path)[0]?.id;
  const ppid = chatPid(path);
  const usage0 = new Set(usageRecords().map((r) => r.key));
  // /explain, still running when the parent reloads.
  prompt(s, "/explain [explain 30] the trial topic");
  const ex = await workerOf(path, (r) => r.kind === "explain");
  R.check(ex, `t21: /explain started a hidden worker chat (${JSON.stringify(workerRecords(path).map((r) => r.kind))})`);
  await waitFor(() => mockLog(mock.log).some((e) => e.scenario === "explain"), 60000);
  const expid = ex && chatPid(ex.path);
  R.check(expid && expid !== ppid && expid !== srv.pid(), `t21: /explain's fork runs in a process of its own (${expid}, parent ${ppid})`);
  process.kill(ppid, "SIGTERM");
  await waitFor(() => chatPid(path) && chatPid(path) !== ppid, 30000);
  s.close();
  const s2 = await chat(c, path);
  const store = join(agent, "explanations");
  const metaOk = () => {
    try {
      return readdirSync(store).some((d) => existsSync(join(store, d, "index.html")) && /EXPLAIN-SUMMARY/.test(readFileSync(join(store, d, "meta.json"), "utf8")));
    } catch {
      return false;
    }
  };
  await waitFor(metaOk, 90000);
  R.check(metaOk(), "t21: /explain wrote its page and meta.json to the store");
  await sleep(5000);
  // The run's row is an explain-doc entry, appended at the start (status running) and again when
  // it settles: one settled entry, none interrupted or failed.
  const docs = entries(path).filter((e) => e.customType === "explain-doc").map((e) => e.data ?? {});
  R.check(docs.filter((d) => d.status !== "running").length === 1 && docs.every((d) => !["interrupted", "failed"].includes(d.status) && !d.error), `t21: the /explain row settled once, never interrupted (${docs.map((d) => d.status ?? (d.summary ? "settled" : "?")).join(", ")})`);
  // /compact-handoff, on enough history that pi has something to compact (F12: a short session is refused).
  await longHistory({ path, s: s2 });
  const p2 = chatPid(path);
  prompt(s2, "/compact-handoff [handoff 5]");
  const ho = await workerOf(path, (r) => r.kind === "handoff");
  R.check(ho && chatPid(ho.path) !== p2, `t21: /compact-handoff's fork is a hidden worker chat in a process of its own (${ho && chatPid(ho.path)})`);
  const note = join(agent, "compact-handoffs", `${sid}.md`);
  await waitFor(() => existsSync(note) && readFileSync(note, "utf8").includes("HANDOFF-NOTE"), 90000);
  R.check(existsSync(note) && readFileSync(note, "utf8").includes("HANDOFF-NOTE"), "t21: /compact-handoff saved the note");
  await waitFor(() => compactedAfterSaved(path), 60000);
  R.check(compactedAfterSaved(path), `t21: a compaction entry follows the run's "saved" row (${handoffRows(path).join(", ")})`);
  // /btw through the real slash command (headless in Sova): the answer lands as a btw-note.
  prompt(s2, "/btw [btw #t21a] a side question");
  const bt = await workerOf(path, (r) => r.kind === "btw");
  R.check(bt && chatPid(bt.path) && chatPid(bt.path) !== chatPid(path), `t21: /btw's side thread is a hidden worker chat in a process of its own (${bt && chatPid(bt.path)})`);
  const btwNote = (tag) => entries(path).some((e) => e.customType === "btw-note" && JSON.stringify(e).includes(`BTW-ANSWER ${tag}`));
  await waitFor(() => btwNote("t21a"), 60000);
  R.check(btwNote("t21a"), "t21: /btw's answer is persisted as a btw-note in the parent");
  // Who asked the model, and what was counted (before :summarize and :inject hand the thread to the
  // parent, whose own turn then reads it).
  const parents = new Set([ppid, p2, chatPid(path), srv.pid()]);
  const hidden = mockLog(mock.log).filter((e) => !e.event && ["explain", "handoff", "btw"].includes(e.scenario));
  R.check(hidden.length >= 3 && hidden.every((e) => e.pid && !parents.has(e.pid)), `t21: every hidden chat's model call came from a process other than the parent's and the server's (${hidden.map((e) => `${e.scenario}@${e.pid}`).join(", ")})`);
  await sleep(2000);
  const counted = usageRecords().filter((r) => !usage0.has(r.key) && r.parent === sid);
  R.check(counted.length >= hidden.length, `t21: the hidden chats' calls are in the usage ledger, attributed to the parent (${counted.length} records for ${hidden.length} calls; owners ${[...new Set(counted.map((r) => r.owner))].join(", ")})`);
  // /btw:summarize: a second, tool-less hidden chat; its summary goes to the parent once confirmed.
  let f = s2.got.length;
  prompt(s2, "/btw:summarize");
  const sum = await s2.until(isConfirm, 60000, "the summarize confirm", f).catch(() => null);
  R.check(sum, "t21: /btw:summarize asks to confirm the summary");
  if (sum) s2.send({ type: "ui_response", id: sum.id, value: true });
  const kinds = () => workerRecords(path).filter((r) => r.kind === "btw").length;
  await waitFor(() => userEntriesWith(path, "summary of a side conversation") > 0, 60000);
  R.check(kinds() >= 2 && userEntriesWith(path, "summary of a side conversation") === 1, `t21: the summary came from a second hidden chat (btw chats ${kinds()}) and reached the parent once`);
  await settled(s2, f, 60000).catch(() => {});
  // /btw:inject: the thread goes to the parent as one user message once confirmed.
  prompt(s2, "/btw [btw #t21b] another side question");
  await waitFor(() => btwNote("t21b"), 60000);
  f = s2.got.length;
  prompt(s2, "/btw:inject");
  const inj = await s2.until(isConfirm, 60000, "the inject confirm", f).catch(() => null);
  R.check(inj, "t21: /btw:inject asks to confirm");
  if (inj) s2.send({ type: "ui_response", id: inj.id, value: true });
  await waitFor(() => userEntriesWith(path, "side conversation I had for additional context") > 0, 60000);
  await sleep(2000);
  R.check(userEntriesWith(path, "side conversation I had for additional context") === 1 && userEntriesWith(path, "another side question") >= 1, "t21: /btw:inject sent the thread to the parent once");
  noRpc("t21");
  s2.close();
}

// T21c: hidden chats on a Claude Code model (the fake claude): /btw and /explain on the parent's
// claude-code-cli model record their usage through the Claude Code bridge, under the parent, as that
// hidden chat.
async function t21c() {
  const { path, s } = await newChat("claude-code-cli/claude-sonnet-5-5");
  const o = { path, s };
  await turn(o, "say ok");
  const sid = entries(path)[0]?.id;
  const before = new Set(usageRecords().map((r) => r.key));
  R.check(usageRecords().some((r) => r.owner === sid && /^claude/.test(r.src)), `t21c: the parent's own turn ran on the fake claude and was recorded (${usageRecords().filter((r) => r.owner === sid).map((r) => `${r.src}/${r.model}`).join(", ") || "none"})`);
  prompt(s, "/btw a side question on claude");
  const bt = await workerOf(path, (r) => r.kind === "btw");
  await waitFor(() => entries(path).some((e) => e.customType === "btw-note"), 90000);
  const note = entries(path).find((e) => e.customType === "btw-note");
  R.check(bt && /Fake answer/.test(JSON.stringify(note ?? "")), `t21c: /btw ran as a hidden chat on the fake claude and its answer is a btw-note (${JSON.stringify(note?.details?.answer ?? note?.content ?? null)?.slice(0, 100)})`);
  prompt(s, "/explain a claude topic");
  const ex = await workerOf(path, (r) => r.kind === "explain");
  R.check(ex, `t21c: /explain started a hidden chat (${ex?.spec?.model ?? "none"})`);
  // The hidden chats' own worker ids (explain: its run id, the topic's slug; btw: btw-contextual-…).
  const exId = ex?.parent?.workerId;
  const btId = bt?.parent?.workerId;
  await waitFor(() => usageRecords().some((r) => !before.has(r.key) && r.parent === sid && r.worker === exId), 90000);
  await sleep(3000);
  const fresh = usageRecords().filter((r) => !before.has(r.key) && r.parent === sid);
  const by = (id) => fresh.filter((r) => id && r.worker === id && /^claude/.test(r.src));
  R.note(`t21c: new usage under the parent: ${fresh.map((r) => `${r.worker}:${r.src}/${r.model} out ${r.output}`).join(", ") || "none"}`);
  R.check(by(btId).length >= 1, `t21c: /btw's Claude Code usage is recorded under the parent as its hidden chat ${btId} (${by(btId).length})`);
  R.check(by(exId).length >= 1, `t21c: /explain's Claude Code usage is recorded under the parent as its hidden chat ${exId} (${by(exId).length})`);
  noRpc("t21c");
  s.close();
}

/** A refusal of the prompt `clientId` among `frames` (an error frame, code refused, naming it), or null. */
const refusedFor = (frames, clientId) => frames.find((m) => m.type === "error" && m.code === "refused" && (m.clientId === clientId || JSON.stringify(m).includes(clientId))) ?? null;

// T21l (browser drive F10, F11):
//   F10: an idle parent's /btw answer reaches the open pane live, as an `append` of its row;
//   F11 (the drive's step): the parent idle, /btw sent and at once an outside SIGTERM to the parent's
//        process; the pane reconnects at once, as a page does, with no turn-error alert, and the answer
//        is in the file once and reaches the pane live.
async function t21l() {
  const label = "t21l";
  const { path, s } = await newChat();
  await turn({ path, s }, "say ok");
  const f0 = s.got.length;
  prompt(s, `/btw [btw #${label}] a side question`);
  const row = await s
    .until((m) => m.type === "append" && JSON.stringify(m.items ?? []).includes(`BTW-ANSWER ${label}`), 60000, "the btw row", f0)
    .catch(() => null);
  const saved = entries(path).some((e) => e.customType === "btw-note" && JSON.stringify(e).includes(`BTW-ANSWER ${label}`));
  R.check(row && saved, `${label} (F10): the /btw answer reached the open pane live (${row ? "append" : "no append"}; in the file: ${saved})`);
  {
    // The drive's step: the parent idle, /btw sent, and at once an outside SIGTERM to the parent's
    // process (an exit, not a reload).
    const pid1 = chatPid(path);
    const unit1 = record(path)?.unit;
    const alert = (m) => /not reachable|turn stopped with an error/i.test(JSON.stringify(m));
    const f1 = s.got.length;
    const cidX = prompt(s, `/btw [btw #${label}x] a side question across the exit`);
    process.kill(pid1, "SIGTERM");
    // The page's reconnect: at once, then its first commands, while the replacement may still be coming.
    await s.until((m) => m.type === "error" || m.type === "reloaded", 15000, "the pane hears of the reload", f0).catch(() => null);
    // A page keeps its socket until the server ends it: a refusal may follow the first notice.
    await waitFor(() => s.closed(), 5000, 100);
    s.close();
    const s2 = await chat(c, path, 60000);
    s2.send({ type: "set_model", ref: "trial/m1" });
    await waitFor(() => chatPid(path) && chatPid(path) !== pid1, 30000);
    await sleep(5000);
    const btwX = `BTW-ANSWER ${label}x`;
    // F14: the question sent as the process stops is never lost in silence: either it is answered (once,
    // shown live), or the pane gets it back: a refusal naming it, or (the architect's ruling) no send_ack
    // for it before an error:reloaded on the socket it was sent on, upon which ChatView restores every
    // unacked send into the draft (its own unit test covers the restore; a socket can't see a draft).
    // Acked and then lost, or answered twice, fails.
    const refusal = refusedFor([...s.got.slice(f1), ...s2.got], cidX);
    const acked = s.got.slice(f1).some((m) => m.type === "send_ack" && m.clientId === cidX);
    const reloadedOn = s.got.slice(f1).some((m) => m.type === "error" && m.code === "reloaded");
    // ...and only for a prompt never taken: a taken-but-unacked one would run and then be restored, asked
    // twice. Not taken: no model call carries it, and the closing process logged it refused.
    const asked = mockLog(mock.log).filter((e) => e.scenario && ((e.hashes ?? []).includes(`${label}x`) || (e.userText ?? "").includes(`#${label}x`))).length;
    const sid = entries(path)[0]?.id ?? "";
    const procLog = procLogOf(path, { unit: unit1, pid: pid1 });
    const refusedInLog = /came while closing: refused/.test(procLog);
    const restored = !acked && reloadedOn && asked === 0 && refusedInLog;
    const live = refusal ? null : await s2.until((m) => m.type === "append" && JSON.stringify(m.items ?? []).includes(btwX), 60000, "the btw row after the exit").catch(() => null);
    await sleep(2000);
    const notes = entries(path).filter((e) => e.customType === "btw-note" && JSON.stringify(e).includes(btwX)).length;
    const shown = live || s.got.slice(f1).some((m) => m.type === "append" && JSON.stringify(m.items ?? []).includes(btwX));
    R.check((notes === 1 && shown && !(!acked && reloadedOn)) || (notes === 0 && (refusal || restored)), `${label} (F10/F14 across the exit): the /btw sent as the process stopped is answered once and shown live (and acked, so ChatView never restores it: answered and restorable would ask it twice), refused back to the pane, or not taken and left unacked before error:reloaded (ChatView restores it) (${refusal ? `refused: ${JSON.stringify(refusal).slice(0, 120)}` : `in the file ${notes}×, ${shown ? "shown live" : "not shown"}, ${acked ? "acked" : "not acked"}, ${reloadedOn ? "error:reloaded" : "no error:reloaded"} on its socket, the model asked ${asked}×, ${refusedInLog ? "refused while closing (process log)" : "no refusal in the process log"}; pane frames after the send: ${[...s.got.slice(f1), ...s2.got].map((m) => m.type + (m.code ? `:${m.code}` : "") + (m.type === "ui_request" ? `(${m.request?.method ?? "?"}: ${String(m.request?.title ?? m.request?.statusKey ?? m.request?.widgetKey ?? "").slice(0, 80)}${m.request?.fireAndForget ? ", fire-and-forget" : ""})` : m.type === "error" ? `(${String(m.message ?? "").slice(0, 100)})` : "")).join(",").slice(0, 1200)}`})`);
    const bad = [...s.got.slice(f1), ...s2.got].filter(alert);
    R.check(chatPid(path) !== pid1 && bad.length === 0, `${label} (F11): after /btw and an exit of the idle parent's process the pane reconnects with no turn-error alert (pid ${pid1} → ${chatPid(path)}; ${bad.map((m) => JSON.stringify(m).slice(0, 160)).join(" | ") || "none"})`);
    await turn({ path, s: s2 }, "say ok after");
    s2.close();
  }
}

// T21r (F15) and T21rx (F14 and F15, either order): a pane attached to an idle chat on older code (set up so
// the automatic reload can't move it first: see the setup below), Reload now, and a prompt.
// t21r: the prompt is sent as the pane hears "reloading" (the rollout starting the replacement), before the
//   drain, which waits for the replacement: the drain finds the chat busy and is refused ("not quiet any
//   more"), the Reload now stays pending and the chat reloads as that reply ends, within seconds, never after
//   the attached pane's 5-min dwell. (A prompt before Reload now would only make it pending, with no drain.)
// t21rx: Reload now and the prompt at once, either order valid, the one that happened printed:
//   (a) the drain wins: the closing process refuses the prompt back to its pane (an error, code refused,
//       naming its clientId), the old process never ran it, the chat reloads, and the prompt, sent again
//       as the page does from the restored draft, runs once on the new process;
//   (b) the prompt wins: as t21r.
//   Lost (neither refused nor run), run twice, or no reload fails. (The refusal on a reload's close has no
//   unit test: F14's covers an operator close.)
async function t21r(variant = "f15") {
  const label = variant === "f15" ? "t21r" : "t21rx";
  // A reply of ~10 s (25 parts at the mock's 400 ms): a short one could end before the replacement booted, and
  // the drain then found the chat quiet again, so neither branch's race was run (seen on systemd).
  const text = `[long 25 #${label}d] DURING-RELOAD ${label}`;
  await teardown();
  await boot({ build: "trial-a" });
  const first = await newChat();
  const path = first.path;
  await turn(first, "say ok");
  const logFile = join(scratch, `server-${n}.log`);
  const logLen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0);
  const sid = entries(path)[0]?.id ?? "";
  // Setup: the chat older than the server, quiet, a pane attached. An unattended quiet chat reloads by
  // itself at once after a restart (that raced Reload now before), so a long reply holds it busy across the
  // restart and the pane reattaches while it runs; once the reply ends, the attached pane makes the
  // automatic rule wait its 5-min dwell. If the chat moved anyway, the setup is redone on new code.
  let s = first.s;
  let p = null;
  let pid1 = 0;
  let logFrom = 0;
  for (const [k, build] of [[1, "trial-b"], [2, "trial-c"]]) {
    prompt(s, `[long 40 #${label}h${k}] hold the chat across the restart`);
    await s.until(delta(/part 2\//), 30000, "the holding reply streams");
    pid1 = chatPid(path);
    logFrom = logLen();
    s.close();
    await restart({ [KNOBS.build]: build });
    p = await chat(c, path, 60000);
    await waitFor(() => mockLog(mock.log).some((e) => e.event === "done" && e.tag === `${label}h${k}`), 60000);
    await sleep(1500);
    // Held: the same process, its record still on the build before this restart's, and no reload of it logged since the offset.
    const since = readFileSync(logFile, "utf8").slice(logFrom).split("\n").filter((l) => l.includes(sid));
    const moved = chatPid(path) !== pid1 || record(path)?.build === build || since.some((l) => /reloading|reloaded into/.test(l));
    if (!moved) break;
    R.note(`${label}: setup ${k}: the chat reloaded by itself before Reload now (pid ${pid1} → ${chatPid(path)}); again on new code`);
    s = p;
    p = null;
  }
  if (!R.check(p, p ? `${label}: setup held: the chat is on the old build (${record(path)?.build}), quiet, its pane attached, not reloaded before Reload now` : `${label}: setup race: auto-reloaded before Reload now (twice)`)) {
    await teardown();
    await boot();
    return;
  }
  const from = p.got.length;
  // The window under test: from just before the restart that made the chat older (its reload lines).
  const chatLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").slice(logFrom) : "").split("\n").filter((l) => sid && l.includes(sid));
  p.send({ type: "reload_code" });
  if (variant === "f15") {
    const reloadingSeen = await p.until((m) => m.type === "code" && m.state === "reloading", 15000, "the reloading state", from).then(() => true, () => false);
    R.note(`${label}: the prompt is sent ${reloadingSeen ? "as the pane heard 'reloading' (the replacement starting)" : "after 15 s with no 'reloading' frame"}`);
  }
  const cid = prompt(p, text);
  // When the prompt's reply ended (if it ran) and when the chat moved to a new process.
  let tEnd = 0;
  let tRel = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !(tRel && (tEnd || refusedFor(p.got.slice(from), cid)))) {
    if (!tEnd && turnAssistants(path, text).length) tEnd = Date.now();
    if (!tRel && chatPid(path) && chatPid(path) !== pid1) tRel = Date.now();
    await sleep(250);
  }
  const p2 = await chat(c, path, 60000);
  await sleep(5000);
  const refusal = refusedFor([...p.got.slice(from), ...p2.got], cid);
  const ran = userEntriesWith(path, text);
  const askedOf = () => mockLog(mock.log).filter((e) => e.scenario && (e.userText ?? "").includes(text));
  const asked = askedOf().length;
  const lines = chatLog();
  R.note(`${label}: the chat's rollout lines: ${lines.map((l) => l.slice(0, 160)).join(" | ") || "none"}`);
  R.check(chatPid(path) && chatPid(path) !== pid1 && lines.some((l) => /reloaded into/.test(l)), `${label} (F15): the chat reloaded (pid ${pid1} → ${chatPid(path)}; 'reloaded into' in the log: ${lines.some((l) => /reloaded into/.test(l))})`);
  const promptWon = ran === 1 && !refusal;
  const drainWon = !!refusal;
  if (variant === "either") R.note(`${label}: order: ${drainWon ? "(a) the drain won: the prompt came back refused" : promptWon ? "(b) the prompt won: it was taken first" : "neither: the prompt was neither refused nor run once"}`);
  R.check((promptWon && asked === 1) || (drainWon && ran === 0 && asked === 0), `${label} (F14): a prompt sent as the reload began ran once or was refused back to the pane, never lost or doubled (${refusal ? `refused: ${JSON.stringify(refusal).slice(0, 120)}` : `in the file ${ran}×, the model asked ${asked}×`})`);
  if (promptWon) {
    const notQuiet = lines.some((l) => /not quiet any more/.test(l));
    R.check(notQuiet, `${label} (F15): the prompt was taken first: the drain was refused and logged ('not quiet any more': ${notQuiet})`);
    R.check(tEnd && tRel && tRel - tEnd <= 15000, `${label} (F15): the pending Reload now reloaded as the reply ended, no 5-min dwell (${tEnd && tRel ? `${Math.round((tRel - tEnd) / 1000)} s after the reply's end` : `reply end ${tEnd ? "seen" : "not seen"}, reload ${tRel ? "seen" : "not seen"} within 90 s`})`);
  } else if (variant === "f15") R.check(false, `${label} (F15): not exercised: the drain won the race (the prompt came back refused, F14's branch); the prompt is sent on the 'reloading' frame so the drain should find the chat busy`);
  else if (drainWon) {
    // (a): the refusal names the prompt, and the old process never ran it; the page sends it again from the
    // restored draft, and it runs once, on the new process.
    R.check(refusal.code === "refused" && (refusal.clientId === cid || JSON.stringify(refusal).includes(cid)), `${label} (F14): the closing process refused the prompt back to its pane by clientId (${JSON.stringify(refusal).slice(0, 120)})`);
    const newPid = chatPid(path);
    const before = askedOf().length;
    const f2 = p2.got.length;
    prompt(p2, text);
    await p2.until(isEvent("run.settled"), 60000, "the re-sent prompt settles", f2).catch(() => null);
    await sleep(1000);
    const again = askedOf().slice(before);
    R.check(userEntriesWith(path, text) === 1 && again.length === 1 && again[0].pid === newPid, `${label} (F14): sent again from the restored draft, it runs once, on the new process (in the file ${userEntriesWith(path, text)}×; asked ${again.length}× by ${again.map((e) => e.pid).join(", ") || "none"}, new process ${newPid})`);
  }
  p.close();
  p2.close();
  await teardown();
  await boot();
}

/** Three long turns: more than pi's keepRecentTokens (20k), so a compaction has something to summarize. */
async function longHistory(o, ms = 90000) {
  for (const i of [1, 2, 3]) await turn(o, `turn ${i}: ${"lorem ipsum dolor sit amet ".repeat(2500)}`, ms);
}
/** The /compact-handoff run rows of the session, oldest first. */
const handoffRows = (path) => entries(path).filter((e) => e.customType === "compact-handoff-run").map((e) => e.data?.status);
/** Whether a compaction entry comes after the newest "saved" run row. */
function compactedAfterSaved(path) {
  const es = entries(path);
  const saved = es.findLastIndex((e) => e.customType === "compact-handoff-run" && e.data?.status === "saved");
  return saved >= 0 && es.slice(saved + 1).some((e) => e.type === "compaction");
}

// T21h (stage 5, F8): /compact-handoff on a Claude Code parent (the fake claude): the fork resumes the
// parent's live CLI session (--resume --fork-session) as a hidden chat, its note is saved, the parent
// compacts, and the fork's usage is recorded under the parent as that hidden chat.
async function t21h() {
  const { path, s } = await newChat("claude-code-cli/claude-sonnet-5-5");
  const o = { path, s };
  // F12: on a short session the command refuses up front: a warning, no fork, no run row.
  await turn(o, "say ok", 90000);
  const f0 = s.got.length;
  prompt(s, "/compact-handoff too early");
  const early = await s.until((m) => m.type === "ui_request" && /nothing can be compacted yet/.test(m.request?.message ?? ""), 30000, "the refusal", f0).catch(() => null);
  await sleep(3000);
  R.check(early && !workerRecords(path).some((r) => r.kind === "handoff") && handoffRows(path).length === 0, `t21h: on a short session /compact-handoff refuses up front, with no fork and no row (${early ? "notice seen" : "no notice"}; forks ${workerRecords(path).filter((r) => r.kind === "handoff").length})`);
  // Enough history that pi has something to compact beyond the kept recent turns.
  await longHistory(o);
  const sid = entries(path)[0]?.id;
  const before = new Set(usageRecords().map((r) => r.key));
  const calls0 = (() => {
    try {
      return readFileSync(join(scratch, "fake-claude-calls.log"), "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  prompt(s, "/compact-handoff the fake focus");
  const ho = await workerOf(path, (r) => r.kind === "handoff", 60000);
  R.check(ho, `t21h: /compact-handoff started a hidden chat (${JSON.stringify(workerRecords(path).map((r) => r.kind))})`);
  const note = join(agent, "compact-handoffs", `${sid}.md`);
  await waitFor(() => existsSync(note), 90000);
  R.check(existsSync(note), `t21h: the note was saved (${existsSync(note) ? readFileSync(note, "utf8").slice(0, 120) : "none"})`);
  const runs = () => entries(path).filter((e) => e.customType === "compact-handoff-run").map((e) => e.data ?? {});
  await waitFor(() => runs().some((r) => r.status !== "running"), 60000);
  R.note(`t21h: run rows ${runs().map((r) => `${r.status}${r.error ? `: ${r.error}` : ""}`).join(", ")}`);
  R.check(runs().some((r) => r.status === "saved"), "t21h: the run's row settled as saved");
  await waitFor(() => compactedAfterSaved(path), 90000);
  R.check(compactedAfterSaved(path), `t21h: a compaction entry follows the run's "saved" row (${handoffRows(path).join(", ")})`);
  R.note(`t21h: the parent's notifications: ${s.got.filter((m) => m.type === "ui_request" && /notify/.test(m.request?.method ?? "")).map((m) => JSON.stringify(m.request).slice(0, 200)).join(" | ") || "none"}`);
  const calls = (() => {
    try {
      return readFileSync(join(scratch, "fake-claude-calls.log"), "utf8").split("\n").filter(Boolean).slice(calls0);
    } catch {
      return [];
    }
  })();
  R.note(`t21h: claude calls since the command: ${calls.map((l) => l.slice(0, 160)).join(" | ")}`);
  R.check(calls.some((l) => / --resume /.test(l) && / --fork-session/.test(l)), "t21h: the fork resumed the parent's CLI session (--resume --fork-session)");
  const hoId = ho?.parent?.workerId;
  await waitFor(() => usageRecords().some((r) => !before.has(r.key) && r.parent === sid && r.worker === hoId), 30000);
  const fresh = usageRecords().filter((r) => !before.has(r.key) && (r.parent === sid || r.owner === sid));
  R.note(`t21h: new usage under the parent: ${fresh.map((r) => `${r.worker ?? "(parent)"}:${r.src}/${r.model} out ${r.output}`).join(", ") || "none"}`);
  R.check(fresh.some((r) => hoId && r.worker === hoId && /^claude/.test(r.src)), `t21h: the fork's Claude Code usage is recorded under the parent as its hidden chat ${hoId}`);
  noRpc("t21h");
  s.close();
}

// T23: idle stop of a waiting worker: its process exits (no death), agent_list still says waiting,
// a steer reopens it and is answered once.
async function t23() {
  await teardown();
  await boot({ idleMs: 4000 });
  const { path, s } = await newChat();
  const o = { path, s };
  prompt(s, "[spawn 1 3 #t23w] start a short worker");
  const done = await workerDone(s, "trial-t23w", 60000);
  R.check(done?.outcome === "success", `t23: the worker finished its task (outcome ${done?.outcome})`);
  const w = await workerWith(path, "#t23w");
  if (!R.check(w, "t23: the server records the worker")) return;
  const pid1 = record(w.path)?.pid;
  await waitFor(() => !alive(pid1), 30000);
  R.check(pid1 && !alive(pid1), `t23: the waiting worker's process stopped when idle (${pid1})`);
  R.check(deaths(w.path).length === 0, "t23: an idle stop is no death");
  // The quiet parent closed too, its pane attached (§app.chat-processes/idle-stop): the pane
  // connects again to send, which opens it again.
  await reawaken(o);
  const me = (await agentList(o)).find((a) => a.name === "trial-t23w");
  R.check(me?.status === "waiting" && !me.restored, `t23: agent_list still says waiting (${me?.status}${me?.restored ? ", restored" : ""})`);
  if (me) await turn(o, `[call agent_steer ${JSON.stringify({ id: me.id, message: "STEER-T23 say ok" })}]`);
  await waitFor(() => asksWith("STEER-T23").length > 0, 60000);
  await sleep(4000);
  const pid2 = asksWith("STEER-T23")[0]?.pid;
  R.check(pid2 && pid2 !== pid1, `t23: the steer reopened the worker in a new process (${pid1} → ${pid2})`);
  R.check(asksWith("STEER-T23").length === 1 && userEntriesWith(w.path, "STEER-T23") === 1, "t23: the steer was answered once");
  s.close();
  await teardown();
  await boot();
}

/** Every live record (<agent>/sessions/live/*): its pid, session file, heartbeat and presence.llm. */
function liveDump() {
  const dir = join(agent, "sessions", "live");
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {}
  return files.map((f) => {
    const r = readJson(join(dir, f)) ?? {};
    const llm = r.presence?.llm;
    return `${f}: ${baseName(r.session?.sessionFile ?? r.sessionFile)} hb ${r.heartbeat} llm ${llm ? JSON.stringify({ producer: llm.producer, active: llm.active, folded: llm.folded }) : "-"}`;
  });
}

// T24: llm-inflight: during a worker's model call (its parent idle), /ws/watch?feed=llm counts it
// once, never twice through a live record; after the worker ends its tokens stay in the ring.
async function t24() {
  const feed = c.socket("/ws/watch?feed=llm");
  const seen = [];
  feed.ws.on("message", (d) => {
    try {
      const m = JSON.parse(String(d));
      if (m.type === "llm_local") seen.push({ at: Date.now(), count: m.local?.count, approximate: m.local?.approximate ?? 0, live: liveDump() });
    } catch {}
  });
  await feed.opened;
  const t0 = Date.now();
  const { path, s } = await newChat();
  prompt(s, "[spawn 1 30 #t24w] start a worker");
  await settled(s, 0, 60000);
  await waitFor(() => mockLog(mock.log).some((e) => e.tag === "t24w"), 60000);
  const from = feed.got.length;
  await sleep(6000);
  // Exact calls only: a `claude -p` one-shot (the parent's topic outline, on the fake claude) is
  // counted approximate, spawn to exit.
  const exact = (m) => (m.local?.count ?? 0) - (m.local?.approximate ?? 0);
  const counts = feed.got.slice(from).filter((m) => m.type === "llm_local").map(exact);
  const last = exact(feed.got.filter((m) => m.type === "llm_local").at(-1));
  R.note(`t24: counts while the worker's call runs: ${counts.join(", ") || "(no change)"}; latest ${last}`);
  R.check(last === 1 && counts.every((n) => n <= 1), `t24: the worker's one call is counted once (exact calls: latest ${last}, max ${Math.max(0, ...counts)})`);
  const oneShots = (() => {
    try {
      return readFileSync(join(scratch, "fake-claude-calls.log"), "utf8").split("\n").filter((l) => / -p( |$)/.test(l));
    } catch {
      return [];
    }
  })();
  const status = await c.api("/api/settings/claude-status").catch((e) => ({ error: String(e.message ?? e) }));
  R.check(/fake/i.test(status?.version ?? ""), `t24: the server's claude is the fake one (${JSON.stringify(status).slice(0, 160)})`);
  if (seen.some((x) => x.approximate)) R.check(oneShots.length >= 1, `t24: the approximate one-shot (the parent's topic outline) ran on the fake claude (${oneShots.length} -p calls logged by its shim${oneShots.length ? `: ${oneShots.at(-1).slice(0, 100)}` : ""})`);
  else R.note(`t24: no approximate one-shot this time; -p calls on the fake: ${oneShots.length}`);
  // What was asked of the model meanwhile, beside each count over one: who else had a call open.
  const asks = mockLog(mock.log).filter((e) => e.scenario && Date.parse(e.at) >= t0).map((e) => `${e.at.slice(11, 23)} pid ${e.pid} ${e.scenario}${e.tag ? ` #${e.tag}` : ""}${e.afterTool ? " (after a tool)" : ""}`);
  R.note(`t24: counts over time (server ${srv.pid()}, parent ${chatPid(path)}): ${seen.map((x) => `${new Date(x.at).toISOString().slice(11, 23)}=${x.count}${x.approximate ? ` (${x.approximate} approximate)` : ""}`).join(", ")}`);
  for (const x of seen) R.note(`t24: live at ${new Date(x.at).toISOString().slice(11, 23)} (count ${x.count}): ${x.live.join(" | ") || "none"}`);
  R.note(`t24: model calls since the feed opened: ${asks.join("; ")}`);
  const done = await workerDone(s, "trial-t24w");
  R.check(done?.outcome === "success", `t24: the worker finished (outcome ${done?.outcome})`);
  const sum = (m) => (m?.local?.tokens?.out ?? []).reduce((a, b) => a + b, 0);
  await sleep(3000);
  const after = sum(feed.got.filter((m) => m.type === "llm_local").at(-1));
  const w = await workerWith(path, "#t24w");
  const wid = (await agentList({ path, s })).find((a) => a.name === "trial-t24w")?.id;
  if (wid) await turn({ path, s }, `[call agent_kill ${JSON.stringify({ id: wid })}]`);
  await waitFor(() => w && !chatPid(w.path), 20000);
  await sleep(4000);
  const kept = sum(feed.got.filter((m) => m.type === "llm_local").at(-1));
  R.check(after > 0 && kept >= after, `t24: the worker's tokens stay in the ring after its process ended (${after} → ${kept})`);
  feed.close();
  s.close();
}

// ── stage 5 (stage5-design.md) ──────────────────────────────────────────────────────────────────

// T25 (stage5-design.md §A-3, G-tests): per-chat code generations. The server runs from a scratch git
// clone of the trial's commit, so the clone can be edited while chats run. A marker in a tool
// description of a pi-config extension (look_at_image's, vision-delegate) shows which code a chat's
// extensions came from: the mock logs the markers each request's tools carry.
//   (a) a chat's process runs from <code root>/<id>; (f) its model call is counted once on the llm feed;
//   (b) the clone edited, no restart: a runtime rebuild (a mode switch) in the running chat and a new
//       chat both keep the old marker;
//   (c) a restart on the edited clone: two quiet unattended chats reload one after the other (the
//       rollout log), each then shows the new marker and no badge; (g) a worker spawned meanwhile by
//       an attached chat still on the older code runs on the current one, its extensions mapped there;
//   (e) once no record names the first generation it is collected;
//   (h) a chat reloaded in an earlier server life reloads again into a unit of its own;
//   (d) a restart whose new code fails to boot (SOVA_CHAT_TEST_FAIL_BOOT=<its id>): the first
//       replacement fails, the rollout halts, the next chat is never tried, every chat keeps its
//       process, one shows "failed"; (e) the generation those chats run is kept meanwhile.
const T25_FILE = "pi-config/extensions/vision-delegate/index.ts";
const T25_ANCHOR = '"Ask a vision model about an image file on disk';
async function t25() {
  // The clone, at the commit the trial runs (a snapshot's .trial-rev), from the repository it came from.
  const src = existsSync(join(ROOT, ".trial-repo")) ? readFileSync(join(ROOT, ".trial-repo"), "utf8").trim() : ROOT;
  const rev = existsSync(join(ROOT, ".trial-rev")) ? readFileSync(join(ROOT, ".trial-rev"), "utf8").trim() : execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const clone = join(scratch, "t25-clone");
  rmSync(clone, { recursive: true, force: true });
  const git = (...a) => execFileSync("git", ["-C", clone, "-c", "user.name=trial", "-c", "user.email=trial@example.invalid", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["clone", "-q", "--no-checkout", src, clone], { stdio: "pipe" });
  git("checkout", "-q", "--detach", rev);
  symlinkSync(realpathSync(join(ROOT, "node_modules")), join(clone, "node_modules"));
  const mark = (m, commit) => {
    const f = join(clone, T25_FILE);
    const text = readFileSync(f, "utf8").replace(/"GEN-MARK-\w+ /, '"');
    if (!text.includes(T25_ANCHOR)) throw new Error(`${T25_FILE} no longer holds ${T25_ANCHOR}`);
    writeFileSync(f, text.replace(T25_ANCHOR, `"GEN-MARK-${m} ${T25_ANCHOR.slice(1)}`));
    if (commit) git("commit", "-q", "-am", `trial: GEN-MARK-${m}`);
  };
  mark("one", true);
  // The agent dir's links into pi-config name the clone's for this check (put back at its end).
  const relink = (from, to) => {
    for (const d of [agent, join(agent, "extensions")])
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        let target;
        try {
          target = readlinkSync(p);
        } catch {
          continue;
        }
        if (!target.startsWith(`${from}/pi-config/`)) continue;
        unlinkSync(p);
        symlinkSync(to + target.slice(from.length), p);
      }
  };
  const rootReal = realpathSync(ROOT);
  relink(rootReal, clone);
  try {
    // The copies go on the checkout's filesystem (hardlinked node_modules, cloned files), never in the
    // scratch on tmpfs (~350 MB a copy there): in the worktree's node_modules, which Git ignores, bun
    // test never walks and the sandbox can write (the copy of node_modules skips it). This server's
    // alone, so it collects there (SOVA_CHAT_CODE_GC=on); removed at the end.
    const codeDir = join(ROOT, "node_modules", ".cache", `sova-chat-code-${tag}`);
    rmSync(codeDir, { recursive: true, force: true });
    const codes = () => {
      try {
        return readdirSync(codeDir).join(", ");
      } catch {
        return "no code root";
      }
    };
    const runsFrom = (pid) => {
      try {
        return /\S*server\/chat-runtime\/main\.ts/.exec(cmdOf(pid))?.[0] ?? "";
      } catch {
        return "";
      }
    };
    const genOf = (pid) => {
      const m = runsFrom(pid);
      return m.startsWith(`${codeDir}/`) ? (/^([^/]+)\/server\/chat-runtime\/main\.ts$/.exec(m.slice(codeDir.length + 1))?.[1] ?? null) : null;
    };
    /** Markers the mock saw in the tools of requests made by `pid` (since mock log line `from`). */
    const marksBy = (pid, from = 0) => [...new Set(mockLog(mock.log).slice(from).filter((e) => e.scenario && e.pid === pid).flatMap((e) => e.marks ?? []))];
    const rollLines = () => {
      try {
        return readFileSync(join(scratch, `server-${n}.log`), "utf8").split("\n").filter((l) => l.includes("[chat-rollout]"));
      } catch {
        return [];
      }
    };
    const waitMoved = (path, oldPid, ms = 90000) => waitFor(() => chatPid(path) && chatPid(path) !== oldPid, ms);
    const grace = { SOVA_CHAT_CODE_GRACE_MIN: "0.05", [KNOBS.codeRoot]: codeDir, [KNOBS.codeGc]: "on" };
    await teardown();
    await boot({ root: clone, build: null, extra: grace });
    // The copy is made while the server already answers (chats wait, the HTTP server doesn't).
    let health = null;
    await waitFor(async () => (health = await c.api("/api/health").catch(() => null))?.chatHost?.code, 60000);
    R.check(health?.chatHost?.code === "copy", `t25: the server's chats run from a copy of its code (health chatHost ${JSON.stringify(health?.chatHost)?.slice(0, 160)})`);

    // (a), (f)
    const feed = c.socket("/ws/watch?feed=llm");
    await feed.opened;
    const A = await newChat();
    const m0 = mockLog(mock.log).length;
    prompt(A.s, "[long 16 #t25f] a reply");
    await A.s.until(delta(/part 6\//), 30000, "A streams");
    const exact = (m) => (m.local?.count ?? 0) - (m.local?.approximate ?? 0);
    const counts = feed.got.filter((m) => m.type === "llm_local").map(exact);
    await settled(A.s, 0, 60000);
    feed.close();
    const pidA = chatPid(A.path);
    const gen1 = record(A.path)?.build;
    R.check(gen1 && genOf(pidA) === gen1 && existsSync(join(codeDir, gen1, ".complete")), `t25(a): the chat runs from <code root>/<id> (${runsFrom(pidA) || "no main.ts"}; build ${gen1})`);
    // The copy's files as made (its directories stay writable, so the copy can go): checked again after
    // chats have run on it, at (c).
    const filesOf = (dir) => {
      const out = [];
      const walk = (d, rel) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (!rel && e.name === "node_modules") continue;
          if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
          else out.push(`${rel}${e.name}`);
        }
      };
      try {
        walk(dir, "");
      } catch {}
      return new Set(out);
    };
    const gen1Files = filesOf(join(codeDir, gen1));
    R.check(marksBy(pidA, m0).join() === "GEN-MARK-one", `t25(a): its extensions are the copy's (markers ${marksBy(pidA, m0).join(", ") || "none"})`);
    R.check(counts.length && Math.max(...counts) === 1, `t25(f): its model call was counted once on the llm feed (exact counts ${counts.join(", ") || "none"})`);

    // (b)
    mark("two", false);
    const m1 = mockLog(mock.log).length;
    const switched = await post(`/api/mode?path=${encodeURIComponent(A.path)}`, { mode: "delegate" }).then(() => "ok", (e) => String(e.message ?? e));
    await turn(A, "say ok after the mode switch");
    R.check(chatPid(A.path) === pidA && marksBy(pidA, m1).join() === "GEN-MARK-one", `t25(b): a runtime rebuild (mode switch ${switched}) in the running chat keeps the old code (markers ${marksBy(pidA, m1).join(", ") || "none"})`);
    await post(`/api/mode?path=${encodeURIComponent(A.path)}`, { mode: "normal" }).catch(() => {});
    const B = await newChat();
    await turn(B, "say ok");
    const pidB = chatPid(B.path);
    R.check(record(B.path)?.build === gen1 && marksBy(pidB, m1).join() === "GEN-MARK-one", `t25(b): a chat started after the edit starts on the server's code, not the clone's (build ${record(B.path)?.build}, markers ${marksBy(pidB, m1).join(", ") || "none"})`);
    const C = await newChat();
    await turn(C, "say ok");
    const pidC = chatPid(C.path);
    B.s.close();
    C.s.close();

    const grown = [...filesOf(join(codeDir, gen1))].filter((p) => !gen1Files.has(p));
    R.check(gen1Files.size > 0 && grown.length === 0, `t25: no file appeared in the copy while chats ran on it (${gen1Files.size} files; new: ${grown.slice(0, 8).join(", ") || "none"}${grown.length > 8 ? ` +${grown.length - 8}` : ""})`);
    // (c), (g): A stays attached (it waits for its dwell), B and C are quiet and unattended.
    const r0 = rollLines().length;
    await restart();
    // A's page comes straight back, as a browser does: attached, it waits for its dwell.
    A.s.close();
    const A2 = await chat(c, A.path);
    await waitFor(() => record(B.path)?.build && record(B.path).build !== gen1, 120000);
    const gen2 = record(B.path)?.build;
    await waitMoved(C.path, pidC);
    await sleep(3000);
    const lines = rollLines().slice(r0);
    R.note(`t25(c): rollout log: ${lines.map((l) => l.replace(/.*\[chat-rollout\] /, "")).join(" | ")}`);
    // One at a time: each "reloading" is followed by its own end before the next "reloading".
    let open = null;
    let overlap = false;
    for (const l of lines) {
      const m = /\] (\S+): (reloading|reloaded|could not start)/.exec(l);
      if (!m) continue;
      if (m[2] === "reloading") {
        if (open) overlap = true;
        open = m[1];
      } else if (open === m[1]) open = null;
    }
    const reloaded = lines.filter((l) => / reloaded into /.test(l)).length;
    // Each end has its start in the log (else "never overlapping" would hold for want of starts).
    const starts = lines.filter((l) => /: reloading/.test(l)).length;
    const ends = reloaded + lines.filter((l) => /could not start/.test(l)).length;
    R.check(gen2 && gen2 !== gen1 && reloaded >= 2 && starts === ends && !overlap, `t25(c): two quiet chats reloaded one after the other, never overlapping (${reloaded} reloads, ${starts} starts for ${ends} ends, onto ${gen2})`);
    const pidB2 = chatPid(B.path);
    const pidC2 = chatPid(C.path);
    const m2 = mockLog(mock.log).length;
    const B2 = await chat(c, B.path);
    const C2 = await chat(c, C.path);
    await turn({ path: B.path, s: B2 }, "say ok on new code");
    await turn({ path: C.path, s: C2 }, "say ok on new code");
    await sleep(1000);
    R.check(genOf(pidB2) === gen2 && genOf(pidC2) === gen2 && marksBy(pidB2, m2).join() === "GEN-MARK-two" && marksBy(pidC2, m2).join() === "GEN-MARK-two", `t25(c): each reloaded chat runs the new code (markers B ${marksBy(pidB2, m2).join(",") || "none"}, C ${marksBy(pidC2, m2).join(",") || "none"})`);
    R.check([...codeMsgs(B2), ...codeMsgs(C2)].every((m) => m.state !== "older"), "t25(c): neither shows the older-code badge");
    B2.close();
    C2.close();
    // (g): A, attached through the restart, is still on gen1; its worker starts on gen2.
    R.check(chatPid(A.path) === pidA && record(A.path)?.build === gen1, `t25(g): the attached chat is still on the older code (${record(A.path)?.build})`);
    const m3 = mockLog(mock.log).length;
    // A worker with a Sova extension named (through the agent dir's link, so the clone's pi-config): it
    // must load from the worker's own copy.
    const vd = join(agent, "extensions", "vision-delegate", "index.ts");
    prompt(A2, `[call agent_spawn ${JSON.stringify({ prompt: "[long 6 #t25g] worker", model: "trial/m1", name: "trial-t25g", extensions: [vd] })}]`);
    const w = await workerWith(A.path, "#t25g");
    const wpid = w && (await waitFor(() => chatPid(w.path), 30000), chatPid(w.path));
    await waitFor(() => mockLog(mock.log).slice(m3).some((e) => e.tag === "t25g"), 60000);
    R.check(wpid && genOf(wpid) === gen2, `t25(g): the worker runs on the current code (${runsFrom(wpid) || "no process"})`);
    R.check(wpid && marksBy(wpid, m3).join() === "GEN-MARK-two", `t25(g): the worker's extensions are mapped to that code (markers ${marksBy(wpid, m3).join(", ") || "none"})`);
    R.check((await workerDone(A2, "trial-t25g"))?.outcome === "success", "t25(g): the worker ran to its end");

    // (e): A reloads (Reload now) onto gen2; then no record names gen1, and the collection after the
    // rollout's batch removes it.
    A2.send({ type: "reload_code" });
    await waitMoved(A.path, pidA);
    await waitFor(() => !existsSync(join(codeDir, gen1)), 60000);
    R.check(!existsSync(join(codeDir, gen1)) && existsSync(join(codeDir, gen2)), `t25(e): the first generation was collected once no chat ran it (${codes()})`);
    A2.close();

    // (h): a chat reloaded in an earlier server life reloads again: B runs a replacement unit of the last
    // life; after new code and a restart its new replacement never takes the live one's unit or socket
    // (it once did: -r<n> restarted per life). The others move too, each at its quiet moment.
    // B goes first (the collision needed it): the idle worker is stopped and A and C are mid-reply across
    // the restart, so B is the only quiet chat when the new server's rollout starts.
    const oa = await chat(c, A.path);
    const wid = (await agentList({ path: A.path, s: oa })).find((a) => a.name === "trial-t25g")?.id;
    if (wid) await turn({ path: A.path, s: oa }, `[call agent_kill ${JSON.stringify({ id: wid })}]`);
    await waitFor(() => !w || !chatPid(w.path), 20000);
    const oc = await chat(c, C.path);
    prompt(oa, "[long 40 #t25ha] a long reply");
    prompt(oc, "[long 40 #t25hc] a long reply");
    await oa.until(delta(/part 3\//), 30000, "A streams");
    await oc.until(delta(/part 3\//), 30000, "C streams");
    mark("twob", true);
    const genB = git("rev-parse", "HEAD");
    const unitB = record(B.path)?.unit;
    const pidB3 = chatPid(B.path);
    const rh = rollLines().length;
    await restart();
    oa.close();
    oc.close();
    await waitMoved(B.path, pidB3);
    await sleep(2000);
    const hl = rollLines().slice(rh).map((l) => l.replace(/.*\[chat-rollout\] /, ""));
    R.note(`t25(h): rollout log: ${hl.join(" | ")}`);
    const firstId = /^(\S+): reloading/.exec(hl.find((l) => /: reloading/.test(l)) ?? "")?.[1];
    R.check(firstId && firstId === record(B.path)?.chatId, `t25(h): B was the first chat the new server reloaded (${firstId})`);
    R.check(chatPid(B.path) && chatPid(B.path) !== pidB3 && record(B.path)?.build === genB && record(B.path)?.unit !== unitB && !hl.some((l) => /could not start/.test(l)), `t25(h): a chat reloaded in an earlier server life reloads again into a unit of its own (${unitB} → ${record(B.path)?.unit}, pid ${pidB3} → ${chatPid(B.path)})`);
    // A and C move once their replies end; (d) starts from every chat on genB.
    await waitFor(() => [A, C].every((x) => record(x.path)?.build === genB && chatPid(x.path)), 120000);

    // (d): new code that fails to boot. Its id is the clone's next one: committed, so the commit.
    mark("three", true);
    const gen3 = git("rev-parse", "HEAD");
    const pids = { A: chatPid(A.path), B: chatPid(B.path), C: chatPid(C.path) };
    const r1 = rollLines().length;
    await restart({ [KNOBS.failBoot]: gen3 });
    await sleep(45000);
    // From this server's first line naming the failing code (a reload of the last life may still log its end).
    const all = rollLines().slice(r1).map((l) => l.replace(/.*\[chat-rollout\] /, ""));
    const dl = all.slice(Math.max(0, all.findIndex((l) => l.includes(gen3))));
    R.note(`t25(d): rollout log: ${dl.join(" | ")}`);
    const tried = dl.filter((l) => /: reloading/.test(l)).length;
    R.check(tried === 1 && !dl.some((l) => / reloaded into /.test(l)) && dl.some((l) => l.includes(`could not start on new code (${gen3})`)), `t25(d): the first replacement failed, the rollout halted, no other chat was tried (${tried} tried)`);
    R.check(chatPid(A.path) === pids.A && chatPid(B.path) === pids.B && chatPid(C.path) === pids.C, `t25(d): every chat keeps its process (${JSON.stringify(pids)} → A ${chatPid(A.path)}, B ${chatPid(B.path)}, C ${chatPid(C.path)})`);
    const panes = await Promise.all([A, B, C].map((x) => chat(c, x.path)));
    await sleep(2000);
    const states = panes.map((p) => codeMsgs(p).at(-1)?.state);
    // The chat the rollout tried first (any chat with a process, a worker too) shows "failed"; the rest "older".
    const failedId = /^(\S+): could not start/.exec(dl.find((l) => /could not start/.test(l)) ?? "")?.[1];
    const want = [A, B, C].map((x) => (record(x.path)?.chatId === failedId ? "failed" : "older"));
    R.check(states.join() === want.join(), `t25(d): the chat that failed shows "failed", the others "older" (${states.join(", ")}; failed chat ${failedId})`);
    for (const p of panes) p.close();
    R.check(existsSync(join(codeDir, genB)), `t25(e): the generation the chats run is kept while the new code fails (${codes()})`);
    await teardown();
  } finally {
    relink(clone, rootReal);
    rmSync(join(ROOT, "node_modules", ".cache", `sova-chat-code-${tag}`), { recursive: true, force: true });
  }
  await boot();
}

// T27 (stage5-design.md Part B/C, B1): a broken deploy. The server runs from a scratch git clone (each
// empty commit a new code id) on a code root of its own.
//   (1) no last good copy yet and the current code fails to start: a new chat's open is refused with
//       the reason;
//   (2) a chat ran on code A (A is last good); code B fails to start: a new chat opens on A and shows
//       the failure banner, and the chat already on A keeps its process;
//   (3) a reload whose open fails relaunches the chat on its previous code. It needs a knob that fails
//       an open (asked of core); without it this part is noted, not run.
async function t27() {
  const src = existsSync(join(ROOT, ".trial-repo")) ? readFileSync(join(ROOT, ".trial-repo"), "utf8").trim() : ROOT;
  const rev = existsSync(join(ROOT, ".trial-rev")) ? readFileSync(join(ROOT, ".trial-rev"), "utf8").trim() : execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const clone = join(scratch, "t27-clone");
  const codeDir = join(ROOT, "node_modules", ".cache", `sova-chat-code-t27-${tag}`);
  rmSync(clone, { recursive: true, force: true });
  rmSync(codeDir, { recursive: true, force: true });
  const git = (...a) => execFileSync("git", ["-C", clone, "-c", "user.name=trial", "-c", "user.email=trial@example.invalid", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["clone", "-q", "--no-checkout", src, clone], { stdio: "pipe" });
  git("checkout", "-q", "--detach", rev);
  symlinkSync(realpathSync(join(ROOT, "node_modules")), join(clone, "node_modules"));
  const next = (m) => (git("commit", "-q", "--allow-empty", "-m", `trial: ${m}`), git("rev-parse", "HEAD"));
  const code = { [KNOBS.codeRoot]: codeDir, [KNOBS.codeGc]: "on" };
  const codeFrames = (s) => s.got.filter((m) => m.type === "code").map((m) => m.state);
  try {
    // (1)
    const genA = next("A");
    await teardown();
    await boot({ root: clone, build: null, extra: { ...code, [KNOBS.failBoot]: genA } });
    const refused = await newChat().then(
      (x) => (x.s.close(), null),
      (e) => String(e.message ?? e),
    );
    R.check(refused && /didn.t start|did not start|could not start/i.test(refused), `t27(1): with no last good copy, a chat on code that fails to start is refused with the reason (${refused?.slice(0, 200) ?? "it opened"})`);
    // (2)
    await teardown();
    await boot({ root: clone, build: null, extra: code });
    const X = await newChat();
    await turn(X, "say ok");
    const pidX = chatPid(X.path);
    R.check(record(X.path)?.build === genA, `t27(2): a chat runs on code A (${record(X.path)?.build})`);
    X.s.close();
    const genB = next("B");
    await restart({ [KNOBS.failBoot]: genB });
    const Y = await newChat();
    await turn(Y, "say ok on a broken deploy");
    await sleep(2000);
    R.check(record(Y.path)?.build === genA && chatPid(Y.path), `t27(2): a new chat opens on the last good code A while B fails (${record(Y.path)?.build})`);
    R.check(codeFrames(Y.s).includes("failed"), `t27(2): it shows the failure banner (code frames ${JSON.stringify(codeFrames(Y.s))})`);
    R.check(chatPid(X.path) === pidX, `t27(2): the chat already on A keeps its process (${pidX} → ${chatPid(X.path)})`);
    Y.s.close();
    // (3) A reload whose open fails: new code C boots but refuses every open (SOVA_CHAT_TEST_FAIL_OPEN). Reload
    // now on the quiet chat X (on A), its pane attached, moves it toward C; C's open fails, and X starts again on the code it ran
    // before, A, with the failure shown; no death, and it answers.
    const genC = next("C");
    const logFile = join(scratch, `server-${n}.log`);
    const logFrom = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
    const xid = entries(X.path)[0]?.id ?? "";
    await restart({ [KNOBS.failBoot]: "", [KNOBS.failOpen]: genC });
    const X3 = await chat(c, X.path, 60000);
    const pidX3 = chatPid(X.path);
    // With a pane attached the automatic path waits the dwell (5 min): Reload now takes the same
    // failed-open → restart-on-old-code path at once (core-2).
    X3.send({ type: "reload_code" });
    const tried = () => {
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(logFrom) : "";
      return log.split("\n").filter((l) => xid && l.includes(xid) && /chat-rollout|reload/i.test(l));
    };
    await waitFor(() => codeFrames(X3).includes("failed") || tried().some((l) => /could not|fail|previous|last good/i.test(l)), 90000);
    await sleep(3000);
    R.note(`t27(3): X's rollout lines: ${tried().map((l) => l.slice(0, 200)).join(" | ") || "none"}`);
    R.check(tried().length > 0 || codeFrames(X3).length > 0, `t27(3): Reload now tried to move the quiet chat to C (code frames ${JSON.stringify(codeFrames(X3))})`);
    const X4 = await chat(c, X.path, 60000).catch(() => null);
    const Xo = { path: X.path, s: X4 ?? X3 };
    await turn(Xo, "say ok after a failed open");
    const recX = record(X.path);
    R.check(recX?.build === genA && chatPid(X.path), `t27(3): after C's open failed, X runs on the code it ran before, A (build ${recX?.build}, pid ${pidX} → ${pidX3} → ${chatPid(X.path) || "none"})`);
    R.check([...codeFrames(X3), ...(X4 ? codeFrames(X4) : [])].includes("failed"), `t27(3): X's pane shows the failure (code frames ${JSON.stringify([...codeFrames(X3), ...(X4 ? codeFrames(X4) : [])])})`);
    R.check(deaths(X.path).length === 0, `t27(3): no death recorded for X (${deaths(X.path).length})`);
    X3.close();
    X4?.close?.();
  } finally {
    await teardown();
    rmSync(codeDir, { recursive: true, force: true });
  }
  await boot();
}

// Trestart (Part C, C1): a restart with no busy gate. A scratch project whose slot 0 adopts the trial's
// own stand-in unit (never sova-runtime.service); while a chat is mid-reply and another's worker runs,
// the operator's confirmed Apply on slot 0 is not refused as busy, schedules the unit's restart in a few
// seconds, and the server restarts then: both chats and the worker keep their processes, the reply ends
// once, the worker's completion arrives once, nothing is resumed and no restart-gate log is written.
async function trestart() {
  if (mode !== "unit") return R.note("trestart: not run: Apply restarts the adopted unit, so it needs --mode unit");
  const root = join(scratch, "trestart-proj");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".sova"), { recursive: true });
  const port = Number(new URL(base).port);
  // The contract wants a <name>.service everywhere; on darwin Sova strips it for the launchd label.
  const adopted = srv.unit.endsWith(".service") ? srv.unit : `${srv.unit}.service`;
  const def = {
    version: 1,
    slots: { cap: 2 },
    services: { server: { cmd: ["node", "-e", "setInterval(()=>{},1e9)"], ports: { http: { base: (await freePort()) + 10, stride: 10 } }, ready: { http: "http", path: "/api/health" }, adopt: { unit: adopted, ports: { http: port } } } },
  };
  writeFileSync(join(root, ".sova", "project.json"), JSON.stringify(def));
  const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=trial", "-c", "user.email=trial@example.invalid", ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "trestart fixture");
  const verb = (v, body) => fetch(`${base}/api/project-services/${v}`, { method: "POST", headers: { "x-sova-token": tokenOf(agent), "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const sanitized = srv.unit.replace(/\.service$/, "").replace(/[^A-Za-z0-9_.-]/g, "_");
  try {
    const cr = await verb("create", { project: root });
    if (!R.check(cr?.ok !== false, `trestart: create records the scratch project's slot 0, adopting ${adopted} (${cr?.error?.message ?? cr?.state ?? "ok"})`)) return;
    const main = cr.instance;
    // Busy: a chat mid-reply, another chat with a working worker.
    const A = await newChat();
    prompt(A.s, "[long 60 #trs] a long reply");
    await A.s.until(delta(/part 3\//), 30000, "A streams");
    const P = await newChat();
    prompt(P.s, "[spawn 1 60 #trsw] start a worker");
    await P.s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
    const w = await workerWith(P.path, "#trsw");
    if (!R.check(w, "trestart: the worker is recorded")) return;
    await waitFor(() => mockLog(mock.log).some((e) => e.tag === "trsw"), 60000);
    const pa = chatPid(A.path);
    const pp = chatPid(P.path);
    const pw = chatPid(w.path);
    const before = srv.pid();
    const started0 = (await c.api("/api/health"))?.startedAt;
    A.s.close();
    P.s.close();
    const t0 = Date.now();
    const ap = await verb("apply", { instance: main, confirm: true });
    const step = ap?.steps?.find((x) => x.id === "restart:server");
    R.check(ap?.ok === true && ap?.error?.code !== "busy", `trestart: with a reply and a worker running, the confirmed Apply is not refused as busy (${ap?.error ? `${ap.error.code}: ${ap.error.message}` : "ok"})`);
    R.check(step && /restart scheduled/.test(step.detail ?? "") && !/busy/.test(step.detail ?? ""), `trestart: it schedules the unit's restart, no busy condition (${step?.detail ?? JSON.stringify(ap)?.slice(0, 200)})`);
    const moved = await waitFor(() => {
      const p = srv.pid();
      return p && p !== before;
    }, 60000);
    const took = Math.round((Date.now() - t0) / 1000);
    R.check(moved, `trestart: the server restarted while busy, ${took} s after Apply (pid ${before} → ${srv.pid() || "none"})`);
    await healthy(base);
    const started1 = (await c.api("/api/health"))?.startedAt;
    R.check(started0 && started1 && started1 !== started0, `trestart: /api/health's startedAt moved (${started0} → ${started1})`);
    R.note(`trestart: restart ${took} s after Apply`);
    R.check(alive(pa) && chatPid(A.path) === pa, `trestart: the chat mid-reply kept its process (${pa} → ${chatPid(A.path) || "none"})`);
    R.check(alive(pp) && chatPid(P.path) === pp, `trestart: the worker's parent kept its process (${pp} → ${chatPid(P.path) || "none"})`);
    R.check(alive(pw) && chatPid(w.path) === pw, `trestart: the worker kept its process (${pw} → ${chatPid(w.path) || "none"})`);
    const a2 = await chat(c, A.path);
    await settled(a2, 0);
    await sleep(1500);
    const msgs = turnAssistants(A.path, "#trs]");
    R.check(msgs.length === 1 && msgs[0].stopReason !== "aborted" && msgs[0].stopReason !== "error" && /REPLY-DONE/.test(textOfMsg(msgs[0])), `trestart: the reply ran to its end once (${msgs.map((m) => m.stopReason).join(", ") || "none"})`);
    R.check(mockLog(mock.log).filter((e) => e.tag === "trs" && e.scenario).length === 1, "trestart: the model was asked for the reply once");
    const p2 = await chat(c, P.path);
    const done = await workerDone(p2, "trial-trsw");
    R.check(done?.outcome === "success", `trestart: the worker finished on its own (${done?.outcome}${done?.error ? `: ${done.error}` : ""})`);
    await sleep(5000);
    R.check(completions(P.path, w.path) === 1, `trestart: the worker's completion reached the parent once (${completions(P.path, w.path)})`);
    noResume(A.path, "trestart (reply)");
    noResume(P.path, "trestart (parent)");
    R.check(deaths(A.path).length + deaths(P.path).length + deaths(w.path).length === 0, "trestart: no death recorded");
    const gateLog = join(sova, "project-services", "logs", "restart-gate.log");
    R.check(!existsSync(gateLog) && !existsSync(join(ROOT, "scripts", "sova-restart-gate.mjs")), `trestart: no restart gate: no gate script, no gate log (${gateLog})`);
    a2.close();
    p2.close();
  } finally {
    // The scheduled restart's own transient units (sova-restart-<state hash>-<our unit>-*), never another's.
    if (!darwin)
      try {
        const units = execFileSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "sova-restart-*"], { encoding: "utf8" })
          .split("\n")
          .map((l) => l.trim().split(/\s+/)[0])
          .filter((u) => u && u.includes(`-${sanitized}-`));
        for (const u of units)
          try {
            sc("stop", u);
          } catch {}
      } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

// Tdefault (Part B/C, B4 and B1): chats in processes of their own by default, with no in-server path:
// no switch set, and then the old switch-off value set (now ignored), the server reports a chat driver, an
// ordinary chat and its worker each run in a process of their own, and neither is the server's child.
async function tdefault() {
  for (const [label, extra] of [["no switch", {}], ["SOVA_CHAT_HOST=off", { [KNOBS.switch]: "off" }]]) {
    await teardown();
    await boot({ extra: { [KNOBS.driver]: "detached", ...extra } });
    const h = await c.api("/api/health").catch(() => null);
    R.check(h?.chatHost?.driver === "detached" && h?.chatHost?.bun !== false && !("mode" in (h?.chatHost ?? {})), `tdefault (${label}): health reports the chat driver, no in/out mode (${JSON.stringify(h?.chatHost)?.slice(0, 120)})`);
    const { path, s } = await newChat();
    prompt(s, "[spawn 1 6 #tdw] start a worker");
    const w = await workerWith(path, "#tdw");
    await waitFor(() => w && chatPid(w.path), 30000);
    const pp = chatPid(path);
    const wp = w && chatPid(w.path);
    const server = srv.pid();
    // The detached driver starts each chat with setsid: its parent is the server until that exits, but it
    // has a session and process group of its own, so a stop of the server's group never reaches it.
    // (Under systemd a chat is a unit, never in the server's tree: t1/t17 check that.)
    const apart = (pid) => {
      const me = info(pid);
      const sv = info(server);
      return me && sv && pid !== server && me.pgid !== sv.pgid && (darwin || me.sid !== sv.sid);
    };
    const fmt = (pid) => `${pid || "none"} pgid ${info(pid)?.pgid} sess ${info(pid)?.sid}; server ${server} pgid ${info(server)?.pgid} sess ${info(server)?.sid}`;
    R.check(pp && apart(pp), `tdefault (${label}): the chat runs in a process of its own, a session and process group apart from the server (${fmt(pp)})`);
    R.check(wp && wp !== pp && apart(wp), `tdefault (${label}): its worker too (${fmt(wp)})`);
    await workerDone(s, "trial-tdw");
    s.close();
  }
  await teardown();
  await boot();
}

// Tserverless (Part B 5e(a)): chats with no server. Idle-stop shortened (SOVA_CHAT_IDLE_MIN=0.05). The
// server stops for good, chats left running (systemctl stop of its unit, or a launchd bootout on darwin);
// a quiet chat with no controller then exits by itself after the idle time, a chat mid-reply keeps
// running until its reply ends, and the next server reads each end as orderly: no death, no resume, and
// the chat reopens on attach.
async function tserverless() {
  await teardown();
  await boot({ idleMs: 3000 });
  const Q = await newChat();
  await turn(Q, "say ok");
  const L = await newChat();
  prompt(L.s, "[long 60 #tsl] a long reply");
  await L.s.until(delta(/part 3\//), 30000, "L streams");
  const pq = chatPid(Q.path);
  const pl = chatPid(L.path);
  Q.s.close();
  L.s.close();
  await srv.down();
  R.note(`tserverless: the server stopped; quiet chat ${pq}, chat mid-reply ${pl}`);
  await sleep(8000);
  R.check(alive(pl), `tserverless: a chat mid-reply keeps running with no server (${pl})`);
  const quietGone = await waitFor(() => !alive(pq), 60000);
  R.check(quietGone, `tserverless: a quiet chat with no server exited by itself after the idle time (${pq})`);
  const longGone = await waitFor(() => !alive(pl), 90000);
  R.check(longGone && mockLog(mock.log).some((e) => e.event === "done" && e.tag === "tsl"), `tserverless: the chat mid-reply finished its reply, then exited (${pl}: ${alive(pl) ? "still running" : "gone"})`);
  srv.up();
  await healthy(base);
  await sleep(3000);
  R.check(deaths(Q.path).length === 0 && deaths(L.path).length === 0, `tserverless: the next server reads both ends as orderly, not deaths (${deaths(Q.path).length + deaths(L.path).length} deaths)`);
  R.check(resumeDecisions(Q.path).length === 0 && resumeDecisions(L.path).length === 0 && userEntriesWith(L.path, RESUME_TEXT) + userEntriesWith(L.path, CRASH_RESUME_TEXT) === 0, "tserverless: nothing is resumed");
  const q2 = await chat(c, Q.path, 60000);
  await turn({ path: Q.path, s: q2 }, "say ok again");
  R.check(chatPid(Q.path) && chatPid(Q.path) !== pq, `tserverless: the quiet chat reopens on attach in a new process (${pq} → ${chatPid(Q.path)})`);
  q2.close();
  await teardown();
  await boot();
}

// Tstopchats (Part B 5e(b)): scripts/stop-chats.ts. A quiet chat, one mid-reply and a parent with a working
// worker are left running and the server stops for good; `bun scripts/stop-chats.ts --agent-dir <trial's>`
// stops every chat process the state root records (never by name), each as an operator stop: none is left,
// a second run finds none, and the next server reads no death. Its only cover is this check.
async function tstopchats() {
  await teardown();
  await boot();
  const Q = await newChat();
  await turn(Q, "say ok");
  const L = await newChat();
  prompt(L.s, "[long 80 #tsc] a long reply");
  await L.s.until(delta(/part 3\//), 30000, "L streams");
  const P = await newChat();
  prompt(P.s, "[spawn 1 80 #tscw] start a worker");
  await P.s.until((m) => m.type === "workers" && m.working >= 1, 60000, "a working worker");
  const w = await workerWith(P.path, "#tscw");
  await waitFor(() => w && chatPid(w.path), 30000);
  const pids = { quiet: chatPid(Q.path), "mid-reply": chatPid(L.path), parent: chatPid(P.path), worker: w ? chatPid(w.path) : 0 };
  for (const o of [Q, L, P]) o.s.close();
  await srv.down();
  await sleep(2000);
  R.check(Object.values(pids).every((p) => p && alive(p)), `tstopchats: with the server stopped, the chats and the worker still run (${JSON.stringify(pids)})`);
  const bun = process.env.SOVA_BUN || (() => {
    try {
      return execFileSync("mise", ["which", "bun"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return "bun";
    }
  })();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SOVA_") && k !== "PI_CODING_AGENT_DIR")), ...(driver === "systemd" ? { [KNOBS.slice]: slice } : {}) };
  const stop = () => {
    try {
      return { code: 0, out: execFileSync(bun, [join(ROOT, "scripts", "stop-chats.ts"), "--agent-dir", agent], { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }) };
    } catch (e) {
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  // What the mid-reply chat's file held just before the stop: the reopened history holds at least that.
  const lHeld = entries(L.path).filter((e) => e.type === "message").length;
  // Its unit, for its journal under systemd: stop-chats removes the record.
  const lUnit = record(L.path)?.unit;
  // The model's requests from here on (one mock log serves every check of the run).
  const mockAt = mockLog(mock.log).length;
  const first = stop();
  R.note(`tstopchats: stop-chats said: ${first.out.trim().split("\n").slice(-6).join(" | ").slice(0, 400)}`);
  R.check(first.code === 0 && /\d+ chat process(es)? stopped/.test(first.out), `tstopchats: stop-chats ran and stopped chat processes (exit ${first.code})`);
  const gone = await waitFor(() => Object.values(pids).every((p) => !p || !alive(p)), 30000);
  R.check(gone, `tstopchats: every chat process is stopped, the worker's too (${Object.entries(pids).filter(([, p]) => p && alive(p)).map(([k, p]) => `${k} ${p}`).join(", ") || "none left"})`);
  const left = strays(agent, { mock: false });
  R.check(left.length === 0, `tstopchats: no process of the trial's state root is left (${left.map((p) => `${p.pid} ${p.cmd.slice(0, 60)}`).join("; ") || "none"})`);
  const recs = allRecords().filter((r) => alive(r.pid));
  R.check(recs.length === 0, `tstopchats: no record names a running chat (${recs.map((r) => r.unit).join(", ") || "none"})`);
  const again = stop();
  R.check(again.code === 0 && /no chat process was recorded as running/.test(again.out), `tstopchats: a second run finds nothing to stop (${again.out.trim().slice(0, 120)})`);
  srv.up();
  await healthy(base);
  await sleep(3000);
  const ds = [Q.path, L.path, P.path, ...(w ? [w.path] : [])].flatMap((p) => deaths(p));
  R.check(ds.length === 0, `tstopchats: the next server reads each stop as orderly, no death (${ds.length})`);
  // The chat stopped mid-reply (the architect, from §app.chat-processes/crash, /supervision, /idle-stop and
  // §app.overseer/auto-resume): an operator stop, announced, never a death, never resumed; it reopens on
  // demand with its history. Its cut reply's partial text is whatever was written: no finish asserted.
  const lLog = procLogOf(L.path, { unit: lUnit, pid: pids["mid-reply"] });
  if (!R.check(/exit operator/.test(lLog), `tstopchats (mid-reply): its process announced an operator exit ('exit operator' in its log; last lines: ${lLog.trim().split("\n").slice(-3).join(" | ").slice(0, 200)})`))
    R.note("tstopchats (mid-reply): no announced exit: a stop-chats stop that ends unannounced (killed past its grace) is a defect for the architect");
  R.check(deaths(L.path).length === 0, `tstopchats (mid-reply): no entry for it in chats/deaths.jsonl (${deaths(L.path).length})`);
  R.check(userEntriesWith(L.path, CRASH_RESUME_TEXT) === 0 && userEntriesWith(L.path, RESUME_TEXT) === 0, "tstopchats (mid-reply): no crash-resume or resume text in its session file");
  R.check(!mockLog(mock.log).slice(mockAt).some((e) => e.tag === "resume" || /stopped unexpectedly and cut off your last turn/.test(e.userText ?? "")), "tstopchats (mid-reply): no crash-resume text reached the model");
  const resumed = resumeDecisions(L.path).filter((a) => a.outcome === "ok" || /resumed/.test(JSON.stringify(a)));
  R.check(resumed.length === 0, `tstopchats (mid-reply): no auto_resume resumed it (${fmtDecisions(resumeDecisions(L.path))})`);
  const l2 = await chat(c, L.path, 60000);
  await sleep(1500);
  const unexpected = l2.got.filter((m) => /stopped unexpectedly/i.test(JSON.stringify(m)));
  R.check(unexpected.length === 0, `tstopchats (mid-reply): its pane shows no 'stopped unexpectedly' (${unexpected.map((m) => JSON.stringify(m).slice(0, 120)).join(" | ") || "none"})`);
  await turn({ path: L.path, s: l2 }, "say ok after stop-chats");
  const lpid = chatPid(L.path);
  const msgs = entries(L.path).filter((e) => e.type === "message");
  R.check(lpid && lpid !== pids["mid-reply"] && msgs.length >= lHeld && userEntriesWith(L.path, "[long 80 #tsc]") === 1, `tstopchats (mid-reply): it reopens on demand in a new process with its history (${pids["mid-reply"]} → ${lpid || "none"}; ${lHeld} messages before the stop, ${msgs.length} now; the original prompt there ${userEntriesWith(L.path, "[long 80 #tsc]")}×)`);
  l2.close();
  await sleep(3000);
  R.check(deaths(L.path).length === 0 && resumeDecisions(L.path).filter((a) => a.outcome === "ok").length === 0 && userEntriesWith(L.path, CRASH_RESUME_TEXT) === 0, "tstopchats (mid-reply): still no death or resume after it reopened");
  const q2 = await chat(c, Q.path, 60000);
  await turn({ path: Q.path, s: q2 }, "say ok after stop-chats");
  R.check(chatPid(Q.path) && chatPid(Q.path) !== pids.quiet, `tstopchats: the quiet chat reopens on attach in a new process (${pids.quiet} → ${chatPid(Q.path)})`);
  q2.close();
  await teardown();
  await boot();
}

// hermetic: hermeticity. The server runs with HOME set to a tripwire home: its ~/.pi/agent, ~/.claude,
// ~/.claude.json and ~/.codex hold decoy files, and its ~/.local/bin/claude (also last on PATH) is a
// decoy claude that logs each call. Through ordinary chats, a pi worker, a claude-code worker, /btw, a
// parent on claude-code-cli, look_at_image, the Claude Code bridge's debug log, a server restart and
// every page's data, nothing is read or written there (inotify; a bare stat makes no event) and the
// decoy claude never runs; the fake claude did (each path that needs a claude reached the trial's own).
// One exception, by decision (coordinator, stage 5): the Overseer's redactor (overseer-redact.ts
// secretSources) reads the user's own credential files to mask their values; those four files, read
// only, during GET /api/overseer, are allowed and each is noted.
const T25_GETS = [
  "/api/auth/status", "/api/claude/accounts", "/api/extensions", "/api/explanations", "/api/insights/agents", "/api/insights/usage",
  "/api/mode", "/api/models", "/api/monitor", "/api/overseer", "/api/overseer/attention", "/api/profiles", "/api/projects", "/api/provider-limits/waiting", "/api/schedules",
  "/api/sessions", "/api/settings", "/api/settings/align", "/api/settings/claude-status", "/api/settings/decisions", "/api/settings/delegate", "/api/settings/delegate/options", "/api/settings/memory",
  "/api/settings/models", "/api/settings/overseer", "/api/settings/provider-limits", "/api/settings/session-titles", "/api/settings/spec", "/api/settings/subagents", "/api/settings/summarizer",
  "/api/settings/team", "/api/settings/team/options", "/api/targets", "/api/themes", "/api/usage/costs", "/api/usage/prices", "/api/usage/today", "/api/voice",
];
const REDACTOR_HOME = new Set(["~/.pi/agent/auth.json", "~/.pi/agent/models.json", "~/.claude/.credentials.json", "~/.claude.json"]);
const REDACTOR_STEP = "GET /api/overseer";
async function hermetic() {
  const home = join(scratch, "tripwire-home");
  const decoys = [".pi/agent", ".claude", ".codex", ".local/bin"];
  for (const d of decoys) mkdirSync(join(home, d), { recursive: true });
  const decoy = (rel, text) => writeFileSync(join(home, rel), text);
  for (const f of ["settings.json", "models.json", "auth.json", "topic-outline.json", "extension-toggle.json", "vision-delegate.json", "usage-status.json", "team-defaults.json", "subagent-profiles.json"]) decoy(join(".pi/agent", f), JSON.stringify({ tripwire: true }));
  mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true });
  mkdirSync(join(home, ".pi/agent/cache"), { recursive: true });
  decoy(".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "tripwire", refreshToken: "tripwire", expiresAt: Date.now() + 3600_000 } }));
  decoy(".claude.json", JSON.stringify({ tripwire: true }));
  decoy(".codex/auth.json", JSON.stringify({ tripwire: true }));
  const decoyCalls = join(scratch, "decoy-claude-calls.log");
  writeFileSync(join(home, ".local/bin/claude"), `#!/bin/sh\necho "$$ $*" >> ${decoyCalls}\nexit 1\n`, { mode: 0o755 });
  // The watch: every open, read or write of a decoy (a directory listing is an open too), stamped
  // with the step running when it arrived (inotify gives no pid).
  const { spawn } = await import("node:child_process");
  const watched = [...decoys.map((d) => join(home, d)), join(home, ".claude.json")];
  // darwin has no inotify (fs_usage needs root): there a listing of the tripwire home (names, sizes,
  // mtimes) before and after the run shows writes; reads go unseen, and the result says so.
  const listing = () => {
    const out = new Map();
    const walk = (p) => {
      let st;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      out.set(p.replace(`${home}/`, "~/"), `${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    };
    for (const w of watched) walk(w);
    return out;
  };
  const before = darwin ? listing() : null;
  const ino = darwin ? null : spawn("inotifywait", ["-m", "-r", "-e", "open,access,modify,close_write,create,delete,moved_to,moved_from,attrib", "--format", "%w%f|%e", ...watched], { stdio: ["ignore", "pipe", "pipe"] });
  let step = "setup";
  const hits = [];
  ino?.stdout.on("data", (d) => {
    for (const l of String(d).split("\n").filter(Boolean)) {
      const [file, ev] = l.split("|");
      hits.push({ file: file.replace(`${home}/`, "~/"), ev, step });
    }
  });
  const ready = darwin || (await new Promise((ok) => {
    let err = "";
    ino.stderr.on("data", (d) => ((err += String(d)), /Watches established/.test(err) && ok(true)));
    ino.once("exit", () => ok(false));
    setTimeout(() => ok(false), 10000);
  }));
  if (!R.check(ready, darwin ? "hermetic: the tripwire home's listing is taken (darwin: no inotify)" : "hermetic: the inotify watch on the tripwire home is up")) return;
  // Mise's shims find their tools through HOME: name the installs directly.
  const bins = [process.execPath, (() => {
    try {
      return execFileSync("mise", ["which", "bun"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })()].filter(Boolean).map((b) => b.replace(/\/[^/]+$/, ""));
  const fakeCalls = () => {
    try {
      return readFileSync(join(scratch, "fake-claude-calls.log"), "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const fake0 = fakeCalls();
  await teardown();
  // PI_CLAUDE_CODE_DEBUG: the Claude Code bridge writes its debug log (to the agent dir, never ~/.pi/agent).
  const env = { HOME: home, PATH: `${claudeBin}:${bins.join(":")}:${process.env.PATH}:${join(home, ".local/bin")}`, PI_CLAUDE_CODE_DEBUG: "1" };
  // A 1x1 png for look_at_image (the mock model sees no images; the tool reads the usage cache first).
  writeFileSync(join(proj, "t25.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  try {
    step = "boot";
    await boot({ extra: env });
    step = "a chat's turn";
    const { path, s } = await newChat();
    const o = { path, s };
    await turn(o, "say ok");
    step = "a pi worker";
    prompt(s, "[spawn 1 10 #t25w] start a worker");
    R.check((await workerDone(s, "trial-t25w"))?.outcome === "success", "hermetic: a pi worker ran to its end");
    step = "a claude-code worker";
    prompt(s, "[spawn-claude 2000 #t25c] start a claude worker");
    R.check((await workerDone(s, "trial-claude"))?.outcome === "success", "hermetic: a claude-code worker ran to its end");
    step = "/btw";
    prompt(s, "/btw [btw #t25b] a side question");
    R.check(await waitFor(() => entries(path).some((e) => e.customType === "btw-note" && JSON.stringify(e).includes("BTW-ANSWER t25b")), 60000), "hermetic: /btw answered");
    step = "a parent on claude-code-cli";
    const cc = await newChat("claude-code-cli/claude-sonnet-5-5");
    await turn(cc, "say ok", 90000);
    step = "look_at_image";
    await turn(o, `[call look_at_image ${JSON.stringify({ path: "t25.png", question: "what colour" })}]`);
    s.close();
    cc.s.close();
    step = "restart";
    await restart();
    const s2 = await chat(c, path);
    await turn({ path, s: s2 }, "say ok again");
    s2.close();
    // Every page's data, as the browser asks for it (no mesh, peer, outreach or editor routes: those reach out).
    const answers = [];
    for (const r of T25_GETS) {
      step = `GET ${r}`;
      answers.push(`${r} ${await c.api(r).then(() => "ok", (e) => String(e.message ?? e).slice(0, 40))}`);
      await sleep(300);
    }
    R.note(`hermetic: GET ${answers.join("; ")}`);
    step = "after";
    await sleep(5000);
  } finally {
    ino?.kill("SIGTERM");
  }
  if (darwin) {
    const after = listing();
    for (const [p, v] of after) if (before.get(p) !== v) hits.push({ file: p, ev: before.has(p) ? "MODIFY" : "CREATE", step: "the run (darwin listing)" });
    for (const p of before.keys()) if (!after.has(p)) hits.push({ file: p, ev: "DELETE", step: "the run (darwin listing)" });
    R.note("hermetic: darwin compares listings, so only writes are seen; a read of a decoy goes unnoticed");
  }
  const write = (h) => !/^(OPEN|ACCESS|CLOSE_NOWRITE)/.test(h.ev.replace(/,ISDIR/, ""));
  const allowed = (h) => !write(h) && REDACTOR_HOME.has(h.file) && h.step === REDACTOR_STEP;
  const fmt = (hs) => [...new Set(hs.map((h) => `${h.file} ${h.ev} (${h.step})`))];
  const ok = fmt(hits.filter(allowed));
  for (const a of ok) R.note(`hermetic: allowed, the Overseer's redactor reading a home secret to mask it: ${a}`);
  const bad = fmt(hits.filter((h) => !allowed(h)));
  R.check(bad.length === 0, `hermetic: nothing else read or wrote anything in the tripwire home (~/.pi/agent, ~/.claude, ~/.claude.json, ~/.codex, ~/.local/bin): ${bad.slice(0, 12).join("; ") || "none"}${bad.length > 12 ? ` (+${bad.length - 12})` : ""}`);
  const decoyRan = existsSync(decoyCalls) ? readFileSync(decoyCalls, "utf8").trim() : "";
  R.check(!decoyRan, `hermetic: the decoy ~/.local/bin/claude never ran (${decoyRan.slice(0, 160) || "no call"})`);
  R.check(fakeCalls() > fake0, `hermetic: the claude paths ran on the trial's fake claude (${fakeCalls() - fake0} calls)`);
  // The next check gets a server with the trial's usual HOME.
  await teardown();
  await boot();
}

// serve (only when asked): the trial's hermetic server, left up for a person with a browser (the
// real-model drive, tmp/browser-drive.md). With --model, new chats start on it. Prints the page's
// unlock URL and the scratch paths, then waits for ^C or SIGTERM, which stop everything it started.
async function serve() {
  if (opt("model")) {
    const [provider, ...id] = opt("model").split("/");
    const f = join(agent, "settings.json");
    writeFileSync(f, JSON.stringify({ ...readJson(f), defaultProvider: provider, defaultModel: id.join("/") }, null, 2));
    await teardown();
    await boot();
  }
  console.log(`\nserve: open ${base}/#t=${tokenOf(agent)}`);
  console.log(`serve: agent dir ${agent}; server log ${join(scratch, `server-${n}.log`)}; project ${proj}`);
  console.log("serve: ^C (or SIGTERM to this pid) stops the server and every chat process it started");
  await new Promise(() => {});
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

const table = { t1: () => t1(), t1b, t1c, t1d, t1e, t2, t3, t4, t4fail, t6, t7, t8, t9, t10, t11, t11b, t11c, t12a, t12b, t12c, t12d, t13, t14, t15, t16, t17: () => t17(), t17c: () => t17(true), t18, t18b, t19, t19n, t20, t21, t21c, t21h, t21l, t21r: () => t21r(), t21rx: () => t21r("either"), tsend, t23, t24, t25, t27, trestart, tdefault, tserverless, tstopchats, hermetic, plumbing, serve, real: () => t1(opt("model")) };
let code = 0;
let finished = null;
/** Stops the server, every chat process and the mock, and writes results.json; once. */
const finish = () =>
  (finished ??= (async () => {
    await teardown().catch(() => {});
    if (driver === "systemd")
      try {
        execFileSync("systemctl", ["--user", "stop", slice]);
      } catch {}
    mock.stop();
    await new Promise((ok) => (mock.child.exitCode !== null ? ok() : (mock.child.once("exit", ok), setTimeout(ok, 3000))));
    // Anything of the scratch dir still running (another agent dir a check made, the mock).
    const left = await sweep(scratch).catch(() => []);
    if (left.length) R.note(`end: stopped ${left.length} process(es) left under the scratch dir: ${left.map((p) => `${p.pid} ${p.cmd.slice(0, 80)}`).join("; ")}`);
    const file = R.save({ asked: checks, mode, driver, slice: driver === "systemd" ? slice : null, knobs: KNOBS });
    console.log(`\nresults: ${file}`);
    if (!argv.includes("--keep") && code === 0 && R.checks.every((x) => x.ok !== false)) rmSync(join(scratch, "agent"), { recursive: true, force: true });
  })());
// A runner stopped from outside (the integration test's timeout, ^C) still stops what it started:
// before, a check cut off this way left its chat and worker processes running (report-s4 item 9).
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.once(sig, () => {
    if (!checks.includes("serve")) R.check(false, `the runner ran to its end`, `stopped by ${sig}`);
    console.log(`\nchat-runtime-trial: ${sig}, stopping what the trial started`);
    finish().finally(() => process.exit(code || (checks.includes("serve") && R.checks.every((x) => x.ok !== false) ? 0 : 1)));
  });
// And one whose parent is gone: run-tests.mjs SIGKILLs a test file that runs past its limit, which
// kills the integration test but not this runner (spawnSync's child). Orphaned, the runner stops what
// it started, and its output (a pipe to the dead test) never crashes it first (EPIPE).
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
const parentAtStart = process.ppid;
setInterval(() => {
  if (process.ppid === parentAtStart) return;
  R.check(false, "the runner ran to its end", `its parent (${parentAtStart}) is gone`);
  finish().finally(() => process.exit(code || 1));
}, 2000).unref();
// So does one that throws where no check catches it (a full disk under a socket's handler, say).
process.once("uncaughtException", (e) => {
  R.check(false, "the runner ran to its end", String(e instanceof Error ? e.stack : e).slice(0, 400));
  finish().finally(() => process.exit(2));
});
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
  await finish();
}
const failed = R.checks.filter((x) => x.ok === false).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
process.exit(code || (failed ? 1 : 0));
