import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostEnv } from "../pi-config/extensions/sandbox/env.ts";
import { parseParentScope, type ParentScope } from "../pi-config/extensions/sandbox/policy.ts";
import { prepareSessionCommand, sessionTmpBase, type SessionPolicyInput } from "../pi-config/extensions/sandbox/session-policy.ts";
import { restoreActive } from "../pi-config/extensions/sandbox/state.ts";
import { maxJobs, nextJobId, readSessionJobs, runningJobs, sessionJobsDir, writeJob, type JobRecord } from "../pi-config/extensions/subagents/job-store.ts";
import type { HEntry, ToolSpec } from "../shared/harness";
import { cgroupProcs, JOBS_SLICE, realProc } from "./background-jobs-capture";
import { envFileText } from "./project-services/drivers";

/**
 * Asking Sova for a job (§app.background-jobs/request): the server-run `background_job` tool. The
 * command runs in a transient service of its own in `sova-jobs.slice`, out of the chat's process, under
 * exactly the confinement the asking chat's own commands have: none for a chat whose sandbox is off, the
 * worker's own write-only policy for a write-only worktree worker. A fully sandboxed chat is refused (its
 * network runs through the chat and would stop with it). A small unconfined wrapper outside the
 * confinement sends the command's output to the job's file and writes its exit code.
 */

export const BACKGROUND_JOB_TOOL = "background_job";
export const SANDBOXED_REFUSAL = "Background jobs aren't available in a sandboxed chat.";
export const NO_JOBS_HERE = "Background jobs need Linux with the systemd user manager, and Sova isn't running its chats under one here, so nothing was started.";
export const requestOverLimit = (n: number) => `This chat already keeps ${n} background jobs, so this one wasn't started. Stop one, or wait for one to end.`;
/** The standing instruction (§app.background-jobs/output), on bash's side and this tool's. */
export const OUTPUT_GUIDELINE = "Send a background command's output to a file (`cmd > out.log 2>&1 &`): a background process whose output goes nowhere dies the first time it writes.";

/** Under what the asking chat's commands run. */
export type JobConfinement = { kind: "none" } | { kind: "write-only"; parent: ParentScope } | { kind: "sandboxed" };

/**
 * A chat's confinement from what the server holds of it: a worker's launch flags (its parent's scope),
 * else the chat's own newest `sandbox` entry on its branch. A malformed scope is sandboxed (fail closed).
 */
export function confinementOf(o: { workerFlags?: Record<string, string | true> | null; branch: readonly HEntry[] }): JobConfinement {
  const flags = o.workerFlags;
  if (flags && flags["sandbox-parent"] !== undefined) {
    const p = parseParentScope(flags["sandbox-parent"]);
    if (!p.ok) return { kind: "sandboxed" };
    return p.value.writeOnly ? { kind: "write-only", parent: p.value } : { kind: "sandboxed" };
  }
  if (flags && flags.sandbox === "on") return { kind: "sandboxed" };
  const raw = o.branch.filter((e) => e.kind === "state").map((e) => ({ type: "custom", customType: (e as { key: string }).key, data: (e as { data: unknown }).data }));
  let on = false;
  try {
    on = restoreActive(raw)?.on === true;
  } catch {
    on = true;
  }
  return on ? { kind: "sandboxed" } : { kind: "none" };
}

