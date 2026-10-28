import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateJob } from "../../shared/protocol";
import { runUpgrade, type RunnerDeps, type RunResult, type UpgradePlan } from "./runner";

/**
 * The upgrade job on fake programs, files and health: the version that runs
 * is kept until the new one answers, a failure before the restart changes nothing, a new version
 * that doesn't answer within the wait is replaced by the previous one, and a developer copy moves
 * only by fast-forward from a clean tree.
 */

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const CO = "/srv/sova";

interface World {
  deps: RunnerDeps;
  calls: string[];
  paths: Set<string>;
  states: UpdateJob[];
  /** What health answers: a function of the clock and what has run. */
  serving: () => string | null;
  setServing(fn: () => string | null): void;
  clock: { t: number };
  started: string[];
  signals: string[];
}

function world(handlers: (cmd: string, w: World) => RunResult | undefined, initial: string[] = []): World {
  const clock = { t: Date.parse("2026-10-14T12:00:00Z") };
  let serving: () => string | null = () => OLD;
  const w: World = {
    calls: [],
    paths: new Set(initial),
    states: [],
    serving: () => serving(),
    setServing: (fn) => (serving = fn),
    clock,
    started: [],
    signals: [],
    deps: undefined as unknown as RunnerDeps,
  };
  w.deps = {
    run: async (file, args, opts) => {
      const cmd = `${file} ${args.join(" ")}`;
      w.calls.push(cmd);
      const r = handlers(cmd, w) ?? { code: 0, out: "" };
      for (const line of r.out.split("\n")) if (line) opts.onLine?.(line);
      return r;
    },
    health: async () => w.serving(),
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    exists: (p) => w.paths.has(p),
    rename: (a, b) => {
      w.calls.push(`mv ${a} ${b}`);
      assert.ok(w.paths.has(a), `mv: ${a} exists`);
      assert.ok(!w.paths.has(b), `mv: ${b} is free`);
      w.paths.delete(a);
      w.paths.add(b);
    },
    remove: (p) => {
      w.calls.push(`rm ${p}`);
      w.paths.delete(p);
    },
    startDetached: (file, _args, env) => {
      w.started.push(`${file} PORT=${env.PORT}`);
      return 777;
    },
    signal: (pid, sig) => {
      w.signals.push(`${pid} ${sig}`);
      return sig !== 0 ? true : false;
    },
    writeState: (job) => w.states.push({ ...job }),
    log: () => {},
  };
  return w;
}

const basePlan = (over: Partial<UpgradePlan> = {}): UpgradePlan => ({
  id: "job1",
  kind: "installer",
  jobDir: "/state/updates/jobs/job1",
  checkout: CO,
  repo: "file:///standin",
  installRef: "v0.3.3",
  from: { sha: OLD, label: "v0.3.2" },
  to: { sha: NEW, label: "v0.3.3" },
  auto: false,
  startedAt: "2026-10-14T12:00:00.000Z",
  healthUrl: "http://127.0.0.1:4800/api/health",
  port: 4800,
  waitMs: 60_000,
  serverPid: 1234,
  unit: { manager: "systemd", name: "sova.service" },
  uid: 1000,
  env: { PATH: "/usr/bin", HOME: "/home/u" },
  installer: { script: "/state/updates/jobs/job1/install.sh", launcher: "/home/u/.local/bin/sova", binDir: "/home/u/.local/bin", installPort: 4800, noExtensions: false, noAppEntry: true, serverLog: "/state/app-server.log" },
  ...over,
});

const KEEP = `${CO}.sova-previous-job1`;

/** install.sh as the job sees it: prints its phases, keeps the previous install, restarts its service. */
const installer = (opts: { fail?: "before" | "after"; serves?: () => string | null } = {}) => (cmd: string, w: World): RunResult | undefined => {
  if (cmd.startsWith("bash ")) {
    if (opts.fail === "before") return { code: 1, out: "cloning file:///standin at v0.3.3\nsova install: pnpm install failed; nothing was changed\n" };
    w.paths.add(KEEP);
    if (opts.fail === "after") return { code: 1, out: "cloning\ninstalling dependencies\nbuilding\nsova install: could not write the launcher\n" };
    w.setServing(opts.serves ?? (() => NEW));
    return { code: 0, out: "cloning file:///standin at v0.3.3\ninstalling dependencies (including dev dependencies)\nbuilding\nservice: restarted sova.service\n" };
  }
  if (cmd === `git -C ${CO} rev-parse HEAD`) return { code: 0, out: `${opts.fail === "after" ? NEW : w.paths.has(KEEP) ? NEW : OLD}\n` };
  return undefined;
};

