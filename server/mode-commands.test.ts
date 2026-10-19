// A project mode's commands and hooks, the runner's gate and bounds (server/mode-commands.ts,
// §chat.mode-menu/project-mode-commands, §chat.mode-menu/project-mode-hooks), in-process: the program runner is a
// recording stand-in (the unit tier starts no process); server/mode-commands.integration.test.ts runs real ones.
// The checkout is real (the gate re-hashes its folder), under the OS temp dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readProjectMode } from "../pi-config/extensions/mode/project-discovery.ts";
import type { RunProjectToolOptions, ProjectToolRun } from "../pi-config/extensions/mode/project-tools.ts";
import type { ProjectModeSnapshot } from "../shared/project-modes";
import { COMMANDS_RUNNING_MAX, HOOK_BUDGET, HOOK_ENV_ALLOW, HOOK_PAUSED_NOTE, HOOK_WINDOW_MS, hookEnv, ModeActions, type ModeActionsHost, type ModeActionsOptions } from "./mode-commands";

const base = mkdtempSync(join(tmpdir(), "sova-mode-commands-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

const MD = (commands: string, hooks: string) => `---\ndescription: Release\ncommands: ${commands}\nhooks: ${hooks}\n---\nDo the release.\n`;
const CMDS = JSON.stringify([
  { name: "echo_args", description: "Echo", run: ["sh", "./echo.sh"] },
  { name: "slow", description: "Slow", run: ["sh", "./slow.sh"] },
]);
const HOOKS = JSON.stringify([{ on: "turn.ended", run: ["sh", "./hook.sh"] }]);

/** A checkout with mode `rel`, turned on as its copy. */
function checkout(md = MD(CMDS, HOOKS)) {
  const root = join(base, `repo-${++n}`);
  const dir = join(root, ".sova", "minor-modes", "rel");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(dir, "MODE.md"), md);
  for (const f of ["echo.sh", "slow.sh", "hook.sh", "fail.sh"]) writeFileSync(join(dir, f), "#!/bin/sh\n");
  const copy = readProjectMode(join(root, ".sova", "minor-modes"), "rel") as ProjectModeSnapshot;
  assert.ok(!("kind" in copy), JSON.stringify(copy));
  return { root, dir, copy };
}

const RAN: ProjectToolRun = { exitCode: 0, signal: null, stdout: "ok\n", stderr: "", timedOut: false, aborted: false, truncated: { stdout: false, stderr: false }, durationMs: 1 };

/** A stand-in runner: records each call; `hold` keeps a call running until released. */
function recorder() {
  const calls: RunProjectToolOptions[] = [];
  let running = 0;
  let most = 0;
  const holds: (() => void)[] = [];
  let hold = false;
  let answer: ProjectToolRun = RAN;
  const run = async (o: RunProjectToolOptions): Promise<ProjectToolRun> => {
    calls.push(o);
    running++;
    most = Math.max(most, running);
    try {
      if (hold) await new Promise<void>((r) => holds.push(r));
      return answer;
    } finally {
      running--;
    }
  };
  return {
    run,
    calls,
    most: () => most,
    hold: (on: boolean) => void (hold = on),
    release: () => holds.splice(0).forEach((r) => r()),
    answer: (a: Partial<ProjectToolRun>) => void (answer = { ...RAN, ...a }),
  };
}

interface HostState {
  on: boolean;
  sandbox: boolean;
  approved: boolean;
  byUser: boolean;
  notHere: string | null;
}

function actionsFor(c: ReturnType<typeof checkout>, state: Partial<HostState> = {}, o: ModeActionsOptions = {}) {
  const s: HostState = { on: true, sandbox: false, approved: true, byUser: true, notHere: null, ...state };
  const host: ModeActionsHost = {
    sessionId: () => "sess-1",
    cwd: () => c.root,
    projectOn: () => (s.on ? [{ id: "rel", sha: c.copy.sha }] : []),
    copies: () => new Map([[c.copy.sha, c.copy]]),
    sandboxOn: () => s.sandbox,
    notHere: () => s.notHere,
    approved: (root, id, hash) => s.approved && id === "rel" && hash === c.copy.toolsHash && root === c.root,
    approvedByUser: (root, id, hash) => s.byUser && id === "rel" && hash === c.copy.toolsHash && root === c.root,
  };
  const logs: string[] = [];
  const r = recorder();
  const actions = new ModeActions(host, { log: (l) => logs.push(l), run: r.run, ...o });
  return { actions, s, logs, r };
}

const tick = async (k = 3) => {
  for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r));
};

