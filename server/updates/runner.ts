/**
 * The upgrade job: runs OUTSIDE the server's service (a transient systemd
 * user unit, or a detached process on macOS), so the restart it causes can't cut it off. The server
 * copies this file into the job's directory, `<stateRoot>/updates/jobs/<id>/`, and starts it there
 * with `plan.json` beside it; it writes `state.json` (an UpdateJob) at every step and its log to
 * `log.txt`, and the restarted server reads both.
 *
 * Self-contained on purpose: node builtins only and type-only imports, and only TypeScript syntax
 * that erases (Bun and Node's type stripping both run it), because an upgrade replaces the checkout
 * this file came from while it runs.
 *
 * The version that runs keeps running until the new one is built; the restarted server must report
 * the new commit on `GET /api/health` within `plan.waitMs` (60 s), and only then is the previous
 * version deleted. Otherwise the previous one goes back and is restarted.
 */
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateJob, UpdateStep } from "../../shared/protocol";

export interface UpgradePlan {
  id: string;
  kind: "installer" | "developer";
  jobDir: string;
  checkout: string;
  repo: string;
  /** The private ref the target was fetched into, and the ref name install.sh is given (a release tag, master, a branch). */
  installRef: string;
  from: { sha: string; label: string };
  to: { sha: string; label: string };
  auto: boolean;
  startedAt: string;
  /** `http://127.0.0.1:<port>/api/health`. */
  healthUrl: string;
  port: number;
  waitMs: number;
  /** The server that started the job: stopped and started again when no service runs it. */
  serverPid: number;
  unit: { manager: "systemd" | "launchd"; name: string } | null;
  uid: number;
  /** The environment every program the job runs gets (PATH, HOME, the agent dir, …). */
  env: Record<string, string>;
  /** Installed copy. */
  installer?: { script: string; launcher: string; binDir: string; installPort: number | null; noExtensions: boolean; noAppEntry: boolean; serverLog: string };
  /** Developer copy: the branch checked out (null: detached). */
  branch?: string | null;
}

export interface RunResult {
  code: number;
  out: string;
}

export interface RunnerDeps {
  /** Run a program to its end; every output line goes to the log and to `onLine`. */
  run(file: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; onLine?: (line: string) => void; timeoutMs?: number }): Promise<RunResult>;
  /** The commit `GET /api/health` reports, or null when nothing answers. */
  health(url: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** Start a program that outlives the job (the launcher, with no service): its pid. */
  startDetached(file: string, args: string[], env: Record<string, string>, logFile: string): number | null;
  /** Signal a process; false when it is gone. */
  signal(pid: number, sig: NodeJS.Signals | 0): boolean;
  writeState(job: UpdateJob): void;
  log(line: string): void;
}

/** What one failed step left, for the job's detail. */
class StepFailed extends Error {}

const lastLine = (out: string): string =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0]
    ?.replace(/^(sova install|fatal|error):\s*/i, "")
    .replace(/\.$/, "") ?? "no output";

export async function runUpgrade(plan: UpgradePlan, deps: RunnerDeps): Promise<UpdateJob> {
  const job: UpdateJob = {
    id: plan.id,
    kind: plan.kind,
    from: plan.from,
    to: plan.to,
    auto: plan.auto,
    startedAt: plan.startedAt,
    step: "starting",
    state: "running",
    detail: null,
    logPath: join(plan.jobDir, "log.txt"),
    endedAt: null,
  };
  const step = (s: UpdateStep, detail: string | null = null) => {
    job.step = s;
    job.detail = detail;
    deps.log(`== ${s}${detail ? `: ${detail}` : ""}`);
    deps.writeState(job);
  };
  const finish = (state: UpdateJob["state"], detail: string) => {
    job.state = state;
    job.step = "done";
    job.detail = detail;
    job.endedAt = new Date(deps.now()).toISOString();
    deps.log(`== ${state}: ${detail}`);
    deps.writeState(job);
    return job;
  };
  step("starting");
  try {
    return plan.kind === "installer" ? await upgradeInstalled(plan, deps, step, finish) : await upgradeDeveloper(plan, deps, step, finish);
  } catch (err) {
    return finish("failed", `The upgrade stopped: ${err instanceof Error ? err.message : String(err)}. See the log.`);
  }
}

/** Wait until the server reports `sha` (true), or `ms` passes (false). */
async function waitFor(plan: UpgradePlan, deps: RunnerDeps, sha: string, ms: number): Promise<boolean> {
  const until = deps.now() + ms;
  for (;;) {
    const head = await deps.health(plan.healthUrl);
    if (head === sha) return true;
    if (deps.now() >= until) return false;
    await deps.sleep(1000);
  }
}

