// Run: npx tsx --test src/lib/releases.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReleaseHistoryItem, ReleaseRecord, ReleaseStep, ReleaseView } from "../../shared/release";
import {
  abandonConfirmLine,
  cardLine,
  countdown,
  previousRelease,
  progressLine,
  publishBlocked,
  publishConfirmLine,
  releaseAt,
  releaseOfTarget,
  shownRecord,
  setupLiveLine,
  setupRun,
  sinceLine,
  stepActions,
  visibleSteps,
  withdrawConfirmLine,
} from "./releases";

const step = (id: string, state: ReleaseStep["state"], phase: ReleaseStep["phase"] = "prepare"): ReleaseStep => ({ id, label: id, phase, state });
const record = (over: Partial<ReleaseRecord> = {}): ReleaseRecord =>
  ({
    id: "rl_abcdef",
    project: "/w/p",
    state: "preparing",
    version: "0.10.0",
    tag: "v0.10.0",
    channels: ["stable"],
    base: "b".repeat(40),
    commit: null,
    entry: null,
    thread: { session: "s1" },
    steps: [step("version", "done"), step("notes", "running"), step("commit", "waiting"), step("checks", "waiting", "sova"), step("publish", "waiting", "sova"), step("gh", "waiting", "after"), step("unlist", "waiting", "withdraw")],
    notes: null,
    artifacts: [],
    startedAt: "2026-11-03T10:00:00Z",
    startedBy: "operator",
    lastReportAt: null,
    manifest: { v: 1, steps: [] },
    settings: {} as ReleaseRecord["settings"],
    ...over,
  }) as ReleaseRecord;
const item = (tag: string, over: Partial<ReleaseHistoryItem> = {}): ReleaseHistoryItem => ({ tag, version: tag.slice(1), sha: `${tag}sha`.padEnd(40, "0"), date: "2026-10-26T00:00:00Z", notes: null, channels: [], deployedTo: [], ...over });

test("'N landings since vX' reads the view's count, and says nothing before the first release", () => {
  assert.equal(sinceLine({ latest: "v0.9.0", landingsSince: 479 }), "479 landings since v0.9.0");
  assert.equal(sinceLine({ latest: "v0.9.0", landingsSince: 1 }), "1 landing since v0.9.0");
  assert.equal(sinceLine({ latest: "v0.9.0", landingsSince: 0 }), "No landings since v0.9.0");
  assert.equal(sinceLine({ latest: null, landingsSince: null }), null);
});

test("the tab shows the open release, else the last one only while its after-publish or after-withdraw steps still have work", () => {
  const open = record();
  assert.equal(shownRecord({ open, last: null }), open);
  const finishing = record({ state: "published", steps: [step("publish", "done", "sova"), step("gh", "failed", "after")] });
  assert.equal(shownRecord({ open: null, last: finishing }), finishing);
  const settled = record({ state: "published", steps: [step("publish", "done", "sova"), step("gh", "done", "after"), step("unlist", "waiting", "withdraw")] });
  assert.equal(shownRecord({ open: null, last: settled }), null, "a withdraw step waiting on a published release is not work");
  const withdrawn = record({ state: "withdrawn", steps: [step("gh", "done", "after"), step("unlist", "running", "withdraw")] });
  assert.equal(shownRecord({ open: null, last: withdrawn }), withdrawn);
  assert.equal(shownRecord({ open: null, last: record({ state: "abandoned" }) }), null);
});

test("after-withdraw steps are listed only once a release is withdrawn, and the progress line counts what is listed", () => {
  const r = record();
  assert.deepEqual(visibleSteps(r).map((s) => s.id), ["version", "notes", "commit", "checks", "publish", "gh"]);
  assert.equal(progressLine(r), "Step 2 of 6 · notes · 1 done");
  assert.equal(progressLine(record({ steps: [step("a", "done"), step("b", "held")] })), "Step 2 of 2 · b, held for you · 1 done");
  assert.equal(progressLine(record({ steps: [step("a", "done"), step("b", "skipped")] })), "All 2 steps done");
  assert.equal(visibleSteps(record({ state: "withdrawn" })).length, 7);
});

test("Continue only on a held step and Retry Step only on a failed one, while the release can still act", () => {
  assert.deepEqual(stepActions({ state: "preparing" }, { state: "held", phase: "prepare" }), { continue: true, retry: false });
  assert.deepEqual(stepActions({ state: "checking" }, { state: "failed", phase: "sova" }), { continue: false, retry: true });
  assert.deepEqual(stepActions({ state: "published" }, { state: "failed", phase: "after" }), { continue: false, retry: true });
  assert.deepEqual(stepActions({ state: "published" }, { state: "failed", phase: "prepare" }), { continue: false, retry: false });
  assert.deepEqual(stepActions({ state: "abandoned" }, { state: "held", phase: "prepare" }), { continue: false, retry: false });
  assert.deepEqual(stepActions({ state: "withdrawn" }, { state: "failed", phase: "withdraw" }), { continue: false, retry: true });
});

