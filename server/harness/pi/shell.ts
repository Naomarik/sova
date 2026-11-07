// The user's own shell commands on pi (§chat.shell-mode/running, quirk P40): pi's `!`, run the way pi's RPC
// mode runs it, any number at once, each stopped on its own. The extensions' `user_bash` event goes first (pi's executeBash never emits it; the remote
// extension's hook answers it with the target's operations), then the operations are picked in a fixed
// order whatever the extensions' load order: the hook's (a remote target, where the sandbox isn't enforced),
// else the sandbox's whole-command confinement when the chat's sandbox is On (prepared before anything runs;
// it fails closed), else pi's own local shell. pi records the result itself, deferred while the agent streams
// (P40); `saved` finds the entry once it is written.
import { spawn } from "node:child_process";
import { createEventBus, createLocalBashOperations, getShellConfig, type AgentSession, type BashOperations, type EventBus } from "@earendil-works/pi-coding-agent";
import type { HEntry, HarnessShell, ShellResult } from "../../../shared/harness";
import type { ParentScope } from "../../../pi-config/extensions/sandbox/policy.ts";
import { prepareSessionCommand, type PreparedSessionCommand } from "../../../pi-config/extensions/sandbox/session-policy.ts";
import { SANDBOX_STATE_EVENT } from "../../../pi-config/extensions/sandbox/state.ts";
import { agentRoot } from "../../state-root";
import { fullOutputFor, modelOutput } from "../../shell-model";
import type { PiExtensionAPI } from "./extension-types";
import { shellTruncation, toHEntry } from "./reader";

/** What the sandbox extension last said of a runtime (its `sandbox:state` event): On, and what a command
    the session starts itself needs to run under its policy. Never said: Off (no sandbox extension). */
export interface SandboxSeen {
  on: boolean;
  scope?: { worktreeRoots: string[]; parent?: unknown; cwdWritable?: false; invalid?: string };
}

const sandboxes = new WeakMap<object, SandboxSeen>();

/** A runtime's extension bus, with Sova listening for the sandbox's state on it. `key` (the runtime's
    services, once built) names the runtime for `sandboxOf`. */
export function sandboxBus(): { bus: EventBus; attach(key: object): void } {
  const bus = createEventBus();
  const seen: SandboxSeen = { on: false };
  bus.on(SANDBOX_STATE_EVENT, (data: unknown) => {
    const next = data as { version?: unknown; on?: unknown; scope?: SandboxSeen["scope"] } | undefined;
    if (next?.version !== 1) return;
    seen.on = next.on === true;
    if (next.scope) seen.scope = next.scope;
    else delete seen.scope;
  });
  return { bus, attach: (key) => void sandboxes.set(key, seen) };
}

/** The sandbox state a runtime's extension said last; Off when it said nothing. */
export function sandboxOf(key: object): SandboxSeen {
  return sandboxes.get(key) ?? { on: false };
}

/** What the session runs a user command with, picked in the fixed order (t20). Exported for its test. */
export type ShellPick = { kind: "hook"; operations: BashOperations } | { kind: "sandbox" } | { kind: "local" };
export function pickOperations(hook: { operations?: BashOperations } | undefined, sandbox: SandboxSeen): ShellPick {
  if (hook?.operations) return { kind: "hook", operations: hook.operations };
  if (sandbox.on) return { kind: "sandbox" };
  return { kind: "local" };
}

/** A confined whole command, spawned as pi's local shell spawns its own: streamed, the process group killed
    on abort. It runs exactly `expected` (the prefixed command it was prepared for), or nothing. */
function confinedOperations(prepared: PreparedSessionCommand, expected: string): BashOperations {
  return {
    exec: (command, cwd, o) =>
      new Promise((resolveRun, reject) => {
        if (command !== expected) return reject(new Error("the sandbox was prepared for another command; nothing ran"));
        if (o.signal?.aborted) return reject(new Error("aborted"));
        const fds = prepared.fds ?? [];
        const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
        for (let i = 3; i <= Math.max(2, ...fds.map((f) => f.fd)); i++) stdio.push(fds.some((f) => f.fd === i) ? "pipe" : "ignore");
        const child = spawn(prepared.argv[0]!, prepared.argv.slice(1), { cwd, env: prepared.env, detached: true, stdio });
        for (const f of fds) {
          const s = child.stdio[f.fd] as NodeJS.WritableStream | null;
          s?.on("error", () => {});
          s?.end(f.data);
        }
        const kill = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        o.signal?.addEventListener("abort", kill, { once: true });
        child.stdout!.on("data", o.onData);
        child.stderr!.on("data", o.onData);
        child.on("error", (err) => {
          o.signal?.removeEventListener("abort", kill);
          reject(new Error(`the sandbox runner failed, the command did not run: ${err.message}`));
        });
        child.on("close", (code, sig) => {
          o.signal?.removeEventListener("abort", kill);
          if (o.signal?.aborted) return reject(new Error("aborted"));
          resolveRun({ exitCode: code ?? (sig ? 128 + 9 : 1) });
        });
      }),
  };
}