/** Restart the service that runs Sova, or with none stop `pid` and start the launcher again: the started pid (no service), else null. */
async function restart(plan: UpgradePlan, deps: RunnerDeps, pid: number | null): Promise<number | null> {
  if (plan.unit?.manager === "systemd") {
    const r = await deps.run("systemctl", ["--user", "restart", plan.unit.name], { env: plan.env, timeoutMs: 120_000 });
    if (r.code !== 0) throw new StepFailed(`systemctl couldn't restart ${plan.unit.name}: ${lastLine(r.out)}`);
    return null;
  }
  if (plan.unit?.manager === "launchd") {
    const r = await deps.run("launchctl", ["kickstart", "-k", `gui/${plan.uid}/${plan.unit.name}`], { env: plan.env, timeoutMs: 120_000 });
    if (r.code !== 0) throw new StepFailed(`launchctl couldn't restart ${plan.unit.name}: ${lastLine(r.out)}`);
    return null;
  }
  const inst = plan.installer;
  if (!inst) throw new StepFailed("nothing restarts this copy");
  if (pid !== null && deps.signal(pid, 0)) {
    deps.signal(pid, "SIGTERM");
    const until = deps.now() + 95_000;
    while (deps.signal(pid, 0) && deps.now() < until) await deps.sleep(500);
    if (deps.signal(pid, 0)) deps.signal(pid, "SIGKILL");
  }
  const started = deps.startDetached(inst.launcher, [], { ...plan.env, PORT: String(plan.port) }, inst.serverLog);
  if (started === null) throw new StepFailed(`couldn't start ${inst.launcher}`);
  return started;
}

async function upgradeInstalled(
  plan: UpgradePlan,
  deps: RunnerDeps,
  step: (s: UpdateStep, d?: string | null) => void,
  finish: (s: UpdateJob["state"], d: string) => UpdateJob,
): Promise<UpdateJob> {
  const inst = plan.installer!;
  const keep = `${plan.checkout}.sova-previous-${plan.id}`;
  const failedDir = `${plan.checkout}.sova-failed-${plan.id}`;
  const args = [inst.script, "--dir", plan.checkout, "--bin", inst.binDir, ...(inst.installPort ? ["--port", String(inst.installPort)] : []), plan.unit ? "--service" : "--no-service"];
  if (inst.noExtensions) args.push("--no-extensions");
  if (inst.noAppEntry) args.push("--no-app-entry");
  let phase: UpdateStep = "downloading";
  const phaseTo = (s: UpdateStep) => {
    if (phase === s) return;
    phase = s;
    step(s);
  };
  step("downloading");
  const env = { ...plan.env, SOVA_REF: plan.installRef, SOVA_REPO: plan.repo, SOVA_TTY: "/dev/null", SOVA_KEEP_PREVIOUS: keep };
  const r = await deps.run("bash", args, {
    cwd: plan.jobDir,
    env,
    timeoutMs: 45 * 60_000,
    onLine: (line) => {
      if (/^installing dependencies/.test(line)) phaseTo("installing");
      else if (/^building/.test(line)) phaseTo("building");
    },
  });
  const putBack = async (why: string): Promise<UpdateJob> => {
    // The installer replaced the checkout and then failed: the kept version goes back.
    if (deps.exists(keep)) {
      step("rolling-back");
      if (deps.exists(plan.checkout)) deps.rename(plan.checkout, failedDir);
      deps.rename(keep, plan.checkout);
      deps.remove(failedDir);
      if ((await deps.health(plan.healthUrl)) !== plan.from.sha) {
        await restart(plan, deps, null);
        await waitFor(plan, deps, plan.from.sha, plan.waitMs);
      }
    }
    return finish("failed", `${why} Nothing changed: ${plan.from.label} still runs. See the log.`);
  };
  if (r.code !== 0) return putBack(`The installer failed: ${lastLine(r.out)}.`);
  const head = await deps.run("git", ["-C", plan.checkout, "rev-parse", "HEAD"], { env: plan.env });
  const newHead = head.code === 0 ? head.out.trim().split("\n").pop()!.trim() : "";
  if (!newHead || newHead === plan.from.sha) return putBack("The installer changed nothing.");
  if (!deps.exists(keep)) deps.log("the installer kept no previous version: a rollback isn't possible");

  step("restarting");
  // The installer restarted its own service; with none, the job stops the old server and starts the launcher.
  let pid: number | null = null;
  if (!plan.unit) pid = await restart(plan, deps, plan.serverPid);
  step("verifying");
  if (await waitFor(plan, deps, newHead, plan.waitMs)) {
    if (deps.exists(keep)) deps.remove(keep);
    return finish("succeeded", `Upgraded to ${plan.to.label}.`);
  }
  if (!deps.exists(keep)) return finish("failed", `${plan.to.label} didn't start within a minute, and there was no previous version to put back. See the log.`);
  step("rolling-back");
  if (pid !== null) deps.signal(pid, "SIGTERM");
  deps.rename(plan.checkout, failedDir);
  deps.rename(keep, plan.checkout);
  await restart(plan, deps, pid);
  const back = await waitFor(plan, deps, plan.from.sha, plan.waitMs);
  deps.remove(failedDir);
  return finish(
    "rolled-back",
    back ? `${plan.to.label} didn't start within a minute, so we put ${plan.from.label} back.` : `${plan.to.label} didn't start within a minute. We put ${plan.from.label} back, but it hasn't answered yet. See the log.`,
  );
}

