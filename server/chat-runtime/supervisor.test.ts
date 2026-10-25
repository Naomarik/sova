import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { envFileText, SystemdDriver, systemdRunArgv, type Exec } from "../project-services/drivers";
import { FakeDriver } from "./fake-driver";
import { execFileSync } from "node:child_process";
import { CHAT_PROCESS_ENV, chatDriver, chatEnv, chatProcessAlive, chatSocketPath, ChatSupervisor, chooseChatHost, exitOfLog, sweepOldChildren, nextEpoch, scrubChatProcessEnv, supervisorConfig, type ChatDeath, type SupervisorDeps } from "./supervisor";
import { GC_TIMER_OFF } from "./gc-timer";
import { gitCleanupConfigPath } from "../git-no-background";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-chat-supervisor-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

let dir: string;
let reg: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.PI_CODING_AGENT_DIR!, "t-"));
  reg = join(dir, "registry");
  clock = 1_000_000;
});

function make(driver: FakeDriver, extra: Partial<SupervisorDeps> = {}) {
  const deaths: ChatDeath[] = [];
  const owned = new Set<number>();
  const launched: { unit: string; sock: string; epoch: number }[] = [];
  const sup = new ChatSupervisor({
    driver,
    epoch: 7,
    launch: (c) => {
      launched.push({ unit: c.unit, sock: c.sock, epoch: c.epoch });
      return { argv: ["/opt/bun/bun", "server/chat-runtime/main.ts"], env: { SOVA_CHAT_ID: c.chatId, SOVA_CHAT_SOCK: c.sock }, build: "abc" };
    },
    onDeath: (d) => void deaths.push(d),
    ownPid: (pid) => {
      owned.add(pid);
      return () => owned.delete(pid);
    },
    registryDir: () => reg,
    deathsFile: () => join(dir, "deaths.jsonl"),
    socketPath: (id, suffix) => `/s/${id}${suffix ?? ""}.sock`,
    unitPrefix: "sova-chat-test01-",
    // Fake pids: never a real process's (and no ps in a unit test).
    isChatProcess: () => false,
    now: () => clock,
    // Waits pass on the fake clock.
    sleep: async (ms) => void (clock += ms),
    log: () => {},
    ...extra,
  });
  return { sup, deaths, owned, launched };
}

const chat = { chatId: "c1", sessionPath: "/s/c1.jsonl", cwd: "/w" };

test("a chat starts as its own unit, is recorded with its pid, socket and epoch, and counts as the server's own", async () => {
  const d = new FakeDriver();
  const { sup, owned, launched } = make(d);
  const rec = await sup.start(chat);
  assert.equal(rec.unit, "sova-chat-test01-c1");
  assert.equal(d.started[0]!.cwd, join(import.meta.dirname, "..", ".."), "the repository root, never the chat's cwd");
  assert.equal(rec.cwd, "/w");
  assert.deepEqual(d.started[0]!.argv, ["/opt/bun/bun", "server/chat-runtime/main.ts"]);
  assert.deepEqual(launched, [{ unit: "sova-chat-test01-c1", sock: "/s/c1.sock", epoch: 7 }]);
  assert.equal(rec.pid, 1000);
  assert.ok(owned.has(1000));
  const onDisk = JSON.parse(readFileSync(join(reg, "c1.json"), "utf8"));
  assert.deepEqual([onDisk.pid, onDisk.build, onDisk.sock, onDisk.epoch], [1000, "abc", "/s/c1.sock", 7]);
  // A second start of a running chat starts nothing.
  await sup.start(chat);
  assert.equal(d.started.length, 1);
});

test("a variable the env file can't carry is said once per name", async () => {
  const d = new FakeDriver();
  const lines: string[] = [];
  const { sup } = make(d, { launch: () => ({ argv: ["b"], env: { OK: "1", "BASH_FUNC_x%%": "() { :; }", ML: "a\nb" } }), log: (l) => void lines.push(l) });
  await sup.start(chat);
  await sup.start({ ...chat, chatId: "c2" });
  assert.deepEqual(lines.filter((l) => l.startsWith("env ")), ["env BASH_FUNC_x%% is not passed to chat processes (not a variable name)", "env ML is not passed to chat processes (a value on more than one line)"]);
});

test("a systemd-run failure leaves no record", async () => {
  const d = new FakeDriver();
  d.failNextStart = "systemd-run failed: boom";
  const { sup } = make(d);
  await assert.rejects(sup.start(chat), /boom/);
  assert.deepEqual(readdirSync(reg), []);
});

