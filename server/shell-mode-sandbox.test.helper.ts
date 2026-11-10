// Test-only: where a shell-mode test with the sandbox On keeps its hermetic server, and when its sandbox's refusal
// may skip the case instead of failing it (server/shell-mode*.integration.test.ts).
import assert from "node:assert/strict";
import { accessSync, constants, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { HermeticServer } from "./testing/hermetic-server";

const ROOT = resolve(import.meta.dirname, "..");

/** A program on PATH, by its absolute path, as `command -v` finds it; undefined when none. */
export function onPath(name: string, pathVar = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir.startsWith("/")) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The hermetic server's `root` for a sandbox-On case. On Linux a short folder in this checkout's gitignored .cache:
    bwrap gives a confined command a private /tmp, so a home and work folder under the OS temp dir aren't the ones the
    command sees, and the sandbox's probe refuses ("wrote outside the policy"). Elsewhere the OS temp dir. */
export function sandboxRoot(): string | undefined {
  return process.platform === "linux" ? join(ROOT, ".cache", "sm") : undefined;
}

const bwrap = process.platform === "linux" ? onPath("bwrap") : undefined;

/** Why a sandbox refusal may skip the case: only where the sandbox can't run (Linux with no bwrap, or a platform whose
    probe can't be proven here, as inside another sandbox). On Linux with bwrap on PATH, undefined: the case fails. */
export function refusalSkip(refused: string): string | undefined {
  if (process.platform === "linux" && bwrap) return undefined;
  if (process.platform === "linux") return `no bwrap on PATH, so the sandbox can't run: ${refused}`;
  return /sandbox probe failed/.test(refused) ? `the sandbox's probe can't run here: ${refused}` : undefined;
}

/** Stops a server whose chats ran with the sandbox On, then removes its scratch root (stop() keeps one whose home
    changed): the sandbox makes its tool-cache folders in the home (.cache, .npm, .m2), empty; any other change in the
    sentinel home fails the case. */
export async function stopSandboxed(s: HermeticServer): Promise<void> {
  const changes = await s.stop();
  try {
    const other = changes.filter((c) => {
      const m = /^added ([^/]+)$/.exec(c);
      if (!m) return true;
      const dir = join(s.home, m[1]!);
      return !statSync(dir).isDirectory() || readdirSync(dir).length > 0;
    });
    assert.deepEqual(other, [], "the sentinel home changed beyond the sandbox's empty cache folders");
  } finally {
    rmSync(s.scratch, { recursive: true, force: true });
  }
}