async function upgradeDeveloper(
  plan: UpgradePlan,
  deps: RunnerDeps,
  step: (s: UpdateStep, d?: string | null) => void,
  finish: (s: UpdateJob["state"], d: string) => UpdateJob,
): Promise<UpdateJob> {
  const git = (args: string[], timeoutMs = 120_000) => deps.run("git", ["-C", plan.checkout, ...args], { env: plan.env, timeoutMs });
  const pnpm = (args: string[]) => deps.run("pnpm", args, { cwd: plan.checkout, env: { ...plan.env, CI: "1" }, timeoutMs: 30 * 60_000 });

  // A developer copy's refusals change nothing.
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0) return finish("failed", `git couldn't read your copy: ${lastLine(dirty.out)}. Nothing changed.`);
  const changed = dirty.out.split("\n").filter((l) => l.trim()).length;
  if (changed > 0) return finish("failed", `Your copy has uncommitted changes in ${changed} ${changed === 1 ? "file" : "files"}. Commit or stash them, then upgrade. Nothing changed.`);
  const head = (await git(["rev-parse", "HEAD"])).out.trim();
  if (head !== plan.from.sha) return finish("failed", `Your copy moved since the check (it's at ${head.slice(0, 7)} now). Check again. Nothing changed.`);
  step("downloading");
  if ((await git(["cat-file", "-e", `${plan.to.sha}^{commit}`])).code !== 0) {
    const f = await git(["-c", "fetch.writeFetchHEAD=false", "fetch", "--quiet", "--no-tags", plan.repo, `+${plan.installRef}:refs/sova-updates/target`], 600_000);
    if (f.code !== 0) return finish("failed", `Couldn't fetch ${plan.to.label}: ${lastLine(f.out)}. Nothing changed.`);
  }
  if ((await git(["merge-base", "--is-ancestor", plan.from.sha, plan.to.sha])).code !== 0) {
    return finish("failed", `Moving to ${plan.to.label} isn't a fast-forward from your copy, so we won't move it. Nothing changed.`);
  }
  const branch = plan.branch ?? null;
  const moved = branch ? await git(["merge", "--ff-only", "--quiet", plan.to.sha]) : await git(["checkout", "--quiet", "--detach", plan.to.sha]);
  if (moved.code !== 0) return finish("failed", `git couldn't move your copy to ${plan.to.label}: ${lastLine(moved.out)}. Nothing changed.`);

  const build = join(plan.checkout, `.sova-update-build-${plan.id}`);
  const outs = ["dist", "dist-share"];
  const moveBack = async () => {
    const back = branch ? await git(["reset", "--keep", "--quiet", plan.from.sha]) : await git(["checkout", "--quiet", "--detach", plan.from.sha]);
    if (back.code !== 0) deps.log(`could not move the copy back: ${back.out}`);
    const re = await pnpm(["install", "--frozen-lockfile"]);
    if (re.code !== 0) deps.log("could not reinstall the previous dependencies");
  };
  const failBefore = async (what: string, r: RunResult) => {
    deps.remove(build);
    await moveBack();
    return finish("failed", `${what} failed: ${lastLine(r.out)}. Nothing changed: ${plan.from.label} still runs. See the log.`);
  };
  step("installing");
  const inst = await pnpm(["install", "--frozen-lockfile"]);
  if (inst.code !== 0) return failBefore("Installing dependencies", inst);
  step("building");
  const app = await pnpm(["exec", "vite", "build", "--outDir", join(build, "dist"), "--emptyOutDir"]);
  if (app.code !== 0) return failBefore("The build", app);
  const share = await pnpm(["exec", "vite", "build", "--mode", "share", "--outDir", join(build, "dist-share"), "--emptyOutDir"]);
  if (share.code !== 0) return failBefore("The build", share);
  // The new build goes in; the one that runs now waits beside it until the new version answers.
  for (const d of outs) {
    const live = join(plan.checkout, d);
    if (deps.exists(live)) deps.rename(live, `${live}.sova-previous-${plan.id}`);
    deps.rename(join(build, d), live);
  }
  deps.remove(build);

  step("restarting");
  await restart(plan, deps, null);
  step("verifying");
  if (await waitFor(plan, deps, plan.to.sha, plan.waitMs)) {
    for (const d of outs) deps.remove(join(plan.checkout, `${d}.sova-previous-${plan.id}`));
    return finish("succeeded", `Upgraded to ${plan.to.label}.`);
  }
  step("rolling-back");
  await moveBack();
  for (const d of outs) {
    const live = join(plan.checkout, d);
    const prev = `${live}.sova-previous-${plan.id}`;
    if (!deps.exists(prev)) continue;
    deps.remove(live);
    deps.rename(prev, live);
  }
  await restart(plan, deps, null);
  const back = await waitFor(plan, deps, plan.from.sha, plan.waitMs);
  return finish(
    "rolled-back",
    back ? `${plan.to.label} didn't start within a minute, so we put ${plan.from.label} back.` : `${plan.to.label} didn't start within a minute. We put ${plan.from.label} back, but it hasn't answered yet. See the log.`,
  );
}

