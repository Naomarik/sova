import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingPriorityCommand } from "../process-priority";
import { prepareSessionCommand, type SessionPolicyInput } from "../../pi-config/extensions/sandbox/session-policy.ts";
import type { ProxyOptions } from "../../pi-config/extensions/sandbox/proxy.ts";

/** This attempt's own proxy only (sandbox on): refused addresses, its one verified running copy, and the tour's admission. */
export type TourProxyOptions = Pick<ProxyOptions, "forbid" | "local" | "admit">;

/** Trusted server context, never accepted in a tour script or an owner HTTP request. */
export interface TourRecordingContext {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  agentDir: string;
  /** Trusted server environment; tests can supply their isolated home without using the host's. */
  home?: string;
  /** `cwdWritable: false`: the cwd is a stand-in for a folder that is gone, never a writable root. */
  sandbox: { on: boolean; worktreeRoots?: readonly string[]; parent?: SessionPolicyInput["parent"]; cwdWritable?: false };
  worker?: { id: string; teamId?: string };
}

export interface TourChild {
  process: ChildProcess;
  /** Call only after the child and its browser tree have exited. */
  dispose(): Promise<void>;
}

/** Launch the entire controller/browser under the requesting tool's effective policy. */
/**
 * `proxy`: the attempt's own proxy inside the sandbox (sandbox on). `ownProxy`: a sandbox-off
 * attempt's own proxy URL (runner-proxy.ts), the browser's only way out; set as the child's proxy
 * environment, replacing any inherited one.
 */
export async function spawnTourCommand(context: TourRecordingContext, argv: readonly string[], proxy?: TourProxyOptions, ownProxy?: string): Promise<TourChild> {
  if (!context.sessionId || !context.cwd || !context.agentDir || !context.sessionFile || typeof context.sandbox?.on !== "boolean")
    throw new Error("Recording refused: the chat's effective sandbox is unknown.");
  // A worker's state entry alone omits parent tightening. Never reconstruct it from its cwd.
  if (context.worker && context.sandbox.on && !context.sandbox.parent)
    throw new Error("Recording refused: the worker's parent sandbox scope is unavailable.");
  const attribution: Record<string, string> = { PI_SESSION_FILE: context.sessionFile };
  if (context.worker?.teamId) {
    attribution.PI_SUBAGENTS_TEAM_MEMBER = JSON.stringify({ teamId: context.worker.teamId, workerId: context.worker.id });
  }
  let command = recordingPriorityCommand(argv);
  let env: NodeJS.ProcessEnv = { ...process.env, ...attribution };
  let fds: { fd: number; data: string }[] = [];
  let dispose = async () => {};
  if (context.sandbox.on) {
    const prepared = await prepareSessionCommand({
      agentDir: context.agentDir, cwd: context.cwd, sessionId: context.sessionId,
      worktreeRoots: context.sandbox.worktreeRoots, parent: context.sandbox.parent, home: context.home,
      ...(context.sandbox.cwdWritable === false ? { cwdWritable: false } : {}),
    }, command, { env: attribution, ...(proxy ? { proxy } : {}) });
    if (!prepared.ok) throw new Error(`Recording refused: sandbox unavailable (${prepared.error}). Nothing ran.`);
    command = prepared.value.argv;
    env = prepared.value.env;
    fds = prepared.value.fds ?? [];
    dispose = prepared.value.dispose;
  } else {
    // The parent owns even an unconfined attempt's temporary tree, so a killed controller
    // cannot leave its profile behind. The confined backend owns its private tmp instead.
    const root = mkdtempSync(join(tmpdir(), "st-"));
    env.TMPDIR = root;
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete env[k];
    if (ownProxy) { env.HTTPS_PROXY = ownProxy; env.HTTP_PROXY = ownProxy; }
    dispose = async () => { rmSync(root, { recursive: true, force: true }); };
  }
  try {
    const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"];
    for (const f of fds) { while (stdio.length <= f.fd) stdio.push("ignore"); stdio[f.fd] = "pipe"; }
    const child = spawn(command[0]!, command.slice(1), { cwd: context.cwd, env, stdio, detached: process.platform !== "win32" });
    for (const f of fds) {
      const stream = child.stdio[f.fd];
      if (stream && "end" in stream) (stream as NodeJS.WritableStream).end(f.data);
    }
    child.once("error", () => { void dispose(); });
    return { process: child, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** The controller is its own process group; Chrome's pipe transport opens no TCP listener. */
export function killTourChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch { /* already exited */ }
}
