// A trial (merge.try) through the real merge run, on throwaway repositories: a check that runs only when its paths
// changed (the way scripts/merge-checks/lib.mjs gates) must run in full in a trial, so a setup branch that changes only
// .sova/project.json can't pass a trial on checks that skipped themselves.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, RunStep } from "../../shared/merge-queue";
import { parseDefinition } from "../../shared/project-contract";
import type { RunInput, RunOutcome } from "./contract";
import { Fixture, git, REPO_ROOT } from "./testing/repo";
import { makeRunMerge } from "./run";

const fixtures: Fixture[] = [];
after(() => {
  for (const f of fixtures) f.dispose();
});

/** lib.mjs's gate: run when picked, or when a watched path is in SOVA_MERGE_CHANGED; else report skipped and exit 0. */
const GATED = `import { readFileSync, writeFileSync } from "node:fs";
const changed = process.env.SOVA_MERGE_CHANGED ? readFileSync(process.env.SOVA_MERGE_CHANGED, "utf8").split("\\n").map((s) => s.trim()).filter(Boolean) : [];
const picked = process.env.SOVA_MERGE_PICKED === "1";
if (!picked && !changed.some((p) => p.startsWith("src/"))) {
  if (process.env.SOVA_OUT) writeFileSync(process.env.SOVA_OUT, JSON.stringify({ passed: 0, failed: 0, skipped: "no src/ change" }));
  process.exit(0);
}
console.log("gated check ran: it fails");
process.exit(1);
`;

/** Records what the run handed the checks. */
const PROBE = (out: string) => `import { readFileSync, writeFileSync } from "node:fs";
const f = process.env.SOVA_MERGE_CHANGED;
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ picked: process.env.SOVA_MERGE_PICKED ?? null, changed: f ? readFileSync(f, "utf8").split("\\n").map((s) => s.trim()).filter(Boolean) : null }));
`;

async function trial(fx: Fixture, commit: string, branch: string) {
  const runId = `mr_trial${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(fx.root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const def = parseDefinition(fx.fileAt(commit, ".sova/project.json")!);
  const entry = { id: "trial", project: "p1", target: fx.target, branch, commit, approval: { by: "land-button", at: new Date().toISOString(), commit }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: "", updatedAt: "" } as MergeEntry;
  const steps = new Map<string, RunStep>();
  const input: RunInput = {
    runId,
    entry,
    project: { id: "p1", root: fx.project, target: fx.target, def },
    base: commit,
    commit,
    runDir,
    picks: [],
    review: false,
    tryOnly: true,
    trialOf: branch,
    signal: new AbortController().signal,
    awaitReview: () => new Promise(() => {}),
  };
  const out: RunOutcome = await makeRunMerge({ specCore: join(REPO_ROOT, "pi-config/extensions/spec/core") })(input, { step: (s) => void steps.set(s.id, s), checks: () => {} });
  return { out, steps };
}

describe("a trial runs path-gated checks in full", () => {
  test("a setup branch that changes only .sova/project.json: the gated check runs and its failure fails the trial; every tracked file counts as changed, and the checks run picked", async () => {
    const fx = new Fixture();
    fixtures.push(fx);
    const probeOut = join(fx.root, "probe.json");
    // The target holds the check scripts and the code they watch.
    fx.commitIn(fx.project, { "checks/gated.mjs": GATED, "checks/probe.mjs": PROBE(probeOut), "src/app.txt": "app\n" }, "checks");
    const def = { version: 1, merge: { checks: [{ id: "gated", label: "Gated", run: ["node", "checks/gated.mjs"] }, { id: "probe", label: "Probe", run: ["node", "checks/probe.mjs"] }] } };
    const br = fx.branch("setup/only-def", { ".sova/project.json": `${JSON.stringify(def, null, 2)}\n` });
    const changedOnBranch = git(fx.project, ["diff", "--name-only", `${fx.target}...${br.commit}`]).split("\n").filter(Boolean);
    assert.deepEqual(changedOnBranch, [".sova/project.json"], "the branch changes only the definition");

    const r = await trial(fx, br.commit, br.branch);
    assert.equal(r.steps.get("check:gated")?.result, "failed", `the gated check ran (not skipped): ${JSON.stringify(r.steps.get("check:gated"))}`);
    assert.equal(r.out.verdict, "failed", `the trial reports the failure: ${r.out.why}`);
    assert.match(r.out.why ?? "", /Gated/);

    const probe = JSON.parse(readFileSync(probeOut, "utf8")) as { picked: string | null; changed: string[] | null };
    assert.equal(probe.picked, "1", "SOVA_MERGE_PICKED=1 in a trial");
    const tracked = git(fx.project, ["ls-tree", "-r", "--name-only", br.commit]).split("\n").filter(Boolean).sort();
    assert.deepEqual([...(probe.changed ?? [])].sort(), tracked, "SOVA_MERGE_CHANGED lists every tracked file of the tried commit");
  });

  test("a proposal with no merge checks (no automated tests) tries as the copy alone and passes, running no check", async () => {
    const fx = new Fixture();
    fixtures.push(fx);
    const def = { version: 1, merge: { checks: "none" } };
    const br = fx.branch("setup/none", { ".sova/project.json": `${JSON.stringify(def, null, 2)}\n` });
    const r = await trial(fx, br.commit, br.branch);
    assert.equal(r.out.verdict, "passed", r.out.why);
    assert.equal(r.out.noChecks, true);
    assert.deepEqual([...r.steps.keys()].filter((k) => k.startsWith("check:")), [], "no check ran");
  });
});