test("a chat process that dies is reported once, with systemd's exit and its last lines, in the deaths log too", async () => {
  const d = new FakeDriver();
  const { sup, deaths, owned } = make(d);
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(rec.unit, ["boot", "TypeError: boom", "sova-chat-test01-c1.service: Main process exited, code=exited, status=1/FAILURE", "sova-chat-test01-c1.service: Failed with result 'exit-code'."]);
  await sup.tick();
  await sup.tick();
  assert.equal(deaths.length, 1);
  assert.deepEqual([deaths[0]!.cause, deaths[0]!.exit, deaths[0]!.sessionPath], ["crashed", 1, "/s/c1.jsonl"]);
  assert.deepEqual(deaths[0]!.logTail, ["boot", "TypeError: boom"]);
  assert.equal(owned.size, 0);
  assert.deepEqual(readdirSync(reg), [], "the record goes once the death is delivered");
  const logged = readFileSync(join(dir, "deaths.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((x) => [x.chatId, x.exit]), [["c1", 1]]);
  assert.equal(await sup.check("c1"), "unknown");
});

test("two looks at one death race: it is reported once, and a process started from that report (a worker's resume) stays tracked and recorded", async () => {
  const d = new FakeDriver();
  let restarted: Promise<unknown> | null = null;
  const reports: ChatDeath[] = [];
  const { sup } = make(d, {
    onDeath: (death) => {
      reports.push(death);
      clock += 1000;
      restarted = sup.start(chat);
    },
  });
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(rec.unit, ["sova-chat-test01-c1.service: Main process exited, code=killed, status=9/KILL"]);
  await Promise.all([sup.check("c1"), sup.check("c1"), sup.tick()]);
  await restarted;
  assert.equal(reports.length, 1);
  const now = sup.record("c1");
  assert.ok(now && now.startedAt !== rec.startedAt, "the new process is tracked");
  assert.ok(readdirSync(reg).length === 1, "and its record kept");
  assert.equal(await sup.check("c1"), "up");
});

test("a signal death reads as crashed with the signal; a unit gone without a word is lost; exit 0 unannounced is an operator stop", async () => {
  assert.deepEqual(exitOfLog(["x.service: Main process exited, code=killed, status=9/KILL"]), { exit: null, signal: "KILL" });
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  const r1 = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(r1.unit, []);
  assert.equal(await sup.check("c1"), "died");
  assert.equal(deaths[0]!.cause, "lost");
  const r2 = await sup.start({ ...chat, chatId: "c2" });
  d.die(r2.unit, ["Main process exited, code=exited, status=0/SUCCESS"]);
  assert.equal(await sup.check("c2"), "ended");
  assert.equal(deaths.length, 1);
});

test("an exit the chat logged (no server linked to hear its frame), or systemd's clean deactivation, is no death", async () => {
  assert.deepEqual(exitOfLog(["sova-chat-x.service: Deactivated successfully."]), { exit: 0, signal: null });
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  const r1 = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(r1.unit, ["[chat-runtime] SIGTERM: closing", `[chat-runtime] exit operator (pid ${r1.pid})`]);
  assert.equal(await sup.check("c1"), "ended");
  const r2 = await sup.start({ ...chat, chatId: "c2" });
  sup.noteConnected("c2");
  d.die(r2.unit, ["sova-chat-test01-c2.service: Deactivated successfully."]);
  assert.equal(await sup.check("c2"), "ended");
  // Another process's line (an earlier run of the unit) says nothing about this one.
  const r3 = await sup.start({ ...chat, chatId: "c3" });
  sup.noteConnected("c3");
  d.die(r3.unit, ["[chat-runtime] exit idle (pid 1)"]);
  assert.equal(await sup.check("c3"), "died");
  assert.deepEqual(deaths.map((x) => x.chatId), ["c3"]);
});

test("systemd's journal, as a real user manager writes it: a stop by request, a kill, an earlier run of the same unit", () => {
  const u = "sova-chat-2e4b56-standin-chat-1.service";
  const started = `Started [systemd-run] /opt/bun/bin/bun -e "…"`;
  const killed = [started, `${u}: Sent signal SIGKILL to main process 1059474 (bun)`, `${u}: Main process exited, code=killed, status=9/KILL`, `${u}: Failed with result 'signal'.`];
  const stoppedClean = [started, `Stopping [systemd-run] /opt/bun/bin/bun -e "…"…`, `Stopped [systemd-run] /opt/bun/bin/bun -e "…".`];
  assert.deepEqual(exitOfLog(killed), { exit: null, signal: "KILL" });
  assert.deepEqual(exitOfLog(stoppedClean), { exit: 0, signal: null }, "a clean stop logs neither Main process exited nor Deactivated");
  assert.deepEqual(exitOfLog([...killed, ...stoppedClean]), { exit: 0, signal: null }, "an earlier run's kill says nothing about this run");
  assert.deepEqual(exitOfLog([started, `${u}: State 'stop-sigterm' timed out. Killing.`, `${u}: Main process exited, code=killed, status=9/KILL`, `${u}: Failed with result 'timeout'.`, `Stopped [systemd-run] x.`]), { exit: null, signal: "KILL" }, "killed at the end of the stop grace is no clean stop");
  assert.deepEqual(exitOfLog([started, `${u}: Failed with result 'oom-kill'.`]), { exit: null, signal: "oom-kill" });
  assert.equal(exitOfLog([started, "chat output"]), null);
});

test("a signal the driver saw itself (the detached driver) is the death's signal, not its exit 128", async () => {
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(rec.unit);
  d.table.get(rec.unit)!.status = { state: "failed", pid: null, exit: 128, signal: "SIGKILL" };
  await sup.check("c1");
  assert.deepEqual([deaths[0]!.cause, deaths[0]!.exit, deaths[0]!.signal], ["crashed", null, "KILL"]);
});

test("a death carries when systemd wrote down the end, when the journal has it", async () => {
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(rec.unit, [
    { t: "2026-10-12T10:00:00.000Z", text: "boom" },
    { t: "2026-10-12T10:00:01.250Z", text: "sova-chat-test01-c1.service: Main process exited, code=exited, status=1/FAILURE" },
    { t: "2026-10-12T10:00:01.260Z", text: "sova-chat-test01-c1.service: Failed with result 'exit-code'." },
  ]);
  clock += 5_000;
  await sup.check("c1");
  assert.equal(deaths[0]!.endedAt, "2026-10-12T10:00:01.250Z");
  const r2 = await sup.start({ ...chat, chatId: "c2" });
  sup.noteConnected("c2");
  d.die(r2.unit, ["Main process exited, code=killed, status=9/KILL"]);
  await sup.check("c2");
  assert.equal(deaths[1]!.endedAt, undefined, "no time in the log: none claimed");
});

test("a log that lags the process's end is read again before the chat is called lost", async () => {
  const d = new FakeDriver();
  let reads = 0;
  const logs = d.logs.bind(d);
  d.logs = async (unit: string, lines: number) => (++reads < 3 ? [] : logs(unit, lines));
  const { sup, deaths } = make(d);
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  d.die(rec.unit, ["sova-chat-test01-c1.service: Deactivated successfully."]);
  assert.equal(await sup.check("c1"), "ended");
  assert.equal(reads, 3);
  assert.equal(deaths.length, 0);
  // Never a word: lost, after a bounded number of reads.
  reads = -100;
  const r2 = await sup.start({ ...chat, chatId: "c2" });
  sup.noteConnected("c2");
  d.die(r2.unit, []);
  assert.equal(await sup.check("c2"), "died");
  assert.equal(reads, -100 + 5, "the first read and 4 more");
  assert.equal(deaths[0]!.cause, "lost");
});

test("a chat that ends before its first hello did not start: logged and handed to the router, never a death", async () => {
  const d = new FakeDriver();
  const failed: string[] = [];
  const lines: string[] = [];
  const { sup, deaths } = make(d, { onBootFailed: (id, x) => void failed.push(`${id}:${x.exit}`), log: (l) => void lines.push(l) });
  const rec = await sup.start(chat);
  d.die(rec.unit, ["chat-runtime: build b fails to boot (test)", "Main process exited, code=exited, status=3/NOTIMPLEMENTED"]);
  assert.equal(await sup.check("c1"), "boot-failed");
  assert.deepEqual(failed, ["c1:3"]);
  assert.equal(deaths.length, 0);
  assert.ok(lines.some((l) => /c1: its process did not start .*exit 3.*fails to boot/.test(l)));
  assert.deepEqual(readdirSync(reg), []);
  assert.throws(() => readFileSync(join(dir, "deaths.jsonl")), "not in the deaths log");
  // No hello in time: given up, also a failed start.
  await sup.start({ ...chat, chatId: "c2" });
  await sup.lost("c2", "no hello in 10 s");
  assert.deepEqual(failed, ["c1:3", "c2:null"]);
  assert.equal(deaths.length, 0);
});

test("a stop of the supervisor's own, or an exit the chat announced, is no death", async () => {
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  await sup.start(chat);
  await sup.stop("c1", "operator");
  assert.deepEqual(d.stopped, ["sova-chat-test01-c1"]);
  const rec = await sup.start({ ...chat, chatId: "c2" });
  sup.expectExit("c2", "closed");
  d.die(rec.unit, ["Main process exited, code=killed, status=9/KILL"]);
  assert.equal(await sup.check("c2"), "ended");
  assert.equal(deaths.length, 0);
  assert.deepEqual(readdirSync(reg), []);
});

test("a chat that stops answering is stopped and reported lost", async () => {
  const d = new FakeDriver();
  const { sup, deaths } = make(d);
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  await sup.lost("c1", "no hello in 60 s");
  assert.deepEqual(d.stopped, [rec.unit]);
  assert.deepEqual([deaths[0]!.cause, deaths[0]!.detail], ["lost", "no hello in 60 s"]);
});

test("a lost chat whose stop fails stays tracked, its record and code kept, no death; stopped again at each check, reported once its unit is gone (xreview #8)", async () => {
  const d = new FakeDriver();
  const lines: string[] = [];
  const { sup, deaths } = make(d, { log: (l) => lines.push(l) });
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  const realStop = d.stop.bind(d);
  let stops = 0;
  // The user manager refuses: the unit and its process run on.
  d.stop = async () => {
    stops++;
    throw new Error("Failed to connect to bus");
  };
  await sup.lost("c1", "it stopped answering");
  assert.equal(deaths.length, 0, "no false death");
  assert.equal(sup.record("c1")?.unit, rec.unit, "still tracked");
  assert.ok(existsSync(join(reg, "c1.json")), "its record kept");
  assert.deepEqual(sup.list().map((r) => r.build), ["abc"], "the code it runs is still in use");
  assert.equal(lines.filter((l) => /still there after a stop/.test(l)).length, 1);
  // A copy collection meanwhile keeps that code (old, not last good, no other record names it).
  const { collectGenerations } = await import("./generations");
  const root = join(dir, "code");
  mkdirSync(join(root, "abc"), { recursive: true });
  writeFileSync(join(root, "abc", ".complete"), "{}\n");
  const old = (Date.now() - 3_600_000) / 1000;
  const { utimesSync } = await import("node:fs");
  utimesSync(join(root, "abc", ".complete"), old, old);
  assert.deepEqual(await collectGenerations(new Set(sup.list().flatMap((r) => (r.build ? [r.build] : []))), { root }), []);
  assert.ok(existsSync(join(root, "abc")));
  // The watch stops it again; still refused: still no death, logged once.
  await sup.tick();
  assert.equal(stops, 2);
  assert.equal(deaths.length, 0);
  assert.equal(lines.filter((l) => /still there after a stop/.test(l)).length, 1);
  // The stop goes through: one death, the record gone.
  d.stop = realStop;
  await sup.tick();
  assert.deepEqual(deaths.map((x) => [x.chatId, x.cause, x.detail]), [["c1", "lost", "it stopped answering"]]);
  assert.equal(sup.record("c1"), undefined);
  await sup.tick();
  assert.equal(deaths.length, 1, "once");
});

test("a lost chat whose status reads gone while its process still runs (the user manager unreachable reads as missing) is kept, no death; reported once the process has ended", async () => {
  const d = new FakeDriver();
  let alive = true;
  const { sup, deaths } = make(d, { isChatProcess: () => alive });
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  // systemctl can't be reached: the stop fails, and status answers "missing" with no pid.
  d.stop = async () => {
    throw new Error("Failed to connect to bus");
  };
  d.status = async () => ({ state: "missing", pid: null });
  await sup.lost("c1", "it stopped answering");
  assert.equal(deaths.length, 0, "its process still runs chat-runtime/main.ts: not gone");
  assert.equal(sup.record("c1")?.unit, rec.unit);
  await sup.tick();
  assert.equal(deaths.length, 0);
  alive = false;
  await sup.tick();
  assert.deepEqual(deaths.map((x) => [x.chatId, x.cause]), [["c1", "lost"]]);
});

test("a lost chat whose unit status can't be read is settled by its recorded process: still running, kept; ended, reported once", async () => {
  const d = new FakeDriver();
  let alive = true;
  const { sup, deaths } = make(d, { isChatProcess: () => alive });
  await sup.start(chat);
  sup.noteConnected("c1");
  d.stop = async () => {
    throw new Error("Failed to connect to bus");
  };
  d.status = async () => {
    throw new Error("Failed to connect to bus");
  };
  await sup.lost("c1", "it stopped answering");
  await sup.tick();
  assert.equal(deaths.length, 0);
  alive = false;
  await sup.tick();
  await sup.tick();
  assert.deepEqual(deaths.map((x) => [x.chatId, x.cause]), [["c1", "lost"]]);
});

test("start waits for the chat's previous process still exiting, and its writer lock", async () => {
  const d = new FakeDriver();
  let locked = true;
  let polls = 0;
  let onPoll = () => {};
  const { sup } = make(d, {
    lockHeld: () => locked,
    pollMs: 100,
    sleep: async (ms) => {
      clock += ms;
      polls++;
      onPoll();
    },
  });
  const rec = await sup.start(chat);
  sup.expectExit("c1", "reload");
  d.exiting(rec.unit);
  const t0 = clock;
  // Gone a few polls later; the lock follows.
  onPoll = () => {
    if (polls === 3) d.die(rec.unit);
    if (polls === 5) locked = false;
  };
  const next = await sup.start(chat);
  assert.equal(polls, 5, "it waited for the unit, then the lock");
  assert.ok(clock > t0, "it waited");
  assert.equal(d.started.length, 2);
  assert.equal(next.pid, 1001);
  // Still there after 10 s: refused, nothing started.
  sup.expectExit("c1", "closed");
  d.exiting(next.unit);
  await assert.rejects(sup.start(chat), /still closing/);
  assert.equal(d.started.length, 2);
});

test("at a server start, running chats are adopted and dead ones reported once; unrecorded units of this server are stopped", async () => {
  const d = new FakeDriver();
  const first = make(d);
  await first.sup.start(chat);
  const dead = await first.sup.start({ ...chat, chatId: "c2" });
  const closed = await first.sup.start({ ...chat, chatId: "c3" });
  first.sup.expectExit("c3", "closed");
  // The server goes; its chats keep running. One dies while it is down, one closes as it said.
  first.sup.detach();
  d.die(dead.unit, ["Main process exited, code=exited, status=3/NOTIMPLEMENTED"]);
  d.die(closed.unit, []);
  await d.start({ unit: "sova-chat-test01-c1-r4", argv: [], cwd: "/", env: {} });
  await d.start({ unit: "sova-chat-other9-x", argv: [], cwd: "/", env: {} });
  const second = make(d);
  const { adopted, died } = await second.sup.adopt();
  assert.deepEqual(adopted.map((r) => r.chatId), ["c1"]);
  assert.ok(second.owned.has(adopted[0]!.pid!));
  assert.deepEqual(died.map((x) => [x.chatId, x.exit]), [["c2", 3]]);
  assert.equal(second.deaths.length, 1);
  assert.deepEqual(d.stopped, ["sova-chat-test01-c1-r4"], "a cut-off replacement goes; another state root's unit is never touched");
  second.sup.detach();
  const third = make(d);
  assert.equal((await third.sup.adopt()).died.length, 0, "no death is reported twice");
});

test("a death recorded but not delivered (the server died reporting it) is delivered at the next start", async () => {
  const d = new FakeDriver();
  const death: ChatDeath = { chatId: "c9", sessionPath: "/s/c9.jsonl", unit: "sova-chat-test01-c9", cause: "crashed", exit: 1, signal: null, logTail: [], at: "t" };
  writeFileSync(join(mkdirP(reg), "c9.json"), JSON.stringify({ chatId: "c9", sessionPath: "/s/c9.jsonl", cwd: "/", unit: death.unit, pid: 5, sock: "/s", epoch: 1, startedAt: "t", death }));
  const { sup, deaths } = make(d);
  await sup.adopt();
  assert.deepEqual(deaths, [death]);
  assert.deepEqual(readdirSync(reg), []);
});

function mkdirP(p: string) {
  mkdirSync(p, { recursive: true });
  return p;
}

test("a chat idle for 30 minutes is asked to drain; a refusal restarts the clock; an accepted drain is waited for", async () => {
  const d = new FakeDriver();
  const stopped: string[] = [];
  let answer = false;
  const drains: string[] = [];
  const { sup, deaths } = make(d, {
    onStopped: (id, cause) => void stopped.push(`${id}:${cause}`),
    drain: async (id, reason) => {
      drains.push(`${id}:${reason}`);
      if (answer) d.die(sup.record(id)!.unit, ["Main process exited, code=exited, status=0/SUCCESS"]);
      return { ok: answer };
    },
  });
  await sup.start(chat);
  sup.noteIdle("c1", true, clock - 60_000);
  clock += 28 * 60_000;
  sup.noteIdle("c1", true); // still idle: the clock keeps its start
  await sup.tick();
  assert.deepEqual(drains, []);
  clock += 60_000;
  await sup.tick();
  assert.deepEqual(drains, ["c1:idle"], "30 min from quiet.since");
  assert.deepEqual(stopped, [], "refused: still running");
  assert.equal(sup.record("c1")!.exiting, undefined);
  sup.noteIdle("c1", true);
  clock += 29 * 60_000;
  await sup.tick();
  assert.equal(drains.length, 1, "the clock restarted at the refusal");
  answer = true;
  clock += 60_000;
  await sup.tick();
  assert.deepEqual(stopped, ["c1:idle"]);
  assert.deepEqual(d.stopped, [], "it exited by itself");
  assert.equal(deaths.length, 0);
  assert.equal(sup.list().length, 0);
});

test("an accepted idle drain whose process doesn't exit within 30 s is stopped; idle 0 never stops", async () => {
  const d = new FakeDriver();
  const { sup } = make(d, { drain: async () => ({ ok: true }) });
  await sup.start(chat);
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  await sup.tick();
  assert.deepEqual(d.stopped, ["sova-chat-test01-c1"]);
  const never = make(new FakeDriver(), { idleMs: 0, drain: async () => ({ ok: true }) });
  await never.sup.start(chat);
  never.sup.noteIdle("c1", true);
  clock += 10 * 60 * 60_000;
  await never.sup.tick();
  assert.equal(never.sup.list().length, 1);
});

/** A clock the test moves by hand: `sleep` waits until `advance` passes its time, so two waits run side by side. */
function manualClock() {
  const sleepers: { at: number; wake: () => void }[] = [];
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    sleep: (ms: number) => new Promise<void>((wake) => void sleepers.push({ at: clock + ms, wake })),
    flush,
    /** Move `ms` ahead in `step`s, waking each sleeper due and letting what it starts run. */
    async advance(ms: number, step = 100) {
      for (const end = clock + ms; clock < end; ) {
        clock += step;
        for (const s of sleepers.filter((x) => x.at <= clock)) {
          sleepers.splice(sleepers.indexOf(s), 1);
          s.wake();
        }
        await flush();
      }
    },
  };
}

test("a chat started again while its idle close is waited for is never stopped by that close (the unit name is reused)", async () => {
  const d = new FakeDriver();
  const time = manualClock();
  const { sup } = make(d, {
    sleep: time.sleep,
    pollMs: 100,
    // It accepts and starts stopping: still there at the first look.
    drain: async (id) => {
      d.exiting(sup.record(id)!.unit);
      return { ok: true };
    },
  });
  const first = await sup.start(chat);
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  let closed = false;
  const ticking = sup.tick().then(() => void (closed = true));
  await time.flush();
  assert.equal(closed, false, "the idle close waits for the process to go");
  // pid1 exits; the server sees its link close and looks; someone sends to the chat at once.
  d.die(first.unit, [`[chat-runtime] exit idle (pid ${first.pid})`]);
  await sup.check("c1");
  const reopening = sup.start(chat);
  await time.flush();
  // The idle close's 30 s wait, and the reopen's, run on.
  await time.advance(31_000);
  await ticking;
  const second = await reopening;
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.unit, first.unit, "the same unit name");
  assert.deepEqual(d.stopped, [], "no stop was sent: pid1 exited by itself, and pid2 is never stopped");
  assert.deepEqual(await d.status(second.unit), { state: "active", pid: second.pid });
  assert.equal(sup.record("c1")?.pid, second.pid);
});

