// Voice setup (§app.settings-dialog/voice): a step machine that runs in the server process (or the
// `pnpm run voice:install` CLI), one job at a time behind a lock file. Every step checks its own
// result first and reports "skipped" when it's already there, so a job is idempotent and resumes
// after a cancel, a failure or a restart. Sova never runs sudo: missing packages stop the job with
// the command for the user to run.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VoiceBackend, VoiceInstallJob, VoiceInstalled, VoiceLogLine, VoiceStep, VoiceStepId } from "../../shared/protocol";
import { stateRoot } from "../state-root";
import { download, sha256File } from "./download";
import { detect, missingFor, packageCommand, planFor, voicePath, type BuildPlan, type Detection, type Probe } from "./platform";
import { CATALOG, catalogModel, DEFAULT_MODEL, PREBUILT, PREBUILT_TAG, SELFTEST_WORDS, TRANSCRIBE_CPP, VAD_MODEL, WHISPER_SOURCE_DIR, WHISPER_SOURCE_URL, WHISPER_TAG, HOTWORDS, type CatalogModel } from "./pins";
import { gpuFromLog, WhisperRuntime, type RuntimeConfig } from "./runtime";
import { activeModelId } from "./settings";
import { cleanTranscript } from "./wav";

export const STEP_IDS: VoiceStepId[] = ["detect", "packages", "source", "build", "model", "selftest", "finish"];
export const STEP_LABELS: Record<VoiceStepId, string> = {
  detect: "Detect this host",
  packages: "Check packages",
  source: "Get whisper.cpp",
  build: "Build whisper.cpp",
  model: "Get the model",
  selftest: "Self-test",
  finish: "Finish",
};

export const SELFTEST_WAV = fileURLToPath(new URL("./selftest.wav", import.meta.url));
/** The C source setup compiles against transcribe.cpp's library (Parakeet's engine). */
export const TRANSCRIBE_HOST_C = fileURLToPath(new URL("./transcribe-host.c", import.meta.url));

/** `<state root>/voice`, or SOVA_VOICE_DIR. Read per call: tests move PI_CODING_AGENT_DIR. */
export const voiceDir = (): string => process.env.SOVA_VOICE_DIR || join(stateRoot(), "voice");

export function voicePaths(dir = voiceDir()) {
  return {
    dir,
    src: join(dir, "src"),
    downloads: join(dir, "downloads"),
    bin: join(dir, "bin"),
    models: join(dir, "models"),
    logs: join(dir, "logs"),
    installFile: join(dir, "install.json"),
    lockFile: join(dir, "install.lock"),
    runtimeFile: join(dir, "runtime.json"),
    settingsFile: join(dir, "settings.json"),
    calibration: join(dir, "calibration"),
    vadFile: join(dir, "models", VAD_MODEL.file),
    /** transcribe.cpp's library folder, where its host program is compiled too. */
    transcribeDir: join(dir, "bin", `transcribe-${TRANSCRIBE_CPP.tag}`),
    transcribeHost: join(dir, "bin", `transcribe-${TRANSCRIBE_CPP.tag}`, "sova-transcribe-host"),
    /** The active model's file (settings.json names it; the default when it doesn't). */
    get modelFile() {
      return join(dir, "models", activeModel(this).file);
    },
  };
}
export type VoicePaths = ReturnType<typeof voicePaths>;

/** The catalog entry this host dictates with. */
export function activeModel(paths: { settingsFile: string }): CatalogModel {
  return catalogModel(activeModelId(paths.settingsFile)) ?? DEFAULT_MODEL;
}

export const modelFileOf = (paths: VoicePaths, m: { file: string }) => join(paths.models, m.file);

/** Whether an entry's file is here at its full size (the size is the cheap check; Repair hashes). */
export function modelPresent(paths: VoicePaths, m: { file: string; bytes: number }): boolean {
  try {
    return statSync(modelFileOf(paths, m)).size === m.bytes;
  } catch {
    return false;
  }
}

/** transcribe.cpp ships a Linux x86_64 build only. */
export const transcribeSupported = (platform: string = process.platform, arch: string = process.arch) => platform === "linux" && arch === "x64";

/** install.json: what "ready" means. Paths are relative to the voice folder, so a moved folder still reads. */
export interface InstallRecord extends VoiceInstalled {
  version: 1;
  binary: string;
  sha256: string;
  cpu: boolean;
}

