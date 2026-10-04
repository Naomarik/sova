import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectEngine } from "./engine";
import { readRegistry } from "./store";

/**
 * A worktree's running copy, torn down before the worktree goes (§app.project-overseer/coding-worktrees,
 * §app.overseer/tools): Remove Worktree and archiving with worktree cleanup call this first. The teardown
 * runs as the operator, confirmed (the act that removes the worktree is already gated), and ends the
 * copy's links with it. Merge Branch never calls it.
 */

export class CopyTeardownFailed extends Error {
  constructor(reason: string) {
    super(`Its running copy could not be torn down: ${reason}`);
    this.name = "CopyTeardownFailed";
  }
}

const canonical = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Tear down the instance running `checkout`, if any: its id when one was torn down, null when there was none. Throws CopyTeardownFailed with the reason. */
export async function teardownCopyOf(checkout: string, engine?: ProjectEngine): Promise<string | null> {
  const at = canonical(checkout);
  const rec = readRegistry().instances.find((i) => i.checkout === at && i.slot !== 0);
  if (!rec) return null;
  const e = engine ?? (await import("./routes")).projectEngine();
  const r = await e.run("teardown", { instance: rec.id, confirm: true }, { kind: "operator", confirm: true });
  if (r.error) throw new CopyTeardownFailed(`${r.error.code}: ${r.error.message}`);
  return rec.id;
}
