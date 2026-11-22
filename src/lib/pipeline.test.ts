import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { setupMapOf, type SetupFacts } from "../../shared/merge-queue-setup-map";
import type { MergeRun } from "../../shared/merge-queue";
import { attemptsOf, planRows, queueStages, type QueueEvent } from "./pipeline";
import { pipelineHref, PIPELINE_VIEWS, projectsRouteFromHash, type PipelineScope } from "./projects-route";

test("every view of each scope, with and without an item, reads back as the same place", () => {
  for (const scope of Object.keys(PIPELINE_VIEWS) as PipelineScope[]) {
    for (const view of PIPELINE_VIEWS[scope]) {
      for (const item of [undefined, "mr_abc123", "feat/a-b"]) {
        const href = pipelineHref("prj_1", scope, view, item);
        const r = projectsRouteFromHash(href);
        assert.ok(r && r.kind === "project", href);
        assert.deepEqual(r.pipeline, { scope, view, ...(item ? { item } : {}) }, href);
        assert.equal(r.tab, scope === "releases" ? "releases" : "merge-queue", href);
      }
    }
  }
  // The first view of a scope is its bare address; a view of the other scope or a fourth part is no place.
  assert.equal(pipelineHref("prj_1"), "#/projects/prj_1/pipeline");
  assert.equal(pipelineHref("prj_1", "releases", "setup"), "#/projects/prj_1/pipeline/releases");
  for (const bad of ["#/projects/prj_1/pipeline/branches", "#/projects/prj_1/pipeline/releases/stories", "#/projects/prj_1/pipeline/runs/a/b"]) assert.equal(projectsRouteFromHash(bad), null, bad);
});

const facts = (o: Partial<SetupFacts> = {}): SetupFacts => ({ of: "main", commit: null, remote: "origin", names: "unanswered", ...o });
const mapOf = (merge: Record<string, unknown>, o?: Partial<SetupFacts>) => setupMapOf(parseDefinition(JSON.stringify({ version: 1, merge })), facts(o));
const checks = [
  { id: "unit", label: "Unit tests", run: ["t"], timeout: 60 },
  { id: "e2e", label: "Browser tests", run: ["e"], timeout: 60, optional: true },
  { id: "deep", label: "Deep tests", run: ["d"], timeout: 60, optional: true },
];

test("each check sits in the lane that says when it runs", () => {
  const s = queueStages(mapOf({ checks, rules: [{ paths: ["src/**"], check: "e2e", why: "the UI" }] }));
  const lanes = s.find((x) => x.id === "checks")!.lanes!;
  const where = (label: string) => lanes.find((l) => l.checks.some((c) => c.label === label))?.label;
  assert.equal(where("Unit tests"), "Every branch");
  assert.equal(where("Browser tests"), "Only when the changed files match");
  assert.equal(where("Deep tests"), "Only when the merge thread adds it");
});

test("the private names step is in the pipeline exactly when the project pushes, and says when it waits for you", () => {
  for (const remote of ["origin", null]) {
    for (const push of [true, false]) {
      const s = queueStages(mapOf({ checks, push }, { remote }));
      const names = s.find((x) => x.id === "names");
      assert.equal(!!names, !!remote && push, `${remote} ${push}`);
      if (names) assert.ok(names.warn, "unanswered names warn");
    }
  }
  assert.equal(queueStages(mapOf({ checks }, { names: "none" })).find((x) => x.id === "names")?.warn, undefined);
});

test("a saved plan's steps keep their place: in, only if, added late, skipped with why, refused with why", () => {
  const run = {
    steps: [],
    plan: {
      fingerprint: "f".repeat(16),
      at: "",
      inputs: {} as never,
      steps: [
        { id: "check:unit", kind: "check", label: "Unit tests", will: "run", source: "required" },
        { id: "install", kind: "install", label: "Install", will: "if", why: "only if a lockfile changes" },
        { id: "check:e2e", kind: "check", label: "Browser tests", will: "run", why: "picked", late: "2026-11-22T00:00:00Z" },
        { id: "check:deep", kind: "check", label: "Deep tests", will: "skip", why: "not picked; no folder rule matched" },
        { id: "rules", kind: "check", label: "Folder rules", will: "refused", why: "your branch's folder rules are refused: src/** → e2e" },
      ],
    },
  } as unknown as MergeRun;
  const { rows, fingerprint } = planRows(run);
  assert.equal(fingerprint, "f".repeat(16));
  assert.deepEqual(
    rows.map((r) => [r.id, !!r.skip, !!r.maybe, !!r.late, !!r.refused]),
    [
      ["check:unit", false, false, false, false],
      ["install", false, true, false, false],
      ["check:e2e", false, false, true, false],
      ["check:deep", true, false, false, false],
      ["rules", false, false, false, true],
    ],
  );
  assert.equal(rows[3]!.note, "not picked; no folder rule matched");
  assert.equal(rows[4]!.note, "your branch's folder rules are refused: src/** → e2e");
});

test("a branch's story is one attempt per run, in the order recorded", () => {
  const ev = (seq: number, kind: string, run?: string) => ({ seq, at: new Date(seq * 1000).toISOString(), kind, by: "queue", why: kind, ...(run ? { run } : {}) }) as unknown as QueueEvent;
  const a = attemptsOf([ev(5, "run-ended", "mr_2"), ev(1, "approved"), ev(2, "run-started", "mr_1"), ev(3, "run-restarted", "mr_1"), ev(4, "run-started", "mr_2"), ev(6, "step-ended", "mr_2")]);
  assert.deepEqual(
    a.map((x) => [x.label, x.events.map((e) => e.seq)]),
    [
      ["Before its first run", [1]],
      ["Attempt 1", [2, 3]],
      ["Attempt 2", [4, 5]],
    ],
  );
});
