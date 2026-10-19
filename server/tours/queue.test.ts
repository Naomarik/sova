import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TourJobBlocked, TourJobFailure, TourJobQueue, readTourConcurrency, type TourQueueTask } from "./queue";
import { TourJobStore } from "./job";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const request = (tourId: string) => ({ tourId, sessionId: "test-session", title: `Tour ${tourId}`, total: 2 });
const setup = (options: Omit<ConstructorParameters<typeof TourJobQueue>[0], "root"> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "tour-queue-"));
  const queue = new TourJobQueue({ root, ...options });
  return { queue, root, cleanup: () => { queue.close(); rmSync(root, { recursive: true, force: true }); } };
};

test("recording concurrency is configurable but small; invalid settings cannot remove the limit", () => {
  assert.equal(readTourConcurrency({}), 2);
  assert.equal(readTourConcurrency({ SOVA_TOUR_CONCURRENCY: "3" }), 3);
  for (const v of ["0", "5", "-1", "2.5", "Infinity", "anything"]) assert.equal(readTourConcurrency({ SOVA_TOUR_CONCURRENCY: v }), 2);
});

test("recording queue enforces the concurrent limit, FIFO order and real positions", async () => {
  const { queue, cleanup } = setup({ limit: 2 });
  const started: string[] = []; const gates = new Map<string, ReturnType<typeof deferred>>();
  let active = 0; let peak = 0;
  const task: TourQueueTask = async job => { started.push(job.tourId); active++; peak = Math.max(peak, active); const gate = deferred(); gates.set(job.tourId, gate); await gate.promise; active--; };
  try {
    const jobs = ["one", "two", "three", "four"].map(id => queue.enqueue(request(id), task));
    await tick();
    assert.deepEqual(started, ["one", "two"]);
    assert.equal(queue.get("test-session", jobs[2]!.id)!.queuePosition, 1);
    assert.equal(queue.get("test-session", jobs[3]!.id)!.queuePosition, 2);
    gates.get("two")!.resolve(); await tick();
    assert.deepEqual(started, ["one", "two", "three"]);
    assert.equal(queue.get("test-session", jobs[3]!.id)!.queuePosition, 1);
    gates.get("one")!.resolve(); await tick();
    assert.deepEqual(started, ["one", "two", "three", "four"]);
    assert.equal(peak, 2, "bad unlimited implementation starts 4 before a slot is released");
    gates.get("three")!.resolve(); gates.get("four")!.resolve(); await tick();
  } finally { cleanup(); }
});

test("same-tour attempts never overlap while another tour can use the free slot", async () => {
  const { queue, cleanup } = setup({ limit: 2 }); const gates = [deferred(), deferred(), deferred()]; const starts: string[] = [];
  const task = (n: number): TourQueueTask => async job => { starts.push(job.id); await gates[n]!.promise; };
  try {
    const a = queue.enqueue(request("same"), task(0)); const b = queue.enqueue(request("same"), task(1)); const c = queue.enqueue(request("other"), task(2));
    await tick(); assert.deepEqual(starts, [a.id, c.id]);
    assert.equal(queue.get("test-session", b.id)!.queuePosition, 1);
    gates[0]!.resolve(); await tick(); assert.deepEqual(starts, [a.id, c.id, b.id]);
    gates[1]!.resolve(); gates[2]!.resolve(); await tick();
  } finally { cleanup(); }
});

test("cancel removes a waiting job and running cancel holds its slot until cleanup finishes", async () => {
  const { queue, cleanup } = setup({ limit: 1 }); const finish = deferred(); let aborted = false; const starts: string[] = [];
  const task: TourQueueTask = async (job, signal) => { starts.push(job.tourId); if (job.tourId === "running") { signal.addEventListener("abort", () => { aborted = true; }); await finish.promise; } };
  try {
    const a = queue.enqueue(request("running"), task); const b = queue.enqueue(request("waiting"), task); const c = queue.enqueue(request("next"), task);
    await tick();
    assert.equal(queue.cancel("other-session", a.id), null, "cannot cancel another session's browser");
    assert.equal(queue.cancel("test-session", b.id)!.phase, "cancelled");
    assert.equal(queue.get("test-session", c.id)!.queuePosition, 1);
    assert.equal(queue.cancel("test-session", a.id)!.phase, "cancelled"); assert.equal(aborted, true);
    await tick(); assert.deepEqual(starts, ["running"], "abort is not proof of child cleanup");
    finish.resolve(); await tick(); assert.deepEqual(starts, ["running", "next"]);
    assert.equal(queue.get("test-session", a.id)!.phase, "cancelled", "late runner success cannot overwrite cancellation");
  } finally { finish.resolve(); await tick(); cleanup(); }
});

