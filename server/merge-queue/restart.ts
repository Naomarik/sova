/**
 * Sova restarting itself after landings, as merge verbs Sova runs for its merge thread (the thread's sandbox reaches no
 * host port, no systemd and no write in the main checkout):
 *
 * - `merge.live`: the commit the running server started on, the target's head, and the restart plan between them;
 * - `merge.restart`: on the queue's Idle, for the project the server itself runs from: plan, hold new starts, install
 *   (when an install file landed) and build in the main checkout, then restart the project's adopted unit a few seconds
 *   after answering (Apply's delayed restart, self-host.ts). The answer can't wait for the new start (the restart ends
 *   this process), so the expectation is recorded (`<queue dir>/restart.json`) and the next start checks it:
 *   `checkRestartAtStart` compares the commit it started on with the expected one, lifts the hold and adds to the
 *   newest landing's note.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MergeLive, MergeRestart, MergeRestartPlan } from "../../shared/merge-queue";
import { onlyVersionBumped, restartPlan } from "../restart-paths";
import { type Proc, runProc } from "./copy";
import type { Git } from "./guard";
import type { ProjectQueue } from "./queue";

/** What the restart verbs read of a queue (ProjectQueue). */
export interface RestartQueue {
  readonly root: string;
  readonly target: string;
  readonly store: { readonly dir: string };
  targetHead(): Promise<string | null>;
  restartFacts(): { busy: boolean; release: boolean; landed: { id: string; branch: string } | null };
  hold(action: "set" | "clear"): Promise<{ changed: boolean }>;
  note(entryId: string, text: string, by: "thread" | "operator"): Promise<{ notes: { kind: string; text: string }[] }>;
  entryNote(entryId: string): string;
  logLine(line: string): void;
}

export interface RestartDeps {
  git: Git;
  /** The running server: when it started and the commit its checkout had then (self-host.ts serverStart). */
  start: () => { startedAt: string; head: string | null };
  /** The checkout the running server was loaded from (self-host.ts serverCheckout). */
  checkout: () => string | null;
  /** The adopted unit of the project at `root` (its definition's slot-0 `adopt.unit`), or null. */
  unitOf: (root: string) => Promise<string | null>;
  /** Whether this process is `unit`'s main process (systemd's MainPID, launchd's pid). Fails closed: a server started
   *  any other way (a hermetic one from a worktree whose definition adopts the live unit) never restarts that unit. */
  runsAs: (unit: string) => Promise<boolean>;
  /** Restart `unit` a few seconds from now; null: scheduled, else why not (self-host.ts scheduleRestart). */
  schedule: (unit: string) => Promise<string | null>;
  /** Run a command in the main checkout (default runProc, the process env). */
  run?: (argv: string[], cwd: string, timeoutMs: number) => Promise<Proc>;
  now?: () => number;
}

const INSTALL = ["pnpm", "install", "--frozen-lockfile"];
const BUILD = ["pnpm", "run", "build"];
/** How long a scheduled restart that hasn't happened counts as on its way. */
export const PENDING_STALE_MS = 2 * 60_000;
/** The restart file's name in the queue's dir. */
export const RESTART_FILE = "restart.json";

interface Pending {
  v: 1;
  expect: string;
  unit: string;
  at: string;
  /** The server start the restart replaces. */
  from: string;
  entry?: string;
  branch?: string;
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "?");

async function gitOut(git: Git, cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await git(args, cwd);
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** The restart plan from `live` (the running commit) to `tip` in `root` (restart-sova.mjs's plan, without its fetch). */
export async function planRestart(git: Git, root: string, live: string | null, tip: string | null, target: string): Promise<MergeRestartPlan> {
  const base = { action: "unknown" as const, install: false };
  if (!tip) return { ...base, why: `no ${target} in ${root}` };
  if (!live) return { ...base, why: "the running server isn't in a git checkout, so what it runs is unknown" };
  const head = await gitOut(git, root, ["rev-parse", "HEAD"]);
  if (!head.ok || head.out !== tip) return { ...base, why: `the main checkout is at ${short(head.out)}, not ${target}'s ${short(tip)}: Sova moves it with each landing, so wait for the next idle` };
  if (live === tip) return { action: "nothing", install: false, why: "the running server already runs the target's head" };
  if (!(await gitOut(git, root, ["cat-file", "-e", `${live}^{commit}`])).ok) return { action: "restart", install: true, why: `the running server's commit ${short(live)} isn't in this repository: restart, installing first` };
  const diff = await gitOut(git, root, ["diff", "--name-only", "--no-renames", live, tip]);
  if (!diff.ok) return { ...base, why: `git diff failed: ${diff.err}` };
  const files = diff.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const versionOnly: string[] = [];
  if (files.includes("package.json")) {
    const before = await gitOut(git, root, ["show", `${live}:package.json`]);
    const after = await gitOut(git, root, ["show", `${tip}:package.json`]);
    if (before.ok && after.ok && onlyVersionBumped(before.out, after.out)) versionOnly.push("package.json");
  }
  const p = restartPlan(files, { versionOnly });
  const ahead = (await gitOut(git, root, ["merge-base", "--is-ancestor", live, tip])).ok;
  return {
    action: p.action,
    install: p.install,
    counts: { files: files.length, restart: p.restart.length, build: p.build.length },
    restartFiles: p.restart.slice(0, 20),
    buildFiles: p.build.slice(0, 20),
    why:
      (p.action === "restart" ? `${p.restart.length} landed file(s) the server only loads at its start` : p.action === "build" ? `${p.build.length} landed file(s) of the page only` : "nothing landed that the server or the page loads") +
      (ahead ? "" : ` (the running commit isn't an ancestor of ${target}: compared tree to tree)`),
  };
}

/** merge.live: what runs, the target's head, and the plan between them. */
export async function liveOf(q: RestartQueue, deps: RestartDeps): Promise<MergeLive> {
  const s = deps.start();
  const tip = (await q.targetHead()) ?? "";
  const self = deps.checkout() === q.root;
  const plan: MergeRestartPlan = self ? await planRestart(deps.git, q.root, s.head, tip || null, q.target) : { action: "unknown", install: false, why: `Sova doesn't run from ${q.root}: nothing of it restarts` };
  return { head: s.head, startedAt: s.startedAt, target: q.target, tip, self, plan };
}

const pendingFile = (q: Pick<RestartQueue, "store">) => join(q.store.dir, RESTART_FILE);

function readPending(file: string): Pending | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<Pending>;
    return v?.v === 1 && typeof v.expect === "string" && typeof v.from === "string" && typeof v.unit === "string" && typeof v.at === "string" ? (v as Pending) : null;
  } catch {
    return null;
  }
}

