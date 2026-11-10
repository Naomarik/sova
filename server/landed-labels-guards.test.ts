import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Step 1 of landed labels changes what a branch reads as, never what can be deleted (§chat.worktrees/nothing-left: "Clean
// Up Merged and archive's folder removal don't read it"). These hold that line at the source, where a reader could slip in.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A top-level or class-level function, from its first line to the first line that closes it at the same indent. */
function bodyOf(text: string, opening: string): string {
  const at = text.indexOf(opening);
  assert.ok(at >= 0, `no ${opening}`);
  const indent = /^ */.exec(text.slice(text.lastIndexOf("\n", at) + 1))![0];
  const end = text.indexOf(`\n${indent}}\n`, at);
  assert.ok(end > at);
  return text.slice(at, end + indent.length + 2);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const REMOVAL_PATHS = [
  "server/worktree-cleanup.ts",
  "server/worktree-leftovers.ts",
  "server/archive-worktrees.ts",
  "server/project-worktrees.ts",
  "server/project-services/checkout-teardown.ts",
  "server/project-services/engine.ts",
];

test("no removal path reads the shared answer or the draft proof", () => {
  for (const f of REMOVAL_PATHS) {
    assert.ok(existsSync(join(ROOT, f)), f);
    const text = source(f);
    for (const name of ["nothing-left", "branchLeft", "codeLeft", "draftProofVia", "DraftProof"]) assert.ok(!text.includes(name), `${f} names ${name}`);
  }
});

test("mergedByContent keeps its own first-line rule: Clean Up Merged offers what it offered", () => {
  const text = source("server/removed-worktrees.ts");
  const body = bodyOf(text, "export async function mergedByContent(");
  assert.equal(sha(body), "f4058d91e9c210fc", "mergedByContent changed");
  assert.ok(!text.includes("mergeTreeOid"), "the driver-aware read is for the shared answer alone");
});

test("a queue-made worktree's reading stays as it is until step 2", () => {
  const body = bodyOf(source("server/merge-queue/owners.ts"), "  async queueMade(worktree: string)");
  assert.equal(sha(body), "ee5e6e84e18bd4e1", "queueMade changed");
});

test("a run skips its merge on git in the copy or an exact recorded landing, never on a reading of the label", () => {
  const run = source("server/merge-queue/run.ts");
  const contract = source("server/merge-queue/contract.ts");
  assert.ok(!/codeLanded/.test(run) && !/codeLanded/.test(contract), "no codeLanded input");
  assert.ok(run.includes('input.landingPins?.includes(commit) || (await gitProc(copy, ["merge-base", "--is-ancestor", commit, base])).code === 0'), "the skip's two conditions");
  assert.ok(!/from "\.\.\/nothing-left"/.test(run), "the run doesn't import the shared answer");
});
