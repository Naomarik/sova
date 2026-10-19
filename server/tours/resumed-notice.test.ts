// When the user answers a recording's sign-in or site approval (card or route) the job continues, and its chat,
// idle, gets one tagged notice to call status (§app.tours/sites): held while the chat is busy, dropped if the
// chat started working meanwhile or the job no longer continues from that answer; one per answer.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { TourScript } from "../../shared/tour";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { parseWakeNudge } from "../../shared/wake";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import { TourRuntime, type TourResumed, type TourRuntimeOptions } from "./runtime";
import { tourResumedNoticeText, tourResumedNotifier } from "./sign-in-notice";
import type { TourToolCaller } from "./tools";

const ORIGIN = "https://example.test";
const event: TourResumed = { sessionId: "s1", tourId: "tour-a", jobId: "job-a", title: "Find a saved draft", answered: "sign-in", origin: ORIGIN, at: "2026-10-17T00:00:00.000Z" };
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));
const deps = (state: { busy: boolean; continuing: boolean }, sent: { text: string; key: string }[]) => ({
  pathOf: async () => "/sessions/s1.jsonl",
  prompt: async (_p: string, text: string, key: string) => (sent.push({ text, key }), { ok: true }),
  busy: () => state.busy, busyOf: () => state.busy, stillContinuing: (jobId: string, at: string) => jobId === "job-a" && at === event.at && state.continuing, pollMs: 10,
});

test("the notice is tagged like the sign-in notice, names the tour and job, and says to call status", () => {
  const text = tourResumedNoticeText(3, event);
  assert.deepEqual(parseWakeNudge(text), { id: "t3", tour: true, reason: `The user signed in to ${ORIGIN} on the tour card.` });
  assert.match(text.split("\n")[0]!, /^\[tour_sign_in t3\] A tour recording continued after the user answered\.$/);
  assert.match(text, /Tour "Find a saved draft" \(tourId tour-a\), job job-a, continued\./);
  assert.match(text, /Call record_tour status with jobId job-a: it waits/);
  assert.equal(parseWakeNudge(tourResumedNoticeText(4, { ...event, answered: "site-approval", origin: undefined }))?.reason, "The user approved the recording's sites on the tour card.");
});

test("an idle chat gets one notice per answer at once", async () => {
  const sent: { text: string; key: string }[] = [];
  const notify = tourResumedNotifier(deps({ busy: false, continuing: true }, sent));
  notify(event);
  await settle();
  notify({ ...event, at: "2026-10-17T00:01:00.000Z" }); // a second answer (a code, say): stillContinuing is about the first only here
  await settle();
  assert.equal(sent.length, 1, "the second answer isn't continuing per the stub, so dropped");
  assert.match(sent[0]!.key, /^tour-resumed:job-a:1$/);
});

test("a chat busy at the answer gets no notice: it is already working and will call status itself", async () => {
  const sent: { text: string; key: string }[] = [];
  const s = { busy: true, continuing: true };
  const notify = tourResumedNotifier(deps(s, sent));
  notify(event);
  await settle();
  assert.equal(sent.length, 0, "never queued behind a turn");
  s.continuing = false; // the job came to rest (checking) while the chat was busy
  s.busy = false;
  await settle();
  assert.equal(sent.length, 0, "dropped, never sent once the turn ends");
  const sent2: { text: string; key: string }[] = [];
  const s2 = { busy: true, continuing: true };
  tourResumedNotifier(deps(s2, sent2))(event);
  await settle();
  s2.busy = false; // still running when the turn ends: still dropped
  await settle();
  assert.equal(sent2.length, 0);
});

test("a chat idle at the answer that starts working before the notice goes gets none", async () => {
  const sent: { text: string; key: string }[] = [];
  const s = { busy: false, continuing: true };
  let paths = 0;
  const notify = tourResumedNotifier({ ...deps(s, sent), pathOf: async () => { paths++; await settle(30); return "/sessions/s1.jsonl"; } });
  notify(event);
  s.busy = true; // the user wrote to the chat meanwhile
  await settle(80);
  s.busy = false;
  await settle();
  assert.equal(paths, 1);
  assert.equal(sent.length, 0);
});

const signed = (): TourScript => ({ ...tourScriptFixture(), signIn: { route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Saved drafts" } } });

test("the runtime tells once per card answer (sign-in and site approval), and a job that no longer continues is no longer continuing", async () => {
  const root = scratchRoot("tour-resumed-");
  const state = () => stateView([]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: root, state: state() };
  const resumed: TourResumed[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const runtime = new TourRuntime({ root, onResumed: e => resumed.push(e),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: ORIGIN, assertCurrent: async () => {} }) as never,
    run: async input => {
      await input.beforeContact(ORIGIN);
      if (input.script.signIn) await input.onSignIn!({ origin: ORIGIN, fields: ["username", "password"] });
      await gate;
      return { steps: [], assets: new Map(), contactSheets: [], suspicious: [], provenance: { origin: ORIGIN, recordedAt: "2026-01-02T03:04:05.000Z", publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script) };
    },
  } as TourRuntimeOptions);
  const phase = async (id: string, want: string) => { for (let i = 0; i < 400 && runtime.queue.get("chat-a", id)?.phase !== want; i++) await settle(5); assert.equal(runtime.queue.get("chat-a", id)?.phase, want); };
  try {
    // Site approval answered on the card: the job continues, one event.
    const dry = await runtime.dryRun(caller, signed(), "tour-demo");
    await phase(dry.job.id, "needs-site-approval");
    await runtime.approveAll(caller, dry.job.id, [ORIGIN]);
    assert.equal(resumed.length, 1);
    assert.deepEqual({ ...resumed[0]!, at: "" }, { sessionId: "chat-a", tourId: "tour-demo", jobId: dry.job.id, title: "Find a saved draft", answered: "site-approval", at: "" });
    // Then it waits for a sign-in: entering that wait means the approval's continuation is over.
    await phase(dry.job.id, "needs-sign-in");
    assert.equal(runtime.stillContinuing(dry.job.id, resumed[0]!.at), false);
    await runtime.signIn(caller, dry.job.id, { origin: ORIGIN, username: "made-up-user", password: "Made-Up-Pass-99" });
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1]!.answered, "sign-in"); assert.equal(resumed[1]!.origin, ORIGIN);
    assert.ok(!JSON.stringify(resumed).includes("made-up-user"), "no login value");
    assert.equal(runtime.stillContinuing(dry.job.id, resumed[1]!.at), true, "running on after the answer");
    assert.equal(runtime.stillContinuing(dry.job.id, resumed[0]!.at), false, "an older answer's notice is superseded");
    release();
    for (let i = 0; i < 400 && runtime.queue.get("chat-a", dry.job.id)?.phase !== "checking"; i++) await settle(5);
    assert.equal(runtime.queue.get("chat-a", dry.job.id)?.phase, "checking");
    assert.equal(runtime.stillContinuing(dry.job.id, resumed[1]!.at), false, "a job come to rest no longer continues");
  } finally { release(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
