import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContent, TranscriptItem } from "../../shared/protocol";
import {
  editOf,
  OTHER_TITLE,
  patchFacts,
  repoPath,
  stepHunksOf,
  stepsFromAgent,
  stepsFromTurns,
  stepTitle,
  turnsFromItems,
  editCallsToLoad,
  type StepFile,
  type StepHunk,
  type Turn,
} from "./changes-steps";

const hunk = (newStart: number, add: string[], del: string[] = [], ctx: string[] = []): StepHunk => ({
  oldStart: newStart,
  oldLines: del.length + ctx.length,
  newStart,
  newLines: add.length + ctx.length,
  rows: [...ctx.map((text) => ({ kind: "ctx" as const, text })), ...del.map((text) => ({ kind: "del" as const, text })), ...add.map((text) => ({ kind: "add" as const, text }))],
});

/** Every hunk ref of a plan, steps and Other together, as "path#i". */
function everyRef(plan: ReturnType<typeof stepsFromTurns>): string[] {
  return [...plan.steps, ...(plan.other ? [plan.other] : [])].flatMap((s) => s.hunks.map((r) => `${r.path}#${r.hunk}`));
}
function allHunks(files: StepFile[]): string[] {
  return files.flatMap((f) => (f.hunks === null ? [`${f.path}#-1`] : f.hunks.map((_, i) => `${f.path}#${i}`)));
}

