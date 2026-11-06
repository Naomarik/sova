// The user's own shell commands on pi (§chat.shell-mode/running, quirk P40): pi's `!`, run the way pi's RPC
// mode runs it. The extensions' `user_bash` event goes first (pi's executeBash never emits it; the remote
// extension's hook answers it with the target's operations), then the operations are picked in a fixed
// order whatever the extensions' load order: the hook's (a remote target, where the sandbox isn't enforced),
// else the sandbox's whole-command confinement when the chat's sandbox is On (prepared before anything runs;
// it fails closed), else pi's own local shell. pi records the result itself, deferred while the agent streams
// (P40); `saved` finds the entry once it is written.
import { spawn } from "node:child_process";
import { createEventBus, getShellConfig, type AgentSession, type BashOperations, type EventBus } from "@earendil-works/pi-coding-agent";
import type { HEntry, HarnessShell, ShellResult } from "../../../shared/harness";
import type { ParentScope } from "../../../pi-config/extensions/sandbox/policy.ts";
import { prepareSessionCommand, type PreparedSessionCommand } from "../../../pi-config/extensions/sandbox/session-policy.ts";
import { SANDBOX_STATE_EVENT } from "../../../pi-config/extensions/sandbox/state.ts";
import { agentRoot } from "../../state-root";
import { shellTruncation, toHEntry } from "./reader";

/** What the sandbox extension last said of a runtime (its `sandbox:state` event): On, and what a command
    the session starts itself needs to run under its policy. Never said: Off (no sandbox extension). */
export interface SandboxSeen {
  on: boolean;
  scope?: { worktreeRoots: string[]; parent?: unknown };
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

/** The newest bashExecution entry for this result not claimed yet, as history; undefined while pi holds it
    (P40: a result recorded mid-stream waits in pi's pending list until the run ends or the next prompt). */
function writtenEntry(s: AgentSession, command: string, output: string, since: number, claimed: Set<string>): HEntry | undefined {
  const entries = s.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { id?: string; type?: string; timestamp?: string; message?: { role?: string; command?: unknown; output?: unknown; timestamp?: unknown } };
    if (e.type !== "message" || e.message?.role !== "bashExecution" || !e.id || claimed.has(e.id)) continue;
    if (typeof e.message.timestamp === "number" && e.message.timestamp < since) break;
    if (e.message.command === command && e.message.output === output) {
      claimed.add(e.id);
      return toHEntry(e) ?? undefined;
    }
  }
  return undefined;
}

/** The shell of a pi session; `session()` is the runtime's session at the call. */
export function piShell(session: () => AgentSession, sandbox: () => SandboxSeen): HarnessShell {
  const claimed = new Set<string>();
  return {
    async run(command, o) {
      const s = session();
      const excludeFromContext = o.private === true;
      const since = Date.now();
      let hook: Awaited<ReturnType<AgentSession["extensionRunner"]["emitUserBash"]>>;
      try {
        hook = await s.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd: s.sessionManager.getCwd() });
      } catch (err) {
        return { refused: `An extension's command hook failed, so nothing ran: ${err instanceof Error ? err.message : String(err)}`, why: "failed" };
      }
      const saved = (result: { output: string }): Promise<HEntry | null> => {
        const now = writtenEntry(s, command, result.output, since, claimed);
        if (now) return Promise.resolve(now);
        return new Promise((resolve) => {
          const off = s.subscribe(() => {
            const got = writtenEntry(s, command, result.output, since, claimed);
            if (!got) return;
            off();
            resolve(got);
          });
        });
      };
      const outcome = (r: { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }): ShellResult => ({
        output: r.output,
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
        cancelled: r.cancelled,
        ...(r.truncated ? { truncated: shellTruncation(r.output) } : {}),
        ...(r.fullOutputPath ? { fullOutputPath: r.fullOutputPath } : {}),
        saved: saved(r),
      });
      // A hook that ran the command itself: pi's RPC records its result as given.
      if (hook?.result) {
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
        const ready = await prepareSessionCommand(
          {
            agentDir: agentRoot(),
            cwd: s.sessionManager.getCwd(),
            sessionId: s.sessionManager.getSessionId(),
            ...(scope?.worktreeRoots ? { worktreeRoots: scope.worktreeRoots } : {}),
            ...(scope?.parent ? { parent: scope.parent as ParentScope } : {}),
          },
          [shell.shell, ...shell.args, resolved],
        );
        if (!ready.ok) return { refused: `The sandbox couldn't be prepared, so nothing ran: ${ready.error}`, why: "sandbox" };
        prepared = ready.value;
        operations = confinedOperations(prepared, resolved);
      }
      o.onStart();
      try {
        const r = await s.executeBash(command, o.onOutput, { excludeFromContext, id: o.id, ...(operations ? { operations } : {}) });
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
    stop() {
      session().abortBash();
    },
    isRunning() {
      return session().isBashRunning;
    },
  };
}