/** The entry pi wrote for this result: the OLDEST bashExecution entry recorded since the run began with its
    command, output and privacy that no earlier run claimed (two identical commands that end in one reply are
    flushed in their order, so each run takes its own); undefined while pi holds it (P40: a result recorded
    mid-stream waits in pi's pending list until the run ends or the next prompt). */
function writtenEntry(s: AgentSession, command: string, output: string, priv: boolean, since: number, claimed: Set<string>): HEntry | undefined {
  const entries = s.sessionManager.getEntries();
  let found: { id: string; e: unknown } | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { id?: string; type?: string; message?: { role?: string; command?: unknown; output?: unknown; timestamp?: unknown; excludeFromContext?: unknown } };
    if (e.type !== "message" || e.message?.role !== "bashExecution" || !e.id) continue;
    if (typeof e.message.timestamp === "number" && e.message.timestamp < since) break;
    if (claimed.has(e.id) || e.message.command !== command || e.message.output !== output || (e.message.excludeFromContext === true) !== priv) continue;
    found = { id: e.id, e }; // keep going back: an older match wins
  }
  if (!found) return undefined;
  claimed.add(found.id);
  return toHEntry(found.e) ?? undefined;
}

/** The shell of a pi session; `session()` is the runtime's session at the call. */
export function piShell(session: () => AgentSession, sandbox: () => SandboxSeen): HarnessShell {
  const claimed = new Set<string>();
  return {
    async run(command, o) {
      const s = session();
      const stopped = { refused: "The command was stopped before it started; nothing ran.", why: "stopped" as const };
      if (o.signal?.aborted) return stopped;
      const excludeFromContext = o.private === true;
      const since = Date.now();
      let hook: Awaited<ReturnType<AgentSession["extensionRunner"]["emitUserBash"]>>;
      try {
        hook = await s.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd: s.sessionManager.getCwd() });
      } catch (err) {
        return { refused: `An extension's command hook failed, so nothing ran: ${err instanceof Error ? err.message : String(err)}`, why: "failed" };
      }
      const saved = (result: { output: string }): Promise<HEntry | null> => {
        const now = writtenEntry(s, command, result.output, excludeFromContext, since, claimed);
        if (now) return Promise.resolve(now);
        return new Promise((resolve) => {
          let done = false;
          const off = s.subscribe(() => {
            if (done) return;
            const got = writtenEntry(s, command, result.output, excludeFromContext, since, claimed);
            if (!got) return;
            done = true;
            // Leave after pi's emit: unsubscribing inside it would skip the next listener, another run's.
            queueMicrotask(off);
            resolve(got);
          });
        });
      };
      let limited = false;
      const outcome = (r: { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }): ShellResult => ({
        output: r.output,
        ...(limited ? { limited: true as const } : {}),
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
        cancelled: r.cancelled,
        ...(r.truncated ? { truncated: shellTruncation(r.output) } : {}),
        ...(r.fullOutputPath ? { fullOutputPath: r.fullOutputPath } : {}),
        saved: saved(r),
      });
      // A hook that ran the command itself: pi's RPC records its result as given.
      if (hook?.result) {
        if (o.signal?.aborted) return stopped;
        o.onStart();
        if (hook.result.output) o.onOutput(hook.result.output);
        s.recordBashResult(command, hook.result, { excludeFromContext });
        return outcome(hook.result);
      }
      const pick = pickOperations(hook, sandbox());
      let operations: BashOperations | undefined = pick.kind === "hook" ? pick.operations : undefined;
      let prepared: PreparedSessionCommand | undefined;
      if (pick.kind === "sandbox") {
        // What executeBash will hand its operations: the settings' prefix, then the command (P40).
        const prefix = s.settingsManager.getShellCommandPrefix();
        const resolved = prefix ? `${prefix}\n${command}` : command;
        const shell = getShellConfig(s.settingsManager.getShellPath());
        if (shell.commandTransport === "stdin") return { refused: "The sandbox can't run this chat's shell (it takes its command on stdin), so nothing ran.", why: "sandbox" };
        const scope = sandbox().scope;
        // A malformed worker scope refuses the session's own tools; it never widens a command's.
        if (scope?.invalid) return { refused: `The sandbox couldn't be prepared, so nothing ran: ${scope.invalid}`, why: "sandbox" };
        const ready = await prepareSessionCommand(
          {
            agentDir: agentRoot(),
            cwd: s.sessionManager.getCwd(),
            sessionId: s.sessionManager.getSessionId(),
            ...(scope?.worktreeRoots ? { worktreeRoots: scope.worktreeRoots } : {}),
            ...(scope?.parent ? { parent: scope.parent as ParentScope } : {}),
            // A reopened chat whose folder is gone runs in a stand-in, never a writable root (as the agent's tools).
            ...(scope?.cwdWritable === false ? { cwdWritable: false } : {}),
          },
          [shell.shell, ...shell.args, resolved],
        );
        if (!ready.ok) return { refused: `The sandbox couldn't be prepared, so nothing ran: ${ready.error}`, why: "sandbox" };
        prepared = ready.value;
        operations = confinedOperations(prepared, resolved);
      }
      // Stopped while the hook or the sandbox prepared it (a close, a Stop): it never starts.
      if (o.signal?.aborted) {
        await prepared?.dispose().catch(() => {});
        return stopped;
      }
      // pi's own local shell when nothing else runs it, as executeBash would pick it.
      const base = operations ?? createLocalBashOperations({ shellPath: s.settingsManager.getShellPath() });
      o.onStart();
      try {
        const r = await s.executeBash(command, o.onOutput, { excludeFromContext, id: o.id, operations: ownStop(s, base, o, () => (limited = true)) });
        return outcome(r);
      } catch (err) {
        // The shell couldn't run it (a spawn or runner failure; pi recorded nothing): saved as its card says it.
        const failed = { output: `The command couldn't run: ${err instanceof Error ? err.message : String(err)}`, exitCode: undefined, cancelled: false, truncated: false };
        s.recordBashResult(command, failed, { excludeFromContext });
        return outcome(failed);
      } finally {
        await prepared?.dispose().catch(() => {});
      }
    },
  };
}