test("a command runs its copy's program in the chat's folder with the chat's own env, and answers how it ended", async () => {
  const c = checkout();
  const env = { PATH: "/bin", SOVA_CHAT_ID: "kept-for-commands" };
  const { actions, r } = actionsFor(c, {}, { env });
  const got = await actions.runCommand("rel", "echo_args", { x: 1 });
  assert.ok(got.ok, JSON.stringify(got));
  assert.equal(got.result.id, "mode.rel.echo_args");
  assert.equal(got.result.exitCode, 0);
  assert.equal(got.result.stdout, "ok\n");
  const call = r.calls[0]!;
  assert.deepEqual(call.args, { x: 1 });
  assert.equal(call.cwd, c.root);
  assert.equal(call.dir, c.copy.dir);
  assert.deepEqual(call.tool.command, ["sh", "./echo.sh"]);
  assert.equal(call.tool.name, "echo_args");
  assert.equal(call.env, env, "a command has exactly the reach of a tool: the chat's env");
  assert.equal(call.hookEvent, undefined);
  r.answer({ exitCode: 3, stderr: "nope\n" });
  const failed = await actions.runCommand("rel", "echo_args", {});
  assert.ok(failed.ok && failed.result.exitCode === 3, "a program that ran answers, whatever its exit code");
  r.answer({ spawnError: "program not found: sh" });
  const never = await actions.runCommand("rel", "echo_args", {});
  assert.ok(!never.ok && never.status === 409 && /program not found/.test(never.error));
  assert.deepEqual(actions.commandsOn().map((x) => x.id), ["mode.rel.echo_args", "mode.rel.slow"]);
});

test("a command runs nothing when the mode is off, the sandbox is on, it isn't approved, its files changed, or the chat isn't one that runs them", async () => {
  const c = checkout();
  const { actions, s, r } = actionsFor(c);
  const refused = async (want: RegExp, status = 409) => {
    const got = await actions.runCommand("rel", "echo_args", {});
    assert.ok(!got.ok, "refused");
    assert.equal(got.status, status);
    assert.match(got.error, want);
  };
  s.on = false;
  await refused(/project mode rel is off/);
  s.on = true;
  s.sandbox = true;
  await refused(/while the sandbox is on/);
  s.sandbox = false;
  s.approved = false;
  await refused(/isn't approved/);
  s.approved = true;
  s.notHere = "this chat can't run project mode programs.";
  await refused(/this chat can't run/);
  s.notHere = null;
  const missing = await actions.runCommand("rel", "nope", {});
  assert.ok(!missing.ok && missing.status === 404 && /has no command nope/.test(missing.error));
  writeFileSync(join(c.dir, "echo.sh"), "#!/bin/sh\necho changed\n");
  await refused(/changed since it was approved/);
  assert.equal(r.calls.length, 0, "nothing ran");
});

test("a command needs any approval of its version; an Overseer approval counts, as for tools", async () => {
  const c = checkout();
  const { actions, r } = actionsFor(c, { byUser: false });
  assert.ok((await actions.runCommand("rel", "echo_args", {})).ok);
  assert.equal(r.calls.length, 1);
});

test(`at most ${COMMANDS_RUNNING_MAX} commands run at once in a chat: one more is refused with 429`, async () => {
  const c = checkout();
  const { actions, r } = actionsFor(c);
  r.hold(true);
  const all = Array.from({ length: COMMANDS_RUNNING_MAX + 1 }, () => actions.runCommand("rel", "slow", {}));
  await tick();
  const fifth = await all[COMMANDS_RUNNING_MAX]!;
  assert.ok(!fifth.ok && fifth.status === 429 && /already running/.test(fifth.error));
  r.hold(false);
  r.release();
  const four = await Promise.all(all.slice(0, COMMANDS_RUNNING_MAX));
  assert.ok(four.every((x) => x.ok));
  assert.equal(r.most(), COMMANDS_RUNNING_MAX);
  assert.ok((await actions.runCommand("rel", "slow", {})).ok, "once they finished, the next one runs");
});

test("only the copy ever runs: an edit to MODE.md adds no hook and changes no command", async () => {
  const c = checkout();
  // MODE.md is outside the approval hash: what it says now reaches nothing until the mode is turned on again.
  writeFileSync(join(c.dir, "MODE.md"), MD(JSON.stringify([{ name: "echo_args", description: "Echo", run: ["sh", "./fail.sh"] }]), JSON.stringify([{ on: "turn.started", run: ["sh", "./fail.sh"] }])));
  const { actions, r } = actionsFor(c);
  assert.ok((await actions.runCommand("rel", "echo_args", {})).ok);
  assert.deepEqual(r.calls[0]!.tool.command, ["sh", "./echo.sh"], "the copy's argv");
  actions.turnStarted();
  await tick();
  assert.equal(r.calls.length, 1, "no turn.started hook: the copy has none");
});

test("a hook runs after the turn ended, never inside the event, with the event as data", async () => {
  const c = checkout();
  const deferred: (() => void)[] = [];
  let now = 5000;
  const { actions, r } = actionsFor(c, {}, { defer: (fn) => deferred.push(fn), now: () => now });
  actions.turnStarted();
  actions.turnSettled();
  assert.equal(deferred.length, 1, "scheduled, not run");
  assert.equal(r.calls.length, 0);
  now = 9000;
  for (const fn of deferred.splice(0)) fn();
  await tick();
  assert.equal(r.calls.length, 1);
  const call = r.calls[0]!;
  assert.deepEqual(call.args, { event: "turn.ended", sessionId: "sess-1", at: 5000, mode: "rel" });
  assert.equal(call.hookEvent, "turn.ended");
  assert.equal(call.tool.name, undefined, "no SOVA_TOOL_NAME for a hook");
});

test("live turns only: a settle with no start seen in this process (boot, restore, reload) runs nothing", async () => {
  const c = checkout();
  const { actions, r } = actionsFor(c);
  actions.turnSettled();
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, 0);
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, 1);
});

