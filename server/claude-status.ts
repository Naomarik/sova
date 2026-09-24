import { spawn } from "node:child_process";
import type { ClaudeCliStatus } from "../shared/protocol";

/**
 * Is the Claude Code CLI on this machine, and which version?
 *
 * Deliberately the smallest possible question. The claude-code extension owns the real protocol
 * work (pi-config/extensions/claude-code), and the server does not import it: those modules are
 * under active development and a server-side import would make Sova's typecheck depend on them.
 * `claude --version` needs none of that, and the model count the status line pairs it with comes
 * from the shared runtime (server/models.ts), which is what the picker will actually show.
 */
const TIMEOUT_MS = 5000;
/** A version string is one short line; anything longer is not one, so stop reading. */
const MAX_OUTPUT = 4096;

export function claudeCliStatus(executable = "claude"): Promise<ClaudeCliStatus> {
  return new Promise((resolve) => {
    // The same env hygiene the extension uses (pi-config/extensions/claude-code/models.ts): these
    // two make the CLI think it is running inside Claude Code, which changes how it behaves.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let child;
    try {
      child = spawn(executable, ["--version"], { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ error: "Could not run the Claude Code CLI" });
    }

    let out = "";
    let settled = false;
    const finish = (status: ClaudeCliStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(status);
    };
    const timer = setTimeout(() => finish({ error: `The Claude Code CLI did not answer within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS);

    child.stdout?.on("data", (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString();
    });
    child.on("error", () => finish({ error: `Could not run \`${executable} --version\`; is the Claude Code CLI installed?` }));
    child.on("close", (code) => {
      // "2.1.278 (Claude Code)" — keep the whole line, it is what the CLI calls itself.
      const version = out.trim().split("\n")[0]?.trim();
      if (code === 0 && version) return finish({ version });
      finish({ error: `\`${executable} --version\` exited ${code ?? "unknown"}` });
    });
  });
}
