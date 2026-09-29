// The show_changes tool refuses steps that don't place every hunk, with its own copy of the
// viewer's matching (pi-config/extensions/show-changes/coverage.ts, standalone). This pins the
// two to the same placement on shared fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiffFileHunks, placeSteps } from "../../pi-config/extensions/show-changes/coverage";
import { type AgentStepInput, type StepFile, stepsFromAgent } from "./changes-steps";

const h = (oldStart: number, oldLines: number, newStart: number, newLines: number) => ({ oldStart, oldLines, newStart, newLines });

const files: DiffFileHunks[] = [
  { path: "a.ts", hunks: [h(1, 6, 1, 7), h(40, 7, 41, 3), h(90, 0, 88, 4)].map((x) => ({ ...x, firstChanged: "+x" })) },
  { path: "new.ts", oldPath: "old.ts", hunks: [{ ...h(12, 3, 10, 5), firstChanged: "+y" }] },
  { path: "gone.ts", hunks: [{ ...h(1, 4, 0, 0), firstChanged: "-z" }] },
  { path: "logo.png", hunks: null },
  { path: "moved.ts", oldPath: "was.ts", hunks: [] },
];

const cases: [string, AgentStepInput[]][] = [
  ["whole files", [{ title: "All", hunks: files.map((f) => ({ path: f.path })) }]],
  [
    "starts inside ranges, first step wins",
    [
      { title: "One", hunks: [{ path: "a.ts", newStart: 43 }, { path: "old.ts", oldStart: 14 }] },
      { title: "Two", hunks: [{ path: "a.ts" }, { path: "logo.png", newStart: 5 }] },
      { title: "Three", hunks: [{ path: "gone.ts", newStart: 0 }, { path: "a.ts", oldStart: 90 }] },
    ],
  ],
  [
    "edges and misses",
    [
      { title: "Edges", hunks: [{ path: "a.ts", newStart: 7 }, { path: "a.ts", newStart: 44 }, { path: "a.ts", oldStart: 46 }, { path: "new.ts", newStart: 15 }] },
      { title: "Misses", hunks: [{ path: "nowhere.ts" }, { path: "moved.ts" }, { path: "gone.ts", oldStart: 5 }] },
      { title: "Rename by new path", hunks: [{ path: "new.ts", newStart: 14 }, { path: "gone.ts", oldStart: 4 }] },
    ],
  ],
];

for (const [name, steps] of cases) {
  test(`show_changes coverage matches the viewer: ${name}`, () => {
    const tool = placeSteps(steps, files);
    const stepFiles: StepFile[] = files.map((f) => ({
      path: f.path,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      hunks: f.hunks === null ? null : f.hunks.map((x) => ({ ...h(x.oldStart, x.oldLines, x.newStart, x.newLines), rows: [] })),
    }));
    const plan = stepsFromAgent(steps, stepFiles, "/r");
    // Unit key → 0-based agent step index (from the step id), or -1 for "Other changes".
    const viewer = new Map<string, number>();
    for (const s of [...plan.steps, ...(plan.other ? [plan.other] : [])]) {
      for (const r of s.hunks) viewer.set(`${r.path}#${Math.max(r.hunk, 0)}`, s.source === "agent" ? Number(s.id.slice("agent:".length)) : -1);
    }
    const mine = new Map<string, number>();
    files.forEach((f, fi) => tool.owner[fi]!.forEach((o, u) => mine.set(`${f.path}#${u}`, o)));
    assert.deepEqual(Object.fromEntries(mine), Object.fromEntries(viewer));
    // A step the viewer drops as unmatched is one that took no unit here.
    const took = new Set(tool.owner.flat());
    assert.deepEqual(plan.unmatched, steps.filter((_, i) => !took.has(i)).map((s) => s.title));
  });
}
