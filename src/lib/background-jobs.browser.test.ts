// Run: pnpm test -- src/lib/background-jobs.browser.test.ts (Solid's reactive build).
// The Background jobs section's state (§app.background-jobs/pane): a read fills it, Stop calls the
// stop route (a worker's job by the worker's own chat id) and reads again, the button waits while
// Stop is out, a failed Stop says so, and a stale read never overwrites a newer one. It only reads
// and stops: no chat is opened, started or sent anything (the deps are all it can reach).
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createJobsState } = await import("./background-jobs");
type BackgroundJob = import("../../shared/protocol").BackgroundJob;

const job = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "j1", sessionId: "s-1", command: "sleep 600 &", cwd: "/w", kind: "kept", startedAt: 0, output: null, noOutput: false, worker: null, stopping: false, ...over,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

function harness(lists: BackgroundJob[][]) {
  const calls: string[] = [];
  const failures: string[] = [];
  let stopAnswer: Promise<unknown> = Promise.resolve({ ok: true });
  const state = solid.createRoot(() =>
    createJobsState(() => "/s/a.jsonl", {
      list: async (path) => {
        calls.push(`list ${path}`);
        return { jobs: lists.shift() ?? [] };
      },
      stop: (path, id, sessionId) => {
        calls.push(`stop ${path} ${id} ${sessionId ?? "-"}`);
        return stopAnswer;
      },
      failed: (t) => failures.push(t),
    }),
  );
  return { state, calls, failures, answerStop: (p: Promise<unknown>) => void (stopAnswer = p) };
}

test("a read fills the list; Stop stops the chat's own job by id, a worker's by its chat id, then reads again", async () => {
  const own = job();
  const theirs = job({ sessionId: "s-w", worker: "w1" });
  const h = harness([[own, theirs], [theirs], []]);
  await h.state.read();
  assert.deepEqual(h.state.jobs().map((j) => `${j.sessionId}/${j.id}`), ["s-1/j1", "s-w/j1"]);
  await h.state.stop(own);
  assert.deepEqual(h.state.jobs(), [theirs]);
  await h.state.stop(theirs);
  assert.deepEqual(h.state.jobs(), []);
  assert.deepEqual(h.calls, ["list /s/a.jsonl", "stop /s/a.jsonl j1 -", "list /s/a.jsonl", "stop /s/a.jsonl j1 s-w", "list /s/a.jsonl"]);
});

test("the button waits while Stop is out and while the server stops the job; a failed Stop says so and frees it", async () => {
  const j = job();
  const h = harness([[j]]);
  await h.state.read();
  assert.equal(h.state.stopping(j), false);
  assert.equal(h.state.stopping(job({ stopping: true })), true);
  const d = deferred<unknown>();
  h.answerStop(d.promise);
  const out = h.state.stop(j);
  assert.equal(h.state.stopping(j), true);
  assert.equal(h.state.stopping(job({ sessionId: "s-w" })), false, "another chat's j1 is another row");
  d.reject(new Error("No job j1"));
  await out;
  assert.equal(h.state.stopping(j), false);
  assert.deepEqual(h.failures, ["Couldn't stop job j1. No job j1"]);
});

test("a stale read never overwrites a newer one, and a failed read keeps the list", async () => {
  const first = deferred<{ jobs: BackgroundJob[] }>();
  const second = deferred<{ jobs: BackgroundJob[] }>();
  const answers = [first.promise, second.promise, Promise.reject(new Error("down"))];
  const state = solid.createRoot(() => createJobsState(() => "/s/a.jsonl", { list: () => answers.shift()!, stop: async () => ({}), failed: () => {} }));
  const a = state.read();
  const b = state.read();
  second.resolve({ jobs: [job({ id: "j2" })] });
  await b;
  first.resolve({ jobs: [job({ id: "j1" })] });
  await a;
  assert.deepEqual(state.jobs().map((j) => j.id), ["j2"]);
  await state.read();
  assert.deepEqual(state.jobs().map((j) => j.id), ["j2"]);
});