test("turn.ended fires for every settled run, a stopped or failed one too; turn.started for a start", async () => {
  const c = checkout(MD(CMDS, JSON.stringify([{ on: "turn.started", run: ["sh", "./hook.sh"] }, { on: "turn.ended", run: ["sh", "./hook.sh"] }])));
  const { actions, r } = actionsFor(c);
  actions.turnStarted();
  await tick();
  assert.deepEqual(r.calls.map((x) => x.hookEvent), ["turn.started"]);
  // The harness settles a stopped or failed run like any other: there is no outcome to tell them apart.
  actions.turnSettled();
  await tick();
  assert.deepEqual(r.calls.map((x) => x.hookEvent), ["turn.started", "turn.ended"]);
});

test("hooks need YOUR approval: an Overseer-only approval runs none, and the log says why", async () => {
  const c = checkout();
  const { actions, logs, r } = actionsFor(c, { byUser: false });
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, 0);
  assert.match(logs[0]!, /hooks need your own approval/);
});

test("a hook re-checks at every run: approval removed, sandbox on, mode off, the chat not one that runs them", async () => {
  const c = checkout();
  const { actions, s, logs, r } = actionsFor(c);
  const event = async () => (actions.turnStarted(), actions.turnSettled(), await tick());
  await event();
  assert.equal(r.calls.length, 1);
  s.byUser = false;
  await event();
  s.byUser = true;
  s.sandbox = true;
  await event();
  s.sandbox = false;
  s.notHere = "this chat can't run project mode programs.";
  await event();
  s.notHere = null;
  writeFileSync(join(c.dir, "hook.sh"), "#!/bin/sh\necho changed\n");
  await event();
  assert.equal(r.calls.length, 1);
  assert.equal(logs.length, 4);
  assert.match(logs[3]!, /changed since it was approved/);
});

test("a hook never runs twice at once: events while it runs leave one more run waiting, the latest", async () => {
  const c = checkout();
  let now = 0;
  const { actions, r } = actionsFor(c, {}, { now: () => now });
  r.hold(true);
  actions.turnStarted();
  for (let i = 0; i < 4; i++) {
    now = i;
    actions.turnSettled();
    await tick();
  }
  assert.equal(r.calls.length, 1, "one running");
  r.hold(false);
  r.release();
  await tick(6);
  assert.equal(r.calls.length, 2, "then the one waiting");
  assert.equal((r.calls[1]!.args as { at: number }).at, 3, "the latest event");
  assert.equal(r.most(), 1);
});

test(`a hook runs at most ${HOOK_BUDGET} times in ${HOOK_WINDOW_MS / 60_000} minutes; past that it is dropped, logged once, noted on the row; later it runs again`, async () => {
  const c = checkout();
  let now = 1_000_000;
  const { actions, logs, r } = actionsFor(c, {}, { now: () => now });
  actions.turnStarted();
  for (let i = 0; i < HOOK_BUDGET + 2; i++) {
    actions.turnSettled();
    await tick();
    now += 1000;
  }
  assert.equal(r.calls.length, HOOK_BUDGET);
  assert.equal(logs.filter((l) => /skipped/.test(l)).length, 1, "one line per window");
  assert.deepEqual([...actions.hookNotes()], [["rel", HOOK_PAUSED_NOTE]]);
  now += HOOK_WINDOW_MS;
  assert.equal(actions.hookNotes().size, 0, "the note is gone once it may run");
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, HOOK_BUDGET + 1);
});

