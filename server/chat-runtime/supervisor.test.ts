import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { envFileText, systemdRunArgv, type Exec } from "../project-services/drivers";
import { FakeDriver } from "./fake-driver";
import { chatDriver, chatEnv, chatSocketPath, ChatSupervisor, chooseChatHost, exitOfLog, nextEpoch, supervisorConfig, type ChatDeath, type SupervisorDeps } from "./supervisor";

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
  assert.equal(rep.unit, "sova-chat-test01-c1-r1");
  assert.equal(rep.sock, "/s/c1-r1.sock");
  assert.equal(sup.record("c1")!.unit, old.unit, "not recorded until re-pointed");
  sup.expectExit("c1", "reload");
  d.die(old.unit);
  await sup.awaitExit("c1");
  sup.repoint("c1", rep);
  assert.equal(JSON.parse(readFileSync(join(reg, "c1.json"), "utf8")).unit, rep.unit);
  assert.deepEqual([...owned], [rep.pid]);
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
  assert.deepEqual(supervisorConfig({ SOVA_CHAT_SLICE: "sova-chats-test.slice", SOVA_CHAT_DRIVER: "detached", SOVA_CHAT_IDLE_MIN: "0.05", SOVA_CHAT_CLAUDE_IDLE_MAX: "1" }), {
    slice: "sova-chats-test.slice",
    driver: "detached",
    idleMs: 3_000,
    claudeIdleMax: 1,
  });
  assert.equal(supervisorConfig({ SOVA_CHAT_IDLE_MIN: "0" }).idleMs, 0);
  assert.equal(supervisorConfig({ SOVA_CHAT_IDLE_MIN: "soon" }).idleMs, 30 * 60_000);
  assert.equal(chatDriver({ slice: "x", driver: "detached" }).id, "detached");
});

test("chats run out of the server only with the switch on, on Linux, on Bun, with systemd answering", async () => {
  const up = { available: async () => ({ ok: true, detail: "systemd user manager (v)" }) };
  const down = { available: async () => ({ ok: false, detail: "no systemd user manager reachable" }) };
  const on = { SOVA_CHAT_HOST: "out" };
  assert.equal((await chooseChatHost({ env: {}, platform: "linux", bun: "1.4", driver: up })).mode, "in");
  assert.equal((await chooseChatHost({ env: on, platform: "linux", bun: "1.4", driver: up })).mode, "out");
  const mac = await chooseChatHost({ env: on, platform: "darwin", bun: "1.4", driver: up });
  assert.equal(mac.mode, "in");
  assert.match(mac.why, /darwin/);
  const node = await chooseChatHost({ env: on, platform: "linux", bun: undefined, driver: up });
  assert.equal(node.mode, "in");
  assert.match(node.why, /need the server on Bun/);
  const nosd = await chooseChatHost({ env: on, platform: "linux", bun: "1.4", driver: down });
  assert.equal(nosd.mode, "in");
  assert.match(nosd.why, /no systemd/);
  assert.equal((await chooseChatHost({ env: { ...on, SOVA_CHAT_DRIVER: "detached" }, platform: "linux", bun: "1.4", driver: down })).mode, "out", "the test driver needs no user bus");
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

test("the socket lives under the state root, or in the runtime dir when that path would not fit", () => {
  assert.equal(chatSocketPath("0123456789abcdef-xyz", { root: "/a/chats" }), "/a/chats/s/0123456789ab.sock");
  assert.equal(chatSocketPath("abc", { root: "/a/chats", suffix: "-r2" }), "/a/chats/s/abc-r2.sock");
  const deep = `/${"d".repeat(120)}/chats`;
  assert.equal(chatSocketPath("abc", { root: deep, runtimeDir: "/run/user/1000", hash: "h1" }), "/run/user/1000/sova-chats-h1/abc.sock");
  assert.equal(chatSocketPath("abc", { root: deep, runtimeDir: undefined, tmp: "/tmp", hash: "h1" }), "/tmp/sova-chats-h1/abc.sock");
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
  assert.ok(chatDriver({ slice: "sova-chats-test.slice", driver: "systemd" }, exec) && systemdRunArgv({ unit: "u", argv: ["x"], cwd: "/", env: {} }, undefined, { slice: "sova-chats-test.slice" }).includes("--slice=sova-chats-test.slice"));
  // Project services keep their units as they were.
  const svc = systemdRunArgv({ unit: "u", argv: ["x"], cwd: "/", env: { A: "1" } });
  assert.ok(svc.includes("--slice=sova-services.slice") && svc.includes("--property=Restart=on-failure") && svc.includes("--setenv=A=1") && svc.includes("--property=TimeoutStopSec=15"));
  assert.equal(envFileText({ "BAD-NAME": "1", NL: "a\nb", Q: 'a"$`\\\'' }), `Q="a\\"\\$\\\`\\\\'"\n`);
});
