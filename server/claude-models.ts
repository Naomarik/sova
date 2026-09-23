import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/**
 * Which models the Claude Code CLI offers this account, and at which efforts — for Settings →
 * Modes → Delegate, which must offer real ids rather than free text.
 *
 * The same initialize-only handshake the claude-code extension's `agent_models` discovery makes
 * (pi-config/extensions/claude-code/models.ts): no user message, no model task, nothing billed.
 * Like `claude-status.ts`, the server does not import that extension (its modules pull the whole
 * subagents graph into Sova's typecheck); the argv is kept byte-identical to the extension's
 * `buildDiscoveryArgv`, and `claude-models.test.ts` fails the moment the two drift.
 *
 * Only `value`, `displayName` and `supportedEffortLevels` are read: the response also carries
 * account metadata, which is never retained. Raw CLI stderr is drained and never reported (it may
 * contain secrets). A failure rejects with a short sentence; it is NOT evidence that any model is
 * absent, and callers must not treat it as such.
 */
export const CLAUDE_DISCOVERY_ARGV: readonly string[] = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  "--permission-mode", "dontAsk", "--permission-prompts", "none",
];

export interface ClaudeModel {
  id: string;
  name: string;
  /** As the CLI reports them; absent when it reports none. */
  efforts?: string[];
}

export interface ClaudeDiscoveryOptions {
  executable?: string;
  timeoutMs?: number;
  /** After the answer (or failure): how long stdin EOF gets before SIGTERM, and SIGTERM before SIGKILL. */
  eofGraceMs?: number;
  termGraceMs?: number;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

const MAX_OUTPUT = 4 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The models array of a successful initialize response; throws on anything else. The same rules,
 * and the same failures, as the extension's own parser (claude-code/models.ts `modelsFrom`): a
 * blank id or display name, or any effort that isn't a non-empty string, fails the whole list
 * rather than being dropped. `claude-code/tests/fixtures/discovery-parity.json` holds the cases
 * both parsers are tested against. Exported for tests.
 */
export function parseClaudeModels(value: unknown): ClaudeModel[] {
  if (!Array.isArray(value)) throw new Error("The Claude Code CLI returned no model list");
  const models: ClaudeModel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.value !== "string" || !item.value.trim() || typeof item.displayName !== "string" || !item.displayName.trim())
      throw new Error("The Claude Code CLI returned an invalid model list");
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    const model: ClaudeModel = { id: item.value, name: item.displayName };
    if (Array.isArray(item.supportedEffortLevels)) {
      if (!item.supportedEffortLevels.every((effort) => typeof effort === "string" && effort.trim() !== ""))
        throw new Error("The Claude Code CLI returned invalid effort levels");
      model.efforts = [...new Set(item.supportedEffortLevels as string[])];
    }
    models.push(model);
  }
  return models;
}

export function discoverClaudeModels(options: ClaudeDiscoveryOptions = {}): Promise<ClaudeModel[]> {
  const env = { ...process.env };
  // The same env hygiene as the extension: these make the CLI think it runs inside Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const group = process.platform !== "win32";
  const eofGraceMs = options.eofGraceMs ?? 500;
  const termGraceMs = options.termGraceMs ?? 1000;
  let child: ChildProcess;
  try {
    child = (options.spawnImpl ?? spawn)(options.executable ?? "claude", [...CLAUDE_DISCOVERY_ARGV], {
      shell: false,
      detached: group,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return Promise.reject(new Error("Could not run the Claude Code CLI"));
  }
  const requestId = randomUUID();
  // Whether the process is gone. Tracked from the start, so cleanup can never signal a pid that
  // has already exited (and might have been reused): every signal checks it, and exit clears the
  // escalation timers whichever order exit and our own cleanup happen in.
  let exited = false;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const clearEscalation = () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    termTimer = killTimer = undefined;
  };
  const markExited = () => {
    exited = true;
    clearEscalation();
  };
  child.once("exit", markExited);
  child.once("close", markExited);
  const kill = (signal: NodeJS.Signals) => {
    if (exited) return;
    try {
      if (group && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  let stopping = false;
  /** EOF, then TERM, then KILL: the CLI exits on stdin EOF; the rest is for one that doesn't. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try {
      child.stdin?.end();
    } catch {
      /* escalate */
    }
    if (exited) return;
    termTimer = setTimeout(() => {
      termTimer = undefined;
      if (exited) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        kill("SIGKILL");
      }, termGraceMs);
      killTimer.unref?.();
    }, eofGraceMs);
    termTimer.unref?.();
  };
  return new Promise<ClaudeModel[]>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    const finish = (error: Error | null, models?: ClaudeModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      stop();
      if (error) reject(error);
      else resolve(models!);
    };
    const deadline = setTimeout(
      () => finish(new Error(`The Claude Code CLI did not list its models within ${Math.round((options.timeoutMs ?? 15000) / 1000)}s`)),
      options.timeoutMs ?? 15000,
    );
    const line = (text: string) => {
      if (!text.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(text);
      } catch {
        return; // not ours: the CLI may print other stream-json records first
      }
      if (!record(event) || event.type !== "control_response" || !record(event.response)) return;
      const response = event.response;
      if (response.request_id !== requestId) return;
      if (response.subtype !== "success") return finish(new Error("The Claude Code CLI refused to list its models; is it logged in?"));
      try {
        finish(null, parseClaudeModels(record(response.response) ? response.response.models : undefined));
      } catch (err) {
        finish(err as Error);
      }
    };
    child.on("error", () => {
      markExited(); // a spawn that failed has no process to signal
      finish(new Error("Could not run the Claude Code CLI; is it installed?"));
    });
    child.on("close", () => finish(new Error("The Claude Code CLI exited before listing its models")));
    child.stderr?.resume();
    child.stdin?.on("error", () => finish(new Error("Could not talk to the Claude Code CLI")));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) return finish(new Error("The Claude Code CLI answered with too much output"));
      buffer += decoder.write(chunk);
      let nl: number;
      while (!settled && (nl = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        line(text);
      }
    });
    try {
      child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
    } catch {
      finish(new Error("Could not talk to the Claude Code CLI"));
    }
  });
}