function writePending(file: string, p: Pending): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 1)}\n`);
  renameSync(tmp, file);
}

/** The last lines of a step's output, for its answer and its note. */
const tailOf = (out: string, n = 30): string => out.split("\n").filter((l) => l.trim()).slice(-n).join("\n");
/** The first line that reads as an error (else the last line), for a note. */
function firstError(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|ERR_|failed|cannot|not found/i.test(l)) ?? lines.at(-1) ?? "no output").slice(0, 160);
}

/** Add `line` to the entry's note, keeping what it said (a note is at most 300 characters). */
async function addToNote(q: RestartQueue, entry: string, line: string): Promise<void> {
  const had = q.entryNote(entry).trim();
  const text = had && !had.includes(line) ? `${had} ${line}` : had.includes(line) ? had : line;
  await q.note(entry, text.length > 300 ? line.slice(0, 300) : text, "thread").catch((err) => q.logLine(`the restart note on ${entry} wasn't written: ${err instanceof Error ? err.message : err}`));
}

/** merge.restart (see the file's comment). Never throws for what it finds: its outcome says it. */
export async function restartSelf(q: RestartQueue, deps: RestartDeps): Promise<MergeRestart> {
  const run = deps.run ?? ((argv, cwd, timeoutMs) => runProc(argv, { cwd, env: process.env as Record<string, string>, timeoutMs }));
  if (deps.checkout() !== q.root) return { outcome: "nothing", why: `Sova doesn't run from ${q.root}: this project's merge thread restarts nothing` };
  const facts = q.restartFacts();
  if (facts.busy) return { outcome: "nothing", why: "something is queued or checking: another Idle follows" };
  if (facts.release) return { outcome: "nothing", why: "a release is open: nothing is built or restarted until it is published or abandoned" };
  const pending = readPending(pendingFile(q));
  if (pending) {
    // The restart was scheduled but this start is still the one it was to replace: on its way for a minute or two, then
    // stale (the unit never restarted), dropped so the next plan can go on.
    const age = (deps.now ?? Date.now)() - Date.parse(pending.at);
    if (pending.from === deps.start().startedAt && age < PENDING_STALE_MS) return { outcome: "nothing", why: "a restart is already on its way" };
    rmSync(pendingFile(q), { force: true });
    q.logLine(`dropped a restart record from ${pending.at}: ${pending.unit} never restarted`);
  }
  const live = await liveOf(q, deps);
  const plan = live.plan;
  if (plan.action === "nothing" || plan.action === "unknown") return { outcome: "nothing", why: plan.why, plan };
  const landed = facts.landed;
  if (plan.action === "build") {
    const b = await run(BUILD, q.root, 20 * 60_000);
    if (b.code !== 0) return { outcome: "failed", step: "build", why: `the page build failed: ${firstError(b.out)}`, tail: tailOf(b.out), plan };
    return { outcome: "built", why: "built the page; nothing restarts (open tabs offer the newer page)", plan };
  }
  const unit = await deps.unitOf(q.root);
  if (!unit) return { outcome: "nothing", why: "the project's definition adopts no unit in slot 0, so there is nothing to restart", plan };
  if (!(await deps.runsAs(unit).catch(() => false))) return { outcome: "nothing", why: `this server isn't run by ${unit}: nothing restarts`, plan };
  await q.hold("set");
  const fail = async (step: "install" | "build" | "restart", why: string, out = ""): Promise<MergeRestart> => {
    await q.hold("clear").catch(() => {});
    return { outcome: "failed", step, why, ...(out ? { tail: tailOf(out) } : {}), plan, unit };
  };
  if (plan.install) {
    const i = await run(INSTALL, q.root, 15 * 60_000);
    if (i.code !== 0) return fail("install", `install failed: ${firstError(i.out)}`, i.out);
  }
  const b = await run(BUILD, q.root, 20 * 60_000);
  if (b.code !== 0) return fail("build", `build failed: ${firstError(b.out)}`, b.out);
  // A run that started before the hold: too late, the next Idle plans again.
  // Renewed: the install and build may outlast one hold (HOLD_MS), and a run started in the gap would be cut off by the
  // restart a few seconds from now.
  await q.hold("set");
  if (q.restartFacts().busy) return fail("restart", "a run started before the hold took: the next Idle plans again");
  const expect = live.tip;
  const file = pendingFile(q);
  writePending(file, { v: 1, expect, unit, at: new Date((deps.now ?? Date.now)()).toISOString(), from: live.startedAt, ...(landed ? { entry: landed.id, branch: landed.branch } : {}) });
  const err = await deps.schedule(unit);
  if (err) {
    rmSync(file, { force: true });
    return fail("restart", `the restart couldn't be scheduled: ${err}`);
  }
  q.logLine(`restarting ${unit} in a few seconds, expecting ${short(expect)}`);
  return { outcome: "restarting", why: `${unit} restarts in a few seconds; at its start Sova checks it runs ${short(expect)}, lifts the hold and notes the newest landing`, plan, expect, unit };
}