test("Publish is offered only on a ready release; otherwise the gates' reasons say why", () => {
  assert.equal(publishBlocked({ gates: { checksPassed: true, stepsDone: true, notes: true, why: [] } }, { state: "ready" }), null);
  assert.equal(publishBlocked({ gates: { checksPassed: false, stepsDone: false, notes: true, why: ["the gating checks haven't passed yet.", "no release notes yet"] } }, { state: "checking" }), "Not ready to publish: the gating checks haven't passed yet; no release notes yet.");
  assert.equal(publishBlocked({ gates: null }, { state: "preparing" }), "Not ready to publish: steps before it aren't done yet.");
  assert.equal(publishBlocked({ gates: null }, { state: "publishing" }), "Publishing now.");
  assert.equal(publishBlocked({ gates: { checksPassed: true, stepsDone: true, notes: true, why: ["pushes are held until this project's private names are set up"] } }, { state: "ready" }), "Not ready to publish: pushes are held until this project's private names are set up.", "a gate's reason holds a ready release too");
});

test("the Publish confirm names what goes out: pushed to origin, or tagged on this machine only", () => {
  const r = record();
  const remote = publishConfirmLine(r, { remote: true, target: "master" });
  assert.match(remote, /^Publishing pushes master, v0\.10\.0, stable to origin in one step/);
  assert.match(remote, /never moved or deleted; Withdraw only moves stable back\.$/);
  const local = publishConfirmLine(r, { remote: false, target: "master" });
  assert.match(local, /^Publishing tags v0\.10\.0 on this machine and moves stable to it\. Nothing is pushed\./);
  assert.doesNotMatch(local, /origin/);
});

test("Withdraw moves each channel back to the newest release before it that isn't withdrawn; the tag stays", () => {
  const history = [item("v0.10.0", { channels: ["stable"] }), item("v0.9.1", { withdrawn: { at: "x", why: "bad" } }), item("v0.9.0")];
  assert.equal(previousRelease(history, "v0.10.0"), "v0.9.0");
  assert.equal(previousRelease(history, "v0.9.0"), null);
  const line = withdrawConfirmLine(history[0]!, "v0.9.0", true);
  assert.match(line, /^stable moves back to v0\.9\.0 on origin too\. v0\.10\.0 itself stays, marked withdrawn/);
  assert.match(line, /roll them back on the Deploy card\.$/);
  assert.match(withdrawConfirmLine(item("v0.8.0"), null, false), /^No channel points at it, so nothing moves\./);
});

test("Abandon says a landed release commit is reverted as a landing, never otherwise", () => {
  assert.doesNotMatch(abandonConfirmLine(record()), /reverted/);
  assert.match(abandonConfirmLine(record({ entry: "mq_1", commit: "c".repeat(40) })), /reverted as a landing on the target/);
});

test("a Deploy row's release: the history item that lists the target, else the one at its verified commit", () => {
  const history = [item("v0.10.0", { deployedTo: ["staging"] }), item("v0.9.0", { deployedTo: ["prod"] })];
  assert.equal(releaseOfTarget(history, "prod")?.tag, "v0.9.0");
  assert.equal(releaseOfTarget(history, "other"), null);
  assert.equal(releaseAt(history, history[1]!.sha)?.tag, "v0.9.0");
  assert.equal(releaseAt(history, history[1]!.sha.slice(0, 7))?.tag, "v0.9.0");
  assert.equal(releaseAt(history, null), null);
});

test("the power's waiting period counts down to the second and never runs negative", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  assert.equal(countdown("2026-11-03T10:04:32Z", now), "Publishes in 4:32");
  assert.equal(countdown("2026-11-03T11:05:09Z", now), "Publishes in 1:05:09");
  assert.equal(countdown("2026-11-03T09:00:00Z", now), "Publishing now");
});

test("the Overview card: the open release first, else the latest with its landings since, else not set up", () => {
  const base: Pick<ReleaseView, "initialized" | "latest" | "landingsSince" | "open"> = { initialized: true, latest: "v0.9.0", landingsSince: 479, open: null };
  assert.equal(cardLine(base), "Latest v0.9.0 · 479 landings since");
  assert.equal(cardLine({ ...base, landingsSince: 0 }), "Latest v0.9.0 · no landings since");
  assert.equal(cardLine({ ...base, open: record({ state: "checking" }) }), "v0.10.0 in progress", "the chip beside it says the state");
  assert.equal(cardLine({ ...base, latest: null, landingsSince: null }), "No release yet.");
  assert.equal(cardLine({ initialized: false, latest: null, landingsSince: null, open: null }), "Releases aren't set up for this project.");
});

test("a Set Up Releases run: live (running or waiting) with its chat, proposed with its branch; other playbooks' runs are none", () => {
  const pb = { sessionId: "s", playbookId: "release-maker", label: "Release maker", proposes: "release" as const, startedBy: "operator" as const, startedAt: "", path: "/s/m.jsonl", branch: "sova/release-setup", questions: 2 };
  assert.deepEqual(setupRun({ playbookState: "running", playbook: pb }), { kind: "live", waiting: false, path: "/s/m.jsonl", questions: 2 });
  const waiting = setupRun({ playbookState: "waiting", playbook: pb });
  assert.deepEqual(waiting, { kind: "live", waiting: true, path: "/s/m.jsonl", questions: 2 });
  assert.equal(setupLiveLine(waiting as Extract<typeof waiting, { kind: "live" }>), "Setup chat waiting on your answers · 2 questions");
  assert.equal(setupLiveLine({ kind: "live", waiting: false }), "Setup chat running");
  assert.deepEqual(setupRun({ playbookState: "proposed", playbook: pb }), { kind: "proposed", branch: "sova/release-setup", path: "/s/m.jsonl" });
  assert.equal(setupRun({ playbookState: "idle", playbook: pb }), null);
  assert.equal(setupRun({ playbookState: "running", playbook: { ...pb, proposes: "deploy" } }), null);
  assert.equal(setupRun(undefined), null);
});
