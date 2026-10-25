// A project mode's commands and hooks (§chat.mode-menu/project-mode-commands, §chat.mode-menu/project-mode-hooks):
// the runner and its one gate, owned by the chat's own ChatSession in the process that hosts the chat (the
// chat-runtime process), so a command or hook runs with exactly the reach an approved mode tool has there: the
// same runner (pi-config's runProjectTool: no shell, own process group, args on stdin, 256 KB caps, killed whole
// at its limit), the session's cwd, lowered priority. The server process never spawns a project's program.
//
// What runs is always the copy the chat turned on (its mode-project-snapshot entry), never MODE.md read again.
// Every run passes `refusal()` first: on with that copy → not a worker or special chat → sandbox not On →
// approved now (commands: any approval of the copy's hash; hooks: the USER's) → the folder still hashes to it.
//
// Hooks report what already happened: `turnStarted` / `turnSettled` only schedule (setImmediate) and return, so
// no event, reply or turn waits for one. This module has no way to send, queue or steer anything: its host gives
// it read accessors only. A hook's env is built from an allowlist, so it holds no Sova credential; a hook is NOT
// walled off, though: like any unsandboxed program it can still read the operator token file from disk under
// HOME. A command's env is the chat's own, as a tool's is. Bounds: one run per hook at a time with at most one
// waiting, HOOK_BUDGET runs per HOOK_WINDOW_MS per hook, in each chat (checked when a run would start; over it
// the run is dropped, never saved), each hook's own time limit, and COMMANDS_RUNNING_MAX commands running per chat.
import { checkoutRootOf, toolsHashOf } from "../pi-config/extensions/mode/project-discovery.ts";
import { formatToolRun, projectRootOfModeDir, runProjectTool, toolTimeoutMs, type ProjectToolRun } from "../pi-config/extensions/mode/project-tools.ts";
import type { ProjectHookEvent, ProjectModeHook, ProjectModeRef, ProjectModeSnapshot } from "../shared/project-modes";
import type { ModeCommandOutcome, ModeCommandResult } from "../shared/protocol";

export type { ModeCommandOutcome, ModeCommandResult };

/** Runs each hook may start in any HOOK_WINDOW_MS, per hook, in each chat (a mode's 8 hooks may each run 10 times). */
export const HOOK_BUDGET = 10;
export const HOOK_WINDOW_MS = 10 * 60_000;
/** Mode commands one chat runs at once; one more is refused (429). */
export const COMMANDS_RUNNING_MAX = 4;
/** What a hook's program gets of the chat process's env: the basics a program needs, no Sova credential. Not a
    wall: with HOME it can still read the operator token file from disk, as any unsandboxed program can. */
export const HOOK_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SHELL"] as const;
/** The note a mode's row carries while one of its hooks is over its budget. */
export const HOOK_PAUSED_NOTE = `Hooks paused: a hook ran ${HOOK_BUDGET} times in ${HOOK_WINDOW_MS / 60_000} minutes.`;

/** What a ChatSession hands its mode actions: read accessors only (no send, queue or steer). */
export interface ModeActionsHost {
  /** The session's own id (a hook's event names it). */
  sessionId(): string;
  /** The session's cwd now: programs run there. */
  cwd(): string | undefined;
  /** The project modes on now (turn-on order) and the copies the branch keeps, by sha. */
  projectOn(): readonly ProjectModeRef[];
  copies(): ReadonlyMap<string, ProjectModeSnapshot>;
  /** The chat's sandbox is On now. */
  sandboxOn(): boolean;
  /** Why this chat never runs mode actions (a worker, a special or remote chat: notHereFor), or null. */
  notHere(): string | null;
  /** The approval store, read per call (server/project-mode-approvals.ts). */
  approved(root: string, id: string, hash: string): boolean;
  approvedByUser(root: string, id: string, hash: string): boolean;
}

export interface ModeActionsOptions {
  now?: () => number;
  log?: (line: string) => void;
  /** The chat process's env (default process.env). */
  env?: NodeJS.ProcessEnv;
  run?: typeof runProjectTool;
  /** Schedules a hook's start after the event (default setImmediate). */
  defer?: (fn: () => void) => void;
}

/** What a chat is, for whether it may run mode commands and hooks at all. */
export interface ModeChatKind {
  /** A worker chat (§app.chat-processes/workers): it never runs them, whatever its branch says. */
  worker: boolean;
  /** A special chat (the Overseer, a baton, a project overseer…). */
  special: boolean;
  /** Its folder now, and whether that folder is a remote target's. */
  cwd: string | undefined;
  remote(cwd: string): boolean;
}

/** Why `chat` never runs mode commands or hooks, or null: the host's `notHere`. A worker is refused
    here, explicitly, not only because its own branch carries no project modes. */
export function notHereFor(chat: ModeChatKind): string | null {
  if (chat.worker) return "this chat is a worker.";
  if (chat.special) return "this chat can't run project mode programs.";
  if (!chat.cwd || chat.remote(chat.cwd)) return "this chat has no local folder.";
  return null;
}