/**
 * At a server start: a restart this queue asked for is checked against the commit the server started on. The hold is
 * lifted and the newest landing's note says how it went; the record goes. A record from the same start (the restart
 * hasn't happened yet) is left. Returns what it found.
 */
export async function checkRestartAtStart(q: RestartQueue, deps: Pick<RestartDeps, "start">): Promise<{ ok: boolean; expect: string; head: string | null } | null> {
  const file = pendingFile(q);
  if (!existsSync(file)) return null;
  const p = readPending(file);
  const s = deps.start();
  if (p && s.startedAt === p.from) return null;
  rmSync(file, { force: true });
  if (!p) return null;
  const ok = !!s.head && s.head.startsWith(p.expect);
  await q.hold("clear").catch(() => {});
  if (p.entry) {
    const line = ok ? `Restarted Sova after landing ${p.branch ?? p.entry}.` : `Restart after landing ${p.branch ?? p.entry} didn't come back on ${short(p.expect)}: it started on ${short(s.head)}. Check ${p.unit}.`;
    await addToNote(q, p.entry, line);
  }
  q.logLine(ok ? `restarted on ${short(p.expect)} as expected` : `the restart expected ${short(p.expect)} but started on ${short(s.head)}`);
  return { ok, expect: p.expect, head: s.head };
}

/** The server's own restart deps: this process, its checkout, the definition's adopted unit and Apply's delayed restart. */
export async function liveRestartDeps(): Promise<RestartDeps> {
  const [{ serverCheckout, serverStart, scheduleRestart }, { definitionAt }, { realGit }] = await Promise.all([import("../project-services/self-host"), import("../project-services/deploy-recipe"), import("./guard")]);
  return {
    git: realGit,
    start: serverStart,
    checkout: serverCheckout,
    unitOf: async (root) => {
      const at = await definitionAt(root, "HEAD").catch(() => null);
      return at?.def?.services.find((s) => s.adopt?.unit)?.adopt?.unit ?? null;
    },
    runsAs: (unit) => runsAsUnit(unit),
    schedule: (unit) => scheduleRestart(unit),
  };
}

/** A queue as the restart verbs read it. */
export const restartQueueOf = (q: ProjectQueue): RestartQueue => ({
  root: q.root,
  get target() {
    return q.target;
  },
  store: q.store,
  targetHead: () => q.targetHead(),
  restartFacts: () => q.restartFacts(),
  hold: (a) => q.hold(a),
  note: (id, text, by) => q.note(id, text, by),
  entryNote: (id) => q.entryNote(id),
  logLine: (l) => q.logLine(l),
});

/** Whether this process is `unit`'s main process: systemd's MainPID on Linux, the launchd job's pid on macOS (its
 *  label is the unit's name without `.service`). Anything unread is no. */
export async function runsAsUnit(unit: string, pid: number = process.pid, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const out = (file: string, args: string[]) => new Promise<string | null>((done) => execFile(file, args, { timeout: 10_000 }, (err, stdout) => done(err ? null : String(stdout))));
  if (platform === "darwin") {
    const label = unit.replace(/\.service$/, "");
    const text = await out("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`]);
    const m = text ? /^\s*pid = (\d+)/m.exec(text) : null;
    return !!m && Number(m[1]) === pid;
  }
  const text = await out("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]);
  const main = Number((text ?? "").trim());
  return Number.isInteger(main) && main > 0 && main === pid;
}
