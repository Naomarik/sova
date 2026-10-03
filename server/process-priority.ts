import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lowerPriority, parseNice, WORKER_NICE, withPriorityPrefix } from "../pi-config/extensions/subagents/priority.ts";
import { stateRoot } from "./state-root";

/**
 * The niceness this server's agents' processes start at (§app.load-priority/workers): every worker
 * the subagents extension starts in a hosted session, and every tool command of one. The server
 * itself keeps its priority, so a worker's test suite oversubscribing the machine waits behind it.
 */
export const DEFAULT_WORKER_NICE = 10;

/**
 * `SOVA_WORKER_NICE` when it holds a niceness, else `workerNice` from Sova's settings file
 * (`<agent dir>/sova/settings.json`, server/web-settings.ts, which keeps keys it doesn't know),
 * else 10. 0 turns the lowering off. Read per call: a change reaches the next spawn.
 */
export function readWorkerNice(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = parseNice(env.SOVA_WORKER_NICE);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const data = JSON.parse(readFileSync(join(stateRoot(), "settings.json"), "utf8")) as Record<string, unknown> | null;
    return parseNice(data?.workerNice) ?? DEFAULT_WORKER_NICE;
  } catch {
    return DEFAULT_WORKER_NICE;
  }
}

/** The hooks the claude-code and sandbox extensions call, which import nothing outside their own directory. */
export const LOWER_WORKER = Symbol.for("sova:lower-worker");
export const TOOL_COMMAND_PREFIX = Symbol.for("sova:tool-command-prefix");

/**
 * Point the extensions' hooks at the setting. Idempotent. The subagents extension reads the
 * niceness itself (pi-config/extensions/subagents/priority.ts); claude-code lowers its launched
 * workers through LOWER_WORKER, and the sandbox prefixes its bash through TOOL_COMMAND_PREFIX.
 */
export function installWorkerNice(): void {
  const g = globalThis as Record<symbol, unknown>;
  g[WORKER_NICE] = () => readWorkerNice();
  g[LOWER_WORKER] = (pid: number) => lowerPriority(pid);
  g[TOOL_COMMAND_PREFIX] = (prefix: string | undefined) => withPriorityPrefix(prefix);
}

/**
 * Lower a hosted session's tool commands: pi builds its `bash` tool, and runs the user's `!`
 * commands, with the settings' shell prefix, so the renice line goes in front of whatever prefix
 * the user configured. On this session's settings object only, never written to settings.json.
 */
export function lowerToolCommands(settings: { getShellCommandPrefix(): string | undefined }): void {
  const own = settings.getShellCommandPrefix.bind(settings);
  settings.getShellCommandPrefix = () => withPriorityPrefix(own());
}
