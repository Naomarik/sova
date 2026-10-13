#!/usr/bin/env node
// The first restart from master onto new code (F), rehearsed on a hermetic stand-in (the review's #1,
// architect-2's triage #1; plan: tmp/runner-rehearsal-plan.md). PREPARED: run it only once the operator
// has said yes (al_6 q5).
//
//   node scripts/chat-runtime-trial/rehearse.mjs [--scratch <dir>] [--from <master ref>] [--to <F ref>]
//        [--variant quiet|busy] [--repo <git dir>] [--no-build] [--allow-lock-diff]
//
// --scratch (default ~/.cache/sova-rehearsal) is the runner's prepared dir: checkout/ (master unpacked by git
// archive, node_modules installed, .rehearsal-rev naming the ref), agent/ (built by master's own
// hermetic-agent-dir.mjs, its extensions linked into checkout/), home/ (a tripwire HOME), proj/. It is
// used up by one run: the checkout ends as F and the state root holds the run's chats, so a second variant
// needs the prepared dir again (keep a copy before the first run).
//
// The server runs as the stand-in unit sova-trial-server-rehearsal.service (KillMode=control-group,
// TimeoutStopSec=90, as sova-runtime.service), never sova-runtime.service, and on F its chats go into the
// top-level stand-in slice sovatrialrehearsal.slice. Everything is stopped and started from here, outside
// Sova. The steps:
//   (a) the mock on a free port, its provider put into agent/models.json; master's server up;
//   (b) chat A streams a long reply ([long 60 #rhA]); chat P's model spawns one pi worker ([spawn 1 120 #rhW],
//       inline on master); a third socket O on P stands for a page left open on master's bundle;
//   (c) master's own busy check (its scripts/sova-restart-gate.mjs busyOf over its live records) says busy;
//       quiet variant: wait for A's reply and W's run to end, the same check must say quiet;
//   (d) stop the unit; switch the checkout IN PLACE to F (git archive F, rsync --delete over checkout/, F's
//       hermetic-agent-dir relink, the web bundle rebuilt), the state root kept; start the unit again;
//   (e) on F: A and P reopen in chat processes of their own with their history; P's master-era worker reads
//       ended or resumable, never running; runs-in-flight.json is ignored (no continue, no auto-resume, the
//       file untouched); O was closed by the stop and a new socket reconnects; nothing of master is left
//       running; the decoy claude never ran; nothing was written under the tripwire HOME.
// Busy variant: no wait at (c); what the switch cuts (A's reply, W) is recorded as notes, not failures.
// Results: <scratch>/rehearsal-<variant>.json and the lines printed. A real browser on master's bundle is
// the coordinator's (tmp/browser-drive.md); O is its socket-level stand-in.
//
// darwin (macOS): the server is the launchd agent test.sova-s5-rehearsal in the user's GUI domain (lib.mjs
// launchdStandIn, ExitTimeOut 60 as the installer writes it), never the live install's agent; the stop is a
// bootout (launchd signals the job's process group, the counterpart of KillMode=control-group), the start a
// bootstrap. On F the chats run on the detached driver (no slice). A chat process counts as apart from the
// server when it is outside the server's process group (it stays the server's child by ppid). Prepare and
// run it with scripts/chat-runtime-trial/mac/rehearse-mac.sh.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CRASH_RESUME_TEXT, RESUME_TEXT, ROOT, chat, client, fakeClaude, freePort, healthy, launchdStandIn, mockLog, modelsJson, recorder, sc, show, sleep, startMock, strays, sweep, tokenOf, userBus } from "./lib.mjs";
import { alive, darwin, info, tree } from "./procs.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const R = resolve(opt("scratch", join(homedir(), ".cache", "sova-rehearsal")));
const FROM = opt("from", "master");
const REPO = resolve(opt("repo", ROOT));
const TO = opt("to", "HEAD");
const VARIANT = opt("variant", "quiet");
const BUILD = !argv.includes("--no-build");
const UNIT = "sova-trial-server-rehearsal.service";
// darwin's stand-in agent: the trial's label prefix (run-mac.sh's leftover sweep knows it).
const LABEL = "test.sova-s5-rehearsal";
const SLICE = "sovatrialrehearsal.slice";
const checkout = join(R, "checkout");
const agent = join(R, "agent");
const home = join(R, "home");
const proj = join(R, "proj");
const sova = join(agent, "sova");
const serverLog = join(R, "server.log");

