import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLine, durationWords, landState, notSetUpWords, setupButtonLabel, trialChip, trialLine, trialStale, type SetupProposal, type SetupTrialCheck } from "./setup-chat";

const HEAD = "a1b2c3d4e5f6a7b8c9d0";
const OLD = "0f9e8d7c6b5a49382716";
const check = (state: SetupTrialCheck["state"], name = "Unit tests"): SetupTrialCheck => ({ name, kind: "merge", state, durationMs: 48_000, run: "mr_1" });
const proposal = (o: Partial<SetupProposal> = {}): SetupProposal => ({
  branch: "sova/setup",
  target: "main",
  commit: HEAD,
  served: true,
  services: [],
  merge: { checks: [{ name: "Unit tests", command: "pnpm test" }] },
  trial: { run: "mr_1", commit: HEAD, at: "2026-11-05T00:00:00Z", pass: true, checks: [check("passed")] },
  ...o,
});

test("the button: Set Up with a Chat until set up, then Change Setup", () => {
  assert.equal(setupButtonLabel(false), "Set Up with a Chat");
  assert.equal(setupButtonLabel(true), "Change Setup");
});

test("not set up: each surface says what the part does and names the target", () => {
  const mq = notSetUpWords("merge-queue", "trunk");
  assert.equal(mq.title, "No merge queue settings are set up for this project");
  assert.match(mq.body, /merged onto trunk in a separate copy/);
  assert.match(mq.body, /branches land here only through the queue/);
  assert.deepEqual(notSetUpWords("settings", "trunk"), mq, "Settings says the tab's words");
  assert.equal(notSetUpWords("releases", "main").title, "Releases aren't set up for this project");
  assert.equal(notSetUpWords("deploy", "main").title, "Main declares no deploy yet.");
  for (const s of ["merge-queue", "releases", "deploy"] as const) assert.doesNotMatch(notSetUpWords(s, "main").body, /!/, "no exclamation marks");
});

test("the chat's chip: questions counted, working live, idle says nothing", () => {
  const c = { sessionId: "s", title: "Setup · demo", startedAt: "", proposal: null };
  assert.deepEqual(chatLine({ ...c, state: "waiting", questions: 1 }), { word: "1 question for you", tone: "warn" });
  assert.deepEqual(chatLine({ ...c, state: "waiting", questions: 3 }), { word: "3 questions for you", tone: "warn" });
  assert.deepEqual(chatLine({ ...c, state: "working" }), { word: "Working", tone: "accent", live: true });
  assert.equal(chatLine({ ...c, state: "idle" }), null);
  assert.equal(chatLine(null), null);
});

test("a trial check's chip says the word, never hue alone", () => {
  assert.equal(trialChip(check("passed")).word, "Passed");
  assert.equal(trialChip(check("failed")).word, "Failed");
  assert.equal(trialChip(check("running")).live, true);
  assert.equal(trialChip(check("skipped")).word, "Not run (unchanged)");
});

test("durations: seconds, then minutes and seconds", () => {
  assert.equal(durationWords(48_000), "48s");
  assert.equal(durationWords(192_000), "3m 12s");
  assert.equal(durationWords(120_000), "2m");
  assert.equal(durationWords(undefined), null);
});

test("the trial line names the commit it tried", () => {
  assert.equal(trialLine(proposal()), "Trial of a1b2c3d: passed");
  assert.equal(trialLine(proposal({ trial: { run: "r", commit: HEAD, at: "", pass: false, checks: [check("failed")] } })), "Trial of a1b2c3d: failed");
  assert.equal(trialLine(proposal({ trial: { run: "r", commit: HEAD, at: "", pass: false, checks: [check("running")] } })), "Trial of a1b2c3d: running");
  assert.equal(trialLine(proposal({ trial: null })), null);
  assert.equal(trialStale(proposal({ trial: { run: "r", commit: OLD, at: "", pass: true, checks: [] } })), true);
});

test("Land and Merge Branch only once a trial of the exact head passed; else Run Trial says why", () => {
  assert.deepEqual(landState(proposal()), { action: "land", can: true });
  assert.deepEqual(landState(proposal({ served: false })), { action: "merge", can: true });
  const why = "Run a trial of a1b2c3d first: it lands only once its own checks pass.";
  assert.deepEqual(landState(proposal({ trial: null })), { action: "trial", can: true, why });
  assert.deepEqual(landState(proposal({ served: false, trial: null })), { action: "trial", can: true, why }, "Merge Branch is gated too");
  // A passing trial of an older commit doesn't count for the head.
  assert.equal(landState(proposal({ trial: { run: "r", commit: OLD, at: "", pass: true, checks: [check("passed")] } })).action, "trial");
  assert.equal(landState(proposal({ trial: { run: "r", commit: HEAD, at: "", pass: false, checks: [check("failed")] } })).action, "trial");
  assert.deepEqual(landState(proposal({ trial: { run: "r", commit: HEAD, at: "", pass: false, checks: [check("running")] } })), { action: "wait", can: false, why: "Trial of a1b2c3d: running" });
  // The host's own refusal stands after a passing trial; a definition that doesn't read refuses before it.
  assert.deepEqual(landState(proposal({ land: { can: false, why: "It conflicts with main." } })), { action: "land", can: false, why: "It conflicts with main." });
  assert.equal(landState(proposal({ problem: "merge.checks[0] has no command." })).can, false);
});