test("a chat started again while its idle close's late stop is on its way waits until that stop is done", async () => {
  const d = new FakeDriver();
  const time = manualClock();
  const { sup } = make(d, {
    sleep: time.sleep,
    pollMs: 100,
    // It accepts, then hangs: still its unit's main process when the 30 s are up.
    drain: async (id) => {
      d.exiting(sup.record(id)!.unit);
      return { ok: true };
    },
  });
  const first = await sup.start(chat);
  // The stop is slow to take effect (the service manager busy): pid1 exits by itself meanwhile, and the
  // unit name is free for a moment before the stop lands on whatever then runs under it.
  const stop = d.stop.bind(d);
  let late = false;
  d.stop = async (unit) => {
    if (!late) {
      late = true;
      d.die(unit, [`[chat-runtime] exit idle (pid ${first.pid})`]);
      await time.advance(500);
    }
    return stop(unit);
  };
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  const ticking = sup.tick();
  await time.flush();
  await time.advance(25_000);
  // Someone sends to it 25 s into the close's wait.
  const reopening = sup.start(chat);
  await time.advance(10_000);
  await ticking;
  const second = await reopening;
  assert.ok(late, "the late stop was sent");
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(await d.status(second.unit), { state: "active", pid: second.pid }, "the reopened chat's process still runs");
  assert.equal(sup.record("c1")?.pid, second.pid);
});