test("the budget is checked when a waiting run would start: one held behind the last run of the window is dropped", async () => {
  const c = checkout();
  let now = 1_000_000;
  const { actions, r } = actionsFor(c, {}, { now: () => now });
  actions.turnStarted();
  for (let i = 0; i < HOOK_BUDGET - 1; i++) {
    actions.turnSettled();
    await tick();
    now += 10;
  }
  r.hold(true);
  actions.turnSettled(); // the 10th: held running
  await tick();
  actions.turnSettled(); // waits behind it
  r.hold(false);
  r.release();
  await tick(6);
  assert.equal(r.calls.length, HOOK_BUDGET);
});

test("a hook that makes the chat take another turn on each run stops at the budget (the loop a hook could make)", async () => {
  const c = checkout();
  let now = 1_000_000;
  let actions!: ModeActions;
  const calls: unknown[] = [];
  const run = async (o: RunProjectToolOptions) => {
    calls.push(o);
    now += 1000;
    setImmediate(() => (actions.turnStarted(), actions.turnSettled()));
    return RAN;
  };
  actions = actionsFor(c, {}, { now: () => now, run }).actions;
  actions.turnStarted();
  actions.turnSettled();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, HOOK_BUDGET);
});

test("a failing hook writes one log line and the next event still runs it", async () => {
  const c = checkout();
  const { actions, logs, r } = actionsFor(c);
  r.answer({ exitCode: 3 });
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  assert.deepEqual(logs, ["rel hook on turn.ended failed: exit code 3"]);
  r.answer({ timedOut: true, exitCode: null });
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, 2);
  assert.match(logs[1]!, /stopped at its 30 s limit/);
  // A runner that throws is caught: the chat never sees it.
  const thrown = actionsFor(c, {}, { run: async () => Promise.reject(new Error("boom")) });
  thrown.actions.turnStarted();
  thrown.actions.turnSettled();
  await tick();
  assert.deepEqual(thrown.logs, ["rel hook on turn.ended failed: boom"]);
});

test("a hook gets no Sova credential: its env is the allowlist of the chat's, nothing else", async () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/x", LANG: "C", OTHER: "x" };
  for (const k of ["SOVA_CHAT_SOCK", "SOVA_CHAT_PATH", "SOVA_CHAT_ID", "SOVA_CHAT_UNIT", "SOVA_CHAT_BUILD", "SOVA_CHAT_STATE_ROOT", "SOVA_CHAT_LIVE_ROOT", "SOVA_CHAT_COPIES_ROOT", "SOVA_CALLER_KEY", "SOVA_URL", "SOVA_PORT", "SOVA_TOKEN", "SOVA_AGENT_DIR", "PI_CODING_AGENT_DIR"])
    parent[k] = `/secret/${k}`;
  const c = checkout();
  const { actions, r } = actionsFor(c, {}, { env: parent });
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  const env = r.calls[0]!.env!;
  assert.ok(Object.keys(env).every((k) => (HOOK_ENV_ALLOW as readonly string[]).includes(k)), Object.keys(env).join(","));
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/x", LANG: "C" });
  assert.deepEqual(hookEnv(parent), env);
});

test("closing the chat stops a running hook and drops the waiting one", async () => {
  const c = checkout();
  const { actions, r } = actionsFor(c);
  r.hold(true);
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  actions.turnSettled();
  const signal = r.calls[0]!.signal!;
  actions.dispose();
  assert.equal(signal.aborted, true);
  r.release();
  await tick(6);
  assert.equal(r.calls.length, 1);
  actions.turnSettled();
  await tick();
  assert.equal(r.calls.length, 1, "nothing after close");
});

test("a run waiting from an older copy never runs once the chat is on a newer one", async () => {
  const c = checkout();
  const { actions, logs, r } = actionsFor(c);
  r.hold(true);
  actions.turnStarted();
  actions.turnSettled();
  await tick();
  actions.turnSettled(); // waits, for this copy
  // Turned off and on again at a new version: the chat's ref now names another copy.
  c.copy = { ...c.copy, sha: "f".repeat(64) };
  r.hold(false);
  r.release();
  await tick(6);
  assert.equal(r.calls.length, 1);
  assert.match(logs.at(-1)!, /is off in this chat/);
});

test("the host is read accessors only: nothing ModeActions holds can send, queue or steer", () => {
  const c = checkout();
  const { actions } = actionsFor(c);
  const keys = Object.keys((actions as unknown as { host: object }).host).sort();
  assert.deepEqual(keys, ["approved", "approvedByUser", "copies", "cwd", "notHere", "projectOn", "sandboxOn", "sessionId"]);
});
