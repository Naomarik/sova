// In-place sign-in (§app.tours/recording), split from runner-signin.integration.test.ts for the runner's per-file
// time cap: an app that draws its sign-in form in place of any page, signed in up front, held sessions and the
// card before view 1. Mid-tour in-place sign-outs (N1–N5) are runner-signin-midtour. Same fixtures, same assertions.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type TourAttemptResult } from "./runner";
import { TourRuntime } from "./runtime";
import { stateView } from "../harness/state-view";
import type { TourJob } from "../../shared/tour";
import type { TourToolCaller } from "./tools";
import { PASS, USER, failed, record } from "./runner-signin.integration.fixture";
import { inPlace, inPlaceApp } from "./runner-signin-inplace.integration.fixture";

test("a form drawn in place of every signed-out page is signed in up front: one POST for both sizes, one capture per view and size, none of the sign-in", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp();
  try {
    const { result, asked, stored } = await record(inPlace(a.origin), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.deepEqual(asked, ["username+password"]);
    assert.equal(a.posts(), 1, "the phone size went on from the session the desktop size signed in");
    const r = result as TourAttemptResult;
    assert.equal(r.signedIn, true);
    assert.deepEqual([...r.assets.keys()].filter(f => f.startsWith("capture-")).sort(), ["capture-1-1-desktop.png", "capture-1-1-phone.png"], "views × sizes");
    assert.equal(a.docs(), 4, "per size: the sign-in route's load, then the view's own fresh load");
    // A session the tour holds: the up-front step sees the signed-in page and signs in no more.
    const again = await record(inPlace(a.origin), { storage: stored[0] });
    assert.equal(failed(again.result), "recorded");
    assert.deepEqual(again.asked, []);
    assert.equal(a.posts(), 1);
  } finally { a.close(); }
});

test("an up-front sign-in page showing neither the signed-in control nor the password box stops, typing nothing", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp({ blank: true });
  try {
    const { result, asked } = await record(inPlace(a.origin));
    assert.match(failed(result), /showed neither its signed-in control nor its password box/);
    assert.deepEqual(asked, []);
    assert.equal(a.posts(), 0);
  } finally { a.close(); }
});

test("one sign-in POST per tour across its dry run and recording; it waits on the card before view 1 when it holds no login", { timeout: 240_000 }, async () => {
  const a = await inPlaceApp();
  const root = mkdtempSync(join(tmpdir(), "tour-upfront-"));
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-up", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  const runtime = new TourRuntime({ root: join(root, "state"),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: a.origin, assertCurrent: async () => {} }),
  });
  const phase = async (id: string, wanted: (j: TourJob) => boolean) => {
    for (let i = 0; i < 2400; i++) { const j = runtime.queue.get(caller.sessionId, id)!; if (wanted(j)) return j; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`job stayed ${runtime.queue.get(caller.sessionId, id)?.phase}`);
  };
  try {
    runtime.approvals.approve(a.origin);
    const dry = await runtime.dryRun(caller, inPlace(a.origin), "tour-up");
    const parked = await phase(dry.job.id, j => j.phase === "needs-sign-in");
    assert.equal(parked.completed, 0); assert.equal(parked.stepId, undefined, "parked before view 1");
    await runtime.signIn(caller, dry.job.id, { origin: a.origin, username: USER, password: PASS });
    await phase(dry.job.id, j => j.phase === "checking" || j.phase === "failed");
    const rec = await runtime.record(caller, dry.job.id);
    assert.equal((await phase(rec.job.id, j => j.phase === "checking" || j.phase === "failed")).phase, "checking");
    assert.equal(a.posts(), 1, "dry run and recording, both sizes: one sign-in");
    // Control: the tour's session cleared between dry run and recording (its login kept) signs in once more.
    const dry2 = await runtime.dryRun(caller, inPlace(a.origin), "tour-up2", { [a.origin]: { username: USER, password: PASS } });
    await phase(dry2.job.id, j => j.phase === "checking" || j.phase === "failed");
    assert.equal(a.posts(), 2);
    runtime.signIns.clear(caller.sessionId, "tour-up2");
    runtime.signIns.setCredentials(caller.sessionId, "tour-up2", { [a.origin]: { username: USER, password: PASS } });
    const rec2 = await runtime.record(caller, dry2.job.id);
    assert.equal((await phase(rec2.job.id, j => j.phase === "checking" || j.phase === "failed")).phase, "checking");
    assert.equal(a.posts(), 3, "a cleared session costs exactly one more sign-in");
  } finally { runtime.close(); a.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a sign-in route that shows neither once signed in: a size holding the tour's session goes on; a held session the site ended stops at the first view", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ lostWhenSignedIn: true });
  try {
    // First attempt: no session held, so the form shows up front; one sign-in, and the phone size goes on from it.
    const first = await record(inPlace(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.deepEqual(first.asked, ["username+password"]);
    assert.equal(a.posts(), 1, "the phone size went on from the held session without signing in again");
    assert.equal((first.result as TourAttemptResult).signedIn, true);
    // (a) A held session the site still honours: the route shows neither, the views are signed in: 0 POSTs.
    const held = await record(inPlace(a.origin), { storage: first.stored[0] });
    assert.equal(failed(held.result), "recorded");
    assert.deepEqual(held.asked, []);
    assert.equal(a.posts(), 1);
    // (b) The site ends that session: the route still shows neither (the page's own token), and the desktop
    // size's first view draws the form in place: stop, typing nothing.
    a.expire();
    const stale = await record(inPlace(a.origin), { storage: first.stored[0] });
    assert.match(failed(stale.result), /The tour's held sign-in no longer works, so recording stopped\. Record again to sign in\./);
    const where = (stale.result as { failure?: { size?: string; viewId?: string } }).failure;
    assert.deepEqual([where?.size, where?.viewId], ["desktop", "view-1"]);
    assert.deepEqual(stale.asked, []);
    assert.equal(a.posts(), 1, "nothing typed or sent");
    // Recording again with no held session (the server forgot it) signs in fresh up front: one more POST.
    const fresh = await record(inPlace(a.origin));
    assert.equal(failed(fresh.result), "recorded");
    assert.equal(a.posts(), 2);
  } finally { a.close(); }
});