/** A chat whose process accepts its idle drain, then hangs (still its unit's main process when the 30 s
    are up), on a manual clock; its first stop is slow to land: `during` runs (pid1 exits by itself by
    default) and time moves `slowMs` on before the stop takes effect on whatever then runs under the name. */
async function hungIdleChat(o: { slowMs?: number; during?: (unit: string) => void | Promise<void> } = {}) {
  const d = new FakeDriver();
  const time = manualClock();
  const { sup } = make(d, {
    sleep: time.sleep,
    pollMs: 100,
    drain: async (id) => {
      d.exiting(sup.record(id)!.unit);
      return { ok: true };
    },
  });
  const first = await sup.start(chat);
  const stop = d.stop.bind(d);
  const sent = { late: false, landed: false };
  d.stop = async (unit) => {
    if (!sent.late) {
      sent.late = true;
      d.die(unit, [`[chat-runtime] exit idle (pid ${first.pid})`]);
      await o.during?.(unit);
      await time.advance(o.slowMs ?? 500);
      sent.landed = true;
    }
    return stop(unit);
  };
  return { d, time, sup, first, sent };
}

/** `p`'s outcome so far, without an unhandled rejection. */
function watchOutcome<T>(p: Promise<T>) {
  const o: { done: boolean; value?: T; error?: Error } = { done: false };
  p.then(
    (v) => Object.assign(o, { done: true, value: v }),
    (e: Error) => Object.assign(o, { done: true, error: e }),
  );
  return o;
}

test("two closes of one chat at once (an idle close and a worker stop's awaitExit): a start waits for both, and the later stop never reaches the new process", async () => {
  const { d, time, sup, first, sent } = await hungIdleChat();
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  const ticking = sup.tick();
  await time.flush();
  await time.advance(25_000);
  // A stop of the chat (stopWorker: drain, then awaitExit) joins the idle close, and someone reopens it.
  const exiting = sup.awaitExit("c1");
  await time.advance(1_000);
  const reopening = watchOutcome(sup.start(chat));
  await time.advance(10_000);
  await ticking;
  await exiting;
  await time.advance(1_000);
  assert.ok(sent.landed, "the idle close's late stop landed");
  assert.ok(reopening.done && !reopening.error, `the reopen started: ${reopening.error?.message}`);
  const second = reopening.value!;
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(await d.status(second.unit), { state: "active", pid: second.pid }, "the reopened chat's process still runs");
  assert.equal(sup.record("c1")?.pid, second.pid);
});

test("an idle close's 30 s run out with pid1 still the unit's main process, and another process is there by the stop: not stopped", async () => {
  const d = new FakeDriver();
  const { sup } = make(d, {
    // It accepts, then hangs.
    drain: async (id) => {
      d.exiting(sup.record(id)!.unit);
      return { ok: true };
    },
  });
  const first = await sup.start(chat);
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  const deadline = clock + 30_000;
  const status = d.status.bind(d);
  let swapped = false;
  d.status = async (unit) => {
    const st = await status(unit);
    // The wait's last look still sees pid1; by the next, another process runs under the name.
    if (!swapped && clock >= deadline && st.pid === first.pid) {
      swapped = true;
      d.table.get(unit)!.status = { state: "active", pid: 4242 };
    }
    return st;
  };
  await sup.tick();
  assert.ok(swapped, "the wait ran its 30 s out on pid1");
  assert.deepEqual(d.stopped, [], "the unit runs another process by the stop: not stopped");
  assert.deepEqual(await d.status(first.unit), { state: "active", pid: 4242 });
});

test("a start held by a close still going after 10 s is refused as still closing, at 10 s, starting nothing", async () => {
  const { d, time, sup } = await hungIdleChat();
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  const ticking = sup.tick();
  await time.flush();
  await time.advance(1_000);
  const t0 = clock;
  const reopening = watchOutcome(sup.start(chat));
  await time.advance(10_500);
  assert.ok(reopening.done, `refused within the 10 s wait (waited ${clock - t0} ms)`);
  assert.match(reopening.error?.message ?? "", /still closing/);
  assert.equal(d.started.length, 1, "nothing started");
  await time.advance(20_000);
  await ticking;
  assert.equal(d.started.length, 1);
});

test("a reopen of a chat whose exited process's stop takes over 10 s to land is refused, never started under the stop", async () => {
  let reopening: ReturnType<typeof watchOutcome<unknown>> | null = null;
  const { d, time, sup, sent } = await hungIdleChat({
    slowMs: 12_000,
    // pid1 has exited and its link's end forgot it: no record holds the reopen, only the close in flight.
    during: async () => {
      await sup.check("c1");
      reopening = watchOutcome(sup.start(chat));
      await time.flush();
    },
  });
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  const ticking = sup.tick();
  await time.flush();
  await time.advance(31_000);
  await ticking;
  assert.ok(sent.landed);
  const r = reopening as ReturnType<typeof watchOutcome<unknown>> | null;
  assert.ok(r?.done, "the reopen was answered");
  assert.match(r!.error?.message ?? "", /still closing/, "refused at 10 s, while the stop was still on its way");
  assert.equal(d.started.length, 1, "no process was started under the late stop");
});

test("awaitExit (a reload, a worker stop) holds a start of the chat too: its late stop never reaches the new process", async () => {
  const d = new FakeDriver();
  const time = manualClock();
  const { sup } = make(d, { sleep: time.sleep, pollMs: 100 });
  const first = await sup.start(chat);
  const stop = d.stop.bind(d);
  let landed = false;
  d.stop = async (unit) => {
    if (!landed) {
      d.die(unit, [`[chat-runtime] exit reload (pid ${first.pid})`]);
      await time.advance(500);
      landed = true;
    }
    return stop(unit);
  };
  // Its drain accepted; it hangs.
  sup.expectExit("c1", "reload");
  d.exiting(first.unit);
  const exiting = sup.awaitExit("c1");
  await time.flush();
  await time.advance(25_000);
  const reopening = watchOutcome(sup.start(chat));
  await time.advance(10_000);
  await exiting;
  await time.advance(1_000);
  assert.ok(landed, "awaitExit's late stop landed");
  assert.ok(reopening.done && !reopening.error, `the reopen started: ${reopening.error?.message}`);
  assert.deepEqual(await d.status(first.unit), { state: "active", pid: reopening.value!.pid }, "the reopened chat's process still runs");
});

