// A sign-in notice names its tour and job, is never queued behind a busy chat's turn, and is dropped once
// the wait it was about has ended (answered, cancelled, failed, finished) (§app.tours/sites).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { TourScript } from "../../shared/tour";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { parseWakeNudge } from "../../shared/wake";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import { TourRuntime, type TourNeedsYou, type TourRuntimeOptions } from "./runtime";
import { tourSignInNoticeText, tourSignInNotifier } from "./sign-in-notice";
import type { TourToolCaller } from "./tools";

const ORIGIN = "https://example.test";
const event = { sessionId: "s1", tourId: "tour-a", jobId: "job-a", origin: ORIGIN, fields: ["username", "password"], title: "Find a saved draft", since: "2026-10-17T00:00:00.000Z" };
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

test("the notice names its tour and job and says to check the job before acting", () => {
  const text = tourSignInNoticeText(5, event);
  assert.deepEqual(parseWakeNudge(text), { id: "t5", tour: true, reason: `Sign in to ${ORIGIN} on the tour card.` });
  assert.match(text, /Tour "Find a saved draft" \(tourId tour-a\), job job-a,/);
  assert.match(text, /record_tour status first, and act only if it still shows needs-sign-in/);
  assert.match(text, /vis_guide tour-signin/);
});

test("a busy chat's notice waits, never queued behind its turn, and is dropped when the wait ends first", async () => {
  const sent: string[] = [];
  let busy = true, waiting = true;
  const notify = tourSignInNotifier({ pathOf: async () => "/sessions/s1.jsonl", prompt: async (_p, text) => (sent.push(text), { ok: true }), busy: () => busy, stillWaiting: () => waiting, pollMs: 10 });
  notify(event);
  await settle();
  assert.equal(sent.length, 0, "nothing goes to a chat mid-turn");
  waiting = false; // the user signed in on the card (or the job was cancelled) during the turn
  await settle();
  busy = false;
  await settle();
  assert.equal(sent.length, 0, "a notice for an ended wait is never sent");
});

test("a busy chat gets the notice once it is idle, if the job still waits", async () => {
  const sent: string[] = [];
  let busy = true;
  const notify = tourSignInNotifier({ pathOf: async () => "/sessions/s1.jsonl", prompt: async (_p, text) => (sent.push(text), { ok: true }), busy: () => busy, stillWaiting: (jobId, since) => jobId === "job-a" && since === event.since, pollMs: 10 });
  notify(event);
  await settle();
  assert.equal(sent.length, 0);
  busy = false;
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /job job-a/);
});

const signed = (): TourScript => ({ ...tourScriptFixture(), signIn: { route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Saved drafts" } } });

test("the runtime's waiting sign-in carries its title and start, and stops counting once cancelled", async () => {
  const root = scratchRoot("tour-notice-");
  const state = () => stateView([]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: root, state: state() };
  const needsYou: TourNeedsYou[] = [];
  const runtime = new TourRuntime({ root, onNeedsYou: e => needsYou.push(e),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: ORIGIN, assertCurrent: async () => {} }) as never,
    run: async input => {
      await input.onSignIn!({ origin: ORIGIN, fields: ["username", "password"] });
      return { steps: [], assets: new Map(), contactSheets: [], suspicious: [], provenance: { origin: ORIGIN, recordedAt: "2026-01-02T03:04:05.000Z", publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script) };
    },
  } as TourRuntimeOptions);
  try {
    runtime.approvals.approve(ORIGIN);
    const dry = await runtime.dryRun(caller, signed(), "tour-demo");
    for (let i = 0; i < 200 && !needsYou.length; i++) await settle(5);
    assert.equal(needsYou.length, 1);
    const e = needsYou[0]!;
    assert.equal(e.title, "Find a saved draft");
    assert.ok(e.since && runtime.stillWaitingSignIn(dry.job.id, e.since), "waiting now");
    assert.equal(runtime.stillWaitingSignIn(dry.job.id, "2000-01-01T00:00:00.000Z"), false, "another wait's notice isn't this one's");
    await runtime.cancel(caller, dry.job.id);
    await settle(20);
    assert.equal(runtime.stillWaitingSignIn(dry.job.id, e.since), false, "a cancelled job no longer waits");
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