test("titles: first non-empty line, capped", () => {
  assert.equal(stepTitle("\n  Fix the parser  \nmore"), "Fix the parser");
  assert.equal(stepTitle(""), "Untitled turn");
  const long = stepTitle("x".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("patchFacts reads ranges and changed lines, not the file headers", () => {
  const f = patchFacts("--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3,3 @@\n ctx\n-old line\n+new line\n+another\n@@ -40 +41 @@\n-z\n+zz");
  assert.deepEqual(f.ranges, [[3, 5], [41, 41]]);
  assert.deepEqual(f.added, ["new line", "another", "zz"]);
  assert.deepEqual(f.removed, ["old line", "z"]);
});

test("editOf: pi edit, pi write, Claude Code Edit/MultiEdit/Write; other tools are not edits", () => {
  const pi = editOf("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] });
  assert.deepEqual(pi, { path: "a.ts", added: ["two"], removed: ["one"], ranges: [] });
  const recorded = editOf("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] }, { patch: "@@ -9 +9 @@\n-one\n+two" });
  assert.deepEqual(recorded?.ranges, [[9, 9]]);
  assert.equal(editOf("write", { path: "b.ts", content: "x\ny" })?.whole, true);
  assert.deepEqual(editOf("Edit", { file_path: "/r/c.ts", old_string: "p", new_string: "q" })?.added, ["q"]);
  assert.deepEqual(editOf("MultiEdit", { file_path: "/r/c.ts", edits: [{ old_string: "p", new_string: "q" }, { old_string: "r", new_string: "s" }] })?.added, ["q", "s"]);
  assert.deepEqual(editOf("edit", { file_path: "c.ts", old_string: "p", new_string: "q" }, { structuredPatch: [{ newStart: 4, newLines: 2, lines: ["-p", "+q", " k"] }] })?.ranges, [[4, 5]]);
  assert.equal(editOf("bash", { command: "rm -rf x" }), null);
  assert.equal(editOf("edit", { path: "a.ts" }), null);
});

test("repoPath maps absolute and cwd-relative tool paths into the diff root, and refuses outside", () => {
  assert.equal(repoPath("/repo/src/a.ts", "/repo", "/repo"), "src/a.ts");
  assert.equal(repoPath("src/../lib/a.ts", "/repo/pkg", "/repo"), "pkg/lib/a.ts");
  assert.equal(repoPath("/wt/x.ts", "/repo", "/wt"), "x.ts");
  assert.equal(repoPath("/other/x.ts", "/repo", "/repo"), null);
  // "/repository" is not inside "/repo".
  assert.equal(repoPath("/repository/x.ts", "/repo", "/repo"), null);
});

function row(kind: TranscriptItem["kind"], id: string, extra: Partial<TranscriptItem> = {}): TranscriptItem {
  return { id, kind, ...extra };
}
/** What GET /api/transcript/tool answers for each call row: its arguments and its result's details. */
const fetched = new Map<string, ToolContent>();
function call(id: string, name: string, args: unknown): TranscriptItem {
  fetched.set(`${id}:c`, { args });
  return row("tool-call", `${id}:c`, { text: name, toolCallId: id, tool: { summary: "", lazy: true, bytes: 10 } });
}
function result(id: string, isError = false, details?: unknown): TranscriptItem {
  const had = fetched.get(`${id}:c`);
  if (had) fetched.set(`${id}:c`, { ...had, result: { output: "", isError, ...(details !== undefined ? { details } : {}) } });
  return row("tool-result", `${id}:r`, { toolCallId: id, meta: { type: "message", role: "toolResult", toolCallId: id, isError }, tool: { lazy: true, bytes: 5 } });
}

test("turnsFromItems: a turn per prompt that edited, failed and unanswered calls left out", () => {
  const items = [
    row("user", "u1", { text: "Add date helpers\nplease" }),
    call("t1", "write", { path: "src/dates.ts", content: "export const shortDate = 1;" }),
    result("t1"),
    call("t2", "read", { path: "src/x.ts" }),
    result("t2"),
    row("user", "u2", { text: "Just a question" }),
    call("t3", "bash", { command: "ls" }),
    result("t3"),
    row("user", "u3", { text: "Use them" }),
    call("t4", "edit", { path: "src/format.ts", edits: [{ oldText: "a", newText: "b" }] }),
    result("t4", true),
    call("t5", "edit", { path: "src/format.ts", edits: [{ oldText: "clockTime", newText: "shortDate" }] }),
    result("t5"),
    call("t6", "edit", { path: "src/never.ts", edits: [{ oldText: "a", newText: "b" }] }),
  ];
  // Only the successful, answered edit and write calls are fetched.
  assert.deepEqual(editCallsToLoad(items), [
    { rowId: "t1:c", resultId: "t1:r", size: 15 },
    { rowId: "t5:c", resultId: "t5:r", size: 15 },
  ]);
  const turns = turnsFromItems(items, fetched);
  assert.deepEqual(turns.map((t) => t.title), ["Add date helpers", "Use them"]);
  assert.deepEqual(turns[1]!.edits.map((e) => e.added), [["shortDate"]]);
  // Without the fetched content a lazy row has no arguments to read: no turns, rather than wrong ones.
  assert.deepEqual(turnsFromItems(items), []);
});

test("turnsFromItems: a recorded patch in the fetched details wins over the arguments", () => {
  const items = [
    row("user", "u1", { text: "Fix" }),
    call("p1", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }),
    result("p1", false, { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,1 +3,1 @@\n-old line\n+new line\n" }),
  ];
  const [turn] = turnsFromItems(items, fetched);
  assert.deepEqual(turn!.edits[0]!.added, ["new line"]);
  assert.deepEqual(turn!.edits[0]!.removed, ["old line"]);
});

test("turnsFromItems: a Claude Code edit's patch beside the message counts when it has no details", () => {
  const items = [row("user", "u1", { text: "Fix" }), call("k1", "Edit", { file_path: "src/b.ts", old_string: "x", new_string: "y" }), result("k1")];
  const got = fetched.get("k1:c")!;
  fetched.set("k1:c", { ...got, result: { ...got.result!, toolUseResult: { structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ["-old b", "+new b"] }] } } });
  const [turn] = turnsFromItems(items, fetched);
  assert.deepEqual(turn!.edits[0]!.added, ["new b"]);
  assert.deepEqual(turn!.edits[0]!.ranges, [[4, 4]]);
});

const files: StepFile[] = [
  { path: "src/dates.ts", hunks: [hunk(1, ["export const shortDate = (iso) => DAY.format(iso);", "export const isToday = (iso) => true;"])] },
  {
    path: "src/format.ts",
    hunks: [
      hunk(1, ['import { shortDate } from "./dates";'], ['import { clockTime } from "./clock";']),
      hunk(20, ["  return shortDate(iso);"], ["  return clockTime(iso);"]),
      hunk(60, ["// a comment the user typed by hand"]),
    ],
  },
  { path: "README.md", hunks: [hunk(3, ["Hand-written notes."])] },
  { path: "src/big.json", hunks: null },
];
const turns: Turn[] = [
  { id: "u1", title: "Add date helpers", edits: [{ path: "/repo/src/dates.ts", added: ["export const shortDate = (iso) => DAY.format(iso);", "export const isToday = (iso) => true;"], removed: [], ranges: [], whole: true }] },
  {
    id: "u2",
    title: "Use them",
    edits: [
      { path: "src/format.ts", added: ['import { shortDate } from "./dates";'], removed: ['import { clockTime } from "./clock";'], ranges: [[1, 1]] },
      { path: "src/format.ts", added: ["  return shortDate(iso);"], removed: ["  return clockTime(iso);"], ranges: [[20, 20]] },
      { path: "src/big.json", added: ["{}"], removed: [], ranges: [] },
    ],
  },
  { id: "u3", title: "Committed long ago", edits: [{ path: "src/gone.ts", added: ["x = 1"], removed: [], ranges: [] }] },
];

test("stepsFromTurns: every hunk in exactly one step, leftovers in Other changes", () => {
  const plan = stepsFromTurns(turns, files, "/repo", "/repo");
  assert.deepEqual(plan.steps.map((s) => [s.n, s.title]), [[1, "Add date helpers"], [2, "Use them"]]);
  const refs = everyRef(plan);
  assert.deepEqual([...refs].sort(), allHunks(files).sort());
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(plan.other?.title, OTHER_TITLE);
  assert.deepEqual(plan.other?.hunks.map((r) => `${r.path}#${r.hunk}`), ["src/format.ts#2", "README.md#0"]);
  assert.deepEqual(plan.steps[1]!.hunks.map((r) => `${r.path}#${r.hunk}`), ["src/format.ts#0", "src/format.ts#1", "src/big.json#-1"]);
  assert.deepEqual(plan.byFile["src/format.ts"], [2]);
  assert.deepEqual(stepHunksOf(plan.steps[1]!, "src/format.ts"), [0, 1]);
  assert.equal(stepHunksOf(plan.steps[1]!, "src/big.json"), null);
});

test("stepsFromTurns: a later turn that rewrote the same lines owns them; builds on follows shared files", () => {
  const f: StepFile[] = [{ path: "a.ts", hunks: [hunk(5, ["const v = 3;"]), hunk(30, ["tail()"])] }];
  const t: Turn[] = [
    { id: "1", title: "First", edits: [{ path: "a.ts", added: ["const v = 2;", "tail()"], removed: [], ranges: [] }] },
    { id: "2", title: "Second", edits: [{ path: "a.ts", added: ["const v = 3;"], removed: ["const v = 2;"], ranges: [] }] },
  ];
  const plan = stepsFromTurns(t, f, "/r", "/r");
  assert.deepEqual(plan.steps.map((s) => s.hunks.map((r) => r.hunk)), [[1], [0]]);
  assert.deepEqual(plan.steps[1]!.buildsOn, [1]);
  assert.equal(plan.other, null);
});

test("stepsFromTurns: short lines fall back to the edit's recorded range", () => {
  const f: StepFile[] = [{ path: "a.ts", hunks: [hunk(12, ["}"])] }];
  const t: Turn[] = [{ id: "1", title: "Close it", edits: [{ path: "a.ts", added: ["}"], removed: [], ranges: [[10, 11]] }] }];
  assert.deepEqual(stepsFromTurns(t, f, "/r", "/r").steps[0]?.hunks, [{ path: "a.ts", hunk: 0 }]);
  const far: Turn[] = [{ id: "1", title: "Close it", edits: [{ path: "a.ts", added: ["}"], removed: [], ranges: [[100, 101]] }] }];
  assert.equal(stepsFromTurns(far, f, "/r", "/r").other?.hunks.length, 1);
});

test("stepsFromTurns: a renamed file matches edits under its old path", () => {
  const f: StepFile[] = [{ path: "new.ts", oldPath: "old.ts", hunks: [hunk(1, ["export function gitStats() {}"])] }];
  const t: Turn[] = [{ id: "1", title: "Rename", edits: [{ path: "old.ts", added: ["export function gitStats() {}"], removed: [], ranges: [] }] }];
  assert.equal(stepsFromTurns(t, f, "/r", "/r").steps.length, 1);
});

test("stepsFromAgent: first claim wins, header starts pick hunks, unmatched and Other reported, builds on renumbered", () => {
  const plan = stepsFromAgent(
    [
      { title: "Helpers", hunks: [{ path: "src/dates.ts" }] },
      { title: "Nothing real", hunks: [{ path: "src/missing.ts" }, { path: "src/format.ts", newStart: 500 }] },
      { title: "Callers", hunks: [{ path: "src/format.ts", newStart: 20 }, { path: "src/dates.ts" }], buildsOn: [1, 2, 5] },
      { title: "Imports", why: " The top of format.ts. ", hunks: [{ path: "src/format.ts", oldStart: 1 }, { path: "src/big.json" }], buildsOn: [3] },
    ],
    files,
    "/repo",
  );
  assert.deepEqual(plan.steps.map((s) => [s.n, s.title]), [[1, "Helpers"], [2, "Callers"], [3, "Imports"]]);
  assert.deepEqual(plan.unmatched, ["Nothing real"]);
  // dates.ts went to step 1 first; Callers keeps only the hunk that starts at line 20.
  assert.deepEqual(plan.steps[1]!.hunks, [{ path: "src/format.ts", hunk: 1 }]);
  assert.deepEqual(plan.steps[1]!.buildsOn, [1]);
  assert.deepEqual(plan.steps[2]!.buildsOn, [2]);
  assert.equal(plan.steps[2]!.note, "The top of format.ts.");
  assert.deepEqual(plan.other?.hunks.map((r) => `${r.path}#${r.hunk}`), ["src/format.ts#2", "README.md#0"]);
  const refs = everyRef(plan);
  assert.deepEqual([...refs].sort(), allHunks(files).sort());
  assert.equal(new Set(refs).size, refs.length);
});

test("stepsFromAgent: a start inside a hunk's range names it, one past its end does not", () => {
  const f: StepFile[] = [{ path: "a.ts", hunks: [hunk(10, ["x1", "x2", "x3"])] }];
  assert.equal(stepsFromAgent([{ title: "In", hunks: [{ path: "a.ts", newStart: 12 }] }], f, "/r").steps.length, 1);
  assert.deepEqual(stepsFromAgent([{ title: "Out", hunks: [{ path: "a.ts", newStart: 13 }] }], f, "/r").unmatched, ["Out"]);
});
