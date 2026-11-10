// A test copy of Sova stops itself when its folder disappears (§chat.worktrees/retirement). Its state root is an
// absolute `<checkout>/.agent`, so a server still running while that checkout is deleted keeps writing there, the
// delete stops part way, and a folder is left that nothing owns. Imported first, so the check comes before any
// state write; and it ends the process with a signal, so no exit handler writes a last file back into the folder.
//
// Applies only to an agent dir named `.agent` in a folder that holds a `.git` at the start. Never the real
// `~/.pi/agent`. Node builtins only, nothing heavy.
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The checkout whose `.git` this process's life rests on, or null. */
export function guardedCheckout(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir || basename(resolve(dir)) !== ".agent") return null;
  return dirname(resolve(dir));
}

const CHECK_MS = 1000;

/**
 * A process whose folder has gone stops at once, before writing anything. Returns the timer, or null when
 * nothing is guarded: not an `.agent` dir, or one in a folder that never was a checkout.
 */
export function startOwnFolderGuard(o: { env?: NodeJS.ProcessEnv; stop?: () => void; everyMs?: number; bootChecked?: boolean } = {}): NodeJS.Timeout | null {
  const checkout = guardedCheckout(o.env);
  if (!checkout) return null;
  const git = join(checkout, ".git");
  // The folder as a whole was deleted before this process started: it must not recreate it. A folder that's there
  // but never had a .git (a scratch agent dir beside something else) isn't a checkout at all.
  const stop = o.stop ?? (() => process.kill(process.pid, "SIGKILL"));
  if (!existsSync(checkout)) {
    stop();
    return null;
  }
  if (!existsSync(git)) return null;
  const timer = setInterval(() => {
    if (!existsSync(git)) stop();
  }, o.everyMs ?? CHECK_MS);
  timer.unref?.();
  return timer;
}
