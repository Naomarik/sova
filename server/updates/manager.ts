import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCheck, UpdateJob, UpdatesRunning, UpdatesSettings, UpdatesState } from "../../shared/protocol";
import { branchMismatch, checkForUpdate, describeRunning, lsRemoteArgs, offersUpgrade, parseLsRemote, sourceRef } from "./check";
import { firstLine, type Git } from "./git";
import type { InstallInfo } from "./install-kind";
import { binDirOf } from "./install-kind";
import type { UpgradePlan } from "./runner";
import { nextCheckDue, parseSource, readUpdatesFile, sameSource, sourceLabel, validBranchName, writeUpdatesFile, type UpdatesFile } from "./state";

/**
 * Updates: what runs, the daily check, the settings, and starting an upgrade job.
 * Everything outside this process comes through `UpdatesDeps`, so unit tests drive the cadence, the
 * refusals and the automatic upgrade with fake git, clocks and launchers.
 */

export class UpdatesRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 409,
  ) {
    super(message);
  }
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface UpdatesDeps {
  /** `<stateRoot>/updates.json`. */
  file: string;
  /** `<stateRoot>/updates/jobs`. */
  jobsDir: string;
  repo: string;
  checksOff: boolean;
  /** The commit this server started on. */
  startedHead: string | null;
  /** What kind of copy this is (cached by the caller; read once per state). */
  install(): Promise<InstallInfo>;
  /** git in a checkout. */
  git(checkout: string): Git;
  now(): number;
  timers: Timers;
  /** Wait after start before an overdue check runs. */
  startDelayMs: number;
  /** Start the job: null once it runs, else why it couldn't start. */
  launch(plan: UpgradePlan): Promise<string | null>;
  /** The port this server listens on, its health URL, its pid, and the environment the job gets. */
  port(): number;
  healthUrl(): string;
  pid: number;
  uid: number;
  jobEnv(): Record<string, string>;
  /** Where the launcher's server writes when the job starts it (no service). */
  serverLog: string;
  log(line: string): void;
}

/** A running job older than this with no word is taken as dead. */
const STALE_JOB_MS = 2 * 60 * 60 * 1000;

export class UpdatesManager {
  private checking: Promise<UpdateCheck> | null = null;
  private timer: unknown = null;
  private autoRefusal: string | null = null;
  private launching = false;

  constructor(private readonly deps: UpdatesDeps) {}

  private read(): UpdatesFile {
    return readUpdatesFile(this.deps.file);
  }

  private write(f: UpdatesFile): void {
    writeUpdatesFile(this.deps.file, f);
  }

  settings(): UpdatesSettings {
    const f = this.read();
    return { source: f.source, autoCheck: f.autoCheck, autoUpgrade: f.autoUpgrade };
  }

  async running(info?: InstallInfo): Promise<UpdatesRunning> {
    const i = info ?? (await this.deps.install());
    const base: UpdatesRunning = { head: null, startedHead: this.deps.startedHead, version: null, baseVersion: null, pastBase: null, branch: null, kind: i.kind, canUpgrade: i.kind !== "check-only", whyNot: i.whyNot };
    if (!i.checkout) return base;
    const r = await describeRunning(this.deps.git(i.checkout));
    return { ...base, ...r };
  }

  /** The latest job, its finished outcome recorded in updates.json once. */
  job(): UpdateJob | null {
    let ids: string[] = [];
    try {
      ids = readdirSync(this.deps.jobsDir).filter((n) => /^[0-9a-z-]+$/.test(n));
    } catch {
      return null;
    }
    const id = ids.sort().pop();
    if (!id) return null;
    const file = join(this.deps.jobsDir, id, "state.json");
    let job: UpdateJob;
    try {
      job = JSON.parse(readFileSync(file, "utf8")) as UpdateJob;
    } catch {
      return null;
    }
    if (job.state === "running") {
      let at = Date.parse(job.startedAt);
      try {
        at = statSync(file).mtimeMs;
      } catch {
        // keep startedAt
      }
      if (this.deps.now() - at > STALE_JOB_MS) job = { ...job, state: "failed", step: "done", detail: "The upgrade stopped without finishing. See the log.", endedAt: new Date(at).toISOString() };
    }
    if (job.state !== "running") {
      const f = this.read();
      if (f.lastUpgrade?.id !== job.id) {
        f.lastUpgrade = { id: job.id, from: job.from.sha, to: job.to.sha, at: job.endedAt ?? new Date(this.deps.now()).toISOString(), outcome: job.state, logPath: job.logPath };
        this.write(f);
      }
    }
    return job;
  }

