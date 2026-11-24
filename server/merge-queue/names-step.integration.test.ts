// One merge run, alone, on a real throwaway repository: a landing that pushes ends with the "Private names and secrets"
// step (§app.merge-queue/names-step), over what it adds, with its log naming places and kinds, never the text.
import { after, describe, test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, RunStep } from "../../shared/merge-queue";
import { parseDefinition } from "../../shared/project-contract";
import type { RunInput } from "./contract";
import { SCAN_STEP_ID } from "./names-step";
import { expect } from "./testing/expect";
import { Fixture, REPO_ROOT } from "./testing/repo";
import { makeRunMerge } from "./run";

const fixtures: Fixture[] = [];
after(() => {
  for (const f of fixtures) f.dispose();
});

const SECRET_NAME = "quorvexian";

async function run(fx: Fixture, br: { branch: string; commit: string }, scan: RunInput["scan"] | undefined) {
  const runId = `mr_n${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(fx.root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const base = fx.head();
  const defText = fx.fileAt(base, ".sova/project.json");
  const entry = { id: "me_n", project: "p1", target: fx.target, branch: br.branch, commit: br.commit, approval: { by: "land-button", at: new Date().toISOString(), commit: br.commit }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: "", updatedAt: "" } as MergeEntry;
  const steps = new Map<string, RunStep>();
  const order: string[] = [];
  const input: RunInput = {
    runId,
    entry,
    project: { id: "p1", root: fx.project, target: fx.target, def: defText ? parseDefinition(defText) : null },
    base,
    commit: br.commit,
    runDir,
    picks: [],
    review: false,
    signal: new AbortController().signal,
    awaitReview: () => new Promise(() => {}),
    ...(scan ? { scan } : {}),
  };
  const out = await makeRunMerge({ specCore: join(REPO_ROOT, "pi-config/extensions/spec/core") })(input, {
    step: (s) => {
      if (!steps.has(s.id)) order.push(s.id);
      steps.set(s.id, s);
    },
    checks: () => {},
  });
  return { out, steps, order, log: (id: string) => readFileSync(join(runDir, steps.get(id)!.log), "utf8") };
}

describe("the run's Private names and secrets step", () => {
  test("last, over what the landing adds: a hit fails the step with where and what kind, never the text; the verdict stays the checks'", async () => {
    const fx = new Fixture();
    fixtures.push(fx);
    const names = join(fx.root, "names.json");
    writeFileSync(names, JSON.stringify({ v: 1, privateNames: [SECRET_NAME] }));
    const br = fx.branch("leak", { "src/app.txt": `hello ${SECRET_NAME}\n` });
    const r = await run(fx, br, { namesFile: names, allowFile: join(fx.root, "allow.json") });
    expect(r.out.verdict).toBe("passed");
    expect(r.order.at(-1)).toBe(SCAN_STEP_ID);
    const s = r.steps.get(SCAN_STEP_ID)!;
    expect(s.kind).toBe("scan");
    expect(s.result).toBe("failed");
    expect(s.scan?.state).toBe("hits");
    expect(s.scan?.hits?.[0]?.where ?? "").toMatch(/src\/app\.txt:1/);
    expect(r.out.scan?.state).toBe("hits");
    expect(r.log(SCAN_STEP_ID).includes(SECRET_NAME)).toBe(false);
    expect(JSON.stringify(s).includes(SECRET_NAME)).toBe(false);
  });

  test("clean passes; a landing that doesn't push has no such step", async () => {
    const fx = new Fixture();
    fixtures.push(fx);
    const names = join(fx.root, "names.json");
    writeFileSync(names, JSON.stringify({ v: 1, privateNames: [SECRET_NAME] }));
    const br = fx.branch("ok", { "src/app.txt": "plain\n" });
    const r = await run(fx, br, { namesFile: names, allowFile: join(fx.root, "allow.json") });
    expect(r.steps.get(SCAN_STEP_ID)?.result).toBe("passed");
    const fx2 = new Fixture();
    fixtures.push(fx2);
    const r2 = await run(fx2, fx2.branch("ok", { "src/app.txt": "plain\n" }), undefined);
    expect(r2.steps.has(SCAN_STEP_ID)).toBe(false);
  });
});
