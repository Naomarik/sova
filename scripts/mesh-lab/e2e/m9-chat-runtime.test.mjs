// M9 (chat runtime) — Sova deployed fresh in a container, end to end (al_3 stage 6, next-team.md §0b): chats,
// workers and side commands each in a process of their own, a server restart that cuts nothing, a new-code
// rollout, the operator stop, and the idle exit with no server. Runs on `plain` (Sova with no tailscale):
//
//   scripts/mesh-lab/lab up [--rev <commit>]        (a PASS needs "built from: … (git archive, clean)")
//   scripts/mesh-lab/lab e2e m9-chat-runtime        (takes the lab LOCK; ~15 short zai/glm-5.3 turns)
//   M9_NEXT=<B>      the new code of step 6: a descendant of the image's commit A, with A's lockfile and
//                    package.json byte for byte (no install in the container); unset, step 6 is skipped
//   M9_CODE=copy     assert the copy path (code "copy", node_modules copied across filesystems); live|any
//
// What a container needs that a host doesn't, decided here (the architect's rulings DK-0..DK-10, al_3 stage 6):
// - Name: its own milestone beside m9-internet-relay; LOCK role "m9-chat-runtime" (no other harness uses it).
// - Driver: DETACHED. The image has no systemd, so the server's own probe picks detached sessions (health
//   `chatHost.driver`; SOVA_CHAT_DRIVER is never set): the Mac's driver, on Linux. A systemd-in-container image
//   (systemd as PID 1, cgroup mounts) is not built: doing it would need the user's OK, and the unit path is
//   certified on the host with stand-in units.
// - PID 1: docker-init (compose `init: true`). Detached chats are setsid children of the server; a restarted
//   server leaves them to PID 1, which reaps them when they end. Checked: no zombie after the stop and the idle exit.
// - Server restart: `lab sova-restart` sends SIGTERM to the server's own pid (/run/lab/sova.pid, written by the
//   entrypoint; start-server.sh and setpriv exec), never a process group, and by name only for an image from
//   before the pid file (anchored to the server's argv). No prompt here names server/index.ts. Chats have
//   their own session and log files, so they never hold the entrypoint's tee pipe. A container restart is a reboot.
// - Bun, no mise: /usr/local/bin/bun from oven/bun at mise.toml's pin; chats run on the server's own Bun
//   (process.execPath). Never run with SOVA_RUNTIME=node: sova.env is cleared at the start and at the end.
// - Code generations: the copies root (/sova/.agent/sova/chats/code) is on the agent volume and /sova on the
//   image's overlay: another filesystem, so node_modules is copied in full (health codeWhy says so).
//   SOVA_CHAT_CODE and SOVA_CHAT_CODE_ROOT are never set. A git-archive tree has no .git: a server without the
//   copy for such a tree runs chats live ("copy failed"); that run is a finding, never a PASS (M9_CODE=copy).
//   The image is never made a Git checkout.
// - New code: roll FORWARD, A (the image) to B (M9_NEXT), unpacked over /sova in the same container: the files
//   B removed deleted first, the bundle rebuilt, BUILD_COMMIT written last (tmp + mv); never a rename of /sova
//   (.agent is a mount in it), never an install. Then `lab sova-restart`: chats stay alive, so the older-code
//   badge and the one-at-a-time reloads show. A new image with the volume kept is a reboot (step 9).
// - Sockets: <state root>/chats/s/<hash>.sock, well under 107 bytes. Sandbox: not exercised (no bwrap in the
//   image; Sova's tool sandbox is per session, off by default, never turned on here; no tracked worktree).
// - Auth: only the zai api_key enters the lab (the lab's default); every chat, worker and side command is on
//   zai/glm-5.3. No Claude Code.
// Leaves: plain recreated from its image (when step 7 changed /sova), sova.env cleared, every chat process stopped,
// settings.json as found; the sessions it made stay on plain's agent volume.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { chat, client } from "../../chat-runtime-trial/lib.mjs";
import { provenanceOf, ROOT } from "../lab.mjs";
import { container, exec, hostUrl, lab, labToken, readAgentFile, requireLab, sh, waitFor, writeAgentFile } from "./lib.mjs";
import { releaseLock, takeLock } from "./links-lib.mjs";