// ── guards: never the live install ─────────────────────────────────────────────────────────────────
const refuse = (why) => {
  console.error(`rehearse: ${why}`);
  process.exit(2);
};
if (!["quiet", "busy"].includes(VARIANT)) refuse(`--variant is quiet or busy, not ${VARIANT}`);
const homePi = join(homedir(), ".pi");
if (R === homePi || R.startsWith(`${homePi}/`)) refuse(`the scratch dir is inside ~/.pi: ${R}`);
for (const d of [checkout, agent, home, proj]) if (!existsSync(d)) refuse(`${d} is missing: prepare the scratch dir first (tmp/runner-rehearsal-plan.md §0)`);
const rev = existsSync(join(checkout, ".rehearsal-rev")) ? readFileSync(join(checkout, ".rehearsal-rev"), "utf8").trim().split("\n")[0] : "";
if (rev !== FROM) refuse(`${checkout}/.rehearsal-rev says '${rev}', not --from '${FROM}': this scratch dir was used already, or prepared from another ref`);
if (existsSync(join(R, "rehearsal-used"))) refuse(`${R} was used by an earlier rehearsal (${readFileSync(join(R, "rehearsal-used"), "utf8").trim()}): prepare it again`);
if (darwin) {
  let loaded = false;
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], { stdio: "pipe" });
    loaded = true;
  } catch {}
  if (loaded) refuse(`the launchd agent ${LABEL} is loaded already`);
} else {
  if (!userBus()) refuse("no systemd user manager answers: the stand-in unit needs one");
  try {
    if (show(UNIT, "ActiveState") === "active") refuse(`${UNIT} is running already`);
  } catch {}
}
const toRev = execFileSync("git", ["-C", REPO, "rev-parse", "--short", TO], { encoding: "utf8" }).trim();
// node_modules is master's, carried across the switch: F must run on the same lockfile.
const lockOf = (text) => text.replace(/\r\n/g, "\n");
const lockFrom = existsSync(join(checkout, "pnpm-lock.yaml")) ? lockOf(readFileSync(join(checkout, "pnpm-lock.yaml"), "utf8")) : "";
const lockTo = (() => {
  try {
    return lockOf(execFileSync("git", ["-C", REPO, "show", `${TO}:pnpm-lock.yaml`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return "";
  }
})();
const depsOf = (text) => {
  try {
    const j = JSON.parse(text);
    return JSON.stringify(["dependencies", "devDependencies", "optionalDependencies"].map((k) => Object.entries(j[k] ?? {}).sort()));
  } catch {
    return "unreadable";
  }
};
const pkgFrom = existsSync(join(checkout, "package.json")) ? depsOf(readFileSync(join(checkout, "package.json"), "utf8")) : "missing";
const pkgTo = (() => {
  try {
    return depsOf(execFileSync("git", ["-C", REPO, "show", `${TO}:package.json`], { encoding: "utf8" }));
  } catch {
    return "missing";
  }
})();
const lockDiffers = lockFrom !== lockTo || pkgFrom !== pkgTo;
if (lockDiffers && !argv.includes("--allow-lock-diff")) refuse(`${lockFrom !== lockTo ? "pnpm-lock.yaml" : "package.json's dependencies"} differ between ${FROM} (the checkout's node_modules) and ${TO}: F would run on master's dependencies. Install F's after the switch, or pass --allow-lock-diff to go on and note it`);
writeFileSync(join(R, "rehearsal-used"), `${new Date().toISOString()} ${VARIANT} ${FROM} → ${toRev}\n`);

const Rec = recorder(join(R, `rehearsal-${VARIANT}.json`));
const RUN_START = Date.now();
console.log(`rehearse: ${VARIANT}, ${FROM} → ${toRev}, scratch ${R}, server as ${darwin ? `the launchd agent ${LABEL}` : UNIT}`);
if (lockDiffers) Rec.note(`the lockfile or package.json's dependencies differ between ${FROM} and ${toRev}: F runs on ${FROM}'s node_modules (--allow-lock-diff)`);

// ── the session file, read as the trial does ─────────────────────────────────────────────────────────
const lines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const entries = (path) => lines(path);
const userEntriesWith = (path, text) => entries(path).filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes(text)).length;
const toolResults = (path) => entries(path).filter((e) => e.type === "message" && e.message?.role === "toolResult");
const records = () => {
  const dir = join(sova, "chats", "registry");
  try {
    return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).filter((r) => r?.sessionPath);
  } catch {
    return [];
  }
};
const base = (p) => String(p ?? "").split("/").pop();
const recordOf = (path) => records().find((r) => base(r.sessionPath) === base(path)) ?? null;
const resumeDecisions = (path) => lines(join(sova, "overseer-actions.jsonl")).filter((a) => a.tool === "auto_resume" && base(a.args?.path) === base(path));
const isEvent = (t) => (m) => m.type === "event" && m.event?.type === t;
const delta = (re) => (m) => m.type === "event" && m.event?.type === "part.delta" && re.test(m.event.delta ?? "");
const waitFor = async (cond, ms, every = 500) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
};
/** Every file under `dir` with its size and mtime (the tripwire HOME, before and after). */
const listing = (dir) => {
  const out = {};
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(d, n);
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(f);
      else out[f] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};

