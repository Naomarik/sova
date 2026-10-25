// al_11 a10 (§app.tours/recording): a login that worked but whose signIn.signedIn never shows on the page the
// app lands on (a "Sign out" button only one page shows, an English heading in an app that switches to Arabic
// after sign-in) is not "wrong details": it stops with its own failure, lists the landed page's controls, and
// the tour keeps the login. A login the site really refuses still fails as wrong details and is forgotten.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTourAttempt } from "./runner";
import { TourRuntime } from "./runtime";
import { stateView } from "../harness/state-view";
import type { TourJob } from "../../shared/tour";
import type { TourToolCaller } from "./tools";
import { TOUR_SIGN_IN_WRONG } from "./runner-protocol";
import { PASS, USER, failed, record, script, site } from "./runner-signin.integration.fixture";

const LANDED = "Signed in, but the signed-in control (signIn.signedIn) never showed, so recording stopped.";

async function withRuntime(origin: string, fn: (runtime: TourRuntime, caller: TourToolCaller, phase: (id: string, wanted: (j: TourJob) => boolean) => Promise<TourJob>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "tour-landed-"));
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-landed", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  const runtime = new TourRuntime({ root: join(root, "state"),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin, assertCurrent: async () => {} }),
    run: options => runTourAttempt(options),
  });
  const phase = async (id: string, wanted: (j: TourJob) => boolean) => {
    for (let i = 0; i < 1600; i++) { const j = runtime.queue.get(caller.sessionId, id)!; if (wanted(j)) return j; await new Promise(r => setTimeout(r, 50)); }
    const j = runtime.queue.get(caller.sessionId, id); throw new Error(`job stayed ${j?.phase}: ${JSON.stringify(j?.failure ?? null)}`);
  };
  try { runtime.approvals.approve(origin); await fn(runtime, caller, phase); }
  finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
}
const rests = (j: TourJob) => ["failed", "checking", "needs-sign-in"].includes(j.phase);

test("a good login whose signedIn never shows after sign-in: its own failure with the landed page's controls, and the tour keeps the login", { timeout: 150_000 }, async () => {
  const s = await site();
  try {
    await withRuntime(s.origin, async (runtime, caller, phase) => {
      // The app lands on /account; the script's signedIn is a "Sign out" button that page doesn't show.
      const sc = script(s.origin, ["/account"]);
      sc.signIn!.signedIn = { kind: "role", role: "button", name: "Sign out" };
      const first = await runtime.dryRun(caller, sc, "tour-landed");
      await phase(first.job.id, j => j.phase === "needs-sign-in");
      await runtime.signIn(caller, first.job.id, { origin: s.origin, username: USER, password: PASS });
      const failed = await phase(first.job.id, j => j.phase === "failed" || j.phase === "checking");
      assert.equal(failed.phase, "failed");
      assert.notEqual(failed.failure?.message, TOUR_SIGN_IN_WRONG, "a login that worked is never reported as wrong details");
      assert.equal(failed.failure?.message, LANDED);
      assert.match(failed.failure?.guidance ?? "", /every signed-in page shows/);
      assert.match(failed.failure?.guidance ?? "", /language/);
      assert.ok(failed.failure?.nearby?.some(n => JSON.stringify(n.target) === JSON.stringify({ kind: "role", role: "heading", name: "Your account" })), `nearby lists the landed page: ${JSON.stringify(failed.failure?.nearby)}`);
      assert.equal(s.hits("POST /login"), 1);
      // The login is kept: the next attempt of the tour signs in with it, no card.
      const again = await runtime.dryRun(caller, sc, "tour-landed");
      const second = await phase(again.job.id, rests);
      assert.equal(second.phase, "failed", "never waits on the card again: the tour kept the login");
      assert.equal(second.failure?.message, LANDED);
      assert.equal(s.hits("POST /login"), 2);
    });
  } finally { s.close(); }
});

test("a login the site refuses (still on the sign-in form) stays wrong details, and the tour forgets it", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    await withRuntime(s.origin, async (runtime, caller, phase) => {
      const sc = script(s.origin, ["/account"]);
      sc.signIn!.signedIn = { kind: "role", role: "button", name: "Sign out" };
      const first = await runtime.dryRun(caller, sc, "tour-wrong");
      await phase(first.job.id, j => j.phase === "needs-sign-in");
      await runtime.signIn(caller, first.job.id, { origin: s.origin, username: USER, password: "fake-pw-08" });
      const failed = await phase(first.job.id, j => j.phase === "failed" || j.phase === "checking");
      assert.equal(failed.failure?.message, TOUR_SIGN_IN_WRONG);
      assert.equal(s.hits("POST /login"), 1);
      const again = await runtime.dryRun(caller, sc, "tour-wrong");
      assert.equal((await phase(again.job.id, rests)).phase, "needs-sign-in", "the wrong login was forgotten: the card asks again");
      assert.equal(s.hits("POST /login"), 1);
    });
  } finally { s.close(); }
});

test("a stored script whose page view is the sign-in page stops by name before loading it: no sign-in loop", { timeout: 120_000 }, async () => {
  // A bare sign-in page that shows its form even signed in: loading it as a view would sign in again and again.
  const s = await site({ formWhenSignedIn: true });
  try {
    // The script check refuses this view now; a script stored before that still reaches the recorder.
    const { result } = await record(script(s.origin, ["/account", "/login"]));
    assert.match(failed(result), /^steps\[0\] "account" › views\[1\] "view-2" is the sign-in page; it is never pictured\./);
    assert.doesNotMatch(failed(result), /signed the recorder out again/);
    assert.equal(s.hits("POST /login"), 1, "the up-front sign-in only");
  } finally { s.close(); }
});