test("site/account waiting releases scarce slots, requires explicit resume and is bounded", async () => {
  const { queue, cleanup } = setup({ limit: 1, maxWaiting: 2 }); let attempts = 0;
  try {
    const blocked = queue.enqueue(request("blocked"), async () => { if (++attempts === 1) throw new TourJobBlocked({ origins: ["http://localhost:9999"] }); });
    const next = queue.enqueue(request("next"), async () => {});
    await tick();
    assert.equal(queue.get("test-session", blocked.id)!.phase, "needs-site-approval");
    assert.equal(queue.get("test-session", next.id)!.phase, "checking");
    await tick(); assert.equal(attempts, 1, "no automatic retry after missing consent");
    const account = queue.enqueue({ ...request("account"), requirements: { testAccount: { origin: "https://example.test", kind: "http-basic" } } }, async () => {});
    assert.equal(account.phase, "needs-test-account");
    assert.throws(() => queue.enqueue(request("overflow"), async () => {}), /queue is full/);
    queue.cancel("test-session", account.id);
    queue.resume("test-session", blocked.id); await tick(); assert.equal(attempts, 2);
  } finally { cleanup(); }
});

test("progress records actual step/view/size, safe failure and independent card snapshots", async () => {
  const seen: string[] = []; const { queue, cleanup } = setup({ onChange: j => { seen.push(j.phase); } });
  try {
    const job = queue.enqueue(request("progress"), async (_j, _s, progress) => {
      progress({ phase: "recording", completed: 1, total: 2, stepId: "first", viewId: "detail", size: "phone" });
      throw new Error("DO-NOT-LEAK-PASSWORD");
    });
    await tick();
    const failed = queue.get("test-session", job.id)!;
    assert.equal(failed.phase, "failed"); assert.equal(failed.completed, 1); assert.equal(failed.size, "phone");
    assert.ok(seen.includes("recording")); assert.ok(!JSON.stringify(failed).includes("DO-NOT-LEAK-PASSWORD"));
    failed.title = "mutated"; assert.notEqual(queue.get("test-session", job.id)!.title, "mutated");
  } finally { cleanup(); }
});

test("malformed recorder findings and a fake ready result fail safely and release their slot", async () => {
  const { queue, cleanup } = setup({ limit: 1 });
  try {
    const malformed = queue.enqueue(request("malformed"), async () => { throw new TourJobFailure({ message: "", guidance: "" }); });
    const fake = queue.enqueue(request("fake"), async () => ({ phase: "ready" }));
    const next = queue.enqueue(request("following"), async () => {});
    await tick();
    assert.equal(queue.get("test-session", malformed.id)!.phase, "failed");
    assert.equal(queue.get("test-session", fake.id)!.phase, "failed", "no checked edition means no plausible ready result");
    assert.equal(queue.get("test-session", next.id)!.phase, "checking", "invalid runner results cannot strand a slot");
  } finally { cleanup(); }
});

