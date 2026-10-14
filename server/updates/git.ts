import { execFile } from "node:child_process";

/**
 * The programs the updates code runs, behind one injectable function so its unit tests drive every
 * branch without a network or a second process. The real one runs `file args`
 * with no shell, a timeout and a capped output, and never throws: a missing program or a timeout is
 * a non-zero `code` with the reason in `stderr`.
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

export const realExec: Exec = (file, args, opts = {}) =>
  new Promise((done) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const code = !e ? 0 : typeof e.code === "number" ? e.code : 1;
        const why = e && typeof e.code !== "number" ? `${e.killed ? "timed out" : e.message}\n` : "";
        done({ code, stdout: String(stdout ?? ""), stderr: why + String(stderr ?? "") });
      },
    );
  });

/** git in one checkout. */
export interface Git {
  (args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

export function gitIn(checkout: string, exec: Exec = realExec): Git {
  return (args, opts) => exec("git", args, { cwd: checkout, timeoutMs: opts?.timeoutMs ?? 30_000 });
}

/** The first line of a failed run's output, for a sentence. */
export function firstLine(r: ExecResult): string {
  const line = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/.test(l));
  return (line ?? `exit ${r.code}`).replace(/^fatal:\s*/, "");
}
