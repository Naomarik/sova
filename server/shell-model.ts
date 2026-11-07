// What the model is sent of a finished `!` command (§chat.shell-mode/model): one line naming the whole command,
// its output cut to its last SHELL_MODEL_CHARS characters (about 500 tokens), and one line with the path of a
// file holding the whole output. A `!!` command is sent nothing. The same in every chat, Claude Code's included:
// the cut is made on the chat's own context, before any provider sees it. A command whose output is longer than
// the cut but was never cut by the harness has no full-output file of its own: one is written beside the
// harness's (same name pattern, this account only), named by the command itself, so the same path comes back on
// every turn and archiving deletes it (server/shell-output.ts). Harness-neutral.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** About 500 tokens of output, the newest. */
export const SHELL_MODEL_CHARS = 2_000;

/** What a command's output becomes for the model: as it is when short; else its tail, with what was cut said.
    `harnessCut`: the saved output is already the harness's tail of a longer one, so how much came before is
    not known from it and no count is given (a count from the tail alone would understate it). */
export function modelOutput(output: string, harnessCut = false): { output: string; cut: boolean } {
  if (output.length <= SHELL_MODEL_CHARS && !harnessCut) return { output, cut: false };
  const tail = output.slice(-SHELL_MODEL_CHARS);
  const said = harnessCut ? "earlier output cut" : `${output.length - SHELL_MODEL_CHARS} earlier characters cut`;
  return { output: `[${said}; the whole output is in the file named below]\n${tail}`, cut: true };
}

/** The file Sova writes a command's whole output to when the harness wrote none: one name per command (its time,
    text and output), in the temporary folder, pi's output-file name pattern. */
export function ownOutputPath(sentAt: unknown, command: string, output: string): string {
  const hex = createHash("sha256").update(`${String(sentAt)}\0${command}\0${output}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-bash-${hex}.log`);
}

/** The full-output file for a command whose output the model gets cut: the harness's, else Sova's (written
    once, readable only by this account). Null when it can't be written: then no path is named. */
export function fullOutputFor(c: { sentAt?: unknown; command: string; output: string; fullOutputPath?: string }): string | null {
  if (c.fullOutputPath) return c.fullOutputPath;
  const path = ownOutputPath(c.sentAt, c.command, c.output);
  try {
    if (!existsSync(path)) writeFileSync(path, c.output, { mode: 0o600, flag: "wx" });
    return path;
  } catch {
    return existsSync(path) ? path : null;
  }
}
