import { spawn } from "node:child_process";
import { redactPatterns } from "../../overseer-redact";

/**
 * Running a host's tool (`gh`, `glab`): from the server only, an argument array (never a shell), stdin piped (closed
 * at once when there is nothing to send, so no prompt can wait on it), every prompt and update check off, no colour,
 * and a timeout that kills it. The tool is found on PATH, so tests put stand-in `gh` / `glab` programs first there.
 * The sign-in is the tool's own: nothing here reads, passes or prints a token (`--show-token` is never used).
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The program isn't on PATH. */
  missing?: true;
  timedOut?: true;
}

export type CliRunner = (cli: "gh" | "glab", args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<CliResult>;

/** The environment every host call runs with: the server's own, with prompts, pagers, update checks, telemetry and
 *  colour off. */
export function hostCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    GH_PAGER: "cat",
    GLAB_NO_PROMPT: "true",
    GLAB_CHECK_UPDATE: "false",
    GLAB_SEND_TELEMETRY: "false",
    GLAB_SHOW_WHATS_NEW: "false",
    GLAB_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    TERM: "dumb",
  };
}

export const CLI_TIMEOUT_MS = 60_000;
const OUTPUT_MAX = 8 * 1024 * 1024;

/** The real runner. */
export const realCli: CliRunner = (cli, args, opts = {}) =>
  new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (r: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { env: hostCliEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      done({ code: 127, stdout: "", stderr: String((err as Error).message ?? err), ...((err as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true as const } : {}) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? CLI_TIMEOUT_MS);
    child.stdout!.on("data", (b: Buffer) => {
      if (stdout.length < OUTPUT_MAX) stdout += b.toString("utf8");
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (stderr.length < OUTPUT_MAX) stderr += b.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => finish({ code: 127, stdout, stderr: stderr || err.message, ...(err.code === "ENOENT" ? { missing: true as const } : {}) }));
    child.on("close", (code) => finish({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, ...(timedOut ? { timedOut: true as const } : {}) }));
    child.stdin!.on("error", () => {}); // a tool that exits before reading its stdin
    child.stdin!.end(opts.stdin ?? "");
  });

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** A line that would carry a token (`gh auth status` prints `Token: gho_****`; any tool may echo one). */
const TOKEN_LINE = /\btoken\b\s*[:=]/i;

/**
 * A tool's error text as Sova shows and stores it: no ANSI, no line naming a token, every recognisable secret
 * redacted, credentials dropped from any URL, at most three non-empty lines and 300 characters.
 */
export function sanitizeCliError(text: string, fallback = "no reason given"): string {
  const lines = String(text ?? "")
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !TOKEN_LINE.test(l));
  const out = redactPatterns(lines.slice(0, 3).join(" · ")).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");
  if (!out) return fallback;
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}
