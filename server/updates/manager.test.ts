import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitIn } from "./git";
import type { InstallInfo } from "./install-kind";
import { UpdatesManager, UpdatesRefusal, type UpdatesDeps } from "./manager";
import type { UpgradePlan } from "./runner";
import { CHECK_EVERY_MS, readUpdatesFile, RETRY_AFTER_MS } from "./state";
import { makeRepos, type Repos } from "./testing";

/**
 * The Updates manager (the daily check, automatic upgrade, the button, the source) with a stand-in
 * repository, a fake clock and timers, and a launcher that records the plan instead of starting it.
 */

const T0 = Date.parse("2026-10-14T12:00:00Z");

interface Rig {
  r: Repos;
  copy: string;
  m: UpdatesManager;
  deps: UpdatesDeps;
  timers: { fn: () => void; ms: number }[];
  launched: UpgradePlan[];
  clock: { t: number };
  file: string;
  info: InstallInfo;
}

function rig(opts: { kind?: InstallInfo["kind"]; checksOff?: boolean; launch?: string | null } = {}): Rig {
  const r = makeRepos("updates-manager-");
  r.commit(r.origin, "first");
  r.tag(r.origin, "v0.1.0");
  r.tag(r.origin, "stable");
  r.git(r.origin, "checkout", "--quiet", "-b", "feat/x");
  r.commit(r.origin, "feat");
  r.git(r.origin, "checkout", "--quiet", "master");
  const copy = r.clone("copy");
  const kind = opts.kind ?? "developer";
  const info: InstallInfo = {
    kind,
    whyNot: kind === "check-only" ? "This copy runs from a worktree, so it updates with git, not from here." : null,
    checkout: copy,
    unit: kind === "check-only" ? null : { manager: "systemd", name: kind === "installer" ? "sova.service" : "sova-runtime.service" },
    launcher: kind === "installer" ? "/home/u/.local/bin/sova" : null,
    installPort: kind === "installer" ? 4800 : null,
    noExtensions: false,
    noAppEntry: false,
  };
  const timers: Rig["timers"] = [];
  const launched: UpgradePlan[] = [];
  const clock = { t: T0 };
  const file = join(r.root, "state", "updates.json");
  const deps: UpdatesDeps = {
    file,
    jobsDir: join(r.root, "state", "updates", "jobs"),
    repo: r.url,
    checksOff: !!opts.checksOff,
    startedHead: null,
    install: async () => info,
    git: (dir) => gitIn(dir),
    now: () => clock.t,
    timers: { set: (fn, ms) => (timers.push({ fn, ms }), timers.length), clear: () => {} },
    startDelayMs: 60_000,
    launch: async (plan) => {
      launched.push(plan);
      return opts.launch ?? null;
    },
    port: () => 4800,
    healthUrl: () => "http://127.0.0.1:4800/api/health",
    pid: 1234,
    uid: 1000,
    jobEnv: () => ({ PATH: "/usr/bin" }),
    serverLog: join(r.root, "state", "app-server.log"),
    log: () => {},
  };
  return { r, copy, m: new UpdatesManager(deps), deps, timers, launched, clock, file, info };
}

/** A newer master in the origin, so a copy of master is offered it. */
const advance = (x: Rig) => x.r.commit(x.r.origin, "newer master");