  async state(): Promise<UpdatesState> {
    const info = await this.deps.install();
    const f = this.read();
    const running = await this.running(info);
    const job = this.job();
    const due = nextCheckDue(f, this.deps.checksOff, this.deps.now());
    const current = f.lastCheck && f.lastCheck.ok && sameSource(f.lastCheck.source, f.source) && f.lastCheck.head === running.head ? f.lastCheck : null;
    return {
      settings: { source: f.source, autoCheck: f.autoCheck, autoUpgrade: f.autoUpgrade },
      running,
      lastCheck: f.lastCheck,
      checking: this.checking !== null,
      checksOff: this.deps.checksOff,
      nextCheckAt: due === null ? null : new Date(due).toISOString(),
      job,
      available: running.canUpgrade && offersUpgrade(current?.result, info.kind) && job?.state !== "running",
      autoRefusal: this.autoRefusal,
    };
  }

  /** Check now (Check Now, or the daily check with `auto`): one at a time, a second caller shares it. */
  check(opts: { auto?: boolean } = {}): Promise<UpdateCheck> {
    if (this.deps.checksOff) return Promise.reject(new UpdatesRefusal("Checks are off on this server (SOVA_UPDATES_CHECK=off)."));
    if (this.checking) return this.checking;
    const run = this.runCheck(!!opts.auto).finally(() => {
      this.checking = null;
      this.schedule();
    });
    this.checking = run;
    return run;
  }