/** `base`, run so that this run alone stops: on its own `signal`, or when its output passes `maxBytes`
    (`limit()` is told first). executeBash keeps one abort controller per run (P40) and records a run that
    its own controller stopped as cancelled; this aborts that run's controller, found by the signal pi hands
    the operations. A pi without it: abortBash, which stops every run. */
function ownStop(s: AgentSession, base: BashOperations, o: { signal?: AbortSignal; maxBytes?: number }, limit: () => void): BashOperations {
  return {
    exec: (command, cwd, x) => {
      const controllers = (s as unknown as { _bashAbortControllers?: Set<AbortController> })._bashAbortControllers;
      const mine = controllers && [...controllers].find((c) => c.signal === x.signal);
      const abort = () => (mine ? mine.abort() : s.abortBash());
      const onAbort = () => abort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) abort();
      let bytes = 0;
      const onData = (data: Buffer) => {
        bytes += data.length;
        if (o.maxBytes !== undefined && bytes > o.maxBytes && !x.signal?.aborted) {
          limit();
          abort();
          return;
        }
        x.onData(data);
      };
      return base.exec(command, cwd, { ...x, onData }).finally(() => o.signal?.removeEventListener("abort", onAbort));
    },
  };
}

/** What the model is sent of a finished `!` command (§chat.shell-mode/model): the chat's context, before any
    provider (Claude Code's included) converts it, carries each one's output cut to its tail with the path of
    its whole output (server/shell-model.ts), in pi's own "Ran `command`" form; a `!!` command stays out, as
    pi leaves it (excludeFromContext). */
export function shellModelExtension() {
  return {
    name: "sova-shell-model",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      pi.on("context", async (event) => {
        let changed = false;
        const messages = (event.messages as { role?: string }[]).map((m) => {
          if (m.role !== "bashExecution") return m;
          const b = m as { command: string; output: string; timestamp?: number; excludeFromContext?: boolean; truncated?: boolean; fullOutputPath?: string };
          if (b.excludeFromContext) return m;
          const cut = modelOutput(b.output ?? "", b.truncated === true);
          if (!cut.cut) return m;
          const full = fullOutputFor({ sentAt: b.timestamp, command: b.command, output: b.output, ...(b.fullOutputPath ? { fullOutputPath: b.fullOutputPath } : {}) });
          changed = true;
          return { ...b, output: cut.output, truncated: full !== null, ...(full ? { fullOutputPath: full } : {}) };
        });
        return changed ? { messages: messages as never } : undefined;
      });
    },
  };
}