test("deleted-session barrier cancels queued work, awaits real running cleanup and prevents late resurrection", async () => {
  const { queue, root, cleanup } = setup({ limit: 1 }); const finishCleanup = deferred(); let aborted = false; let removed = false; const started: string[] = [];
  try {
    const active = queue.enqueue(request("active"), async (j, signal, progress) => {
      started.push(j.tourId); signal.addEventListener("abort", () => { aborted = true; });
      await finishCleanup.promise;
      progress({ phase: "recording", completed: 1, total: 2 });
      return { phase: "ready", editionId: "must-not-resurrect" };
    });
    const waiting = queue.enqueue(request("waiting"), async j => { started.push(j.tourId); });
    const other = queue.enqueue({ ...request("other"), sessionId: "other-session" }, async j => { started.push(j.tourId); });
    await tick();
    const deletion = queue.removeSession("test-session").then(() => { removed = true; });
    await tick();
    assert.equal(aborted, true); assert.equal(removed, false, "abort alone must not permit deleting files still used by a runner");
    assert.equal(queue.get("test-session", active.id)!.phase, "cancelled");
    assert.equal(queue.get("test-session", waiting.id)!.phase, "cancelled");
    assert.equal(new TourJobStore(root).list().filter(j => j.sessionId === "test-session").length, 2, "job files stay until actual cleanup settles");
    assert.throws(() => queue.enqueue(request("late-request"), async () => {}), /chat was deleted/);
    assert.deepEqual(started, ["active"]);
    finishCleanup.resolve(); await deletion; await tick();
    assert.equal(queue.get("test-session", active.id), null); assert.deepEqual(queue.list("test-session"), []);
    assert.equal(new TourJobStore(root).list().some(j => j.sessionId === "test-session"), false, "late success/progress cannot recreate a removed job");
    assert.equal(queue.get("other-session", other.id)!.phase, "checking"); assert.deepEqual(started, ["active", "other"]);
    await queue.removeSession("test-session"); assert.equal(queue.get("other-session", other.id)!.phase, "checking", "repeat cleanup stays scoped");
  } finally { finishCleanup.resolve(); await tick(); cleanup(); }
});

test("deletion rejects persistence errors only after actual cleanup and still attempts all remaining job cleanup", async () => {
  for (const failure of ["cancel-save", "job-remove", "both"] as const) {
    const { queue, root, cleanup } = setup({ limit: 1 }); const finish = deferred(); let aborted = false; let settled = false; let rejection: unknown; let removalAttempts = 0;
    const save = TourJobStore.prototype.save; const remove = TourJobStore.prototype.removeSession;
    try {
      queue.enqueue(request("active"), async (_j, signal) => { signal.addEventListener("abort", () => { aborted = true; }); await finish.promise; });
      queue.enqueue(request("waiting"), async () => { assert.fail("deleted waiting job must never start"); });
      const other = queue.enqueue({ ...request("other"), sessionId: "other-session" }, async () => {});
      await tick();
      TourJobStore.prototype.save = function (this: TourJobStore, job) {
        if (failure !== "job-remove" && job.phase === "cancelled") throw new Error("Fixture cancellation persistence failure");
        return save.call(this, job);
      };
      TourJobStore.prototype.removeSession = function (this: TourJobStore, sessionId) {
        removalAttempts++;
        if (failure !== "cancel-save") throw new Error("Fixture job-removal persistence failure");
        return remove.call(this, sessionId);
      };
      const deletion = queue.removeSession("test-session").then(() => { settled = true; }, error => { settled = true; rejection = error; });
      await tick();
      assert.equal(aborted, true, `${failure}: failed cancellation save cannot skip controller abort`);
      assert.equal(settled, false, `${failure}: even a rejected deletion must await actual cleanup`);
      assert.equal(removalAttempts, 0, `${failure}: job deletion cannot race the running task`);
      finish.resolve(); await deletion; await tick();
      assert.ok(rejection instanceof AggregateError, `${failure}: bounded caller-visible partial cleanup failure`);
      assert.equal(removalAttempts, 1, `${failure}: cancellation errors cannot skip job removal`);
      assert.deepEqual(queue.list("test-session"), [], `${failure}: stale memory rows cannot resurrect after errors`);
      assert.equal(queue.get("other-session", other.id)!.phase, "checking");
      assert.throws(() => queue.enqueue(request("late"), async () => {}), /chat was deleted/);
      TourJobStore.prototype.save = save; TourJobStore.prototype.removeSession = remove;
      await queue.removeSession("test-session");
      assert.equal(new TourJobStore(root).list().some(j => j.sessionId === "test-session"), false, "retry removes any files the failed disk operation left behind");
      assert.equal(queue.get("other-session", other.id)!.phase, "checking");
    } finally {
      TourJobStore.prototype.save = save; TourJobStore.prototype.removeSession = remove;
      finish.resolve(); await tick(); cleanup();
    }
  }
});