const N = "plain";
const MODEL = "zai/glm-5.3";
const CHATS = "/sova/.agent/sova/chats";
const AGENT = "/sova/.agent";
const CHAT_MAIN = "server/chat-runtime/main.ts";
const RESUME_TEXT = "The Sova server restarted and cut off your last turn. Continue where you left off.";
const CRASH_RESUME_TEXT = "This chat's process stopped unexpectedly and cut off your last turn. Continue where you left off.";
/** What health's chatHost must say about the code: "copy" (the copy path, across filesystems) or "live". */
const CODE = process.env.M9_CODE ?? "any";
const COPY_WHY = "full node_modules copy (another filesystem)";

const c = client(hostUrl(N), labToken());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

// ---- inside the container ------------------------------------------------------------------------------

/** Every process (from /proc), the chat registry and worker records, and the server's pid. */
const PROBE = `
const fs=require("fs"),p=require("path");
const rd=(d)=>{try{return fs.readdirSync(d).filter(f=>f.endsWith(".json")).map(f=>{try{return JSON.parse(fs.readFileSync(p.join(d,f),"utf8"))}catch{return null}}).filter(Boolean)}catch{return []}};
const procs=[];
for(const d of fs.readdirSync("/proc")){if(!/^\\d+$/.test(d))continue;try{
  const st=fs.readFileSync("/proc/"+d+"/stat","utf8");const f=st.slice(st.lastIndexOf(")")+2).split(" ");
  const cmd=fs.readFileSync("/proc/"+d+"/cmdline","utf8").split("\\0").filter(Boolean);
  let exe="";try{exe=fs.readlinkSync("/proc/"+d+"/exe")}catch{}
  procs.push({pid:+d,state:f[0],ppid:+f[1],pgid:+f[2],sid:+f[3],cmd:cmd.join(" "),exe});
}catch{}}
let serverPid=0;try{serverPid=+fs.readFileSync("/run/lab/sova.pid","utf8")}catch{}
console.log(JSON.stringify({procs,registry:rd("${CHATS}/registry"),workers:rd("${CHATS}/workers"),serverPid}));`;
function probe() {
  const r = exec(N, ["node", "-e", PROBE]);
  if (r.code !== 0) throw new Error(`probe: ${r.err}`);
  return JSON.parse(r.out);
}
const chatProcs = (pr = probe()) => pr.procs.filter((p) => p.cmd.includes(CHAT_MAIN) && p.state !== "Z");
const zombies = (pr = probe()) => pr.procs.filter((p) => p.state === "Z");
const recordOf = (path, pr = probe()) => pr.registry.find((r) => r.sessionPath === path) ?? null;
/** The chat's live process: its registry record's pid while a chat process has it. */
function pidOf(path, pr = probe()) {
  const r = recordOf(path, pr);
  return r && pr.procs.some((p) => p.pid === r.pid && p.cmd.includes(CHAT_MAIN) && p.state !== "Z") ? r.pid : 0;
}
const procOf = (pid, pr = probe()) => pr.procs.find((p) => p.pid === pid) ?? null;
const workersOf = (path, pr = probe()) => pr.workers.filter((w) => w.parent?.path === path);

