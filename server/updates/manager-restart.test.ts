import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { UpdateJob } from "../../shared/protocol";
import { scratchRoot } from "../test-scratch";
import { gitIn } from "./git";
import type { InstallInfo, ServiceUnit } from "./install-kind";
import { RESTART_DURING_UPGRADE, RESTART_NO_SERVICE, RESTART_PENDING, RESTART_PENDING_MS, UPGRADE_DURING_RESTART, UpdatesManager, UpdatesRefusal } from "./manager";

/**
 * Restart Sova in the Updates manager: only a copy a service runs may restart, never while an upgrade
 * runs, and no upgrade starts while a restart is on its way, whichever came first. Every outside fact
 * is a stand-in: the install, the scheduler and the clock; no git, no service.
 */

/** Now: a running job older than two hours (by its file's time) is taken as dead. */
const T0 = Date.now();
const UNIT: ServiceUnit = { manager: "systemd", name: "sova-runtime.service" };
const info = (unit: ServiceUnit | null): InstallInfo => ({
  kind: unit ? "developer" : "check-only",
  whyNot: unit ? null : "This copy runs from a worktree, so it updates with git, not from here.",
  checkout: null,
  unit,
  launcher: null,
  installPort: null,
  noExtensions: false,
  noAppEntry: false,
});

/** A gate a stand-in waits on, opened by the test. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function rig(o: { unit?: ServiceUnit | null; schedule?: string | null; install?: () => Promise<InstallInfo> } = {}) {
  const root = scratchRoot("updates-restart-");
  const clock = { t: T0 };
  const scheduled: ServiceUnit[] = [];
  const logs: string[] = [];
  const unit = o.unit === undefined ? UNIT : o.unit;
  const m = new UpdatesManager({
    file: join(root, "updates.json"),
    jobsDir: join(root, "jobs"),
    repo: "file:///nowhere",
    checksOff: true,
    startedHead: null,
    install: o.install ?? (async () => info(unit)),
    git: (d) => gitIn(d),
    now: () => clock.t,
    timers: { set: () => 0, clear: () => {} },
    startDelayMs: 0,
    launch: async () => null,
    port: () => 4800,
    healthUrl: () => "http://127.0.0.1:4800/api/health",
    pid: 1,
    uid: 1000,
    jobEnv: () => ({}),
    serverLog: join(root, "app-server.log"),
    log: (l) => logs.push(l),
    startedAt: "2026-10-29T11:00:00.000Z",
    restart: async (u) => {
      scheduled.push(u);
      return o.schedule ?? null;
    },
    restartDelaySec: 3,
    diskAhead: async () => ({ commits: 3, dirty: true }),
  });
  /** A job the runner left running, as its state.json says. */
  const runningJob = () => {
    const dir = join(root, "jobs", "0000000aa-abcdef");
    mkdirSync(dir, { recursive: true });
    const job: UpdateJob = { id: "0000000aa-abcdef", kind: "developer", from: { sha: "a".repeat(40), label: "a" }, to: { sha: "b".repeat(40), label: "b" }, auto: false, startedAt: new Date(T0).toISOString(), step: "building", state: "running", detail: null, logPath: join(dir, "log.txt"), endedAt: null };
    writeFileSync(join(dir, "state.json"), JSON.stringify(job));
  };
  return { m, clock, scheduled, logs, runningJob };
}

const refusal = (message: string, status = 409) => (e: unknown) => e instanceof UpdatesRefusal && e.message === message && e.status === status;

test("a copy a service runs: Restart schedules that service once, says who asked, and the state says it may", async () => {
  const x = rig();
  const before = (await x.m.state()).running;
  assert.equal(before.canRestart, true);
  assert.equal(before.restartWhyNot, null);
  assert.deepEqual(before.restartUnit, UNIT);
  assert.equal(before.startedAt, "2026-10-29T11:00:00.000Z");
  assert.deepEqual(before.diskAhead, { commits: 3, dirty: true });
  const r = await x.m.restart("browser");
  assert.deepEqual(r, { startedAt: "2026-10-29T11:00:00.000Z", inSeconds: 3, unit: UNIT });
  assert.deepEqual(x.scheduled, [UNIT]);
  assert.ok(x.logs.some((l) => l === "[updates] restart asked for by browser: sova-runtime.service restarts in 3 s"), x.logs.join("\n"));
  // A second press while the first is on its way schedules nothing more.
  await assert.rejects(x.m.restart("command server.restart (no-key)"), refusal(RESTART_PENDING));
  assert.equal(x.scheduled.length, 1);
  assert.equal((await x.m.state()).running.canRestart, false);
});

test("no service runs this copy: refused with the block's own sentence, nothing scheduled", async () => {
  const x = rig({ unit: null });
  const s = (await x.m.state()).running;
  assert.equal(s.canRestart, false);
  assert.equal(s.restartWhyNot, RESTART_NO_SERVICE);
  assert.equal(s.restartUnit, null);
  await assert.rejects(x.m.restart("browser"), refusal(RESTART_NO_SERVICE));
  assert.equal(x.scheduled.length, 0);
  // A refusal leaves nothing pending: an upgrade isn't held back by it.
  await assert.rejects(x.m.apply({ target: "a".repeat(40) }), (e: unknown) => e instanceof UpdatesRefusal && e.message !== UPGRADE_DURING_RESTART);
});

test("the scheduler fails: its own words, a 500, and nothing stays pending", async () => {
  const x = rig({ schedule: "Failed to connect to bus: No medium found" });
  await assert.rejects(x.m.restart("browser"), refusal("Failed to connect to bus: No medium found", 500));
  assert.equal((await x.m.state()).running.canRestart, true, "it may be tried again");
});

test("an upgrade first: a running job refuses Restart, and so does one still starting", async () => {
  const x = rig();
  x.runningJob();
  assert.equal((await x.m.state()).running.restartWhyNot, RESTART_DURING_UPGRADE);
  await assert.rejects(x.m.restart("browser"), refusal(RESTART_DURING_UPGRADE));
  assert.equal(x.scheduled.length, 0);

  // An upgrade between its button and its job (apply waits on the install): Restart is refused already.
  const held = gate();
  let calls = 0;
  const y = rig({
    install: async () => {
      if (calls++ === 0) await held.p;
      return info(UNIT);
    },
  });
  const applying = y.m.apply({ target: "a".repeat(40) }).catch((e: unknown) => e);
  await assert.rejects(y.m.restart("browser"), refusal(RESTART_DURING_UPGRADE));
  held.open();
  await applying;
  assert.equal(y.scheduled.length, 0);
});

test("a restart first: no upgrade starts while it is on its way, whether it is still being scheduled or scheduled", async () => {
  const held = gate();
  let calls = 0;
  const x = rig({
    install: async () => {
      if (calls++ === 0) await held.p;
      return info(UNIT);
    },
  });
  const restarting = x.m.restart("script (no-key)");
  await assert.rejects(x.m.apply({ target: "a".repeat(40) }), refusal(UPGRADE_DURING_RESTART));
  held.open();
  await restarting;
  await assert.rejects(x.m.apply({ target: "a".repeat(40) }), refusal(UPGRADE_DURING_RESTART));
  // A restart that never came (the process still answers long after): the buttons come back.
  x.clock.t = T0 + RESTART_PENDING_MS + 1;
  await assert.rejects(x.m.apply({ target: "a".repeat(40) }), (e: unknown) => e instanceof UpdatesRefusal && e.message !== UPGRADE_DURING_RESTART);
  assert.equal((await x.m.state()).running.canRestart, true);
});