test("the daily check is persisted: a restart within the day schedules the rest of the day, not a check", async () => {
  const x = rig();
  await x.deps.git(x.copy)(["status"]); // the copy exists
  x.m.start();
  assert.equal(x.timers.length, 1);
  assert.equal(x.timers[0]!.ms, 60_000, "no check yet: the start delay, then a check");
  x.timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  // Let the check finish.
  for (let i = 0; i < 50 && !readUpdatesFile(x.file).lastCheck; i++) await new Promise((r) => setTimeout(r, 20));
  const after = readUpdatesFile(x.file).lastCheck!;
  assert.equal(after.ok, true);
  assert.equal(after.at, new Date(T0).toISOString());

  // A "restart" 3 hours later: a new manager reads the file and waits (capped at an hour per sleep).
  const later = rig();
  mkdirSync(dirname(later.file), { recursive: true });
  later.clock.t = T0 + 3 * 3600_000;
  writeFileSync(later.file, readFileSync(x.file));
  later.m.start();
  assert.equal(later.timers.length, 1);
  assert.equal(later.timers[0]!.ms, 3600_000, "asleep at most an hour at a time");
  later.timers[0]!.fn(); // an hour on, still not due: it only reschedules
  assert.equal(readUpdatesFile(later.file).lastCheck!.at, after.at, "no early check");
  assert.equal(later.timers.length, 2);
  // At the day's end it checks.
  later.clock.t = T0 + CHECK_EVERY_MS;
  later.timers[1]!.fn();
  for (let i = 0; i < 50 && readUpdatesFile(later.file).lastCheck!.at === after.at; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(readUpdatesFile(later.file).lastCheck!.at, new Date(T0 + CHECK_EVERY_MS).toISOString());
});

test("checks off, or the checkbox off: no timer, and Check Now says checks are off", async () => {
  const off = rig({ checksOff: true });
  off.m.start();
  assert.equal(off.timers.length, 0);
  await assert.rejects(off.m.check(), (e: unknown) => e instanceof UpdatesRefusal && /SOVA_UPDATES_CHECK=off/.test(e.message));
  const box = rig();
  await box.m.saveSettings({ autoCheck: false });
  box.timers.length = 0;
  box.m.start();
  assert.equal(box.timers.length, 0);
  assert.equal((await box.m.state()).nextCheckAt, null);
});

test("a failed check is kept with its reason and tried again an hour later", async () => {
  const x = rig();
  x.deps.repo = join(x.r.root, "gone.git");
  const check = await x.m.check();
  assert.equal(check.ok, false);
  assert.match(check.error!, /^Couldn't reach Sova's repository: /);
  assert.equal((await x.m.state()).nextCheckAt, new Date(T0 + RETRY_AFTER_MS).toISOString());
});

test("Upgrade automatically: a daily check that finds an update starts the upgrade; off, it only reports", async () => {
  const on = rig();
  await on.m.saveSettings({ source: { kind: "master" }, autoUpgrade: true });
  const target = advance(on);
  on.m.start();
  on.timers[on.timers.length - 1]!.fn();
  for (let i = 0; i < 100 && on.launched.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(on.launched.length, 1);
  const plan = on.launched[0]!;
  assert.equal(plan.to.sha, target);
  assert.equal(plan.auto, true);
  assert.equal(plan.kind, "developer");
  assert.equal(plan.branch, "master");
  assert.ok(existsSync(join(plan.jobDir, "plan.json")) && existsSync(join(plan.jobDir, "state.json")));
  assert.equal((await on.m.state()).job?.state, "running");

  const off = rig();
  await off.m.saveSettings({ source: { kind: "master" } });
  advance(off);
  await off.m.check({ auto: true });
  assert.equal(off.launched.length, 0);
  const s = await off.m.state();
  assert.equal(s.available, true, "the dot shows");
  assert.equal(s.lastCheck?.result?.state, "available");
});

test("Upgrade automatically keeps the button's refusals: uncommitted changes start nothing and say why", async () => {
  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" }, autoUpgrade: true });
  advance(x);
  writeFileSync(join(x.copy, "file.txt"), "edited\n");
  await x.m.check({ auto: true });
  assert.equal(x.launched.length, 0);
  assert.equal((await x.m.state()).autoRefusal, "Your copy has uncommitted changes in 1 file. Commit or stash them, then upgrade.");
});

test("Upgrade automatically never reinstalls a version that was put back; one that merely failed is tried again", async () => {
  for (const outcome of ["rolled-back", "failed"] as const) {
    const x = rig();
    await x.m.saveSettings({ source: { kind: "master" }, autoUpgrade: true });
    const target = advance(x);
    const f = JSON.parse(readFileSync(x.file, "utf8"));
    f.lastUpgrade = { id: "j1", from: "a".repeat(40), to: target, at: new Date(T0).toISOString(), outcome, logPath: "/state/updates/jobs/j1/log.txt" };
    writeFileSync(x.file, JSON.stringify(f));
    await x.m.check({ auto: true });
    const s = await x.m.state();
    if (outcome === "rolled-back") {
      assert.equal(x.launched.length, 0, "no unattended retry of a version that didn't start");
      assert.equal(s.autoRefusal, "master was put back last time, so it isn't installed again automatically. Upgrade by hand to try it again.");
      assert.equal(s.available, true, "the button still offers it");
    } else {
      assert.equal(x.launched.length, 1, "a failure that changed nothing (a network error) is tried again");
    }
  }
});

test("the button: refused on a check-only copy, for a target that isn't the one on offer, and while a job runs", async () => {
  const co = rig({ kind: "check-only" });
  await co.m.saveSettings({ source: { kind: "master" } });
  const t = advance(co);
  await co.m.check();
  const st = await co.m.state();
  assert.equal(st.available, false, "no dot where nothing can be installed");
  await assert.rejects(co.m.apply({ target: t }), /runs from a worktree/);

  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" } });
  const target = advance(x);
  await x.m.check();
  await assert.rejects(x.m.apply({ target: "c".repeat(40) }), /changed since this page loaded/);
  await x.m.apply({ target });
  assert.equal(x.launched.length, 1);
  assert.equal(x.launched[0]!.auto, false);
  await assert.rejects(x.m.apply({ target }), /already running/);
});

test("never older code: nothing is offered or applied when the copy is ahead of its source", async () => {
  const x = rig();
  x.r.commit(x.copy, "a local commit past Stable");
  await x.m.check();
  const s = await x.m.state();
  assert.equal(s.lastCheck?.result?.state, "ahead");
  assert.equal(s.available, false);
  await assert.rejects(x.m.apply({ target: "a".repeat(40) }), /no update on offer/);
});

test("a developer copy whose branch diverged is never moved, even by the button", async () => {
  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" } });
  x.r.commit(x.copy, "local work");
  advance(x);
  await x.m.check();
  const s = await x.m.state();
  assert.equal(s.lastCheck?.result?.state, "diverged");
  assert.equal(s.available, false);
});

test("a developer copy follows only the branch its source names: on topic with source master, nothing is offered and apply refuses", async () => {
  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" } });
  x.r.git(x.copy, "checkout", "--quiet", "-b", "topic"); // at master's commit: an ancestor of the new tip
  const tip = advance(x);
  await x.m.check({ auto: true });
  const s = await x.m.state();
  assert.equal(s.running.branch, "topic");
  assert.notEqual(s.lastCheck?.result?.state, "available");
  assert.equal(s.available, false, "no button, no dot");
  assert.equal(x.launched.length, 0, "Upgrade automatically starts nothing");
  assert.match(JSON.stringify(s.lastCheck?.result), /You're on topic; switch to master to follow it\./);
  await assert.rejects(x.m.apply({ target: tip }), (e: unknown) => e instanceof UpdatesRefusal);
  assert.equal(x.launched.length, 0);
});

test("a developer copy on master, source master, is offered the update", async () => {
  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" } });
  const tip = advance(x);
  await x.m.check();
  const s = await x.m.state();
  assert.equal(s.lastCheck?.result?.state, "available");
  assert.equal(s.available, true);
  await x.m.apply({ target: tip });
  assert.equal(x.launched.length, 1);
});

test("apply re-checks the branch: an offer made on master is refused once the copy is on another branch", async () => {
  const x = rig();
  await x.m.saveSettings({ source: { kind: "master" } });
  const tip = advance(x);
  await x.m.check();
  x.r.git(x.copy, "checkout", "--quiet", "-b", "topic"); // same commit, so the offer still matches the head
  await assert.rejects(x.m.apply({ target: tip }), (e: unknown) => e instanceof UpdatesRefusal && /You're on topic; switch to master to follow it\./.test(e.message));
  assert.equal(x.launched.length, 0);
});

test("an installed copy runs the target's own installer, and refuses one that can't keep the version that runs", async () => {
  const keep = rig({ kind: "installer" });
  await keep.m.saveSettings({ source: { kind: "master" } });
  mkdirSync(join(keep.r.origin, "scripts"), { recursive: true });
  writeFileSync(join(keep.r.origin, "scripts/install.sh"), "#!/bin/sh\n# keeps it: SOVA_KEEP_PREVIOUS\n");
  keep.r.git(keep.r.origin, "add", "scripts/install.sh");
  const target = keep.r.commit(keep.r.origin, "an installer that keeps");
  await keep.m.check();
  await keep.m.apply({ target });
  const plan = keep.launched[0]!;
  assert.equal(plan.installRef, "master");
  assert.equal(plan.installer?.binDir, "/home/u/.local/bin");
  assert.match(readFileSync(plan.installer!.script, "utf8"), /SOVA_KEEP_PREVIOUS/);

  const old = rig({ kind: "installer" });
  await old.m.saveSettings({ source: { kind: "master" } });
  mkdirSync(join(old.r.origin, "scripts"), { recursive: true });
  writeFileSync(join(old.r.origin, "scripts/install.sh"), "#!/bin/sh\necho old\n");
  old.r.git(old.r.origin, "add", "scripts/install.sh");
  const t2 = old.r.commit(old.r.origin, "an old installer");
  await old.m.check();
  await assert.rejects(old.m.apply({ target: t2 }), /installer can't keep the version that runs/);
  assert.equal(old.launched.length, 0);
});

test("a job that couldn't start is a failed job that says why, and changes nothing", async () => {
  const x = rig({ launch: "systemd-run: Failed to connect to bus" });
  await x.m.saveSettings({ source: { kind: "master" } });
  const target = advance(x);
  await x.m.check();
  await assert.rejects(x.m.apply({ target }), /couldn't start: systemd-run: Failed to connect to bus\. Nothing changed\./);
  const s = await x.m.state();
  assert.equal(s.job?.state, "failed");
  assert.equal(readUpdatesFile(x.file).lastUpgrade?.outcome, "failed", "a finished job is recorded once in updates.json");
});

test("saving the source: a branch must exist in the repository; changing it installs nothing", async () => {
  const x = rig();
  await assert.rejects(x.m.saveSettings({ source: { kind: "branch", branch: "nope" } }), (e: unknown) => e instanceof UpdatesRefusal && e.status === 400 && e.message === "Updates: Sova's repository has no branch nope.");
  await assert.rejects(x.m.saveSettings({ source: { kind: "branch", branch: "" } }), /Updates: Name the branch\./);
  await assert.rejects(x.m.saveSettings({ source: { kind: "branch", branch: "a..b" } }), /isn't a branch name git takes/);
  const saved = await x.m.saveSettings({ source: { kind: "branch", branch: "feat/x" }, autoUpgrade: true });
  assert.deepEqual(saved, { source: { kind: "branch", branch: "feat/x" }, autoCheck: true, autoUpgrade: true });
  assert.equal(x.launched.length, 0);
  assert.equal(x.r.git(x.copy, "rev-parse", "--abbrev-ref", "HEAD"), "master", "nothing moved");
});