test("installed copy: the target's installer runs with keep-previous; once the new commit answers, the kept version goes", async () => {
  const w = world(installer(), [CO]);
  const job = await runUpgrade(basePlan(), w.deps);
  assert.equal(job.state, "succeeded");
  assert.equal(job.detail, "Upgraded to v0.3.3.");
  const bash = w.calls.find((c) => c.startsWith("bash "))!;
  assert.match(bash, /install\.sh --dir \/srv\/sova --bin \/home\/u\/\.local\/bin --port 4800 --service --no-app-entry$/);
  assert.deepEqual(
    w.states.map((s) => s.step),
    ["starting", "downloading", "installing", "building", "restarting", "verifying", "done"],
  );
  assert.ok(!w.paths.has(KEEP), "the previous version is deleted only after health passed");
  assert.ok(w.calls.indexOf(`rm ${KEEP}`) > w.calls.findIndex((c) => c.startsWith("bash ")));
});

test("installed copy: a new version that doesn't answer within a minute is replaced by the kept one, restarted", async () => {
  const w = world(installer({ serves: () => null }), [CO]);
  // Once the previous version is back and restarted, it answers with its commit.
  const origRun = w.deps.run;
  w.deps.run = async (file, args, opts) => {
    const r = await origRun(file, args, opts);
    if (file === "systemctl" && args.includes("restart")) w.setServing(() => OLD);
    return r;
  };
  const job = await runUpgrade(basePlan(), w.deps);
  assert.equal(job.state, "rolled-back");
  assert.equal(job.detail, "v0.3.3 didn't start within a minute, so we put v0.3.2 back.");
  assert.ok(w.calls.includes(`mv ${CO} ${CO}.sova-failed-job1`) && w.calls.includes(`mv ${KEEP} ${CO}`), "the kept install is the checkout again");
  assert.ok(w.calls.includes("systemctl --user restart sova.service"));
  assert.ok(w.paths.has(CO) && !w.paths.has(KEEP) && !w.paths.has(`${CO}.sova-failed-job1`));
  assert.ok(w.states.some((s) => s.step === "rolling-back"));
});

test("installed copy: an installer that fails before promoting changes nothing and restarts nothing", async () => {
  const w = world(installer({ fail: "before" }), [CO]);
  const job = await runUpgrade(basePlan(), w.deps);
  assert.equal(job.state, "failed");
  assert.equal(job.detail, "The installer failed: pnpm install failed. Nothing changed: v0.3.2 still runs. See the log.");
  assert.ok(!w.calls.some((c) => c.startsWith("systemctl") || c.startsWith("mv ")));
});

test("installed copy: an installer that fails after promoting gets its kept version put back", async () => {
  const w = world(installer({ fail: "after" }), [CO]);
  const job = await runUpgrade(basePlan(), w.deps);
  assert.equal(job.state, "failed");
  assert.ok(w.calls.includes(`mv ${KEEP} ${CO}`));
  assert.ok(!w.calls.some((c) => c.startsWith("systemctl")), "the old server still answered with its commit: no restart");
});

test("installed copy with no service: the job stops the old server and starts the launcher again", async () => {
  const w = world(installer(), [CO]);
  // The old server exits once signalled.
  let alive = true;
  w.deps.signal = (pid, sig) => {
    w.signals.push(`${pid} ${sig}`);
    if (sig === "SIGTERM") alive = false;
    return sig === 0 ? alive : true;
  };
  const job = await runUpgrade(basePlan({ unit: null }), w.deps);
  assert.equal(job.state, "succeeded");
  assert.ok(w.calls.find((c) => c.startsWith("bash "))!.includes("--no-service"));
  assert.deepEqual(w.signals.filter((s) => s.endsWith("SIGTERM")), ["1234 SIGTERM"]);
  assert.deepEqual(w.started, ["/home/u/.local/bin/sova PORT=4800"]);
});

// ---- developer copies ----

const dev = (over: { dirty?: string; ff?: boolean; buildFails?: boolean; head?: string; on?: string } = {}) => (cmd: string, w: World): RunResult | undefined => {
  const g = `git -C ${CO} `;
  if (cmd === `${g}symbolic-ref --quiet --short HEAD`) return { code: over.on === "" ? 1 : 0, out: `${over.on ?? "master"}\n` };
  if (cmd === `${g}status --porcelain --untracked-files=no`) return { code: 0, out: over.dirty ?? "" };
  if (cmd === `${g}rev-parse HEAD`) return { code: 0, out: `${over.head ?? OLD}\n` };
  if (cmd.startsWith(`${g}cat-file -e`)) return { code: 0, out: "" };
  if (cmd.startsWith(`${g}merge-base --is-ancestor`)) return { code: over.ff === false ? 1 : 0, out: "" };
  if (cmd.startsWith("pnpm exec vite build")) {
    if (over.buildFails) return { code: 1, out: "error: Could not resolve ./x\n" };
    const out = cmd.split("--outDir ")[1]!.split(" ")[0]!;
    w.paths.add(out);
    return { code: 0, out: "built\n" };
  }
  if (cmd === "systemctl --user restart sova-runtime.service") w.setServing(() => NEW);
  return undefined;
};

const devPlan = (over: Partial<UpgradePlan> = {}) =>
  basePlan({ kind: "developer", installer: undefined, installRef: "refs/heads/master", from: { sha: OLD, label: "master at aaaaaaa" }, to: { sha: NEW, label: "master" }, unit: { manager: "systemd", name: "sova-runtime.service" }, branch: "master", ...over });