/** A hook's env: only HOOK_ENV_ALLOW of `parent` (each when present). The runner adds the four mode vars. */
export function hookEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of HOOK_ENV_ALLOW) if (parent[k] !== undefined) out[k] = parent[k];
  return out;
}

const commandId = (mode: string, name: string) => `mode.${mode}.${name}`;

interface HookState {
  /** A run is scheduled or going: a new event waits in `pending`. */
  running: boolean;
  /** The one waiting event (latest wins). */
  pending: { event: ProjectHookEvent; at: number } | null;
  /** Start times inside the window. */
  starts: number[];
  /** The window a skip was last logged in (one line per window). */
  loggedSkip: boolean;
  abort: AbortController | null;
}

export class ModeActions {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: typeof runProjectTool;
  private readonly defer: (fn: () => void) => void;
  private readonly hooks = new Map<string, HookState>();
  private readonly commandAborts = new Set<AbortController>();
  private commandsRunning = 0;
  /** Live turns only: hooks fire once this process saw a turn start itself. */
  private armed = false;
  private disposed = false;

  constructor(
    private readonly host: ModeActionsHost,
    o: ModeActionsOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.warn(`[mode-hook] ${l}`));
    this.env = o.env ?? process.env;
    this.run = o.run ?? runProjectTool;
    this.defer = o.defer ?? ((fn) => void setImmediate(fn));
  }

  /** The copy on now for `modeId`, or null. */
  private onCopy(modeId: string): ProjectModeSnapshot | null {
    const ref = this.host.projectOn().find((r) => r.id === modeId);
    const copy = ref ? this.host.copies().get(ref.sha) : undefined;
    return copy && copy.id === modeId ? copy : null;
  }

  /** Why `what` of this copy must not run now, or null (the one gate, every run). */
  refusal(copy: ProjectModeSnapshot, what: string, kind: "command" | "hook"): string | null {
    const ref = this.host.projectOn().find((r) => r.id === copy.id);
    if (!ref || ref.sha !== copy.sha) return `${what} wasn't run: project mode ${copy.id} is off in this chat.`;
    const notHere = this.host.notHere();
    if (notHere) return `${what} wasn't run: ${notHere}`;
    if (this.host.sandboxOn()) return `${what} wasn't run: project mode programs don't run while the sandbox is on. Turn the sandbox off to use ${copy.id}'s ${kind}s.`;
    const root = checkoutRootOf(projectRootOfModeDir(copy.dir)) ?? projectRootOfModeDir(copy.dir);
    if (kind === "hook" ? !this.host.approvedByUser(root, copy.id, copy.toolsHash) : !this.host.approved(root, copy.id, copy.toolsHash))
      return kind === "hook"
        ? `${what} wasn't run: ${copy.id}'s hooks need your own approval in the mode menu.`
        : `${what} wasn't run: this version of ${copy.id} isn't approved. Approve it in the mode menu.`;
    if (toolsHashOf(copy.dir, copy.tools, { commands: copy.commands, hooks: copy.hooks }) !== copy.toolsHash)
      return `${what} wasn't run: the files of ${copy.id} changed since it was approved. Approve ${copy.id} again in the mode menu.`;
    return null;
  }

  /** The commands of the modes on now, as `mode.<id>.<name>` (for listing). */
  commandsOn(): { id: string; mode: string; name: string; description: string; params: Record<string, unknown> }[] {
    const out = [];
    for (const ref of this.host.projectOn()) {
      const copy = this.host.copies().get(ref.sha);
      for (const c of copy?.commands ?? []) out.push({ id: commandId(ref.id, c.name), mode: ref.id, name: c.name, description: c.description, params: c.params });
    }
    return out;
  }

  /** Run one command of a mode on in this chat, from its copy. Never throws. */
  async runCommand(modeId: string, name: string, args: unknown): Promise<ModeCommandOutcome> {
    const id = commandId(modeId, name);
    if (this.disposed) return { ok: false, status: 409, error: `${id} wasn't run: the chat is closing.` };
    const copy = this.onCopy(modeId);
    if (!copy) return { ok: false, status: 409, error: `${id} wasn't run: project mode ${modeId} is off in this chat.` };
    const command = copy.commands?.find((c) => c.name === name);
    if (!command) return { ok: false, status: 404, error: `${modeId} has no command ${name}.` };
    const refused = this.refusal(copy, id, "command");
    if (refused) return { ok: false, status: 409, error: refused };
    if (this.commandsRunning >= COMMANDS_RUNNING_MAX)
      return { ok: false, status: 429, error: `${id} wasn't run: ${COMMANDS_RUNNING_MAX} mode commands of this chat are already running. Try again when one finishes.` };
    const cwd = this.host.cwd();
    if (!cwd) return { ok: false, status: 409, error: `${id} wasn't run: this chat has no folder.` };
    this.commandsRunning++;
    const abort = new AbortController();
    this.commandAborts.add(abort);
    try {
      const timeoutMs = toolTimeoutMs(command);
      const run = await this.run({ dir: copy.dir, modeId, projectRoot: projectRootOfModeDir(copy.dir), cwd, tool: command, args: args ?? {}, signal: abort.signal, env: this.env });
      if (run.spawnError) return { ok: false, status: 409, error: `${id} wasn't run: ${run.spawnError}.` };
      return { ok: true, result: resultOf(id, run, formatToolRun(run, timeoutMs)) };
    } finally {
      this.commandsRunning--;
      this.commandAborts.delete(abort);
    }
  }

  /** A turn started in this chat (the harness's run.start). */
  turnStarted(): void {
    this.armed = true;
    this.fire("turn.started");
  }

  /** A turn settled (run.settled): fires turn.ended hooks only for a turn this process saw start. */
  turnSettled(): void {
    if (!this.armed) return;
    this.fire("turn.ended");
  }

  /** The note of each mode whose hooks are over their budget now (absent: none). */
  hookNotes(): Map<string, string> {
    const out = new Map<string, string>();
    const t = this.now();
    for (const [key, h] of this.hooks) {
      if (this.inWindow(h, t) >= HOOK_BUDGET && h.loggedSkip) out.set(key.split("\u0000")[0]!, HOOK_PAUSED_NOTE);
    }
    return out;
  }

  /** The chat is closing: kill every running program, drop every waiting hook. */
  dispose(): void {
    this.disposed = true;
    for (const h of this.hooks.values()) {
      h.pending = null;
      h.abort?.abort();
    }
    for (const a of this.commandAborts) a.abort();
  }

  private fire(event: ProjectHookEvent): void {
    if (this.disposed) return;
    const on = this.host.projectOn();
    if (on.length === 0) return;
    const copies = this.host.copies();
    const at = this.now();
    for (const ref of on) {
      const copy = copies.get(ref.sha);
      if (!copy?.hooks) continue;
      copy.hooks.forEach((hook, i) => {
        if (hook.on !== event) return;
        const key = `${copy.id}\u0000${copy.sha}\u0000${i}`;
        const h = this.hooks.get(key) ?? { running: false, pending: null, starts: [], loggedSkip: false, abort: null };
        this.hooks.set(key, h);
        if (h.running) {
          h.pending = { event, at };
          return;
        }
        h.running = true;
        this.defer(() => void this.start(copy, hook, h, { event, at }));
      });
    }
  }

  private inWindow(h: HookState, t: number): number {
    while (h.starts.length && t - h.starts[0]! >= HOOK_WINDOW_MS) h.starts.shift();
    if (h.starts.length < HOOK_BUDGET) h.loggedSkip = false;
    return h.starts.length;
  }

  /** One scheduled run (h.running is already set): the gate and the budget, then the program. */
  private async start(copy: ProjectModeSnapshot, hook: ProjectModeHook, h: HookState, ev: { event: ProjectHookEvent; at: number }): Promise<void> {
    const what = `${copy.id} hook on ${ev.event}`;
    try {
      if (this.disposed) return;
      const refused = this.refusal(copy, what, "hook");
      if (refused) return this.log(refused);
      const t = this.now();
      if (this.inWindow(h, t) >= HOOK_BUDGET) {
        if (!h.loggedSkip) this.log(`${what}: skipped, it ran ${HOOK_BUDGET} times in ${HOOK_WINDOW_MS / 60_000} minutes`);
        h.loggedSkip = true;
        return;
      }
      const cwd = this.host.cwd();
      if (!cwd) return this.log(`${what} wasn't run: this chat has no folder.`);
      h.starts.push(t);
      h.abort = new AbortController();
      const input = { event: ev.event, sessionId: this.host.sessionId(), at: ev.at, mode: copy.id };
      const run = await this.run({ dir: copy.dir, modeId: copy.id, projectRoot: projectRootOfModeDir(copy.dir), cwd, tool: hook, args: input, hookEvent: ev.event, signal: h.abort.signal, env: hookEnv(this.env) });
      if (run.spawnError) this.log(`${what} didn't run: ${run.spawnError}`);
      else if (run.timedOut) this.log(`${what} stopped at its ${hook.timeoutS} s limit`);
      else if (run.aborted) this.log(`${what} stopped: the chat closed`);
      else if (run.exitCode !== 0) this.log(`${what} failed: ${run.exitCode !== null ? `exit code ${run.exitCode}` : `signal ${run.signal}`}`);
    } catch (err) {
      this.log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      h.abort = null;
      const next = h.pending;
      h.pending = null;
      // The waiting run passes the gate and the budget again when it would start; over the budget it is dropped.
      if (next && !this.disposed) this.defer(() => void this.start(copy, hook, h, next));
      else h.running = false;
    }
  }
}

function resultOf(id: string, run: ProjectToolRun, text: string): ModeCommandResult {
  return { id, exitCode: run.exitCode, signal: run.signal, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut, truncated: run.truncated, durationMs: run.durationMs, text };
}