test("cancelSession waits for only that session's cleanup without deleting it or aborting another session", async () => {
  const { queue, cleanup } = setup({ limit: 2 }); const own = deferred(); const other = deferred(); let otherAborted = false; let cancelled = false;
  try {
    const a = queue.enqueue(request("own"), async () => { await own.promise; });
    const b = queue.enqueue({ ...request("other"), sessionId: "other-session" }, async (_j, signal) => { signal.addEventListener("abort", () => { otherAborted = true; }); await other.promise; });
    await tick();
    const idle = queue.cancelSession("test-session").then(() => { cancelled = true; });
    await tick(); assert.equal(cancelled, false); assert.equal(otherAborted, false);
    own.resolve(); await idle;
    assert.equal(cancelled, true); assert.equal(queue.get("test-session", a.id)!.phase, "cancelled");
    assert.equal(queue.get("other-session", b.id)!.phase, "dry-run", "waiting for one session does not await or abort unrelated work");
    const again = queue.enqueue(request("allowed-after-cancel"), async () => {}); await tick(); assert.equal(queue.get("test-session", again.id)!.phase, "checking", "cancellation is not transcript deletion");
    other.resolve(); await tick();
  } finally { own.resolve(); other.resolve(); await tick(); cleanup(); }
});

test("restart interrupts queued/running jobs without rerunning, keeps a finished capture awaiting its check, and keeps ready editions", async () => {
  const { queue, root, cleanup } = setup({ limit: 1 }); const running = deferred(); let runs = 0;
  try {
    const ready = queue.enqueue(request("ready"), async () => ({ phase: "ready", editionId: "checked-edition" })); await tick();
    const checking = queue.enqueue(request("checking"), async () => {}); await tick();
    const active = queue.enqueue(request("active"), async () => { runs++; await running.promise; });
    const waiting = queue.enqueue(request("waiting"), async () => { runs++; }); await tick();
    queue.close();
    const recovered = new TourJobQueue({ root, runner: async () => { runs++; } });
    try {
      await tick(); assert.equal(runs, 1);
      const edition = recovered.get("test-session", ready.id)!;
      assert.equal(edition.phase, "ready"); assert.equal(edition.editionId, "checked-edition");
      for (const j of [active, waiting]) { const interrupted = recovered.get("test-session", j.id)!; assert.equal(interrupted.phase, "interrupted"); assert.equal(interrupted.queuePosition, undefined); assert.equal(recovered.resume("test-session", j.id), null); }
      // A finished capture holds no browser: it still awaits its explicit check, and nothing reran it.
      assert.equal(recovered.get("test-session", checking.id)!.phase, "checking");
      assert.equal(recovered.resume("test-session", checking.id), null, "and nothing resumes it");
      assert.equal(recovered.list("test-session").length, 4);
      running.resolve(); await tick(); assert.equal(recovered.get("test-session", active.id)!.phase, "interrupted");
    } finally { recovered.close(); }
  } finally { running.resolve(); await tick(); cleanup(); }
});

// al_6 (operator (i)): a job waiting for a sign-in keeps its child and browser but frees its slot;
// parked browsers are capped at the concurrency limit; parked jobs count toward the waiting cap.
const signIn = { origin: "https://example.test", kind: "form" as const, fields: ["username", "password"] as ["username", "password"] };
const parking = (queue: TourJobQueue, answered: Map<string, ReturnType<typeof deferred>>, outcome: string[]): TourQueueTask => async (job, signal) => {
  const answer = deferred(); answered.set(job.tourId, answer);
  queue.park(job.id, signIn);
  signal.addEventListener("abort", () => answer.resolve(), { once: true });
  await answer.promise;
  if (signal.aborted) { outcome.push(`${job.tourId} aborted`); return; }
  queue.unpark(job.id, "dry-run"); outcome.push(`${job.tourId} done`);
};

test("a job waiting for a sign-in frees its slot: a second tour runs and finishes, and the answered job resumes at once", async () => {
  const { queue, cleanup } = setup({ limit: 1 }); const answered = new Map<string, ReturnType<typeof deferred>>(); const outcome: string[] = [];
  const gate = deferred(); let bStarted = false;
  try {
    const a = queue.enqueue(request("a"), parking(queue, answered, outcome));
    await tick();
    assert.equal(queue.get("test-session", a.id)!.phase, "needs-sign-in");
    assert.deepEqual(queue.get("test-session", a.id)!.requirements, { signIn });
    const b = queue.enqueue(request("b"), async () => { bStarted = true; await gate.promise; });
    await tick();
    assert.equal(bStarted, true, "the parked job's slot went to the next tour");
    // Answered while B holds the only slot: A continues at once, with no second wait.
    answered.get("a")!.resolve(); await tick();
    assert.deepEqual(outcome, ["a done"]);
    assert.equal(queue.get("test-session", a.id)!.phase, "checking");
    gate.resolve(); await tick();
    assert.equal(queue.get("test-session", b.id)!.phase, "checking");
  } finally { cleanup(); }
});