type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const realExec: Exec = (file, args) =>
  new Promise((ok) => execFile(file, args, { timeout: 30_000 }, (err, stdout, stderr) => ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

export interface RequestDeps {
  /** The jobs store, and the unit prefix this server's jobs carry; null where jobs aren't kept. */
  dir: string | null;
  unitPrefix: string | null;
  exec: Exec;
  now(): number;
  bootId(): string;
  /** The environment a job starts from (the server's; the sandbox's own for a confined one). */
  env: NodeJS.ProcessEnv;
  agentDir: string;
  /** Where job output files go (default `<os tmp>/sova-jobs-<uid>`). */
  outDir?: string;
  prepare?: typeof prepareSessionCommand;
  nice?: number;
}

export interface JobAsk {
  sessionId: string;
  path: string;
  command: string;
  cwd: string;
  confinement: JobConfinement;
  /** The worker this chat is, when it is one. */
  worker?: string;
}

export type JobAskResult = { ok: true; job: JobRecord; text: string } | { ok: false; error: string };

/** The private tmp a confined argv binds (`--bind <base>/<id>/tmp …`): its `<base>/<id>` directory. */
export function privateTmpOf(argv: readonly string[]): string | undefined {
  const base = `${sessionTmpBase()}/`;
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--bind" && argv[i + 1]!.startsWith(base)) return dirname(argv[i + 1]!);
  return undefined;
}

const unitPart = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(-12);
const BASH = "/bin/bash";
/** Outside the confinement: the command's output to the job's file, then its exit code beside the record. */
const WRAPPER = 'out=$1; ex=$2; shift 2; "$@" >>"$out" 2>&1 </dev/null; r=$?; echo "$r" >"$ex.tmp" && mv "$ex.tmp" "$ex"; exit "$r"';

/** The `systemd-run` argv of a requested job (pure, for tests). */
export function requestArgv(o: { unit: string; cwd: string; envFile: string; description: string; output: string; exitFile: string; argv: string[]; nice?: number; slice?: string }): string[] {
  return [
    "--user",
    `--unit=${o.unit}`,
    `--slice=${o.slice ?? JOBS_SLICE}`,
    "--collect",
    "--quiet",
    `--working-directory=${o.cwd}`,
    "--property=StandardInput=null",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=15",
    "--property=RuntimeMaxSec=86400",
    `--property=EnvironmentFile=${o.envFile}`,
    `--description=${o.description}`,
    ...(o.nice ? [`--property=Nice=${o.nice}`] : []),
    "--",
    "/bin/sh",
    "-c",
    WRAPPER,
    "sova-job",
    o.output,
    o.exitFile,
    ...o.argv,
  ];
}

/** Start one requested job, or say why not. */
export async function requestJob(ask: JobAsk, d: RequestDeps): Promise<JobAskResult> {
  if (ask.confinement.kind === "sandboxed") return { ok: false, error: SANDBOXED_REFUSAL };
  if (!d.dir || !d.unitPrefix) return { ok: false, error: NO_JOBS_HERE };
  const command = ask.command;
  if (!command.trim()) return { ok: false, error: "No command given." };
  const max = maxJobs(d.env);
  const running = runningJobs(readSessionJobs(d.dir, ask.sessionId)).filter((j) => !j.cgroup || cgroupProcs(j.cgroup).length > 0);
  if (running.length >= max) return { ok: false, error: requestOverLimit(max) };

  let argv = [BASH, "-c", command];
  let env: Record<string, string> = hostEnv(d.env);
  let keepTmp: string | undefined;
  if (ask.confinement.kind === "write-only") {
    const input: SessionPolicyInput = { agentDir: d.agentDir, cwd: ask.cwd, sessionId: ask.sessionId, parent: ask.confinement.parent };
    const prepared = await (d.prepare ?? prepareSessionCommand)(input, argv);
    if (!prepared.ok) return { ok: false, error: `The worker's sandbox can't run it: ${prepared.error}` };
    if (prepared.value.fds?.length) {
      await prepared.value.dispose();
      return { ok: false, error: "The worker's sandbox can't run it as a job (it needs a secret handed over at start)." };
    }
    // Its private tmp, bound into the sandbox, lasts as long as the job: the keeper removes it at the end.
    argv = prepared.value.argv;
    env = prepared.value.env;
    keepTmp = privateTmpOf(argv);
  }

  const id = nextJobId(d.dir, ask.sessionId);
  const unit = `${d.unitPrefix}${unitPart(ask.sessionId)}-${id}.service`;
  const own = sessionJobsDir(d.dir, ask.sessionId);
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const outDir = join(d.outDir ?? join(tmpdir(), `sova-jobs-${process.getuid?.() ?? "u"}`), unitPart(ask.sessionId));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const output = join(outDir, `${id}.log`);
  const exitFile = join(own, `${id}.exit`);
  const envFile = join(own, `${id}.env`);
  writeFileSync(envFile, envFileText(env), { mode: 0o600 });
  writeFileSync(output, "", { flag: "a", mode: 0o600 });
  const r = await d.exec("systemd-run", requestArgv({ unit, cwd: ask.cwd, envFile, description: `Sova background job ${id}: ${command.slice(0, 120)}`, output, exitFile, argv, ...(d.nice ? { nice: d.nice } : {}) }));
  if (r.code !== 0) return { ok: false, error: `The service manager didn't start it: ${r.stderr.trim() || `systemd-run exited ${r.code}`}` };
  const show = await d.exec("systemctl", ["--user", "show", "--property=ControlGroup", "--value", unit]);
  const cg = show.code === 0 ? show.stdout.trim() : "";
  const job: JobRecord = {
    v: 1,
    id,
    sessionId: ask.sessionId,
    path: ask.path,
    kind: "requested",
    command,
    cwd: ask.cwd,
    unit,
    driver: "systemd",
    ...(cg ? { cgroup: `/sys/fs/cgroup${cg}` } : {}),
    startedAt: d.now(),
    bootId: d.bootId(),
    output,
    exitFile,
    ...(ask.worker ? { worker: ask.worker } : {}),
    ...(keepTmp ? { scratch: keepTmp } : {}),
  };
  writeJob(d.dir, job);
  const text = [
    `[Sova] Started background job ${id}. It runs outside this chat, so it outlives this chat's shutdown, reload or crash, and its end will wake you with its exit code unless this chat has reached its limit of 30 wakes without the user.`,
    ask.confinement.kind === "write-only" ? "It runs under this chat's own sandbox: it can write only where your commands can." : "",
    `Its output: ${output}`,
  ]
    .filter(Boolean)
    .join(" ");
  return { ok: true, job, text };
}

export const realRequestDeps = (o: { dir: string | null; unitPrefix: string | null; agentDir: string; nice?: number }): RequestDeps => ({
  ...o,
  exec: realExec,
  now: Date.now,
  bootId: () => realProc.bootId(),
  env: process.env,
});

/** Who asks: the chat's session file, and for a worker its launch flags and id (the server's own record of it). */
export interface ToolOwner {
  path: string;
  worker?: { flags: Record<string, string | true>; workerId: string };
}

/** Where jobs are kept on this server now: the store and unit prefix, or none (another driver, a Mac). */
export type JobsHere = () => Promise<{ dir: string; unitPrefix: string } | null>;

/** The `background_job` tool, served to a chat or a worker (§app.background-jobs/request). */
export function backgroundJobTool(owner: ToolOwner, here: JobsHere, deps: (o: { dir: string | null; unitPrefix: string | null }) => RequestDeps): ToolSpec<{ command?: unknown; cwd?: unknown }> {
  return {
    name: BACKGROUND_JOB_TOOL,
    label: "Background job",
    description:
      "Start a shell command as a background job Sova keeps: it runs outside this chat, outlives the chat's shutdown, reload or crash, and its end wakes the chat with its exit code. Use it for a server, a test lab or a long build that must keep running after this call returns; its output goes to the file the result names. A worktree worker's job runs under the worker's own sandbox.",
    promptSnippet: "Start a command as a background job that outlives this chat; its end wakes you",
    promptGuidelines: [OUTPUT_GUIDELINE, "Use background_job for a command that must keep running after its call returns when a command's own `&` won't last (a worktree worker's do not)."],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command (bash) to run as the job" },
        cwd: { type: "string", description: "The folder to run it in (default: this chat's working directory)" },
      },
      required: ["command"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const command = typeof params?.command === "string" ? params.command : "";
      const cwd = typeof params?.cwd === "string" && params.cwd.trim() ? params.cwd : (ctx?.cwd ?? "");
      const confinement = confinementOf({ workerFlags: owner.worker?.flags ?? null, branch: ctx?.branch() ?? [] });
      const where = confinement.kind === "sandboxed" ? null : await here();
      const r = await requestJob(
        { sessionId: ctx?.sessionId ?? "", path: owner.path, command, cwd, confinement, ...(owner.worker ? { worker: owner.worker.workerId } : {}) },
        deps({ dir: where?.dir ?? null, unitPrefix: where?.unitPrefix ?? null }),
      );
      if (!r.ok) throw new Error(r.error);
      return { content: [{ type: "text", text: r.text }], details: { id: r.job.id, output: r.job.output, unit: r.job.unit } };
    },
  };
}