test("an idle close's late stop never reaches another process found under the unit's name", async () => {
  const d = new FakeDriver();
  let other: number | null = null;
  const { sup } = make(d, {
    // pid1 exits as it accepts, and something else starts a process under the same unit name.
    drain: async (id) => {
      const unit = sup.record(id)!.unit;
      d.die(unit);
      await d.start({ unit, argv: [], cwd: "/", env: {} });
      other = (await d.status(unit)).pid;
      return { ok: true };
    },
  });
  const first = await sup.start(chat);
  sup.noteIdle("c1", true);
  clock += 30 * 60_000;
  await sup.tick();
  assert.notEqual(other, first.pid);
  assert.deepEqual(d.stopped, [], "the unit now runs another process: not stopped");
  assert.deepEqual(await d.status(first.unit), { state: "active", pid: other });
});

test("beyond the cap, the Claude children idle longest are let go; busy ones never", async () => {
  const d = new FakeDriver();
  const reaped: string[] = [];
  const { sup } = make(d, { claudeIdleMax: 2, reapClaude: (id) => void reaped.push(id) });
  for (const id of ["a", "b", "c", "d"]) await sup.start({ ...chat, chatId: id });
  sup.noteClaude("a", "busy");
  clock += 1;
  sup.noteClaude("b", "idle");
  clock += 1;
  sup.noteClaude("c", "idle");
  assert.deepEqual(reaped, []);
  clock += 1;
  sup.noteClaude("d", "idle");
  assert.deepEqual(reaped, ["b"]);
  sup.noteClaude("b", "none");
  sup.noteClaude("a", "idle");
  assert.deepEqual(reaped, ["b", "c"]);
});

test("a release that fails, or finds no child, counts the chat again; one unanswered for 30 s too", async () => {
  const d = new FakeDriver();
  const reaped: string[] = [];
  let answer: () => Promise<"released" | "none" | "busy"> = () => Promise.reject(new Error("The chat's process is not reachable right now."));
  const { sup } = make(d, { claudeIdleMax: 1, reapClaude: (id) => (reaped.push(id), answer()) });
  const flush = () => new Promise((r) => setImmediate(r));
  for (const id of ["a", "b", "c"]) await sup.start({ ...chat, chatId: id });
  sup.noteClaude("a", "idle");
  clock += 1;
  sup.noteClaude("b", "idle");
  assert.deepEqual(reaped, ["a"]);
  await flush();
  // The release failed: a is idle and counted again, so the next pass asks a again, never b instead.
  answer = async () => "none";
  sup.noteClaude("c", "busy");
  assert.deepEqual(reaped, ["a", "a"]);
  await flush();
  // "none": a had no child after all; with only b idle the cap holds.
  sup.noteClaude("c", "busy");
  assert.deepEqual(reaped, ["a", "a"]);
  // Unanswered: b counts as let go until 30 s pass.
  answer = () => new Promise(() => {});
  clock += 1;
  sup.noteClaude("c", "idle");
  assert.deepEqual(reaped, ["a", "a", "b"]);
  clock += 29_000;
  await sup.tick();
  assert.deepEqual(reaped, ["a", "a", "b"]);
  clock += 1_000;
  await sup.tick();
  assert.deepEqual(reaped, ["a", "a", "b", "b"]);
});

test("a reload replacement runs beside the chat under its own unit and socket, then takes its record", async () => {
  const d = new FakeDriver();
  const { sup, owned } = make(d);
  const old = await sup.start(chat);
  const rep = await sup.startReplacement("c1");
  assert.equal(rep.unit, "sova-chat-test01-c1-r7-1");
  assert.equal(rep.sock, "/s/c1-r7-1.sock");
  assert.equal(sup.record("c1")!.unit, old.unit, "not recorded until re-pointed");
  sup.expectExit("c1", "reload");
  d.die(old.unit);
  await sup.awaitExit("c1");
  sup.repoint("c1", rep);
  assert.equal(JSON.parse(readFileSync(join(reg, "c1.json"), "utf8")).unit, rep.unit);
  assert.deepEqual([...owned], [rep.pid]);
});

test("a replacement counts as the server's own from its start (it opens the chat before the repoint); one not used is let go", async () => {
  const d = new FakeDriver();
  const { sup, owned } = make(d);
  const old = await sup.start(chat);
  const rep = await sup.startReplacement("c1");
  assert.deepEqual([...owned].sort(), [old.pid, rep.pid].sort());
  await sup.stopUnit(rep.unit);
  assert.deepEqual([...owned], [old.pid]);
  const rep2 = await sup.startReplacement("c1");
  sup.expectExit("c1", "reload");
  d.die(old.unit);
  sup.repoint("c1", rep2);
  assert.deepEqual([...owned], [rep2.pid]);
});

test("a replacement's name is new in every server life: the next life's never names the unit or socket a chat was reloaded into before; a chat's own unit is never stopped as a replacement", async () => {
  const d = new FakeDriver();
  const first = make(d);
  const old = await first.sup.start(chat);
  const rep = await first.sup.startReplacement("c1");
  first.sup.expectExit("c1", "reload");
  d.die(old.unit);
  first.sup.repoint("c1", rep);
  first.sup.detach();
  // The next server life (another epoch) adopts c1 in its replacement's unit, and reloads it again.
  const next = make(d, { epoch: 8 }).sup;
  await next.adopt();
  assert.equal(next.record("c1")!.unit, rep.unit);
  const again = await next.startReplacement("c1");
  assert.notEqual(again.unit, rep.unit);
  assert.notEqual(again.sock, rep.sock);
  assert.equal(again.unit, "sova-chat-test01-c1-r8-1");
  await next.stopUnit(rep.unit);
  assert.equal((await d.status(rep.unit)).state, "active", "the chat's live unit is not stopped");
});

test("a stopping server keeps its chat processes' pids as its own; the next counts the recorded ones before it adopts them", async () => {
  const { claimRecordedChats } = await import("./supervisor");
  const d = new FakeDriver();
  const first = make(d);
  const a = await first.sup.start(chat);
  const gone = await first.sup.start({ ...chat, chatId: "c2" });
  first.sup.detach();
  assert.ok(first.owned.has(a.pid!), "still its own while the server finishes stopping");
  d.die(gone.unit, []);
  // The next server, before its supervisor exists (the build and systemd are awaited first).
  const early = new Set<number>();
  claimRecordedChats(
    (pid) => {
      early.add(pid);
      return () => early.delete(pid);
    },
    () => reg,
    () => true,
  );
  assert.deepEqual([...early].sort(), [a.pid, gone.pid].sort());
  // Its supervisor takes the claims over; the process that is gone is let go at adoption.
  const second = make(d, {
    ownPid: (pid) => {
      early.add(pid);
      return () => early.delete(pid);
    },
  });
  const { adopted } = await second.sup.adopt();
  assert.deepEqual(adopted.map((r) => r.chatId), ["c1"]);
  assert.deepEqual([...early], [a.pid]);
  second.sup.detach();
});

test("waitUnlocked: free at once, free after a while, or still held after 10 s", async () => {
  let held = 0;
  const { sup } = make(new FakeDriver(), { lockHeld: () => held-- > 0 });
  assert.equal(await sup.waitUnlocked("/s/c1.jsonl"), true);
  held = 3;
  assert.equal(await sup.waitUnlocked("/s/c1.jsonl"), true);
  held = Number.POSITIVE_INFINITY;
  const t0 = clock;
  assert.equal(await sup.waitUnlocked("/s/c1.jsonl"), false);
  assert.ok(clock - t0 >= 10_000);
});