test("parked browsers are capped at the concurrency limit: past it the job fails naming the waiting ones", async () => {
  const { queue, cleanup } = setup({ limit: 1 }); const answered = new Map<string, ReturnType<typeof deferred>>(); const outcome: string[] = [];
  try {
    const a = queue.enqueue(request("a"), parking(queue, answered, outcome));
    await tick();
    const b = queue.enqueue(request("b"), parking(queue, answered, outcome));
    await tick();
    const failed = queue.get("test-session", b.id)!;
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.message, "Too many recordings are waiting for a sign-in (\u201cTour a\u201d). Answer or cancel one, then record again.");
    assert.equal(queue.get("test-session", a.id)!.phase, "needs-sign-in");
    answered.get("a")!.resolve(); await tick();
  } finally { cleanup(); }
  // Control: one fewer parked (a limit of 2) and the second job parks too.
  const two = setup({ limit: 2 }); const answered2 = new Map<string, ReturnType<typeof deferred>>();
  try {
    two.queue.enqueue(request("a"), parking(two.queue, answered2, [])); await tick();
    const b = two.queue.enqueue(request("b"), parking(two.queue, answered2, [])); await tick();
    assert.equal(two.queue.get("test-session", b.id)!.phase, "needs-sign-in");
    for (const d of answered2.values()) d.resolve(); await tick();
  } finally { two.cleanup(); }
});

test("parked jobs count toward the waiting cap, and a full queue names the job waiting for a sign-in", async () => {
  const { queue, cleanup } = setup({ limit: 1, maxWaiting: 2 }); const answered = new Map<string, ReturnType<typeof deferred>>(); const gate = deferred();
  try {
    queue.enqueue(request("a"), parking(queue, answered, [])); await tick();
    queue.enqueue(request("b"), async () => { await gate.promise; }); await tick();
    queue.enqueue(request("c"), async () => {}); await tick();
    assert.throws(() => queue.enqueue(request("d"), async () => {}), { message: "The recording queue is full while \u201cTour a\u201d waits for a sign-in. Answer or cancel it, then retry." });
    answered.get("a")!.resolve(); gate.resolve(); await tick();
  } finally { cleanup(); }
});

test("cancelling a job waiting for a sign-in aborts its runner; a restart interrupts it with no requirement kept", async () => {
  const { queue, root, cleanup } = setup({ limit: 1 }); const answered = new Map<string, ReturnType<typeof deferred>>(); const outcome: string[] = [];
  try {
    const a = queue.enqueue(request("a"), parking(queue, answered, outcome)); await tick();
    queue.cancel("test-session", a.id); await tick();
    assert.deepEqual(outcome, ["a aborted"]);
    assert.equal(queue.get("test-session", a.id)!.phase, "cancelled");
    assert.equal(queue.get("test-session", a.id)!.requirements, undefined);
    const b = queue.enqueue(request("b"), async job => { queue.park(job.id, signIn); await new Promise(() => {}); }); await tick();
    assert.equal(queue.get("test-session", b.id)!.phase, "needs-sign-in");
    const restarted = new TourJobQueue({ root, limit: 1 });
    const recovered = restarted.get("test-session", b.id)!;
    assert.equal(recovered.phase, "interrupted");
    assert.equal(recovered.requirements, undefined);
    restarted.close();
  } finally { cleanup(); }
});

test("a job failing while it waits for a sign-in is saved as failed, its sign-in request gone", async () => {
  const { queue, cleanup } = setup({ limit: 1 });
  try {
    const a = queue.enqueue(request("a"), async job => { queue.park(job.id, signIn); throw new TourJobFailure({ message: "The sign-in expired after an hour. Record again.", guidance: "Nothing was published." }); });
    await tick();
    const failed = queue.get("test-session", a.id)!;
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.message, "The sign-in expired after an hour. Record again.");
    assert.equal(failed.requirements, undefined);
  } finally { cleanup(); }
});