/** The session file's entries (read in the container). */
function entries(path) {
  const r = exec(N, ["cat", path]);
  return r.code === 0 ? r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const text = (m) => (Array.isArray(m?.content) ? m.content.map((p) => p.text ?? (p.type === "toolCall" ? JSON.stringify(p.arguments) : "")).join("") : String(m?.content ?? ""));
const userEntriesWith = (path, s) => entries(path).filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes(s)).length;
/** The messages after the user message that holds `marker` (that turn), up to the next user message. */
function turnOf(path, marker) {
  const es = entries(path).filter((e) => e.type === "message");
  const at = es.findIndex((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes(marker));
  if (at < 0) return [];
  const out = [];
  for (const e of es.slice(at + 1)) {
    if (e.message?.role === "user") break;
    out.push(e.message);
  }
  return out;
}
/** GET /api/health, retried once (a pooled connection dies with the server at each restart). */
async function health() {
  const get = async () => (await fetch(`${hostUrl(N)}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  try {
    return await get();
  } catch {
    return get();
  }
}
/** A JSON API call, retried once on a connection the last server left behind. */
async function api(path, init) {
  try {
    return await c.api(path, init);
  } catch (e) {
    if (!/fetch failed/.test(String(e?.message))) throw e;
    return c.api(path, init);
  }
}
const sovaLog = () => exec(N, ["cat", "/var/log/lab/sova.log"]).out.split("\n");

// ---- chats -----------------------------------------------------------------------------------------------

let prompts = 0;
function prompt(s, text) {
  const clientId = `m9-${Date.now()}-${++prompts}`;
  s.send({ type: "prompt", text, clientId });
  return clientId;
}
const settled = (s, from = 0, ms = 240000) => s.until((m) => m.type === "event" && m.event?.type === "run.settled", ms, "run.settled", from);
async function turn(o, text, ms) {
  const from = o.s.got.length;
  prompt(o.s, text);
  await settled(o.s, from, ms);
}
async function newChat() {
  const { path } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/root/work" }) });
  return open(path);
}
async function open(path) {
  const s = await chat(c, path, 60000);
  s.send({ type: "set_model", ref: MODEL });
  const m = await s.until((x) => x.type === "model" || x.type === "error", 15000, "set_model answer");
  assert.equal(m.type, "model", `set_model ${MODEL}: ${JSON.stringify(m)}`);
  return { path, s };
}
/** Until the chat runs no turn (its summary's busy flag, false twice in a row). */
async function quiet(path, timeoutMs = 240000) {
  const id = entries(path)[0]?.id;
  let calm = 0;
  await waitFor(
    async () => {
      const r = await api(`/api/sessions/by-id/${id}`).catch(() => ({ busy: true }));
      calm = r && !r.busy ? calm + 1 : 0;
      return calm >= 2;
    },
    { timeoutMs, intervalMs: 1500, what: `${path} quiet` },
  );
}

// ---- state shared by the steps ----------------------------------------------------------------------------

let cfg;
let built; // the image's provenance
let settingsBefore = null;
let changedCode = false;
let envSet = false;
const chats = {}; // A, B, C: { path, s }

describe("M9 chat runtime: a fresh deploy in a container", { concurrency: false }, () => {
  before(async () => {
    cfg = requireLab();
    assert.ok(cfg.plain, "m9 runs on `plain`: lab up without --no-plain");
    await takeLock("m9-chat-runtime");
    built = provenanceOf(N);
    console.log(`# built from: ${built ? `${built.commit.slice(0, 12)} (${built.source}${built.dirty.length ? `, DIRTY: ${built.dirty.length} path(s)` : ", clean"}); lab build files: ${built.labBuildFiles}` : "unknown"}`);
    // /compact-handoff needs history older than pi's kept tail: a small tail, so two short turns do.
    settingsBefore = readAgentFile(N, "settings.json");
    const settings = { ...(settingsBefore ? JSON.parse(settingsBefore) : {}), compaction: { enabled: true, keepRecentTokens: 400 } };
    writeAgentFile(N, "settings.json", `${JSON.stringify(settings, null, 2)}\n`);
    lab("sova-env", N, "--clear");
  });

  after(async () => {
    for (const o of Object.values(chats)) o.s?.close();
    try {
      if (envSet) lab("sova-env", N, "--clear");
      // Every chat process stopped, as the operator does: the server first, then stop-chats.
      lab("sova-stop", N);
      exec(N, ["sh", "-c", `cd /sova && PI_CODING_AGENT_DIR=${AGENT} bun scripts/stop-chats.ts`], { timeoutMs: 120000 });
      lab("sova-start", N);
      if (settingsBefore !== null) writeAgentFile(N, "settings.json", settingsBefore.endsWith("\n") ? settingsBefore : `${settingsBefore}\n`);
      if (changedCode) {
        // /sova was changed in place (step 7): plain again as its image built it, volumes kept.
        spawnSync("docker", ["rm", "-f", container(N)], { stdio: "ignore" });
        lab("up", "--no-build");
      }
    } finally {
      releaseLock();
    }
  });

  test("0. provenance: git archive of a named commit, clean (no --dirty for a PASS)", () => {
    assert.ok(built, "no /sova/BUILD_COMMIT");
    assert.equal(built.source, "git archive", `built from ${built.source}`);
    assert.deepEqual(built.dirty, []);
    assert.match(built.commit, /^[0-9a-f]{40}$/);
  });

  test("1. /api/health: on Bun, detached chat host, Bun for chats, the code it runs", async () => {
    const h = await health();
    assert.equal(h.ok, true);
    assert.equal(h.runtime?.name, "bun", JSON.stringify(h.runtime));
    assert.equal(h.chatHost?.driver, "detached", JSON.stringify(h.chatHost));
    assert.ok(!("bun" in h.chatHost), `chatHost.bun present: ${JSON.stringify(h.chatHost)}`);
    console.log(`# chatHost: ${JSON.stringify(h.chatHost)}`);
    if (CODE === "copy") assert.deepEqual([h.chatHost.code, h.chatHost.codeWhy], ["copy", COPY_WHY]);
    else if (CODE === "live") assert.equal(h.chatHost.code, "live");
    else assert.ok(["copy", "live"].includes(h.chatHost.code));
    if (h.chatHost.code === "copy") assert.equal(h.chatHost.codeWhy, COPY_WHY, "the copies root is on another filesystem than /sova");
    assert.ok(sovaLog().some((l) => l.includes("chats run in processes of their own, as detached sessions")), "the server logs its detached chat host");
  });

  test("2. sign in: the token opens the API, a wrong one does not", async () => {
    const at = (headers) => fetch(`${hostUrl(N)}/api/sessions`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.status);
    assert.equal(await at({}), 401);
    assert.equal(await at({ "x-sova-token": "not-the-token" }), 401);
    assert.equal(await at({ "x-sova-token": labToken() }), 200);
  });

  test("3. three chats open, each in a process of its own (setsid, Bun, a short socket)", async () => {
    for (const k of ["A", "B", "C"]) chats[k] = await newChat();
    const pr = probe();
    const pids = new Set();
    for (const [k, o] of Object.entries(chats)) {
      const pid = pidOf(o.path, pr);
      assert.ok(pid, `${k} has a live chat process`);
      const p = procOf(pid, pr);
      assert.equal(p.sid, pid, `${k} leads its own session`);
      assert.equal(p.ppid, pr.serverPid, `${k} was started by the server`);
      assert.equal(p.exe, "/usr/local/bin/bun", `${k} runs on Bun`);
      const sock = recordOf(o.path, pr).sock;
      assert.ok(sock.startsWith(`${CHATS}/s/`) && Buffer.byteLength(sock) < 107, `${k}'s socket ${sock}`);
      assert.equal(sh(N, `test -S '${sock}' && echo ok`).out, "ok", `${k}'s socket exists`);
      pids.add(pid);
    }
    assert.equal(pids.size, 3);
    await turn(chats.A, "Reply with exactly: M9-A-READY");
    assert.ok(entries(chats.A.path).some((e) => e.message?.role === "assistant" && text(e.message).includes("M9-A-READY")), "A answered on zai/glm-5.3");
  });

  test("4. /btw, /explain and /compact-handoff each run in a hidden chat process of their own", async () => {
    const A = chats.A;
    await turn(A, "Explain in three short paragraphs how a B-tree splits a full node.");
    const sid = entries(A.path)[0]?.id;
    const parentPid = pidOf(A.path);
    const hiddenPid = async (kind) => {
      const w = await waitFor(() => workersOf(A.path).find((r) => r.kind === kind), { timeoutMs: 60000, what: `a ${kind} record` });
      const pid = await waitFor(() => pidOf(w.path), { timeoutMs: 60000, what: `${kind}'s process` });
      assert.ok(pid !== parentPid && pid !== probe().serverPid, `${kind} runs apart (${pid}, parent ${parentPid})`);
      return pid;
    };
    // /explain first (glm takes minutes to write its page), and /btw beside it.
    prompt(A.s, "/explain splits a full node");
    await hiddenPid("explain");
    // /btw: the answer lands in the parent as a btw-note, once.
    prompt(A.s, "/btw What is the main trade-off of a higher B-tree order?");
    await hiddenPid("btw");
    const notes = () => entries(A.path).filter((e) => e.customType === "btw-note").length;
    await waitFor(() => notes() >= 1, { timeoutMs: 180000, intervalMs: 2000, what: "the /btw answer" });
    await sleep(3000);
    assert.equal(notes(), 1, "one btw-note");
    // /explain: one settled row, never interrupted or failed, and its page.
    const docs = () => entries(A.path).filter((e) => e.customType === "explain-doc").map((e) => e.data ?? {});
    await waitFor(() => docs().some((d) => d.status !== "running"), { timeoutMs: 15 * 60000, intervalMs: 5000, what: "/explain settles" });
    await sleep(3000);
    assert.equal(docs().filter((d) => d.status !== "running").length, 1, JSON.stringify(docs().map((d) => d.status)));
    assert.ok(docs().every((d) => !["interrupted", "failed"].includes(d.status) && !d.error), JSON.stringify(docs()));
    assert.match(sh(N, `ls ${AGENT}/explanations/*/index.html | head -1`).out, /index\.html$/);
    // /compact-handoff: the note is saved, then the session compacts. It waits for an idle session (the
    // explanation's completion wakes A for a turn) and says so; then it is sent again.
    await quiet(A.path);
    let f = A.s.got.length;
    for (let i = 0; i < 3; i++) {
      f = A.s.got.length;
      prompt(A.s, "/compact-handoff keep the SSD point");
      const r = await A.s.until((m) => (m.type === "append" && m.items?.some((x) => x.handoffRun)) || (m.type === "ui_request" && /waits for an idle session/.test(m.request?.message ?? "")), 60000, "the handoff starts", f);
      if (r.type === "append") break;
      await quiet(A.path);
    }
    await hiddenPid("handoff");
    const note = `${AGENT}/compact-handoffs/${sid}.md`;
    await waitFor(() => sh(N, `test -s '${note}' && echo ok`).out === "ok", { timeoutMs: 240000, what: "the handoff note" });
    const rows = () => entries(A.path).filter((e) => e.customType === "compact-handoff-run").map((e) => e.data?.status);
    await waitFor(() => rows().includes("saved"), { timeoutMs: 60000, what: "the saved row" });
    await waitFor(
      () => {
        const es = entries(A.path);
        const saved = es.findLastIndex((e) => e.customType === "compact-handoff-run" && e.data?.status === "saved");
        return saved >= 0 && es.slice(saved + 1).some((e) => e.type === "compaction");
      },
      { timeoutMs: 180000, what: "a compaction after the saved row" },
    );
    assert.ok(!rows().includes("interrupted"), JSON.stringify(rows()));
    await settled(A.s, f, 120000).catch(() => {});
  });

  test("5. a server restart inside the container cuts nothing: chats, a worker and a running reply go on", async () => {
    const { B, C } = chats;
    // A worker from C, on zai, busy for a while.
    const spawnText =
      'Use the agent_spawn tool now to start exactly one worker with name "m9w", model "zai/glm-5.3", and this task: ' +
      '"Run the bash command `sleep 75; echo M9-WORKER-DONE` and reply with its output only." Do not wait for it. After spawning, reply with the single word: spawned';
    let w = null;
    for (let i = 0; i < 2 && !w; i++) {
      await turn(C, spawnText);
      w = await waitFor(() => workersOf(C.path).find((r) => r.kind === "worker" || r.spec?.name === "m9w"), { timeoutMs: 30000, what: "C's worker" }).catch(() => null);
    }
    assert.ok(w, `glm started no worker from C: ${JSON.stringify(probe().workers.map((r) => r.kind))}`);
    const wpid = await waitFor(() => pidOf(w.path), { timeoutMs: 60000, what: "the worker's process" });
    await waitFor(() => entries(w.path).some((e) => e.message?.role === "assistant" && JSON.stringify(e.message.content).includes("sleep 75")), { timeoutMs: 120000, what: "the worker's sleep running" });
    // B's reply runs a slow command; the restart lands in the middle of it.
    prompt(B.s, "Run the bash command `sleep 25; echo M9-REPLY-DONE` and then reply with only its output.");
    await waitFor(() => turnOf(B.path, "M9-REPLY-DONE").some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("sleep 25")), { timeoutMs: 120000, what: "B's command running" });
    const before = probe();
    const pids = { A: pidOf(chats.A.path, before), B: pidOf(B.path, before), C: pidOf(C.path, before), w: wpid };
    const started0 = (await health()).startedAt;
    lab("sova-restart", N);
    await waitFor(async () => (await health().catch(() => null))?.startedAt !== started0, { timeoutMs: 90000, what: "a new server" });
    const after1 = probe();
    assert.notEqual(after1.serverPid, before.serverPid, "a new server process");
    for (const [k, pid] of Object.entries(pids)) {
      assert.equal(pidOf(k === "w" ? w.path : chats[k].path, after1), pid, `${k} kept its process`);
      assert.equal(procOf(pid, after1).ppid, 1, `${k} now belongs to PID 1 (docker-init)`);
    }
    assert.equal(procOf(1, after1).cmd.split(" ")[0], "/sbin/docker-init");
    // B's reply ran on: the command's output, then a normal end, once, and no "continue" from the server.
    await waitFor(() => turnOf(B.path, "M9-REPLY-DONE").some((m) => m.role === "assistant" && m.stopReason === "stop" && !JSON.stringify(m.content).includes("toolCall")), {
      timeoutMs: 180000,
      what: "B's reply ends",
    });
    const bt = turnOf(B.path, "M9-REPLY-DONE");
    assert.ok(bt.some((m) => m.role === "toolResult" && text(m).includes("M9-REPLY-DONE")), "the command ran to its end");
    assert.ok(bt.every((m) => m.stopReason !== "aborted" && m.stopReason !== "error"), JSON.stringify(bt.map((m) => m.stopReason)));
    assert.equal(userEntriesWith(B.path, "M9-REPLY-DONE"), 1);
    assert.equal(userEntriesWith(B.path, RESUME_TEXT), 0, "no server-restarted continue");
    assert.equal(userEntriesWith(B.path, CRASH_RESUME_TEXT), 0, "no crash resume");
    // Panes reconnect with a hello.
    for (const k of ["A", "B", "C"]) {
      chats[k].s.close();
      chats[k] = await open(chats[k].path);
    }
    // The worker finishes once, into C.
    const done = () => entries(C.path).filter((e) => e.customType === "subagent-complete" && JSON.stringify(e).includes("M9-WORKER-DONE")).length;
    await waitFor(() => done() >= 1, { timeoutMs: 240000, what: "the worker's completion in C" });
    await sleep(5000);
    assert.equal(done(), 1, "one completion");
    assert.ok(entries(w.path).some((e) => e.message?.role === "toolResult" && text(e.message).includes("M9-WORKER-DONE")), "the worker's command ran to its end");
  });

  test("6. new code rolls out: the attached chat shows older code, quiet chats reload one at a time", async (t) => {
    if (!process.env.M9_NEXT) return t.skip("M9_NEXT unset: name B, a descendant of the image's commit with its lockfile");
    const from = built.commit;
    const next = git("rev-parse", "--verify", `${process.env.M9_NEXT}^{commit}`).stdout.trim();
    assert.match(next, /^[0-9a-f]{40}$/, "M9_NEXT names a commit");
    assert.notEqual(next, from);
    assert.equal(git("merge-base", "--is-ancestor", from, next).status, 0, `${next.slice(0, 12)} descends from the image's ${from.slice(0, 12)}`);
    assert.equal(git("diff", "--quiet", from, next, "--", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml").status, 0, "A and B differ in dependencies: pick another pair (no install in the container)");
    // Quiet everything first (C's wake turn after the completion, A's compaction).
    for (const k of ["A", "B", "C"]) await quiet(chats[k].path);
    // Each chat runs A's own copy (the copy path) or, with no copy, the checkout itself (the finding).
    const runsFrom = (pid) => (procOf(pid)?.cmd ?? "").split(" ").find((a) => a.endsWith(CHAT_MAIN)) ?? "";
    const code0 = (await health()).chatHost.code;
    for (const k of ["A", "B", "C"]) {
      const where = runsFrom(pidOf(chats[k].path));
      console.log(`# ${k} runs ${where}`);
      if (code0 === "copy") assert.ok(where.startsWith(`${CHATS}/code/${from}/`), `${k} runs A's copy: ${where}`);
    }
    const copyOfA = `${CHATS}/code/${from}`;
    if (code0 === "copy") {
      // The copy holds the code alone: no agent dir (auth.json, sessions), no page builds.
      assert.equal(sh(N, `test ! -e ${copyOfA}/.agent && test ! -e ${copyOfA}/dist && test ! -e ${copyOfA}/dist-share && echo ok`).out, "ok", "no .agent, dist or dist-share in A's copy");
      assert.equal(sh(N, `find ${CHATS}/code/ -name auth.json | head -1`).out, "", "no auth.json anywhere under the copies root");
    }
    // B over /sova, as a pull on a live checkout: the files B removed go first, then B's files, both page
    // builds, and its stamp last. Chats keep running meanwhile.
    changedCode = true;
    const pidsBefore = { A: pidOf(chats.A.path), B: pidOf(chats.B.path), C: pidOf(chats.C.path) };
    const gone = git("diff", "--no-renames", "--name-only", "--diff-filter=D", from, next).stdout.split("\n").filter(Boolean);
    if (gone.length) assert.equal(exec(N, ["sh", "-c", 'cd /sova && rm -f -- "$@"', "-", ...gone]).code, 0, "deleting what B removed");
    const tar = spawnSync("sh", ["-c", `git -C "$1" archive "$2" | docker exec -i "$3" tar -x -C /sova`, "-", ROOT, next, container(N)], { stdio: "inherit" });
    assert.equal(tar.status, 0, "unpacking B");
    assert.equal(exec(N, ["sh", "-c", "cd /sova && pnpm exec vite build >/dev/null && pnpm exec vite build --mode share >/dev/null"], { timeoutMs: 600000 }).code, 0, "vite builds");
    exec(N, ["sh", "-c", "cat > /sova/BUILD_COMMIT.tmp && mv /sova/BUILD_COMMIT.tmp /sova/BUILD_COMMIT"], { input: `${JSON.stringify({ commit: next, source: "git archive (m9 rollout)", rolledOverFrom: from, at: new Date().toISOString() })}\n` });
    if (code0 === "copy") {
      // A file B changed still reads A's bytes in A's copy, and a quiet chat on A's copy still answers.
      const changed = git("diff", "--no-renames", "--name-only", "--diff-filter=M", from, next, "--", "server", "shared", "pi-config").stdout.split("\n").filter(Boolean)[0];
      assert.ok(changed, "A and B differ in some server, shared or pi-config file");
      const sha = (rev) => createHash("sha256").update(spawnSync("git", ["-C", ROOT, "show", `${rev}:${changed}`]).stdout).digest("hex");
      const inCopy = sh(N, `sha256sum '${copyOfA}/${changed}' | cut -d' ' -f1`).out;
      assert.equal(inCopy, sha(from), `${changed} in A's copy is A's`);
      assert.notEqual(inCopy, sha(next));
      await turn(chats.B, "Reply with exactly: M9-STILL-ON-A");
      assert.ok(entries(chats.B.path).some((e) => e.message?.role === "assistant" && text(e.message).includes("M9-STILL-ON-A")), "B answers on A's copy after the unpack");
    }
    const pr0 = probe();
    for (const [k, pid] of Object.entries(pidsBefore)) assert.equal(pidOf(chats[k].path, pr0), pid, `${k} ran on through the code change`);
    // B and C nobody watches; A stays attached.
    chats.B.s.close();
    chats.C.s.close();
    const logFrom = sovaLog().length;
    const started0 = (await health()).startedAt;
    lab("sova-restart", N);
    await waitFor(async () => (await health().catch(() => null))?.startedAt !== started0, { timeoutMs: 120000, what: "the server on new code" });
    chats.A.s.close();
    chats.A = await open(chats.A.path);
    const older = await chats.A.s.until((m) => m.type === "code" && m.state === "older", 60000, "A's older-code badge").catch(() => null);
    assert.ok(older, `A, attached, shows older code (${JSON.stringify(chats.A.s.got.filter((m) => m.type === "code"))})`);
    for (const k of ["B", "C"])
      await waitFor(() => recordOf(chats[k].path)?.build === next && pidOf(chats[k].path) && pidOf(chats[k].path) !== pidsBefore[k], { timeoutMs: 240000, what: `${k} reloads onto ${next.slice(0, 8)}` });
    assert.equal(pidOf(chats.A.path), pidsBefore.A, "A, attached, did not reload by itself");
    // One at a time: no reload starts while another is under way.
    const lines = sovaLog().slice(logFrom).filter((l) => l.includes("[chat-rollout]") && /: (reloading|reloaded into)/.test(l));
    let open1 = 0;
    for (const l of lines) {
      open1 += / reloading/.test(l) ? 1 : -1;
      assert.ok(open1 >= 0 && open1 <= 1, `reloads overlap:\n${lines.join("\n")}`);
    }
    assert.ok(lines.filter((l) => / reloading/.test(l)).length >= 2, lines.join("\n"));
    // Reload now on A.
    const f = chats.A.s.got.length;
    chats.A.s.send({ type: "reload_code" });
    const bye = await chats.A.s.until((m) => m.type === "error" && m.code === "reloaded", 60000, "A reloaded", f).catch(() => null);
    assert.ok(bye, "Reload now reloads A");
    chats.A.s.close();
    await waitFor(() => recordOf(chats.A.path)?.build === next && pidOf(chats.A.path), { timeoutMs: 60000, what: "A on the new code" });
    chats.A = await open(chats.A.path);
    await sleep(3000);
    assert.ok(chats.A.s.got.filter((m) => m.type === "code").every((m) => m.state !== "older"), "no badge after the reload");
    const h = await health();
    console.log(`# after the rollout to ${next.slice(0, 12)}: chatHost ${JSON.stringify(h.chatHost)}`);
    if (code0 === "copy") {
      // One node_modules copy for the lockfile, shared by both generations. A's copy, unused once every chat
      // reloaded and older than 10 minutes, may already be collected (§app.chat-processes/code-generations).
      const deps = sh(N, `ls ${CHATS}/code/deps`).out.split("\n").filter(Boolean);
      assert.equal(deps.length, 1, `one deps copy: ${deps.join(" ")}`);
      assert.equal(sh(N, `readlink ${CHATS}/code/${next}/node_modules`).out, `../deps/${deps[0]}/node_modules`, "B's copy uses it");
      const aLink = sh(N, `readlink ${CHATS}/code/${from}/node_modules`).out;
      console.log(`# A's copy: ${aLink ? `kept, node_modules -> ${aLink}` : "collected (no chat runs it)"}`);
      if (aLink) assert.equal(aLink, `../deps/${deps[0]}/node_modules`, "A's copy uses it");
      // The deps copy is whole: as many files and links as the image's node_modules, and as many file bytes.
      const tally = (d) => sh(N, `cd '${d}' && echo $(find . -type f | wc -l) $(find . -type l | wc -l) $(find . -type f -printf '%s\\n' | awk '{s+=$1} END {print s}') $(du -sb --apparent-size . | cut -f1)`).out.split(" ");
      const [img, dep] = [tally("/sova/node_modules"), tally(`${CHATS}/code/deps/${deps[0]}/node_modules`)];
      console.log(`# node_modules files/links/file bytes/du: image ${img.join(" ")}, deps copy ${dep.join(" ")}`);
      assert.deepEqual(dep.slice(0, 3), img.slice(0, 3), "the deps copy holds every file and link of the image's node_modules");
      const mb = sovaLog().filter((l) => /full node_modules copy, \d+ MB/.test(l));
      console.log(`# ${mb.join(" | ") || "no node_modules copy logged since the log began"}`);
      assert.ok(sovaLog().some((l) => l.includes(`chats run code ${next}`)), "the new server copied B");
    }
    assert.equal(h.chatHost.driver, "detached");
  });

  test("7. stop-chats: with Sova stopped for good, every chat process ends, and none is left a zombie", async () => {
    assert.ok(chatProcs().length >= 3, "chats run before the stop");
    lab("sova-stop", N);
    const r = exec(N, ["sh", "-c", `cd /sova && PI_CODING_AGENT_DIR=${AGENT} bun scripts/stop-chats.ts`], { timeoutMs: 120000 });
    assert.equal(r.code, 0, `stop-chats: ${r.out}\n${r.err}`);
    console.log(`# stop-chats: ${r.out.split("\n").slice(-1)[0]}`);
    await waitFor(() => chatProcs().length === 0, { timeoutMs: 30000, what: "no chat process" });
    await sleep(1000);
    assert.deepEqual(zombies(), [], "no zombie");
    lab("sova-start", N);
  });

  test("8. the idle exit: a chat with no server exits by itself after its idle time", async () => {
    lab("sova-env", N, "SOVA_CHAT_IDLE_MIN=0.5");
    envSet = true;
    lab("sova-restart", N);
    for (const k of ["A", "B"]) {
      chats[k].s.close();
      chats[k] = await open(chats[k].path);
    }
    const pids = [pidOf(chats.A.path), pidOf(chats.B.path)];
    assert.ok(pids.every(Boolean), "both reopened");
    for (const k of ["A", "B"]) chats[k].s.close();
    lab("sova-stop", N);
    const t0 = Date.now();
    await waitFor(() => !pids.some((p) => procOf(p)?.cmd.includes(CHAT_MAIN) && procOf(p).state !== "Z"), { timeoutMs: 120000, intervalMs: 2000, what: "the idle exit" });
    const took = Date.now() - t0;
    console.log(`# idle exit after ${Math.round(took / 1000)} s with no server`);
    assert.ok(took >= 20000, `exited too soon for a 0.5 min idle time (${took} ms): not the idle exit`);
    const logs = sh(N, `grep -l "no server, and quiet for 0.5 min: closing" ${CHATS}/logs/*.log | wc -l`).out;
    assert.ok(Number(logs) >= 2, `both chats logged their idle exit (${logs})`);
    await sleep(1000);
    assert.deepEqual(zombies(), [], "no zombie");
    lab("sova-env", N, "--clear");
    envSet = false;
    lab("sova-start", N);
    chats.A = await open(chats.A.path);
    assert.ok(chats.A.s.hello.items.length > 0, "A reopens with its history");
  });

  test("9. a container restart is a reboot: nothing survives, chats reopen with their history", async () => {
    chats.A.s.close();
    spawnSync("docker", ["restart", container(N)], { stdio: "ignore" });
    await waitFor(async () => (await health().catch(() => null))?.ok, { timeoutMs: 180000, what: "Sova after the reboot" });
    assert.deepEqual(chatProcs(), [], "no chat process from before the reboot");
    chats.B = await open(chats.B.path);
    assert.ok(chats.B.s.hello.items.length > 0, "B reopens with its history");
    assert.ok(pidOf(chats.B.path), "B runs in a process again");
    await sleep(5000);
    for (const k of ["A", "B", "C"]) {
      assert.equal(userEntriesWith(chats[k].path, RESUME_TEXT), 0, `${k}: no server-restarted continue`);
      assert.equal(userEntriesWith(chats[k].path, CRASH_RESUME_TEXT), 0, `${k}: no crash resume`);
    }
  });
});