test("developer copy: uncommitted changes refuse the upgrade and change nothing", async () => {
  const w = world(dev({ dirty: " M server/app.ts\n M src/App.tsx\n" }), [CO, `${CO}/dist`]);
  const job = await runUpgrade(devPlan(), w.deps);
  assert.equal(job.state, "failed");
  assert.equal(job.detail, "Your copy has uncommitted changes in 2 files. Commit or stash them, then upgrade. Nothing changed.");
  assert.ok(!w.calls.some((c) => / (merge|checkout|reset) /.test(c) || c.startsWith("pnpm") || c.startsWith("systemctl")));
});

test("developer copy: a move that isn't a fast-forward is refused, changing nothing", async () => {
  const w = world(dev({ ff: false }), [CO]);
  const job = await runUpgrade(devPlan(), w.deps);
  assert.equal(job.state, "failed");
  assert.match(job.detail!, /isn't a fast-forward from your copy, so we won't move it\. Nothing changed\./);
  assert.ok(!w.calls.some((c) => / merge --ff-only /.test(c)));
});

test("developer copy: fast-forward, install, build into staging, swap, restart; the previous build goes only after health", async () => {
  const w = world(dev(), [CO, `${CO}/dist`, `${CO}/dist-share`]);
  const job = await runUpgrade(devPlan(), w.deps);
  assert.equal(job.state, "succeeded");
  assert.ok(w.calls.includes(`git -C ${CO} -c maintenance.auto=false -c gc.auto=0 merge --ff-only --quiet ${NEW}`), "on a branch: merge --ff-only, starting no background cleanup");
  assert.ok(w.calls.includes("pnpm install --frozen-lockfile"));
  assert.ok(w.calls.includes(`mv ${CO}/dist ${CO}/dist.sova-previous-job1`));
  assert.ok(w.calls.includes(`mv ${CO}/.sova-update-build-job1/dist ${CO}/dist`));
  assert.ok(w.calls.indexOf("systemctl --user restart sova-runtime.service") < w.calls.indexOf(`rm ${CO}/dist.sova-previous-job1`));
  assert.ok(w.paths.has(`${CO}/dist`) && !w.paths.has(`${CO}/dist.sova-previous-job1`));
});

test("developer copy, detached: moved with checkout --detach, never a branch", async () => {
  const w = world(dev(), [CO]);
  const job = await runUpgrade(devPlan({ branch: null }), w.deps);
  assert.equal(job.state, "succeeded");
  assert.ok(w.calls.includes(`git -C ${CO} checkout --quiet --detach ${NEW}`));
  assert.ok(!w.calls.some((c) => c.includes(" merge --ff-only ")));
});

test("developer copy: a failed build moves the branch back and reinstalls, with no restart", async () => {
  const w = world(dev({ buildFails: true }), [CO, `${CO}/dist`]);
  const job = await runUpgrade(devPlan(), w.deps);
  assert.equal(job.state, "failed");
  assert.equal(job.detail, "The build failed: Could not resolve ./x. Nothing changed: master at aaaaaaa still runs. See the log.");
  assert.ok(w.calls.includes(`git -C ${CO} reset --keep --quiet ${OLD}`));
  assert.equal(w.calls.filter((c) => c === "pnpm install --frozen-lockfile").length, 2, "installed, then reinstalled for the old commit");
  assert.ok(!w.calls.some((c) => c.startsWith("systemctl")));
  assert.ok(w.paths.has(`${CO}/dist`), "the build that runs was never touched");
});

test("developer copy: a new version that doesn't answer gets the old commit, dependencies and build back", async () => {
  const w = world(dev(), [CO, `${CO}/dist`, `${CO}/dist-share`]);
  let restarts = 0;
  const run = w.deps.run;
  w.deps.run = async (file, args, opts) => {
    const r = await run(file, args, opts);
    if (file === "systemctl") w.setServing(++restarts === 1 ? () => null : () => OLD);
    return r;
  };
  const job = await runUpgrade(devPlan(), w.deps);
  assert.equal(job.state, "rolled-back");
  assert.ok(w.calls.includes(`git -C ${CO} reset --keep --quiet ${OLD}`));
  assert.ok(w.calls.includes(`mv ${CO}/dist.sova-previous-job1 ${CO}/dist`));
  assert.equal(restarts, 2);
});

test("developer copy: the job itself refuses a branch other than the source's, before any git move", async () => {
  const w = world(dev({ on: "topic" }), [CO, `${CO}/dist`]);
  const job = await runUpgrade(devPlan({ source: { kind: "master" } }), w.deps);
  assert.equal(job.state, "failed");
  assert.equal(job.detail, "You're on topic; switch to master to follow it. Nothing changed.");
  assert.ok(!w.calls.some((c) => / (fetch|merge|checkout|reset) /.test(c) || c.startsWith("pnpm") || c.startsWith("systemctl")));
  const ok = world(dev(), [CO, `${CO}/dist`]);
  assert.equal((await runUpgrade(devPlan({ source: { kind: "master" } }), ok.deps)).state, "succeeded", "on master it moves");
});