test("knobs: slice, test driver, idle minutes and the Claude cap from the server's env", () => {
  assert.deepEqual(supervisorConfig({}), { slice: "sova-chats.slice", driver: "systemd", idleMs: 30 * 60_000, claudeIdleMax: 4 });
  assert.deepEqual(supervisorConfig({ SOVA_CHAT_SLICE: "sovatest.slice", SOVA_CHAT_DRIVER: "detached", SOVA_CHAT_IDLE_MIN: "0.05", SOVA_CHAT_CLAUDE_IDLE_MAX: "1" }), {
    slice: "sovatest.slice",
    driver: "detached",
    idleMs: 3_000,
    claudeIdleMax: 1,
  });
  assert.equal(supervisorConfig({ SOVA_CHAT_IDLE_MIN: "0" }).idleMs, 0);
  assert.equal(supervisorConfig({ SOVA_CHAT_IDLE_MIN: "soon" }).idleMs, 30 * 60_000);
  assert.equal(chatDriver({ slice: "x", driver: "detached" }).id, "detached");
});

test("chats run as systemd units where the user manager answers, else as detached sessions; no switch moves them into the server", async () => {
  const up = { available: async () => ({ ok: true, detail: "systemd user manager (v)" }) };
  const down = { available: async () => ({ ok: false, detail: "no systemd user manager reachable" }) };
  assert.equal((await chooseChatHost({ env: {}, platform: "linux", driver: up })).driver, "systemd");
  assert.equal((await chooseChatHost({ env: { SOVA_CHAT_HOST: "off" }, platform: "linux", driver: up })).driver, "systemd", "the old switch means nothing");
  const mac = await chooseChatHost({ env: {}, platform: "darwin", driver: up });
  assert.equal(mac.driver, "detached");
  assert.match(mac.why, /darwin/);
  const nosd = await chooseChatHost({ env: {}, platform: "linux", driver: down });
  assert.equal(nosd.driver, "detached");
  assert.match(nosd.why, /no systemd/);
  assert.equal((await chooseChatHost({ env: { SOVA_CHAT_DRIVER: "detached" }, platform: "linux", driver: up })).driver, "detached", "the test override");
});

test("once at start, an older server's worker children are stopped by their records and their place removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-old-children-"));
  mkdirSync(join(root, "procs"), { recursive: true });
  const rec = { pid: 4_194_000, startedAt: 1 };
  writeFileSync(join(root, "procs", "sova-chatw-h1-w1.json"), JSON.stringify(rec));
  writeFileSync(join(root, "procs", "sova-chatw-other-w2.json"), JSON.stringify(rec));
  // No process lives (a fake table: a unit test spawns no ps).
  const table = { kind: "ps" as const, sessions: false, list: () => [], get: () => null, startOf: () => null };
  assert.deepEqual(await sweepOldChildren(root, "h1", table), ["sova-chatw-h1-w1"]);
  assert.equal(existsSync(root), false, "the place is gone, so the next start sweeps nothing");
  assert.deepEqual(await sweepOldChildren(root, "h1", table), []);
});

test("the chat env: the server's minus the deny list, Sova's bun and the resolved claude first on PATH", () => {
  const env = chatEnv({
    serverEnv: { PATH: "/usr/bin:relative:/opt/bun/bin", LANG: "C.UTF-8", HTTPS_PROXY: "http://p", CLAUDE_CODE_X: "1", INVOCATION_ID: "i", NOTIFY_SOCKET: "/n", PORT: "3000", HOST: "0.0.0.0", PWD: "/srv", HOME: "/elsewhere" },
    bun: "/opt/bun/bin/bun",
    claude: "/home/u/.local/bin/claude",
    home: "/home/u",
    agentDir: "/home/u/.pi/agent",
    extra: { SOVA_CHAT_ID: "c1" },
  });
  assert.equal(env.PATH, "/opt/bun/bin:/home/u/.local/bin:/usr/bin");
  assert.deepEqual([env.HOME, env.PI_CODING_AGENT_DIR, env.SOVA_CHAT_ID, env.HTTPS_PROXY, env.CLAUDE_CODE_X, env.LANG], ["/home/u", "/home/u/.pi/agent", "c1", "http://p", "1", "C.UTF-8"]);
  for (const k of ["INVOCATION_ID", "NOTIFY_SOCKET", "PORT", "HOST", "PWD"]) assert.equal(env[k], undefined, k);
});

test("the chat env turns Bun's GC timer off, whatever the server's own env says", () => {
  const base = { bun: "/opt/bun/bin/bun", home: "/h", agentDir: "/h/a" };
  assert.equal(chatEnv({ ...base, serverEnv: { LANG: "C" } })[GC_TIMER_OFF.name], GC_TIMER_OFF.value);
  assert.equal(chatEnv({ ...base, serverEnv: { [GC_TIMER_OFF.name]: "0" } })[GC_TIMER_OFF.name], GC_TIMER_OFF.value);
});

test("the chat env names Sova's git system config: git run by the chat starts no background cleanup", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "chat-gitcfg-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const env = chatEnv({ serverEnv: { LANG: "C", GIT_CONFIG_NOSYSTEM: "1" }, bun: "/opt/bun/bin/bun", home: agentDir, agentDir });
  assert.equal(env.GIT_CONFIG_SYSTEM, gitCleanupConfigPath(agentDir));
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined, "it would make git skip the file");
  // Never a variable that turns the idle git cache off (§app/idle-git-cache).
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  const git = (key: string) => execFileSync("git", ["config", "--get", key], { env: { PATH: process.env.PATH!, HOME: agentDir, GIT_CONFIG_SYSTEM: env.GIT_CONFIG_SYSTEM! }, encoding: "utf8" }).trim();
  assert.deepEqual([git("maintenance.auto"), git("gc.auto")], ["false", "0"]);
  // An agent dir that can't be written: the chat still starts, without the variable.
  const blocked = join(agentDir, "file");
  writeFileSync(blocked, "");
  assert.equal(chatEnv({ serverEnv: { LANG: "C" }, bun: "/opt/bun/bin/bun", home: agentDir, agentDir: blocked }).GIT_CONFIG_SYSTEM, undefined);
});

test("a chat process's own variables: never inherited from its server, and deleted from a server's env at boot", () => {
  const leaked = { SOVA_CHAT_SOCK: "/s", SOVA_CHAT_PATH: "/p", SOVA_CHAT_ID: "x", SOVA_CHAT_UNIT: "u", SOVA_CHAT_BUILD: "b", SOVA_CHAT_STATE_ROOT: "/live/sova", SOVA_CHAT_LIVE_ROOT: "/live", SOVA_CHAT_COPIES_ROOT: "/live/sova/chats/code" };
  const env = chatEnv({ serverEnv: { ...leaked, SOVA_CHAT_CODE_ROOT: "/scratch", LANG: "C" }, bun: "/opt/bun/bin/bun", home: "/h", agentDir: "/h/a", extra: { SOVA_CHAT_ID: "c1" } });
  for (const k of CHAT_PROCESS_ENV) assert.equal(env[k], k === "SOVA_CHAT_ID" ? "c1" : undefined, k);
  assert.equal(env.SOVA_CHAT_CODE_ROOT, undefined, "the server's own code root");
  const server: NodeJS.ProcessEnv = { ...leaked, SOVA_CHAT_SLICE: "x.slice", LANG: "C" };
  assert.deepEqual(scrubChatProcessEnv(server).sort(), Object.keys(leaked).sort());
  assert.deepEqual(server, { SOVA_CHAT_SLICE: "x.slice", LANG: "C" });
});

test("the socket lives under the state root, or in the runtime dir when that path would not fit", () => {
  const abc = createHash("sha256").update("abc").digest("hex").slice(0, 16);
  assert.equal(chatSocketPath("abc", { root: "/a/chats" }), `/a/chats/s/${abc}.sock`);
  assert.equal(chatSocketPath("abc", { root: "/a/chats", suffix: "-r2" }), `/a/chats/s/${abc}-r2.sock`);
  const deep = `/${"d".repeat(120)}/chats`;
  assert.equal(chatSocketPath("abc", { root: deep, runtimeDir: "/run/user/1000", hash: "h1", platform: "linux" }), `/run/user/1000/sova-chats-h1/${abc}.sock`);
  assert.equal(chatSocketPath("abc", { root: deep, runtimeDir: undefined, tmp: "/tmp", hash: "h1", platform: "linux" }), `/tmp/sova-chats-h1/${abc}.sock`);
  assert.equal(chatSocketPath("abc", { root: deep, runtimeDir: "/run/user/1000", hash: "h1", platform: "darwin" }), `/private/tmp/sova-chats-h1/${abc}.sock`);
  // Two session ids made in the same millisecond (UUIDv7: the same first 12 characters) get sockets of their own.
  assert.notEqual(chatSocketPath("0199bbbb-0000-7000-8000-000000000001", { root: "/a/chats" }), chatSocketPath("0199bbbb-0000-7000-8000-000000000002", { root: "/a/chats" }));
});