// ---- the real job -------------------------------------------------------------------------------

export function realDeps(jobDir: string): RunnerDeps {
  const logFile = join(jobDir, "log.txt");
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // the log is best effort
    }
  };
  return {
    run: (file, args, opts) =>
      new Promise((done) => {
        log(`$ ${file} ${args.join(" ")}`);
        let out = "";
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
          return done({ code: 127, out: (err as Error).message });
        }
        const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : null;
        let partial = "";
        const take = (chunk: Buffer) => {
          const text = partial + chunk.toString("utf8");
          const lines = text.split("\n");
          partial = lines.pop() ?? "";
          for (const l of lines) {
            out += `${l}\n`;
            log(`  ${l}`);
            opts.onLine?.(l);
          }
        };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        child.once("error", (err) => {
          if (timer) clearTimeout(timer);
          done({ code: 127, out: `${out}${err.message}` });
        });
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          if (partial) {
            out += partial;
            log(`  ${partial}`);
            opts.onLine?.(partial);
          }
          log(`  (exit ${code ?? "signal"})`);
          done({ code: code ?? 1, out });
        });
      }),
    health: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return null;
        const body = (await r.json()) as { head?: unknown };
        return typeof body.head === "string" ? body.head : null;
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    exists: (p) => existsSync(p),
    rename: (a, b) => {
      log(`mv ${a} ${b}`);
      renameSync(a, b);
    },
    remove: (p) => {
      log(`rm -rf ${p}`);
      rmSync(p, { recursive: true, force: true });
    },
    startDetached: (file, args, env, logFile2) => {
      try {
        mkdirSync(dirname(logFile2), { recursive: true });
        const fd = openSync(logFile2, "a");
        const child = spawn(file, args, { env, detached: true, stdio: ["ignore", fd, fd] });
        closeSync(fd);
        child.unref();
        log(`started ${file} (pid ${child.pid})`);
        return child.pid ?? null;
      } catch (err) {
        log(`could not start ${file}: ${(err as Error).message}`);
        return null;
      }
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
    writeState: (job) => {
      const file = join(jobDir, "state.json");
      writeFileSync(`${file}.tmp`, `${JSON.stringify(job, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    },
    log,
  };
}

/** Copy this file into the job's directory: the job runs the copy, never a file an upgrade replaces. */
export function installRunner(jobDir: string): string {
  const to = join(jobDir, "runner.ts");
  copyFileSync(fileURLToPath(import.meta.url), to);
  return to;
}

async function main(jobDir: string): Promise<void> {
  const plan = JSON.parse(readFileSync(join(jobDir, "plan.json"), "utf8")) as UpgradePlan;
  const deps = realDeps(jobDir);
  deps.log(`upgrade ${plan.id}: ${plan.from.label} (${plan.from.sha.slice(0, 7)}) → ${plan.to.label} (${plan.to.sha.slice(0, 7)}), ${plan.kind} copy, pid ${process.pid}`);
  const job = await runUpgrade(plan, deps);
  process.exitCode = job.state === "succeeded" ? 0 : 1;
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main || (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url))) {
  void main(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
}
