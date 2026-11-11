import { existsSync } from "node:fs";
import { type Git, isAncestor, revParse } from "./guard";
import type { QueueFile } from "./store";
import { superseded } from "./view";

/** How many sent-back entries git is asked about, newest first: generous past the view's 20 current rows. */
export const SETTLED_CHECKED = 60;

/**
 * Sent-back entries git says need no fix any more (the view's `settled`): `merged` when the sent-back commit or the
 * branch's tip is already in the target, `gone` when the branch is definitely missing or the worktree it was approved
 * from was removed. A git error that doesn't say the branch is missing settles nothing (it stays current). Superseded
 * ones are the view's to see and skip git; only the newest SETTLED_CHECKED others are checked.
 */
export async function settledFacts(git: Git, root: string, head: string, entries: QueueFile["entries"], exists: (p: string) => boolean = existsSync): Promise<Map<string, "merged" | "gone">> {
  const candidates = entries
    .filter((e) => (e.state === "needs-fix" || e.state === "with-chat") && !superseded(entries, e))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
    .slice(0, SETTLED_CHECKED);
  return factsOf(git, root, head, candidates, exists);
}

/** How many sent-back entries one sweep asks git about at most (sweepSettled). */
export const SETTLED_SWEPT = 500;

/**
 * The hourly sweep's check of EVERY sent-back entry (not only the view's newest SETTLED_CHECKED), off the save path:
 * the same facts as settledFacts, for at most `max` entries a pass, by id from the one after `after`, so each is reached
 * within a few passes however many there are. `next`: where the next pass starts (null: the end was reached; the next
 * pass starts from the top).
 */
export async function sweepSettled(git: Git, root: string, head: string, entries: QueueFile["entries"], o: { after?: string | null; max?: number; exists?: (p: string) => boolean } = {}): Promise<{ facts: Map<string, "merged" | "gone">; checked: string[]; next: string | null }> {
  const max = o.max ?? SETTLED_SWEPT;
  const all = entries.filter((e) => e.state === "needs-fix" && !superseded(entries, e)).sort((x, y) => x.id.localeCompare(y.id));
  const from = o.after ? all.findIndex((e) => e.id > o.after!) : 0;
  const start = from < 0 ? 0 : from;
  const batch = all.slice(start, start + max);
  const facts = await factsOf(git, root, head, batch, o.exists ?? existsSync);
  return { facts, checked: batch.map((e) => e.id), next: start + max < all.length ? (batch.at(-1)?.id ?? null) : null };
}

async function factsOf(git: Git, root: string, head: string, candidates: QueueFile["entries"], exists: (p: string) => boolean): Promise<Map<string, "merged" | "gone">> {
  const facts = new Map<string, "merged" | "gone">();
  for (const e of candidates) {
    const ref = await git(["show-ref", "--verify", "--quiet", `refs/heads/${e.branch}`], root);
    // show-ref exits 1 when the ref is missing; anything else (128: no repo, a lock, a timeout) is unknown.
    const missing = ref.code === 1;
    const tip = ref.code === 0 ? await revParse(git, root, `refs/heads/${e.branch}`) : null;
    if (head && ((await isAncestor(git, root, e.commit, head)) || (tip && (await isAncestor(git, root, tip, head))))) facts.set(e.id, "merged");
    else if (missing || (e.worktree && !exists(e.worktree))) facts.set(e.id, "gone");
  }
  return facts;
}