test("5d: a socket path fits the platform's sockaddr limit (darwin 103, Linux 107) with room for a replacement's suffix; macOS falls back to /private/tmp", () => {
  const abc = chatSocketPath("abc", { root: "/a/chats" }).split("/").pop()!.replace(/\.sock$/, "");
  // A root that fits on Linux with the suffix's room, but not on darwin (4 bytes less).
  const mid = `/${"m".repeat(107 - 18 - "/s/".length - 16 - ".sock".length - 1)}`;
  assert.equal(chatSocketPath("abc", { root: mid, platform: "linux" }), `${mid}/s/${abc}.sock`);
  assert.equal(chatSocketPath("abc", { root: mid, platform: "darwin", hash: "h1" }), `/private/tmp/sova-chats-h1/${abc}.sock`, "darwin: never its /var/folders temp dir");
  // A replacement lives beside its chat, and its path still fits.
  const rep = chatSocketPath("abc", { root: mid, platform: "linux", suffix: "-rmv62926i-12" });
  assert.equal(rep, `${mid}/s/${abc}-rmv62926i-12.sock`);
  assert.ok(Buffer.byteLength(rep) <= 107);
  // Too long anywhere: refused, never cut short.
  assert.throws(() => chatSocketPath("abc", { root: `/${"d".repeat(120)}`, runtimeDir: `/${"r".repeat(100)}`, hash: "h1", platform: "linux" }), /too long for a unix socket here \(at most 107 bytes\)/);
});

test("5d: a recorded pid is a chat process only by its command: /proc on Linux, ps on macOS (alive is never enough)", () => {
  const ps = (stdout: string, code = 0) => (file: string, args: string[]) => (assert.deepEqual([file, ...args], ["ps", "-o", "command=", "-p", String(process.pid)]), { code, stdout });
  assert.equal(chatProcessAlive(process.pid, "darwin", ps("/opt/bun/bin/bun /copies/g1/server/chat-runtime/main.ts\n")), true);
  assert.equal(chatProcessAlive(process.pid, "darwin", ps("/usr/local/bin/pi --session x.jsonl\n")), false, "a reused pid: another program");
  assert.equal(chatProcessAlive(process.pid, "darwin", ps("", 1)), false);
  assert.equal(chatProcessAlive(0x3ffffff, "darwin", () => assert.fail("a dead pid needs no ps")), false);
});

test("the controller epoch only grows, across starts and a clock that went back", () => {
  const f = join(dir, "epoch");
  assert.equal(nextEpoch(f, 5_000), 5_000);
  assert.equal(nextEpoch(f, 4_000), 5_001);
  assert.equal(nextEpoch(f, 9_000), 9_000);
  assert.equal(readFileSync(f, "utf8").trim(), "9000");
});

test("chat units: the chats' slice, a 30 s stop, no Restart=, and the env in a 0600 file rather than argv", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  await chatDriver({ slice: "sova-chats.slice", driver: "systemd" }, exec).start({ unit: "sova-chat-abc123-c1", argv: ["/b/bun", "e.ts"], cwd: "/w", env: { SECRET_API_KEY: "s3cr'et", A: "x y" } });
  const run = calls.find((c) => c[0] === "systemd-run")!;
  assert.ok(run.includes("--slice=sova-chats.slice"));
  assert.ok(run.includes("--property=KillMode=mixed") && run.includes("--property=TimeoutStopSec=30"));
  assert.ok(!run.some((a) => a.startsWith("--property=Restart")), "no Restart=");
  assert.ok(!run.some((a) => a.includes("s3cr")), "no env value in argv");
  const envFile = run.find((a) => a.startsWith("--property=EnvironmentFile="))!.split("=").slice(2).join("=");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(envFile, "utf8"), `A='x y'\nSECRET_API_KEY="s3cr'et"\n`);
  assert.ok(chatDriver({ slice: "sovatest.slice", driver: "systemd" }, exec) && systemdRunArgv({ unit: "u", argv: ["x"], cwd: "/", env: {} }, undefined, { slice: "sovatest.slice" }).includes("--slice=sovatest.slice"));
  // Project services keep their units as they were.
  const svc = systemdRunArgv({ unit: "u", argv: ["x"], cwd: "/", env: { A: "1" } });
  assert.ok(svc.includes("--slice=sova-services.slice") && svc.includes("--property=Restart=on-failure") && svc.includes("--setenv=A=1") && svc.includes("--property=TimeoutStopSec=15"));
  assert.equal(envFileText({ "BAD-NAME": "1", NL: "a\nb", Q: 'a"$`\\\'' }), `Q="a\\"\\$\\\`\\\\'"\n`);
});

test("a recorded pid that is no chat process (dead, or reused by another program) is never claimed", async () => {
  const { claimRecordedChats, chatProcessAlive } = await import("./supervisor");
  const d = new FakeDriver();
  const first = make(d);
  const a = await first.sup.start(chat);
  first.sup.detach();
  const claimed: number[] = [];
  claimRecordedChats((pid) => (claimed.push(pid), () => {}), () => reg, (pid) => pid !== a.pid);
  assert.deepEqual(claimed, []);
  // Its command, read as the platform reads it (macOS's ps injected: a unit test spawns none).
  const notChat = () => ({ code: 0, stdout: "bun test server/chat-runtime/supervisor.test.ts\n" });
  assert.equal(chatProcessAlive(process.pid, process.platform === "linux" ? "linux" : "darwin", notChat), false, "this test process is alive but no chat process");
  assert.equal(chatProcessAlive(2 ** 22 + 7, "darwin", notChat), false, "no such process");
});

test("a chat whose main process came after the start stopped waiting is recorded and own once it is seen", async () => {
  const d = new FakeDriver();
  const { sup, owned } = make(d, { startWaitMs: 0 });
  d.slowNextStart = true;
  const rec = await sup.start(chat);
  assert.equal(rec.pid, null);
  assert.equal(owned.size, 0);
  d.activate(rec.unit);
  assert.equal(await sup.check("c1"), "up");
  const pid = sup.record("c1")!.pid!;
  assert.ok(pid);
  assert.ok(owned.has(pid));
  assert.equal(JSON.parse(readFileSync(join(reg, "c1.json"), "utf8")).pid, pid);
});

test("a start asked for before adoption finished never starts a surviving chat twice, nor makes adoption stop it", async () => {
  const d = new FakeDriver();
  const first = make(d);
  const a = await first.sup.start(chat);
  first.sup.detach();
  const second = make(d);
  // The router's wait for adoption timed out (a slow build check), and a start came first.
  await assert.rejects(second.sup.start(chat), /still running from before this server started/);
  assert.equal(d.started.length, 1, "nothing started twice");
  assert.equal(JSON.parse(readFileSync(join(reg, "c1.json"), "utf8")).unit, a.unit, "its record is untouched");
  const { adopted } = await second.sup.adopt();
  assert.deepEqual(adopted.map((r) => r.chatId), ["c1"]);
  assert.deepEqual(d.stopped, [], "the surviving chat's unit is not stopped");
});

test("a chat started while adoption runs is not stopped as unrecorded", async () => {
  const d = new FakeDriver();
  const first = make(d);
  await first.sup.start(chat);
  first.sup.detach();
  const second = make(d);
  let started: Promise<unknown> | null = null;
  const status = d.status.bind(d);
  d.status = async (unit: string) => {
    // While adoption checks c1's unit, another chat starts (its own status reads pass straight through).
    if (unit.endsWith("-c1") && !started) {
      started = second.sup.start({ ...chat, chatId: "c5", sessionPath: "/s/c5.jsonl" });
      await started;
    }
    return status(unit);
  };
  await second.sup.adopt();
  assert.deepEqual(d.stopped, []);
  assert.ok(second.sup.record("c5"));
});

