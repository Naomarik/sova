/**
 * pi's agent directory, resolved exactly as pi's own getAgentDir() does (dist/config.js):
 * PI_CODING_AGENT_DIR when it is set and non-empty, with a leading `~` / `~/` expanded and a
 * `file://` URL converted (pi's normalizePath; any other value is taken as given), else
 * ~/.pi/agent. Sova's server resolves the same directories through getAgentDir(), so a
 * hermetic runtime (PI_CODING_AGENT_DIR=<dir>) must write and read its live records there
 * too, never in the user's real ~/.pi/agent. Node builtins only (bin/pi-sessions loads it).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function agentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const value = env[AGENT_DIR_ENV];
  if (!value) return join(home, ".pi", "agent");
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return join(home, value.slice(2));
  if (/^file:\/\//.test(value)) return fileURLToPath(value);
  return value;
}

/** Where live records go: <agent dir>/sessions/live. */
export const liveDirOf = (env: NodeJS.ProcessEnv = process.env, home?: string): string => join(agentDir(env, home), "sessions", "live");