// ── the stand-in unit ────────────────────────────────────────────────────────────────────────────────
const bunBin = (() => {
  try {
    return execFileSync("mise", ["which", "bun"], { cwd: checkout, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
const fake = fakeClaude(R);
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
/** The unit's environment: no real login or key, the fake claude first and the decoy last on PATH. */
const unitEnv = (onF) => ({
  PORT: String(port),
  PI_CODING_AGENT_DIR: agent,
  HOME: home,
  PATH: [fake.claudeBin, dirname(process.execPath), ...(bunBin ? [dirname(bunBin)] : []), "/usr/local/bin", "/usr/bin", "/bin", ...(darwin ? ["/usr/sbin", "/sbin"] : []), join(home, ".local", "bin")].join(":"),
  CLAUDE_CONFIG_DIR: fake.claudeLogin,
  ...(bunBin ? { SOVA_BUN: bunBin } : {}),
  SOVA_PRICES_FETCH: "off",
  SOVA_USAGE_POLL: "off",
  LANG: process.env.LANG ?? (darwin ? "en_US.UTF-8" : "C.UTF-8"),
  ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
  ...(onF ? { ...(darwin ? {} : { SOVA_CHAT_SLICE: SLICE }), SOVA_CHAT_CODE: "live" } : {}),
});
let agentJob = null;
function unitUp(onF) {
  const env = unitEnv(onF);
  if (darwin) {
    agentJob = launchdStandIn({ label: LABEL, env, log: serverLog, root: checkout, exitTimeOut: 60 });
    agentJob.up();
    return;
  }
  execFileSync("systemd-run", ["--user", `--unit=${UNIT}`, "--property=KillMode=control-group", "--property=TimeoutStopSec=90", `--working-directory=${checkout}`, `--property=StandardOutput=append:${serverLog}`, `--property=StandardError=append:${serverLog}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), join(checkout, "scripts", "start-server.sh")], { stdio: "pipe" });
}
const unitDown = async () => {
  if (darwin) return agentJob?.down();
  try {
    sc("stop", UNIT);
  } catch {}
};
const mainPid = () => (darwin ? agentJob?.pid() ?? 0 : Number(show(UNIT, "MainPID")) || 0);
/** `pid` runs apart from F's server: outside its process tree under systemd (a unit of its own), outside its
    process group on darwin (a detached chat is a setsid child of the server). */
const apart = (pid, server) => {
  if (!darwin) return !tree(server).some((p) => p.pid === pid);
  const me = info(pid);
  const sv = info(server);
  return !!me && !!sv && me.pgid !== sv.pgid;
};
/** The trial's mock provider and defaults in the agent dir: replaced, never written through a link.
    `onMaster`: also master's summarizer onto the fake claude (below). */
function putMock(mockPort, { onMaster = false } = {}) {
  const put = (file, fn) => {
    const f = join(agent, file);
    const cur = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    rmSync(f, { force: true });
    writeFileSync(f, JSON.stringify(fn(cur), null, 2));
  };
  put("models.json", (m) => ({ ...m, providers: { ...(m.providers ?? {}), ...modelsJson(mockPort).providers } }));
  put("settings.json", (s) => ({ ...s, defaultProvider: "trial", defaultModel: "m1" }));
  put("trust.json", (t) => ({ ...t, [proj]: true }));
  // Master's topic-outline summarizer spawns claudeBin, default $HOME/.local/bin/claude (0ba0e92c
  // pi-config/extensions/topic-outline/config.ts:18): the tripwire's decoy. On master only, a trusted
  // project's .pi/topic-outline.json points it at the fake claude (as lib.mjs buildAgentDir does). The switch
  // removes it, so F resolves claude on its own and the decoy still catches F reaching $HOME/.local/bin/claude.
  if (onMaster) {
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(proj, ".pi", "topic-outline.json"), JSON.stringify({ claudeBin: join(fake.claudeBin, "claude"), summarizers: [{ backend: "claude-code", model: "claude-sonnet-5-5", timeoutMs: 20000 }] }, null, 2));
  }
  mkdirSync(sova, { recursive: true });
  const ov = join(sova, "overseer.json");
  if (!existsSync(ov)) writeFileSync(ov, JSON.stringify({ version: 1, model: "trial/m1", explorer: { backend: "pi", model: "trial/m1", effort: "medium" } }, null, 2));
}

let mock = null;
const cleanup = async () => {
  await unitDown();
  if (!darwin)
    try {
      sc("stop", SLICE);
    } catch {}
  mock?.stop();
  // F's chat processes outlive the server's stop by design (on darwin nothing else stops them): TERM, a
  // grace for their own shutdown, then KILL.
  const left = await sweep(agent, { mock: false, graceMs: 10000 });
  if (left.length) Rec.note(`cleanup: stopped ${left.length} process(es) of the agent dir: ${left.map((p) => `${p.pid} ${p.cmd.slice(0, 60)}`).join("; ")}`);
  console.log(`\nresults: ${Rec.save({ variant: VARIANT, from: FROM, to: toRev, scratch: R, platform: process.platform, standIn: darwin ? LABEL : UNIT })}`);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(sig, () => {
    Rec.check(false, "the rehearsal ran to its end", `stopped by ${sig}`);
    cleanup().finally(() => process.exit(1));
  });

try {
  // (a)
  mock = await startMock({ port: await freePort(), log: join(R, "mock.jsonl"), step: 400 });
  putMock(mock.port, { onMaster: true });
  const homeBefore = listing(home);
  const decoyLog = join(R, "decoy-claude-calls.log");
  const decoyBefore = existsSync(decoyLog) ? readFileSync(decoyLog, "utf8").length : 0;
  unitUp(false);
  const h0 = await healthy(baseUrl);
  const pidM = mainPid();
  Rec.note(`master up: pid ${pidM}, health ${JSON.stringify(h0).slice(0, 160)}`);
  const c = client(baseUrl, tokenOf(agent));
  const newChat = async () => {
    const { path } = await c.api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: proj }) });
    const s = await chat(c, path);
    s.send({ type: "set_model", ref: "trial/m1" });
    await s.until((m) => m.type === "model" || m.type === "error", 15000, "set_model answer");
    return { path, s };
  };
  const prompt = (s, text) => s.send({ type: "prompt", text, clientId: `rh-${Date.now()}` });

  // (b)
  const A = await newChat();
  prompt(A.s, "[long 60 #rhA] a long reply");
  await A.s.until(delta(/part 3\//), 60000, "A streams");
  const P = await newChat();
  prompt(P.s, "[spawn 1 120 #rhW] start a worker");
  const wStarted = await waitFor(() => mockLog(mock.log).some((e) => e.tag === "rhW"), 90000);
  Rec.check(wStarted, "master: P's worker runs (the mock is asked for rhW)");
  const O = await chat(c, P.path);
  const runsFile = join(sova, "runs-in-flight.json");

  // (c) master's own busy rule, from master's code (its main runs only when it is argv[1]: pass nothing).
  const busyNow = () => {
    try {
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", "const m = await import(process.env.REH_GATE); const r = m.busyOf(m.readRecords(process.env.REH_LIVE), Number(process.env.REH_PID), Date.now()); console.log(JSON.stringify(r ?? null));"], { cwd: checkout, env: { ...process.env, REH_GATE: join(checkout, "scripts", "sova-restart-gate.mjs"), REH_LIVE: join(agent, "sessions", "live"), REH_PID: String(pidM) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      return JSON.parse(out.trim().split("\n").pop());
    } catch (e) {
      return { error: String(e.stderr ?? e.message ?? e).slice(0, 200) };
    }
  };
  const busy1 = busyNow();
  Rec.check(busy1 && !busy1.error, `master's busy check says busy while A streams and W runs (${JSON.stringify(busy1)})`);
  if (VARIANT === "quiet") {
    const quiet = await waitFor(() => {
      const log = mockLog(mock.log);
      return log.some((e) => e.event === "done" && e.tag === "rhA") && log.some((e) => e.event === "done" && e.tag === "rhW") && entries(P.path).some((e) => e.customType === "subagent-complete");
    }, 180000, 1000);
    Rec.check(quiet, "quiet: A's reply and W's run ended, P has W's completion");
    await sleep(3000);
    const busy2 = busyNow();
    Rec.check(busy2 === null, `quiet: master's busy check now says quiet (${JSON.stringify(busy2)})`);
  } else Rec.note("busy: no wait; stop → switch → start while A streams and W runs");
  const runsBefore = existsSync(runsFile) ? readFileSync(runsFile, "utf8") : null;
  const aHeld = entries(A.path).filter((e) => e.type === "message").length;
  const pHeld = entries(P.path).filter((e) => e.type === "message").length;
  const masterProcs = [pidM, ...tree(pidM).map((p) => p.pid)];

  // (d)
  const t0 = Date.now();
  await unitDown();
  const tStopped = Date.now();
  const fTree = join(R, "f-tree");
  rmSync(fTree, { recursive: true, force: true });
  mkdirSync(fTree);
  execFileSync("sh", ["-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", REPO, TO, fTree], { stdio: "pipe" });
  execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules", "--exclude", "dist", "--exclude", "dist-share", "--exclude", ".rehearsal-rev", `${fTree}/`, `${checkout}/`], { stdio: "pipe" });
  writeFileSync(join(checkout, ".rehearsal-rev"), `${toRev}\n`);
  if (BUILD) {
    const vite = join(checkout, "node_modules", ".bin", "vite");
    for (const mode of [[], ["--mode", "share"]]) execFileSync(vite, ["build", ...mode], { cwd: checkout, stdio: "pipe", timeout: 600000 });
  }
  execFileSync(process.execPath, [join(checkout, "scripts", "hermetic-agent-dir.mjs")], { env: { ...process.env, HERMETIC_AGENT_DIR: agent }, stdio: "pipe" });
  rmSync(join(proj, ".pi", "topic-outline.json"), { force: true });
  putMock(mock.port);
  const tSwitched = Date.now();
  unitUp(true);
  const h1 = await healthy(baseUrl);
  Rec.note(`switch: stopped in ${Math.round((tStopped - t0) / 1000)} s, files and links in ${Math.round((tSwitched - tStopped) / 1000)} s, down ${Math.round((Date.now() - t0) / 1000)} s in all`);

  // (e)
  Rec.check(h1?.chatHost && "driver" in h1.chatHost && (!darwin || h1.chatHost.driver === "detached"), `the new server is F${darwin ? ", chats on the detached driver" : ""} (health chatHost ${JSON.stringify(h1?.chatHost)?.slice(0, 120)})`);
  const pidF = mainPid();
  const oClosed = await waitFor(() => O.closed(), 5000, 200);
  Rec.check(oClosed, "the socket left open on master (O) was closed by the stop, as a page's is");
  const c2 = client(baseUrl, tokenOf(agent));
  const reopen = async (path, label) => {
    // busy: a chat whose reply the stop cut may be refused as written by an unknown process (its last
    // entry, master's abort, is not in master's owned-writes record): the page reads "Read only while
    // another process may be writing this file." for up to 120 s. Noted, then opened anyway as a user can.
    const s = await chat(c2, path, 60000).catch(async (e) => {
      if (VARIANT !== "busy" || !/"code":"recent"/.test(String(e?.message))) throw e;
      Rec.note(`busy: ${label} refused on F as recently written by an unknown process (${String(e.message).slice(9, 140)}); opened anyway (&force=1)`);
      return chat(c2, path, 60000, { force: true });
    });
    s.send({ type: "set_model", ref: "trial/m1" });
    await s.until((m) => m.type === "model" || m.type === "error", 15000, "set_model answer").catch(() => null);
    const from = s.got.length;
    const before = toolResults(path).length;
    prompt(s, `say ok after the switch ${label}`);
    const settled = await s.until(isEvent("run.settled"), 60000, "run.settled", from).then(() => true, () => false);
    return { s, settled, results: () => toolResults(path).slice(before) };
  };
  const O2 = await chat(c2, P.path, 60000).then(() => true, () => false);
  Rec.check(O2, "a page on P reconnects to F (hello)");
  for (const [label, X, held, marker] of [["A", A, aHeld, "[long 60 #rhA]"], ["P", P, pHeld, "[spawn 1 120 #rhW]"]]) {
    const r = await reopen(X.path, label);
    const rec = recordOf(X.path);
    Rec.check(r.settled && rec && alive(rec.pid) && rec.pid !== pidF && apart(rec.pid, pidF), `${label} reopens on F in a chat process of its own and answers (pid ${rec?.pid ?? "none"}${darwin ? ` pgid ${info(rec?.pid)?.pgid ?? "?"}` : `, unit ${rec?.unit ?? "none"}`}, server ${pidF}${darwin ? ` pgid ${info(pidF)?.pgid ?? "?"}` : ""})`);
    Rec.check(entries(X.path).filter((e) => e.type === "message").length >= held && userEntriesWith(X.path, marker) === 1, `${label} keeps its history (${held} messages before the stop, ${entries(X.path).filter((e) => e.type === "message").length} now; its first prompt once)`);
    r.s.close();
  }
  // P's master-era worker, as F lists it: ended or resumable, never running.
  const p3 = await chat(c2, P.path, 60000);
  const before = toolResults(P.path).length;
  const from = p3.got.length;
  prompt(p3, "[call agent_list {}]");
  await p3.until(isEvent("run.settled"), 60000, "agent_list settles", from).catch(() => null);
  await sleep(500);
  const agents = toolResults(P.path).slice(before).at(-1)?.message?.details?.agents ?? [];
  const w = agents.find((a) => a.name === "trial-rhW");
  Rec.note(`P's agent_list on F: ${JSON.stringify(agents).slice(0, 300)}`);
  const settledState = w && !/^(running|working|starting)$/.test(String(w.status));
  if (VARIANT === "quiet") Rec.check(settledState, `P's master-era worker reads ended or resumable, not running (${JSON.stringify(w)?.slice(0, 200) ?? "not listed"})`);
  else Rec.note(`busy: P's master-era worker as F lists it: ${JSON.stringify(w)?.slice(0, 200) ?? "not listed"}`);
  p3.close();
  // Nothing of master left running: its server's processes, and no process of the agent dir that is not F's
  // server or one of F's chat processes.
  await sleep(3000);
  const masterLeft = masterProcs.filter((p) => alive(p));
  Rec.check(masterLeft.length === 0, `nothing of master's server is left running (${masterLeft.join(", ") || "none"})`);
  const fOwn = new Set([pidF, ...tree(pidF).map((p) => p.pid), ...records().flatMap((r) => (alive(r.pid) ? [r.pid, ...tree(r.pid).map((p) => p.pid)] : []))]);
  const others = strays(agent, { mock: false }).filter((p) => !fOwn.has(p.pid));
  Rec.check(others.length === 0, `no other process of the agent dir runs (${others.map((p) => `${p.pid} ${p.cmd.slice(0, 60)}`).join("; ") || "none"})`);
  // runs-in-flight.json ignored, nothing resumed.
  const runsAfter = existsSync(runsFile) ? readFileSync(runsFile, "utf8") : null;
  Rec.note(`runs-in-flight.json before the stop: ${runsBefore === null ? "none" : runsBefore.slice(0, 160)}. The checks below pin F's behaviour as having no reader of master's ledger: if one is added (a one-time legacy recovery), they change with it`);
  const resumed = [A.path, P.path].flatMap((p) => resumeDecisions(p));
  const continues = [A.path, P.path].reduce((n, p) => n + userEntriesWith(p, RESUME_TEXT) + userEntriesWith(p, CRASH_RESUME_TEXT), 0);
  if (VARIANT === "quiet") {
    Rec.check(continues === 0 && resumed.length === 0, `F resumes nothing: no continue text, no auto-resume decision (${continues} continue(s), ${resumed.map((a) => a.outcome).join(", ") || "no decision"})`);
    Rec.check(runsAfter === runsBefore, "F leaves master's runs-in-flight.json as it was");
  } else {
    const aMsgs = entries(A.path).filter((e) => e.type === "message" && e.message?.role === "assistant").map((e) => e.message.stopReason);
    const rhA = mockLog(mock.log).find((e) => e.scenario && e.tag === "rhA");
    Rec.note(`busy: A's assistant entries ${JSON.stringify(aMsgs)}; the mock ${mockLog(mock.log).some((e) => e.event === "cut-off" && e.n === rhA?.n) ? "cut A's reply off" : mockLog(mock.log).some((e) => e.event === "done" && e.tag === "rhA") ? "finished A's reply" : "has no end for A's reply"}`);
    Rec.note(`busy: continue texts ${continues}, auto-resume decisions ${resumed.map((a) => `${a.outcome}${a.error ? `: ${a.error}` : ""}`).join("; ") || "none"}; runs-in-flight.json ${runsAfter === runsBefore ? "unchanged" : "changed"}`);
    Rec.note(`busy: W ${mockLog(mock.log).some((e) => e.event === "done" && e.tag === "rhW") ? "finished" : "did not finish"}; P has ${entries(P.path).filter((e) => e.customType === "subagent-complete").length} completion(s)`);
  }
  // The tripwire.
  const decoyAfter = existsSync(decoyLog) ? readFileSync(decoyLog, "utf8").length : 0;
  Rec.check(decoyAfter === decoyBefore, `the decoy claude never ran (${decoyLog})`);
  const homeAfter = listing(home);
  // darwin: bun keeps its transpiler cache in ~/Library/Caches/bun (the live agent's too): bun's own, not a
  // read or write of the user's files by Sova. Counted, not failed.
  const bunCache = join(home, "Library", "Caches", "bun") + "/";
  const all = Object.keys({ ...homeBefore, ...homeAfter }).filter((f) => homeBefore[f] !== homeAfter[f]);
  const changed = all.filter((f) => !f.startsWith(bunCache));
  if (all.length > changed.length) Rec.note(`bun wrote ${all.length - changed.length} file(s) of its transpiler cache under the tripwire HOME's Library/Caches/bun (allowed)`);
  Rec.check(changed.length === 0, `nothing was written under the tripwire HOME (${changed.slice(0, 5).join(", ") || "none"})`);
  Rec.note(`run took ${Math.round((Date.now() - RUN_START) / 1000)} s; server log ${serverLog}`);
} catch (e) {
  Rec.check(false, "the rehearsal ran to its end", e instanceof Error ? e.stack?.slice(0, 600) : String(e));
} finally {
  await cleanup();
}
const failed = Rec.checks.filter((x) => x.ok === false).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
process.exit(failed ? 1 : 0);