test("a chat an older build started keeps the socket path its record names: adoption hands that one back", async () => {
  const d = new FakeDriver();
  mkdirP(reg);
  const legacy = "/a/chats/s/0199bbbb0000.sock"; // the old naming: the id's first 12 characters
  await d.start({ unit: "sova-chat-test01-0199bbbb-0000-7000-8000-000000000001", argv: [], cwd: "/", env: {} });
  writeFileSync(
    join(reg, "0199bbbb-0000-7000-8000-000000000001.json"),
    JSON.stringify({ chatId: "0199bbbb-0000-7000-8000-000000000001", sessionPath: "/s/x.jsonl", cwd: "/", unit: "sova-chat-test01-0199bbbb-0000-7000-8000-000000000001", pid: 1000, sock: legacy, epoch: 1, startedAt: "t" }),
  );
  const { sup } = make(d, { socketPath: (id, suffix) => chatSocketPath(id, { root: "/a/chats", ...(suffix ? { suffix } : {}) }) });
  const { adopted } = await sup.adopt();
  assert.equal(adopted[0]!.sock, legacy, "the router connects to the recorded path (chat-host takeBack: rec.sock)");
  assert.equal(sup.record("0199bbbb-0000-7000-8000-000000000001")!.sock, legacy);
  assert.deepEqual(d.stopped, []);
});

test("adoption says it stops only a running unrecorded unit; what is left of an ended one is cleared quietly", async () => {
  const d = new FakeDriver();
  await d.start({ unit: "sova-chat-test01-live", argv: [], cwd: "/", env: {} });
  await d.start({ unit: "sova-chat-test01-ended", argv: [], cwd: "/", env: {} });
  d.die("sova-chat-test01-ended");
  // The fake drops a unit on stop; a dead one stays listed until then, as the detached driver's file does.
  const lines: string[] = [];
  const { sup } = make(d, { log: (l) => lines.push(l) });
  await sup.adopt();
  assert.deepEqual(d.stopped.sort(), ["sova-chat-test01-ended", "sova-chat-test01-live"]);
  assert.deepEqual(lines.filter((l) => l.includes("no chat records it")), ["sova-chat-test01-live: no chat records it; stopping it"]);
});


// ---- the watch's fast look: no program for a healthy chat --------------------------------------------

/**
 * The real systemd driver over a scripted user manager: every program it would run is logged in
 * `ran` and answered from `units`. A unit's cgroup (`owns`) holds its main pid while `alive` says the
 * process runs; `isChatProcess` reads the same flag, as /proc would.
 */
function scriptedSystemd() {
  const ran: string[][] = [];
  const units = new Map<string, { pid: number; up: boolean; journal: string[] }>();
  let nextPid = 4000;
  const alive = new Set<number>();
  const exec: Exec = async (file, args) => {
    ran.push([file, ...args]);
    if (file === "systemd-run") {
      const unit = args.find((a) => a.startsWith("--unit="))!.slice("--unit=".length);
      const pid = nextPid++;
      units.set(unit, { pid, up: true, journal: [] });
      alive.add(pid);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file === "systemctl" && args[1] === "show") {
      const u = units.get(args[2]!.replace(/\.service$/, ""));
      if (!u) return { code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" };
      return { code: 0, stdout: u.up ? `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=${u.pid}\nExecMainStatus=0\nResult=success\n` : `LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=failed\n`, stderr: "" };
    }
    if (file === "journalctl") {
      const u = units.get(args[2]!.replace(/\.service$/, ""));
      return { code: 0, stdout: (u?.journal ?? []).map((m) => JSON.stringify({ MESSAGE: m })).join("\n"), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  class Driver extends SystemdDriver {
    override owns(unit: string, pid: number) {
      return units.get(unit)?.pid === pid && alive.has(pid);
    }
  }
  const driver = new Driver(exec, {});
  /** The unit's main process is killed: gone from /proc, its unit failed with the signal. */
  const kill = (unit: string) => {
    const u = units.get(unit)!;
    alive.delete(u.pid);
    u.up = false;
    u.journal = ["Started x.", `${unit}.service: Main process exited, code=killed, status=9/KILL`, `${unit}.service: Failed with result 'signal'.`];
  };
  return { ran, units, alive, exec, driver, kill };
}

function makeScripted(extra: Partial<SupervisorDeps> = {}) {
  const sys = scriptedSystemd();
  const m = make(new FakeDriver(), { driver: sys.driver, platform: "linux", isChatProcess: (pid) => sys.alive.has(pid), ...extra });
  return { ...m, ...sys };
}

test("a healthy chat's watch tick runs no program: its process is read directly, systemctl only at the slow reconcile", async () => {
  const { sup, ran, deaths } = makeScripted();
  await sup.start(chat);
  await sup.tick(); // the first tick after a start may still ask: the start's own answer counts
  ran.length = 0;
  // 14 watch ticks, 2 s apart (28 s, inside the 30 s reconcile): nothing started, no death.
  for (let i = 0; i < 14; i++) {
    clock += 2_000;
    await sup.tick();
  }
  assert.deepEqual(ran.map((c) => c.join(" ")), [], "a healthy chat's tick starts no program");
  // The slow reconcile asks the manager once, then the fast look goes on.
  clock += 2_000;
  await sup.tick();
  assert.deepEqual(ran.map((c) => c.slice(0, 2)), [["systemctl", "--user"]]);
  assert.equal(ran[0]![2], "show");
  ran.length = 0;
  clock += 2_000;
  await sup.tick();
  assert.deepEqual(ran.map((c) => c.join(" ")), []);
  assert.deepEqual(deaths, []);
});

test("a killed chat is reported at the very next tick, its death read from systemd as before", async () => {
  const { sup, deaths, kill } = makeScripted();
  const rec = await sup.start(chat);
  sup.noteConnected("c1");
  await sup.tick();
  clock += 2_000;
  await sup.tick(); // a fast-look tick
  kill(rec.unit);
  clock += 2_000;
  await sup.tick();
  assert.equal(deaths.length, 1, "noticed at the first tick after it died");
  assert.deepEqual([deaths[0]!.cause, deaths[0]!.exit, deaths[0]!.signal, deaths[0]!.pid], ["crashed", null, "KILL", rec.pid]);
});

test("the fast look trusts no reused pid, no pid outside the unit, no unknown pid, and nothing off Linux: each asks systemd at once", async () => {
  const shows = (ran: string[][]) => ran.filter((c) => c[0] === "systemctl" && c[2] === "show").length;
  // The pid runs another program now (no chat-runtime/main.ts): systemd is asked, and its death reported.
  {
    let reused = false;
    const s = makeScripted({ isChatProcess: () => !reused });
    const rec = await s.sup.start(chat);
    s.sup.noteConnected("c1");
    await s.sup.tick();
    s.units.get(rec.unit)!.up = false;
    s.units.get(rec.unit)!.journal = [`${rec.unit}.service: Main process exited, code=exited, status=1/FAILURE`];
    reused = true;
    s.ran.length = 0;
    clock += 2_000;
    await s.sup.tick();
    assert.equal(shows(s.ran), 1);
    assert.equal(s.deaths.length, 1);
    assert.equal(s.deaths[0]!.exit, 1);
  }
  // The pid is a chat process but no longer in the chat's unit (its cgroup): systemd is asked.
  {
    const s = makeScripted();
    const rec = await s.sup.start({ ...chat, chatId: "c2" });
    await s.sup.tick();
    s.units.get(rec.unit)!.pid = 99_999;
    s.ran.length = 0;
    clock += 2_000;
    await s.sup.tick();
    assert.equal(shows(s.ran), 1);
  }
  // Not Linux: every tick asks the driver, as before.
  {
    const s = makeScripted({ platform: "darwin" });
    await s.sup.start({ ...chat, chatId: "c3" });
    s.ran.length = 0;
    for (let i = 0; i < 3; i++) {
      clock += 2_000;
      await s.sup.tick();
    }
    assert.equal(shows(s.ran), 3);
  }
  // A start whose main process has no pid yet: asked each tick until it has one.
  {
    const d = new FakeDriver();
    let asked = 0;
    const status = d.status.bind(d);
    d.status = async (u) => (asked++, status(u));
    d.owns = () => true;
    const { sup } = make(d, { platform: "linux", isChatProcess: () => true, startWaitMs: 0 });
    d.slowNextStart = true;
    await sup.start({ ...chat, chatId: "c4" });
    asked = 0;
    await sup.tick();
    await sup.tick();
    assert.equal(asked, 2);
  }
});