export function readInstall(paths: VoicePaths): InstallRecord | null {
  try {
    const rec = JSON.parse(readFileSync(paths.installFile, "utf8")) as InstallRecord;
    if (rec.version !== 1 || typeof rec.binary !== "string" || typeof rec.model !== "string") return null;
    if (!existsSync(join(paths.dir, rec.binary)) || !existsSync(paths.modelFile)) return null;
    if (activeModel(paths).engine === "transcribe" && !existsSync(paths.transcribeHost)) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Folders already holding a verified copy of a model, checked by size and sha256 before any
    download. SOVA_VOICE_IMPORT_DIRS (path-list) replaces the default, the voice-lab spike's cache. */
export function importDirs(): string[] {
  const env = process.env.SOVA_VOICE_IMPORT_DIRS;
  if (env !== undefined) return env.split(":").filter(Boolean);
  return [join(homedir(), ".cache", "sova-voice-lab", "models")];
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export function sourceBinaryName(backend: VoiceBackend): string {
  return `whisper-server-${WHISPER_TAG}-${backend}`;
}
export const prebuiltDirName = (key: string) => `whisper-${PREBUILT_TAG}-${key}`;

/** Bytes under a folder (no symlink following). */
export function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return 0;
  }
  for (const e of entries) {
    try {
      const st = statSync(join(dir, e), { throwIfNoEntry: false });
      if (st?.isFile()) total += st.size;
    } catch {
      // raced away
    }
  }
  return total;
}

// ---- the job --------------------------------------------------------------------------------

export class NeedsPackages {
  constructor(
    readonly packages: string[],
    readonly command: string | null,
  ) {}
}

export interface StepContext {
  paths: VoicePaths;
  job: VoiceInstallJob;
  signal: AbortSignal;
  probe: Probe;
  mode: "gpu" | "cpu";
  repair: boolean;
  det?: Detection;
  plan?: BuildPlan;
  log(text: string): void;
  progress(done: number, total: number, unit: "bytes" | "percent"): void;
  note(text: string): void;
}
export type StepResult = "done" | "skipped" | NeedsPackages;
export type StepFn = (ctx: StepContext) => Promise<StepResult>;

export interface InstallerOptions {
  paths?: () => VoicePaths;
  probe: () => Probe;
  /** Replace steps (tests). */
  steps?: Partial<Record<VoiceStepId, StepFn>>;
  /** Called when a job ends, any way. */
  onEnd?(job: VoiceInstallJob): void;
  /** Called before a job starts: the service stops the running whisper so a repair can test fresh. */
  onStart?(): Promise<void> | void;
  /** Echo each log line (the CLI's console reporter). */
  echo?(text: string): void;
}

const LOG_MAX = 500;

export class VoiceInstaller {
  job: VoiceInstallJob | null = null;
  missing: { packages: string[]; command: string | null } | null = null;
  private lines: VoiceLogLine[] = [];
  private seq = 0;
  private abort: AbortController | null = null;
  private done: Promise<void> | null = null;
  lastDetection: Detection | null = null;

  constructor(private readonly opts: InstallerOptions) {}

  paths(): VoicePaths {
    return this.opts.paths?.() ?? voicePaths();
  }

  running(): boolean {
    return !!this.job && !this.job.outcome;
  }

  log(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.lines.push({ seq: ++this.seq, at: Date.now(), text: line.slice(0, 400) });
      this.opts.echo?.(line);
      try {
        mkdirSync(this.paths().logs, { recursive: true });
        appendFileSync(join(this.paths().logs, "install.log"), `${new Date().toISOString()} ${line}\n`);
      } catch {
        // the file is a convenience; the ring is the source
      }
    }
    if (this.lines.length > LOG_MAX) this.lines.splice(0, this.lines.length - LOG_MAX);
  }

  logSince(since: number): { seq: number; lines: VoiceLogLine[] } {
    return { seq: this.seq, lines: this.lines.filter((l) => l.seq > since) };
  }

  /** Detection, cached until the next job re-runs it. */
  detection(): Detection {
    if (!this.lastDetection) this.lastDetection = detect(this.opts.probe());
    return this.lastDetection;
  }

  /** Start a job; a second start while one runs is refused. Resolves when the job has begun. */
  start(mode: "gpu" | "cpu" = "gpu", repair = false): { ok: true; job: VoiceInstallJob; finished: Promise<void> } | { ok: false; error: string } {
    if (this.running()) return { ok: false, error: "Setup is already running." };
    const paths = this.paths();
    const lock = acquireLock(paths);
    if (lock) return { ok: false, error: lock };
    const job: VoiceInstallJob = {
      id: randomUUID(),
      mode,
      repair,
      steps: STEP_IDS.map((id) => ({ id, state: "pending" })),
      startedAt: Date.now(),
    };
    this.job = job;
    this.missing = null;
    this.abort = new AbortController();
    this.done = this.run(job, this.abort.signal).finally(() => {
      releaseLock(paths);
      this.opts.onEnd?.(job);
    });
    return { ok: true, job, finished: this.done };
  }

  cancel(): boolean {
    if (!this.running()) return false;
    this.abort?.abort(new Error("Cancelled"));
    return true;
  }

  whenDone(): Promise<void> {
    return this.done ?? Promise.resolve();
  }

  private async run(job: VoiceInstallJob, signal: AbortSignal): Promise<void> {
    const paths = this.paths();
    mkdirSync(paths.dir, { recursive: true });
    this.log(`${job.repair ? "Repair" : "Setup"} started (${job.mode === "cpu" ? "CPU" : "GPU"}), whisper.cpp ${WHISPER_TAG}, ${activeModel(paths).id}`);
    try {
      await this.opts.onStart?.();
    } catch {
      // stopping a runtime that isn't there
    }
    if (job.repair) rmSync(paths.installFile, { force: true });
    const ctx: StepContext = {
      paths,
      job,
      signal,
      probe: this.opts.probe(),
      mode: job.mode,
      repair: job.repair,
      log: (t) => this.log(t),
      progress: () => {},
      note: () => {},
    };
    for (const step of job.steps) {
      if (signal.aborted) break;
      const fn = this.opts.steps?.[step.id] ?? DEFAULT_STEPS[step.id];
      step.state = "running";
      delete step.progress;
      delete step.note;
      delete step.error;
      ctx.progress = (done, total, unit) => {
        step.progress = { done, total, unit };
      };
      ctx.note = (text) => {
        step.note = text;
      };
      this.log(`▸ ${STEP_LABELS[step.id]}`);
      try {
        // A step that doesn't watch the signal still ends the job on a cancel.
        const r = await Promise.race([fn(ctx), aborted(signal)]);
        if (step.id === "detect" && ctx.det) this.lastDetection = ctx.det;
        if (r instanceof NeedsPackages) {
          step.state = "failed";
          step.error = `Missing: ${r.packages.join(", ")}`;
          this.missing = { packages: r.packages, command: r.command };
          job.outcome = "needs-packages";
          this.log(`Missing packages: ${r.packages.join(", ")}${r.command ? `. Run: ${r.command}` : ""}`);
          break;
        }
        step.state = r;
        const shown = step.progress as VoiceStep["progress"];
        if (shown && shown.total > 0) step.progress = { ...shown, done: shown.total };
        const said = step.note && step.note !== "Already done" ? ` — ${step.note}` : "";
        this.log(`  ${r === "skipped" ? "already done" : "done"}${said}`);
      } catch (err) {
        if (signal.aborted) {
          step.state = "pending";
          delete step.progress;
          break;
        }
        step.state = "failed";
        step.error = sentence((err as Error).message || String(err));
        job.outcome = "failed";
        this.log(`  failed: ${step.error}`);
        break;
      }
    }
    if (!job.outcome) {
      job.outcome = signal.aborted ? "cancelled" : "ok";
      if (job.outcome === "cancelled") this.log("Setup cancelled. Everything done so far is kept.");
      else this.log("Voice is ready.");
    }
    job.finishedAt = Date.now();
  }
}

const aborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const sentence = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");

// ---- the lock --------------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** null when the lock is ours now; otherwise why not. A dead holder's lock is taken over. */
export function acquireLock(paths: VoicePaths): string | null {
  mkdirSync(paths.dir, { recursive: true });
  try {
    const held = JSON.parse(readFileSync(paths.lockFile, "utf8")) as { pid?: number };
    if (held.pid && held.pid !== process.pid && alive(held.pid)) return `Another process (pid ${held.pid}) is setting up voice in ${tilde(paths.dir)}.`;
  } catch {
    // no lock, or unreadable: take it
  }
  writeFileSync(paths.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return null;
}

export function releaseLock(paths: VoicePaths): void {
  try {
    const held = JSON.parse(readFileSync(paths.lockFile, "utf8")) as { pid?: number };
    if (held.pid === process.pid) rmSync(paths.lockFile, { force: true });
  } catch {
    // gone
  }
}

/** The pid holding the lock, when it's alive and not us. */
export function lockHolder(paths: VoicePaths): number | null {
  try {
    const held = JSON.parse(readFileSync(paths.lockFile, "utf8")) as { pid?: number };
    return held.pid && held.pid !== process.pid && alive(held.pid) ? held.pid : null;
  } catch {
    return null;
  }
}

// ---- running a command -----------------------------------------------------------------------

/** Spawn argv (never a shell) in its own process group so a cancel stops the whole build; each
    output line goes to `onLine`. Rejects with the last lines on a non-zero exit. */
export function runCommand(argv: string[], o: { cwd?: string; signal: AbortSignal; onLine(line: string): void; env?: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: o.cwd,
        env: o.env ?? { ...process.env, PATH: voicePath() },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        shell: false,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const tail: string[] = [];
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop() ?? "";
      for (const l of parts) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 12) tail.shift();
        o.onLine(l);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    o.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      o.signal.removeEventListener("abort", kill);
      reject(new Error(`${argv[0]} couldn't start: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      o.signal.removeEventListener("abort", kill);
      if (buf.trim()) o.onLine(buf);
      if (code === 0) resolve();
      else if (o.signal.aborted) reject(o.signal.reason ?? new Error("Cancelled"));
      else {
        const why = tail.filter((l) => /error|fatal|not found|could not/i.test(l)).slice(-2).join(" ") || tail.slice(-2).join(" ");
        reject(new Error(`${argv.slice(0, 2).join(" ")} exited with ${code ?? sig}. ${why}`.trim()));
      }
    });
  });
}

/** Whether a whisper-server binary runs at all (`--help` exits 0 on 1.9.x). */
async function probeBinary(binary: string, signal: AbortSignal): Promise<boolean> {
  try {
    await runCommand([binary, "--help"], { signal, onLine: () => {} });
    return true;
  } catch {
    return false;
  }
}

// ---- the steps -------------------------------------------------------------------------------

function binaryFor(paths: VoicePaths, plan: BuildPlan): string {
  return plan.kind === "prebuilt" ? join(paths.bin, prebuiltDirName(plan.key), "whisper-server") : join(paths.bin, sourceBinaryName(plan.backend));
}

const backendLabel = (b: VoiceBackend) => ({ vulkan: "Vulkan", metal: "Metal", cuda: "CUDA", cpu: "CPU" })[b];

async function extract(tarball: string, into: string, expectDir: string, ctx: StepContext): Promise<void> {
  const tmp = join(dirname(into), `.extract-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await runCommand(["tar", "-xzf", tarball, "-C", tmp], { signal: ctx.signal, onLine: (l) => ctx.log(`  ${l}`) });
  const got = join(tmp, expectDir);
  if (!existsSync(got)) throw new Error(`The archive didn't hold ${expectDir}`);
  rmSync(into, { recursive: true, force: true });
  renameSync(got, into);
  rmSync(tmp, { recursive: true, force: true });
}

export const DEFAULT_STEPS: Record<VoiceStepId, StepFn> = {
  async detect(ctx) {
    const det = detect(ctx.probe);
    ctx.det = det;
    if (det.unsupported) throw new Error(det.unsupported);
    const plan = planFor(det, ctx.mode);
    ctx.plan = plan;
    ctx.job.backend = plan.kind === "prebuilt" ? "cpu" : plan.backend;
    const what = plan.kind === "prebuilt" ? "CPU · prebuilt" : `${backendLabel(plan.backend)}${plan.backend !== "cpu" && det.device ? ` · ${det.device}` : ""}`;
    ctx.note(what);
    ctx.log(`  ${det.os} ${det.arch}${det.distro ? ` (${det.distro})` : ""}, package manager ${det.packageManager ?? "unknown"}; building for ${what}`);
    return "done";
  },

  async packages(ctx) {
    const needs = missingFor(ctx.probe, ctx.plan!);
    if (needs.length === 0) {
      ctx.note("Nothing missing");
      return "done";
    }
    const { packages, command } = packageCommand(ctx.probe.platform, ctx.det?.packageManager, needs);
    return new NeedsPackages(packages, command);
  },

  async source(ctx) {
    const plan = ctx.plan!;
    mkdirSync(ctx.paths.downloads, { recursive: true });
    if (plan.kind === "prebuilt") {
      const bin = binaryFor(ctx.paths, plan);
      if (existsSync(bin) && (!ctx.repair || (await probeBinary(bin, ctx.signal)))) {
        ctx.note("Already done");
        return "skipped";
      }
      const pb = PREBUILT[plan.key]!;
      const tarball = join(ctx.paths.downloads, `${prebuiltDirName(plan.key)}.tar.gz`);
      if (!existsSync(tarball)) {
        ctx.log(`  downloading ${pb.url}`);
        await download({ url: pb.url, dest: tarball, bytes: pb.bytes, sha256: pb.sha256, signal: ctx.signal, onProgress: (d, t) => ctx.progress(d, t, "bytes") });
      }
      mkdirSync(ctx.paths.bin, { recursive: true });
      await extract(tarball, join(ctx.paths.bin, prebuiltDirName(plan.key)), pb.dir, ctx);
      ctx.note("Prebuilt CPU binary");
      return "done";
    }
    const srcDir = join(ctx.paths.src, WHISPER_SOURCE_DIR);
    if (existsSync(join(srcDir, "CMakeLists.txt"))) {
      ctx.note("Already done");
      return "skipped";
    }
    const tarball = join(ctx.paths.downloads, `${WHISPER_SOURCE_DIR}.tar.gz`);
    if (!existsSync(tarball)) {
      ctx.log(`  downloading ${WHISPER_SOURCE_URL}`);
      await download({ url: WHISPER_SOURCE_URL, dest: tarball, signal: ctx.signal, onProgress: (d, t) => ctx.progress(d, t, "bytes") });
    }
    mkdirSync(ctx.paths.src, { recursive: true });
    try {
      await extract(tarball, srcDir, WHISPER_SOURCE_DIR, ctx);
    } catch (err) {
      rmSync(tarball, { force: true }); // a bad tarball must not be reused by the retry
      throw err;
    }
    return "done";
  },

  async build(ctx) {
    const plan = ctx.plan!;
    if (plan.kind === "prebuilt") {
      ctx.note("Prebuilt CPU binary");
      return "skipped";
    }
    const bin = binaryFor(ctx.paths, plan);
    if (existsSync(bin) && (!ctx.repair || (await probeBinary(bin, ctx.signal)))) {
      ctx.note("Already done");
      return "skipped";
    }
    const src = join(ctx.paths.src, WHISPER_SOURCE_DIR);
    const build = join(ctx.paths.dir, `build-${plan.backend}`);
    const flags = ["-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON"];
    if (plan.backend === "vulkan") flags.push("-DGGML_VULKAN=ON");
    if (plan.backend === "cuda") flags.push("-DGGML_CUDA=ON");
    if (plan.backend === "cpu" && ctx.probe.platform === "darwin") flags.push("-DGGML_METAL=OFF");
    const nice = ctx.probe.which("nice") ? ["nice", "-n", "10"] : [];
    const onLine = (l: string) => {
      const m = /^\[\s*(\d{1,3})%\]/.exec(l);
      if (m) ctx.progress(Number(m[1]), 100, "percent");
      if (m || /error|warning: unused|Found Vulkan|Found CUDA|Metal/i.test(l)) ctx.log(`  ${l}`);
    };
    ctx.log(`  cmake ${flags.join(" ")}`);
    await runCommand([...nice, "cmake", "-S", src, "-B", build, ...flags], { signal: ctx.signal, onLine: (l) => ctx.log(`  ${l}`) });
    const jobs = String(Math.max(1, ctx.probe.cores()));
    await runCommand([...nice, "cmake", "--build", build, "--config", "Release", "-j", jobs, "--target", "whisper-server"], { signal: ctx.signal, onLine });
    const built = [join(build, "bin", "whisper-server"), join(build, "bin", "Release", "whisper-server")].find((f) => existsSync(f));
    if (!built) throw new Error("The build finished without a whisper-server binary");
    mkdirSync(ctx.paths.bin, { recursive: true });
    const tmp = `${bin}.tmp-${process.pid}`;
    copyFileSync(built, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, bin);
    // The build tree is ~hundreds of MB and nothing reads it once the binary is out.
    rmSync(build, { recursive: true, force: true });
    ctx.note(backendLabel(plan.backend));
    return "done";
  },

  async model(ctx) {
    const active = activeModel(ctx.paths);
    let result: StepResult = "skipped";
    if (ctx.repair) {
      // Every downloaded model, not just the active one: a bad file is deleted, and only the
      // active one is fetched again now.
      for (const m of CATALOG) {
        if (m.id === active.id || !modelPresent(ctx.paths, m)) continue;
        ctx.log(`  re-hashing ${m.file}`);
        if ((await sha256File(modelFileOf(ctx.paths, m), ctx.signal)) !== m.sha256) {
          ctx.log(`  ${m.file}'s sha256 is wrong; deleted it. Download it again in Settings → Voice.`);
          rmSync(modelFileOf(ctx.paths, m), { force: true });
        }
      }
    }
    const got = await ensureFile(active, modelFileOf(ctx.paths, active), ctx);
    if (got.result === "done") result = "done";
    if (got.importedFrom) ctx.note(`Copied from ${tilde(got.importedFrom)}`);
    else if (got.result === "skipped") ctx.note(ctx.repair ? "Checked" : "Already done");
    if (active.engine === "transcribe") {
      if ((await ensureTranscribeEngine(ctx.paths, ctx)) === "done") result = "done";
    }
    return result;
  },

  async selftest(ctx) {
    const plan = ctx.plan!;
    const active = activeModel(ctx.paths);
    const cpu = plan.kind === "prebuilt" || plan.backend === "cpu";
    const cfg = runtimeConfigFor(ctx.paths, active, binaryFor(ctx.paths, plan), cpu);
    const st = await selfTest(cfg, ctx.paths, ctx.signal, (t) => ctx.log(t));
    const backend: VoiceBackend = cpu ? "cpu" : st.gpu ? plan.backend : "cpu";
    if (!cpu && !st.gpu) ctx.log("  the log shows no GPU in use: reporting CPU");
    ctx.job.backend = backend;
    selftestResults.set(ctx.job.id, { ms: st.ms, text: st.text, device: backend !== "cpu" ? st.device : undefined, backend });
    ctx.note(`${(st.ms / 1000).toFixed(1)} s · ${backendLabel(backend)}${backend !== "cpu" && st.device ? ` · ${st.device}` : ""}`);
    return "done";
  },

  async finish(ctx) {
    const plan = ctx.plan!;
    const st = selftestResults.get(ctx.job.id);
    selftestResults.delete(ctx.job.id);
    const binary = binaryFor(ctx.paths, plan);
    const rec: InstallRecord = {
      version: 1,
      backend: st?.backend ?? ctx.job.backend ?? "cpu",
      whisper: plan.kind === "prebuilt" ? PREBUILT_TAG : WHISPER_TAG,
      model: activeModel(ctx.paths).id,
      sha256: activeModel(ctx.paths).sha256,
      binary: binary.slice(ctx.paths.dir.length + 1),
      cpu: plan.kind === "prebuilt" || plan.backend === "cpu",
      selftestMs: st?.ms ?? 0,
      selftestText: st?.text ?? "",
      installedAt: Date.now(),
    };
    if (st?.device) rec.device = st.device;
    const tmp = `${ctx.paths.installFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, ctx.paths.installFile);
    return "done";
  },
};

/** The self-test's result, handed to Finish within one job. */
const selftestResults = new Map<string, { ms: number; text: string; device: string | undefined; backend: VoiceBackend }>();

/** The step list as the UI shows it before any job ran. */
export const pendingSteps = (): VoiceStep[] => STEP_IDS.map((id) => ({ id, state: "pending" }));

// ---- models, engines and the self-test, shared by setup and the model jobs ----------------------

/** What a file fetch reports into: a setup step's context, or a model job's. */
export interface FetchContext {
  signal: AbortSignal;
  repair?: boolean;
  log(text: string): void;
  progress(done: number, total: number, unit: "bytes" | "percent"): void;
  /** Which part is running: an import's hash, the download, or the hash of a file already here. */
  phase?(phase: "import" | "download" | "verify"): void;
}

/**
 * One pinned file into place: kept when it's already here (hashed again on a repair), else copied
 * from an import folder holding a verified copy, else downloaded (resumable, streaming sha256).
 */
export async function ensureFile(
  entry: { file: string; url: string; bytes: number; sha256: string },
  dest: string,
  ctx: FetchContext,
): Promise<{ result: "done" | "skipped"; importedFrom?: string }> {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size === entry.bytes) {
    if (!ctx.repair) return { result: "skipped" };
    ctx.phase?.("verify");
    ctx.log(`  re-hashing ${entry.file}`);
    if ((await sha256File(dest, ctx.signal, (d) => ctx.progress(d, entry.bytes, "bytes"))) === entry.sha256) return { result: "skipped" };
    ctx.log(`  ${entry.file}'s sha256 is wrong; fetching it again`);
    rmSync(dest, { force: true });
  } else if (existsSync(dest)) {
    rmSync(dest, { force: true });
  }
  const names = [...new Set([entry.file, basename(new URL(entry.url).pathname)])];
  for (const dir of importDirs()) {
    for (const name of names) {
      const cand = join(dir, name);
      try {
        if (!existsSync(cand) || statSync(cand).size !== entry.bytes) continue;
      } catch {
        continue;
      }
      ctx.phase?.("import");
      ctx.log(`  checking ${tilde(cand)}`);
      if ((await sha256File(cand, ctx.signal, (d) => ctx.progress(d, entry.bytes, "bytes"))) !== entry.sha256) {
        ctx.log("  its sha256 doesn't match; not using it");
        continue;
      }
      const part = `${dest}.import-${process.pid}`;
      // A reflink where the file system has them, else a plain copy. Never a hardlink: the
      // source folder isn't ours, and a link would tie its file to ours.
      copyFileSync(cand, part, constants.COPYFILE_FICLONE);
      renameSync(part, dest);
      return { result: "done", importedFrom: dir };
    }
  }
  const have = existsSync(`${dest}.part`) ? statSync(`${dest}.part`).size : 0;
  const free = freeBytes(dirname(dest));
  const need = entry.bytes - have + 50e6;
  if (free !== null && free < need) throw new Error(`Not enough disk space: ${entry.file} needs ${mb(need)} and ${tilde(dirname(dest))} has ${mb(free)} free`);
  ctx.phase?.("download");
  ctx.log(`  downloading ${entry.url}${have ? ` (resuming at ${mb(have)})` : ""}`);
  await download({ url: entry.url, dest, bytes: entry.bytes, sha256: entry.sha256, signal: ctx.signal, onProgress: (d, t) => ctx.progress(d, t, "bytes") });
  return { result: "done" };
}

/** Free bytes on the disk holding `dir` (or its nearest existing parent), or null when unknown. */
export function freeBytes(dir: string): number | null {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const fsInfo = statfsSync(at);
    return Number(fsInfo.bavail) * Number(fsInfo.bsize);
  } catch {
    return null;
  }
}

/**
 * transcribe.cpp for Parakeet: its prebuilt release (library only) and the header of the same
 * tag, both pinned, then server/voice/transcribe-host.c compiled beside the library with `cc`.
 */
export async function ensureTranscribeEngine(paths: VoicePaths, ctx: FetchContext): Promise<"done" | "skipped"> {
  if (existsSync(paths.transcribeHost) && (!ctx.repair || (await probeBinary(paths.transcribeHost, ctx.signal)))) return "skipped";
  if (!transcribeSupported()) throw new Error("transcribe.cpp has a Linux x86_64 build only, so Parakeet can't run on this host");
  const cc = ["cc", "gcc", "clang"].find((c) => systemWhich(c));
  if (!cc) throw new Error("Parakeet needs a C compiler to set up transcribe.cpp. Install gcc, then try again");
  const tarball = join(paths.downloads, `transcribe-${TRANSCRIBE_CPP.tag}-${TRANSCRIBE_CPP.platform}.tar.gz`);
  mkdirSync(paths.downloads, { recursive: true });
  if (!existsSync(tarball)) {
    ctx.phase?.("download");
    ctx.log(`  downloading ${TRANSCRIBE_CPP.url}`);
    await download({ url: TRANSCRIBE_CPP.url, dest: tarball, bytes: TRANSCRIBE_CPP.bytes, sha256: TRANSCRIBE_CPP.sha256, signal: ctx.signal, onProgress: (d, t) => ctx.progress(d, t, "bytes") });
  }
  mkdirSync(paths.bin, { recursive: true });
  const log = (l: string) => ctx.log(`  ${l}`);
  try {
    await extractInto(tarball, paths.transcribeDir, TRANSCRIBE_CPP.dir, ctx.signal, log);
  } catch (err) {
    rmSync(tarball, { force: true });
    throw err;
  }
  const header = join(paths.transcribeDir, "transcribe.h");
  ctx.log(`  downloading ${TRANSCRIBE_CPP.headerUrl}`);
  await download({ url: TRANSCRIBE_CPP.headerUrl, dest: header, bytes: TRANSCRIBE_CPP.headerBytes, sha256: TRANSCRIBE_CPP.headerSha256, signal: ctx.signal });
  const tmp = `${paths.transcribeHost}.tmp-${process.pid}`;
  ctx.log(`  compiling sova-transcribe-host with ${cc}`);
  await runCommand(
    [cc, "-O2", "-std=gnu11", "-o", tmp, TRANSCRIBE_HOST_C, `-I${paths.transcribeDir}`, `-L${paths.transcribeDir}`, "-ltranscribe", "-Wl,-rpath,$ORIGIN"],
    { signal: ctx.signal, onLine: log },
  );
  chmodSync(tmp, 0o755);
  renameSync(tmp, paths.transcribeHost);
  return "done";
}

const systemWhich = (cmd: string): boolean => voicePath().split(":").some((d) => d && existsSync(join(d, cmd)));

async function extractInto(tarball: string, into: string, expectDir: string, signal: AbortSignal, log: (l: string) => void): Promise<void> {
  const tmp = join(dirname(into), `.extract-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await runCommand(["tar", "-xzf", tarball, "-C", tmp], { signal, onLine: log });
  const got = join(tmp, expectDir);
  if (!existsSync(got)) throw new Error(`The archive didn't hold ${expectDir}`);
  rmSync(into, { recursive: true, force: true });
  renameSync(got, into);
  rmSync(tmp, { recursive: true, force: true });
}

/** How the runtime runs one catalog model: its engine's program, the model file, and Silero for whisper. */
export function runtimeConfigFor(paths: VoicePaths, m: CatalogModel, whisperBinary: string, cpu: boolean): RuntimeConfig {
  if (m.engine === "transcribe") return { engine: "transcribe", binary: paths.transcribeHost, model: modelFileOf(paths, m), cpu };
  const cfg: RuntimeConfig = { engine: "whisper", binary: whisperBinary, model: modelFileOf(paths, m), cpu };
  if (modelPresent(paths, VAD_MODEL)) cfg.vadModel = paths.vadFile;
  return cfg;
}

export interface SelftestResult {
  ms: number;
  firstMs: number;
  text: string;
  gpu: boolean;
  device?: string;
}

/**
 * The self-test: a throwaway server on this config transcribes the test clip twice (the first
 * run loads), and passes when it heard 2 of the clip's words. Throws with what it heard otherwise.
 */
export async function selfTest(cfg: RuntimeConfig, paths: VoicePaths, signal: AbortSignal, log: (text: string) => void, o: { onWarm?(): void } = {}): Promise<SelftestResult> {
  const rt = new WhisperRuntime(() => cfg, {
    logFile: join(paths.logs, "selftest-server.log"),
    runtimeFile: join(paths.dir, "selftest-runtime.json"),
    backoffMs: [0],
    env: { ...process.env, PATH: voicePath() },
  });
  const onAbort = () => void rt.stop();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const wav = readFileSync(SELFTEST_WAV);
    const prompt = `${HOTWORDS.join(", ")}.`;
    const first = await rt.transcribe(wav, prompt);
    const warm = await rt.transcribe(wav, prompt);
    o.onWarm?.();
    const text = cleanTranscript(warm.text);
    const words = text.toLowerCase();
    const heard = SELFTEST_WORDS.filter((w) => words.includes(w)).length;
    log(`  heard “${text}” in ${warm.ms} ms (first run ${first.ms} ms)`);
    if (heard < 2) throw new Error(`The self-test heard “${text || "nothing"}”, not the test sentence`);
    const gpu = gpuFromLog(rt.logTail());
    const out: SelftestResult = { ms: warm.ms, firstMs: first.ms, text, gpu: gpu.gpu };
    if (gpu.device) out.device = gpu.device;
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await rt.stop();
  }
}
