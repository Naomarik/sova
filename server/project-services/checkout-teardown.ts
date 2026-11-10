import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTRACT_FILE } from "../../shared/project-contract";
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
export async function teardownCopyOf(checkout: string, engine?: ProjectEngine, opts: { keepWorktree?: boolean } = {}): Promise<string | null> {
  const at = canonical(checkout);
  const rec = readRegistry().instances.find((i) => i.checkout === at && i.slot !== 0);
  if (!rec) return null;
  const e = engine ?? (await import("./routes")).projectEngine();
  const r = await e.run("teardown", { instance: rec.id, confirm: true, ...(opts.keepWorktree ? { keepWorktree: true } : {}) }, { kind: "operator", confirm: true });
  if (r.error) throw new CopyTeardownFailed(`${r.error.code}: ${r.error.message}`);
  return rec.id;
}

/**
 * A retired folder brought back (§chat.worktrees/retirement): the project's setup through the same `create` a
 * copy gets, when its definition declares one. Why it failed, or null. No definition or no setup: nothing to run.
 */
export async function setUpCheckout(checkout: string, engine?: ProjectEngine): Promise<string | null> {
  let declared = false;
  try {
    const raw = JSON.parse(readFileSync(join(checkout, CONTRACT_FILE), "utf8")) as { setup?: unknown };
    declared = Array.isArray(raw.setup) && raw.setup.length > 0;
  } catch {
    return null;
  }
  if (!declared) return null;
  const e = engine ?? (await import("./routes")).projectEngine();
  const r = await e.run("create", { checkout }, { kind: "operator", confirm: true });
  return r.error ? `${r.error.code}: ${r.error.message}` : null;
}

/** The copy registered on `checkout`, for retirement: its id, whether it has an active share link, whether it's a conformance run's. */
export function registeredCopyOf(checkout: string, links: (id: string) => number): { id: string; shareLink: boolean; ownRun: boolean } | null {
  const at = canonical(checkout);
  const rec = readRegistry().instances.find((i) => i.checkout === at && i.slot !== 0);
  return rec ? { id: rec.id, shareLink: links(rec.id) > 0, ownRun: rec.createdBy.startsWith("conform:") } : null;
}
