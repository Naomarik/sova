/**
 * Tests only. What the merge-queue scenario files share (scenarios-*.integration.test.ts): one state root per file,
 * a fixture project per test with the real queue on it (fixtures/harness.ts), cleanup, and small helpers. Import it
 * first: it sets PI_CODING_AGENT_DIR before anything reads the state root.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { MergeEntry } from "../../../shared/merge-queue";
import { type HarnessOptions, type QueueHarness, startHarness } from "./harness";
import { Fixture, git } from "./repo";

process.env.PI_CODING_AGENT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-agent-")));
export const STATE = process.env.PI_CODING_AGENT_DIR;

const made: { fx: Fixture; h?: QueueHarness }[] = [];
after(async () => {
  for (const m of made) {
    await m.h?.stop().catch(() => {});
    for (const g of ["a", "b", "hold", "main"]) m.fx.openGate(g);
    m.fx.dispose();
  }
  rmSync(STATE, { recursive: true, force: true });
});

export async function setup(fo: ConstructorParameters<typeof Fixture>[0] = {}, ho: HarnessOptions | ((fx: Fixture) => HarnessOptions) = {}): Promise<{ fx: Fixture; h: QueueHarness }> {
  const fx = new Fixture(fo);
  const slot: { fx: Fixture; h?: QueueHarness } = { fx };
  made.push(slot);
  slot.h = await startHarness(fx, STATE, typeof ho === "function" ? ho(fx) : ho);
  return { fx, h: slot.h };
}

export const LIST_PLUS = (extra: string) => `alpha\nbravo\ncharlie\n${extra}\n`;
export const APP = (three: string) => `line 1\nline 2\n${three}\nline 4\nline 5\nline 6\nline 7\nline 8\n`;
export const mergeCopyOf = (fx: Fixture) => join(fx.parent, ".worktrees", `${fx.name}-merge`);
export const FINAL = ["landed", "needs-fix", "behaviour-differs", "review-flagged", "drafts-changed", "cancelled"] as const;
/** Settled: a state the entry won't leave by itself, and a landing's push decided (pushed, held, refused). */
export const settled = (e: MergeEntry) => (FINAL as readonly string[]).includes(e.state) && (e.state !== "landed" || (!!e.landed && e.landed.pushed !== "pending"));
/** The newest whole run of `script` (no selectors) since `mark`: the commit the check ran on. */
export function testedHead(fx: Fixture, mark = 0, script: "unit" | "build" | "runner" = "unit"): string {
  const runs = fx.callsSince(mark).filter((c) => c.script === script && c.argv.length === 0);
  assert.ok(runs.length > 0, `${script} ran`);
  return runs.at(-1)!.head;
}
export const mergesOnto = (fx: Fixture, from: string) => Number(git(fx.project, ["rev-list", "--count", "--merges", "--first-parent", `${from}..${fx.target}`]));

/** The thread's resolution, made the way its playbook says (playbooks/merge-queue/references/conflicts.md): a side
 *  worktree detached at the target's head, the pinned commit merged in, `content` for `file`: parents [target, pinned]. */
export function resolution(fx: Fixture, pinned: string, file: string, content: string): string {
  const side = fx.worktreeOf(`resolve-${pinned.slice(0, 7)}-${Date.now()}`);
  git(fx.project, ["worktree", "add", "-q", "--detach", side, fx.head()]);
  git(side, ["merge", "-q", "--no-ff", "--no-commit", pinned], { allowFail: true });
  writeFileSync(join(side, file), content);
  git(side, ["add", file]);
  git(side, ["commit", "-q", "--no-edit", "-m", "merge queue: resolve"]);
  return git(side, ["rev-parse", "HEAD"]);
}

/** The same resolution with the parents the other way round ([pinned, target]): refused as needing the user's look. */
export function reversedResolution(fx: Fixture, pinned: string, file: string, content: string): string {
  const side = fx.worktreeOf(`resolve-rev-${pinned.slice(0, 7)}-${Date.now()}`);
  git(fx.project, ["worktree", "add", "-q", "--detach", side, pinned]);
  git(side, ["merge", "-q", "--no-ff", "--no-commit", fx.head()], { allowFail: true });
  writeFileSync(join(side, file), content);
  git(side, ["add", file]);
  git(side, ["commit", "-q", "--no-edit", "-m", "merge queue: resolve (reversed)"]);
  return git(side, ["rev-parse", "HEAD"]);
}

/** The stand-in reviewer: reads review.conf in the commit under review (ok | notes: t | blocking: t | crash | hang). */
export const reviewer: HarnessOptions["reviewer"] = async ({ commit, copy }) => {
  const c = git(copy, ["show", `${commit}:review.conf`]).trim();
  if (c === "crash") return "crash";
  if (c === "hang") return "hang";
  if (c.startsWith("blocking")) return { verdict: "blocking", text: c.slice(9).trim() };
  if (c.startsWith("notes")) return { verdict: "notes", text: c.slice(6).trim() };
  return { verdict: "ok" };
};