  private async runCheck(auto: boolean): Promise<UpdateCheck> {
    const info = await this.deps.install();
    const f = this.read();
    const at = new Date(this.deps.now()).toISOString();
    this.autoRefusal = null;
    let check: UpdateCheck;
    if (!info.checkout) {
      check = { at, ok: false, source: f.source, head: null, error: info.whyNot ?? "This server doesn't run from a git checkout." };
    } else {
      const git = this.deps.git(info.checkout);
      const running = await describeRunning(git);
      try {
        if (!running.head) throw new Error("git couldn't read this copy's commit.");
        const { result } = await checkForUpdate({ git, repo: this.deps.repo, source: f.source, kind: info.kind, head: running.head, branch: running.branch });
        check = { at, ok: true, source: f.source, head: running.head, result };
      } catch (err) {
        check = { at, ok: false, source: f.source, head: running.head, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const fresh = this.read();
    fresh.lastCheck = check;
    this.write(fresh);
    this.deps.log(`[updates] ${auto ? "daily " : ""}check of ${sourceLabel(f.source)}: ${check.ok ? check.result?.state : `failed: ${check.error}`}`);
    // Upgrade automatically: the same path as the button, the same refusals.
    if (auto && fresh.autoUpgrade && check.ok && offersUpgrade(check.result, info.kind) && info.kind !== "check-only") {
      const target = check.result.target;
      // A version that was put back because it didn't start isn't installed again unattended: each
      // try costs a minute of Sova not answering. The button still offers it.
      this.job(); // records a finished job's outcome in updates.json
      const last = this.read().lastUpgrade;
      if (last && last.to === target.sha && last.outcome === "rolled-back") {
        this.autoRefusal = `${target.label} was put back last time, so it isn't installed again automatically. Upgrade by hand to try it again.`;
        this.deps.log(`[updates] automatic upgrade didn't start: ${this.autoRefusal}`);
      } else {
        try {
          await this.apply({ target: target.sha, auto: true });
        } catch (err) {
          this.autoRefusal = err instanceof Error ? err.message : String(err);
          this.deps.log(`[updates] automatic upgrade didn't start: ${this.autoRefusal}`);
        }
      }
    }
    return check;
  }

  /** Save the Updates form: a branch must exist in Sova's repository. Changing the source installs nothing. */
  async saveSettings(input: unknown): Promise<UpdatesSettings> {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const f = this.read();
    let source = f.source;
    if (body.source !== undefined) {
      const raw = body.source as Record<string, unknown> | null;
      if (raw && raw.kind === "branch") {
        const name = typeof raw.branch === "string" ? raw.branch.trim() : "";
        if (!name) throw new UpdatesRefusal("Updates: Name the branch.", 400);
        if (!validBranchName(name)) throw new UpdatesRefusal(`Updates: ${name} isn't a branch name git takes.`, 400);
      }
      const parsed = parseSource(raw);
      if (!parsed) throw new UpdatesRefusal("Updates: Choose Stable releases, Latest changes or a branch.", 400);
      if (parsed.kind === "branch" && !(f.source.kind === "branch" && f.source.branch === parsed.branch)) {
        const info = await this.deps.install();
        const git = this.deps.git(info.checkout ?? process.cwd());
        const ls = await git(lsRemoteArgs(this.deps.repo, parsed).slice(0, 3), { timeoutMs: 60_000 });
        if (ls.code !== 0) throw new UpdatesRefusal(`Updates: Couldn't reach Sova's repository to look for ${parsed.branch}: ${firstLine(ls)}.`, 409);
        if (!parseLsRemote(ls.stdout).has(sourceRef(parsed))) throw new UpdatesRefusal(`Updates: Sova's repository has no branch ${parsed.branch}.`, 400);
      }
      source = parsed;
    }
    const bool = (k: "autoCheck" | "autoUpgrade") => {
      if (body[k] === undefined) return f[k];
      if (typeof body[k] !== "boolean") throw new UpdatesRefusal(`Updates: ${k} is true or false.`, 400);
      return body[k] as boolean;
    };
    const next: UpdatesFile = { ...this.read(), source, autoCheck: bool("autoCheck"), autoUpgrade: bool("autoUpgrade") };
    this.write(next);
    this.schedule();
    return { source: next.source, autoCheck: next.autoCheck, autoUpgrade: next.autoUpgrade };
  }

  /**
   * Start the upgrade the last check offered: refused, changing nothing, when
   * this copy can't upgrade, another job runs, the offer changed, or (a developer copy) the tree has
   * uncommitted changes or the move isn't a fast-forward.
   */
  async apply(req: { target: string; auto?: boolean }): Promise<UpdateJob> {
    if (this.launching || this.job()?.state === "running") throw new UpdatesRefusal("An upgrade is already running.");
    this.launching = true;
    try {
      return await this.startJob(req);
    } finally {
      this.launching = false;
    }
  }

  private async startJob(req: { target: string; auto?: boolean }): Promise<UpdateJob> {
    const info = await this.deps.install();
    if (info.kind === "check-only" || !info.checkout) throw new UpdatesRefusal(info.whyNot ?? "This copy can't upgrade itself.");
    const f = this.read();
    const check = f.lastCheck;
    const git = this.deps.git(info.checkout);
    const running = await describeRunning(git);
    if (!check?.ok || !sameSource(check.source, f.source) || check.head !== running.head || !offersUpgrade(check.result, info.kind)) {
      throw new UpdatesRefusal("There's no update on offer for what runs now. Check again.");
    }
    const target = check.result.target;
    if (target.sha !== req.target) throw new UpdatesRefusal("The update on offer changed since this page loaded. Check again.");
    const from = { sha: running.head!, label: running.version ?? (running.branch ? `${running.branch} at ${running.head!.slice(0, 7)}` : running.head!.slice(0, 7)) };

    if (info.kind === "developer") {
      const wrong = branchMismatch(f.source, running.branch);
      if (wrong) throw new UpdatesRefusal(wrong);
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
      const n = dirty.stdout.split("\n").filter((l) => l.trim()).length;
      if (dirty.code !== 0) throw new UpdatesRefusal(`git couldn't read your copy: ${firstLine(dirty)}.`);
      if (n > 0) throw new UpdatesRefusal(`Your copy has uncommitted changes in ${n} ${n === 1 ? "file" : "files"}. Commit or stash them, then upgrade.`);
      if ((await git(["merge-base", "--is-ancestor", running.head!, target.sha])).code !== 0) {
        throw new UpdatesRefusal(`Moving to ${target.label} isn't a fast-forward from your copy, so we won't move it.`);
      }
    }

    const id = `${this.deps.now().toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
    const jobDir = join(this.deps.jobsDir, id);
    mkdirSync(jobDir, { recursive: true });
    const plan: UpgradePlan = {
      id,
      kind: info.kind,
      jobDir,
      checkout: info.checkout,
      repo: this.deps.repo,
      installRef: f.source.kind === "stable" ? (target.version ?? "stable") : f.source.kind === "master" ? "master" : f.source.branch,
      from,
      to: { sha: target.sha, label: target.label },
      auto: !!req.auto,
      startedAt: new Date(this.deps.now()).toISOString(),
      healthUrl: this.deps.healthUrl(),
      port: this.deps.port(),
      waitMs: 60_000,
      serverPid: this.deps.pid,
      unit: info.unit,
      uid: this.deps.uid,
      env: this.deps.jobEnv(),
      branch: running.branch,
      source: f.source,
    };
    if (info.kind === "installer") {
      // The target's own installer, taken from the target commit (the check fetched it).
      const script = await git(["show", `${target.sha}:scripts/install.sh`]);
      if (script.code !== 0) throw new UpdatesRefusal(`${target.label} has no installer we could read: ${firstLine(script)}.`);
      if (!script.stdout.includes("SOVA_KEEP_PREVIOUS")) throw new UpdatesRefusal(`${target.label}'s installer can't keep the version that runs, so we won't start it.`);
      const path = join(jobDir, "install.sh");
      writeFileSync(path, script.stdout, { mode: 0o755 });
      plan.installer = { script: path, launcher: info.launcher!, binDir: binDirOf(info.launcher!), installPort: info.installPort, noExtensions: info.noExtensions, noAppEntry: info.noAppEntry, serverLog: this.deps.serverLog };
    }
    const job: UpdateJob = { id, kind: info.kind, from, to: plan.to, auto: plan.auto, startedAt: plan.startedAt, step: "starting", state: "running", detail: null, logPath: join(jobDir, "log.txt"), endedAt: null };
    writeFileSync(join(jobDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(jobDir, "state.json"), `${JSON.stringify(job, null, 2)}\n`);
    const why = await this.deps.launch(plan);
    if (why) {
      const failed: UpdateJob = { ...job, state: "failed", step: "done", detail: `The upgrade couldn't start: ${why}. Nothing changed.`, endedAt: new Date(this.deps.now()).toISOString() };
      writeFileSync(join(jobDir, "state.json"), `${JSON.stringify(failed, null, 2)}\n`);
      throw new UpdatesRefusal(failed.detail!);
    }
    this.deps.log(`[updates] ${plan.auto ? "automatic " : ""}upgrade ${id} started: ${from.label} → ${target.label}`);
    return job;
  }

  /** Schedule the next daily check; re-reads the file each time. */
  schedule(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    this.timer = null;
    const due = nextCheckDue(this.read(), this.deps.checksOff, this.deps.now());
    if (due === null) return;
    // Never more than an hour asleep (a suspended machine, a moved clock), never sooner than the start delay at boot.
    const wait = Math.min(Math.max(due - this.deps.now(), 0), 60 * 60 * 1000);
    this.timer = this.deps.timers.set(() => {
      this.timer = null;
      const d = nextCheckDue(this.read(), this.deps.checksOff, this.deps.now());
      if (d !== null && d <= this.deps.now()) void this.check({ auto: true }).catch(() => this.schedule());
      else this.schedule();
    }, wait);
  }

  /** At server start: a check that is overdue waits the start delay; one due later waits for its day. */
  start(): void {
    const due = nextCheckDue(this.read(), this.deps.checksOff, this.deps.now());
    if (due === null) return;
    if (due <= this.deps.now()) {
      this.timer = this.deps.timers.set(() => {
        this.timer = null;
        void this.check({ auto: true }).catch(() => this.schedule());
      }, this.deps.startDelayMs);
      return;
    }
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    this.timer = null;
  }
}

