// Run: pnpm test -- src/lib/merge-run.browser.test.ts (Solid's reactive build).
// The run page (components/MergeRunView.tsx) reads a running run every few seconds. Each read is a fresh object;
// reconciled by step id, every step keeps its identity, so `<For>` keeps its row and what the row holds (its open
// log) until the user closes it. A step's open log follows it while it runs and stops once it finishes. No DOM
// here: a row stands for the DOM node `<For>` would keep, built through Solid's own mapArray.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createFollowedRead, createRunRead } = await import("./merge-run");
type MergeRun = import("../../shared/merge-queue").MergeRun;
type RunStep = import("../../shared/merge-queue").RunStep;

const st = (id: string, result: RunStep["result"], ms = 0): RunStep => ({ id, kind: id === "copy" ? "copy" : "check", label: id, result, ms, log: `${id}.log` });
const runOf = (verdict: MergeRun["verdict"], steps: RunStep[]): MergeRun => ({ id: "mr_1", entry: "me_1", project: "prj_1", branch: "feat/x", base: "a".repeat(40), commit: "b".repeat(40), startedAt: "2026-11-03T10:00:00Z", verdict, steps }) as MergeRun;

/** Waits for `ok` with a generous deadline; the reads here resolve in microtasks or a few ms. */
async function until(ok: () => boolean, what: string) {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("a refetched run with the same step ids keeps every row, and an open log stays open; only Log closes it", async () => {
  // Each read hands back fresh objects, as the merge.logs verb does.
  const answers = [
    runOf("running", [st("copy", "passed", 1000), st("check:unit", "running"), st("check:int", "pending")]),
    runOf("running", [st("copy", "passed", 1000), st("check:unit", "passed", 75_000), st("check:int", "running")]),
    runOf("passed", [st("copy", "passed", 1000), st("check:unit", "passed", 75_000), st("check:int", "passed", 90_000)]),
  ];
  let reads = 0;
  const read = async () => structuredClone(answers[Math.min(reads++, answers.length - 1)]!);
  await new Promise<void>((done, fail) => {
    solid.createRoot(async (dispose) => {
      try {
        const r = createRunRead(() => "mr_1", read, 5);
        const built: string[] = [];
        // What `<For each={run().steps}>` does: one row per step object, kept while that object is.
        const rows = solid.mapArray(
          () => r.run()?.steps ?? [],
          (s) => {
            built.push(s.id);
            const [open, setOpen] = solid.createSignal(false);
            return { step: s, open, setOpen };
          },
        );
        const list = solid.createMemo(rows);
        await until(() => list().length === 3, "the first read");
        const first = list();
        assert.deepEqual(built, ["copy", "check:unit", "check:int"]);
        first[1]!.setOpen(true);
        await until(() => reads >= 3 && r.run()?.verdict === "passed", "the run to finish");
        const after = list();
        assert.deepEqual(built, ["copy", "check:unit", "check:int"], "no row was built again");
        for (let i = 0; i < 3; i++) assert.equal(after[i], first[i], `row ${i} is the same row`);
        assert.equal(after[1]!.open(), true, "its log is still open");
        assert.equal(after[1]!.step.result, "passed", "and the row shows the step's new state");
        assert.equal(after[2]!.step.ms, 90_000);
        // Finished: no more reads.
        const n = reads;
        await new Promise((res) => setTimeout(res, 40));
        assert.equal(reads, n, "a finished run isn't read again");
        after[1]!.setOpen(false);
        assert.equal(after[1]!.open(), false);
        dispose();
        done();
      } catch (err) {
        dispose();
        fail(err);
      }
    });
  });
});

test("an open log of a running step is read again while it runs, keeps its text between reads, and stops once the step ends", async () => {
  const keys: string[] = [];
  let lines = 0;
  await new Promise<void>((done, fail) => {
    solid.createRoot(async (dispose) => {
      try {
        const [open, setOpen] = solid.createSignal(false);
        const [result, setResult] = solid.createSignal<RunStep["result"]>("running");
        const log = createFollowedRead(
          () => (open() ? `mr_1\ncheck:unit\n${result()}` : null),
          async (key) => {
            keys.push(key);
            lines++;
            return `line ${lines}`;
          },
          () => open() && result() === "running",
          5,
        );
        await new Promise((res) => setTimeout(res, 20));
        assert.equal(keys.length, 0, "a closed log reads nothing");
        setOpen(true);
        await until(() => lines >= 3, "a few live reads");
        assert.match(log.text() ?? "", /^line \d+$/, "the text so far shows between reads");
        setResult("passed");
        await until(() => keys.at(-1) === "mr_1\ncheck:unit\npassed", "one last read once it finished");
        const n = keys.length;
        await new Promise((res) => setTimeout(res, 40));
        assert.equal(keys.length, n, "a finished step's log isn't read again");
        setOpen(false);
        assert.equal(log.text(), undefined, "closed: nothing kept");
        dispose();
        done();
      } catch (err) {
        dispose();
        fail(err);
      }
    });
  });
});
