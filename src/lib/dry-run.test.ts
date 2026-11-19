import assert from "node:assert/strict";
import { test } from "node:test";
import { dryRunActions, dryRunChip, dryRunLine, failureLine, explainerWords, landFirstLine, nth, olderNote, scopeWords, stoppedBy, testsWords, trialChip, whoStarted, type BranchDryRun, type BranchFailure } from "./dry-run";

const HEAD = "a1b2c3d4e5f6a7b8c9d0";
const OLD = "0f9e8d7c6b5a49382716";
const WHY = "adds the merge check Playbook tests";
const dr = (state: BranchDryRun["state"], o: Partial<BranchDryRun> = {}): BranchDryRun => ({ commit: HEAD, state, why: WHY, ...o });
const failure = (whose: BranchFailure["whose"], o: Partial<BranchFailure> = {}): BranchFailure => ({
  kind: "dry-run",
  run: "mr_1",
  commit: HEAD,
  whose,
  line: "",
  checks: [{ id: "playbook", label: "Playbook tests", step: "check:playbook", whose: whose === "machine" ? "unclear" : whose, tests: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] }],
  ...o,
});

test("every state's line says why it is needed while one is needed, waits or runs, and never 'trial'", () => {
  const states: BranchDryRun["state"][] = ["needed", "waiting", "running", "passed", "failed", "stopped", "machine"];
  for (const s of states) {
    const line = dryRunLine(dr(s, { progress: { at: 2, of: 3 }, failure: failure("branch"), run: "mr_1" }), "master").text;
    assert.doesNotMatch(line, /trial/i, s);
    assert.doesNotMatch(dryRunChip(dr(s)).label, /trial/i, s);
    if (s === "needed" || s === "waiting" || s === "running") assert.match(line, new RegExp(`: ${WHY}$`), s);
  }
  assert.equal(dryRunLine(dr("needed"), "master").text, `Needs a dry run: ${WHY}`);
  assert.equal(dryRunLine(dr("running", { progress: { at: 2, of: 3 } }), "master").text, `Dry run running · check 2 of 3: ${WHY}`);
  assert.equal(dryRunLine(dr("passed"), "master").text, "Dry run passed at a1b2c3d");
  assert.equal(dryRunLine(dr("waiting", { after: "the landing of feat/x", position: 2 }), "master").text, `Dry run waiting · 2nd · starts after the landing of feat/x: ${WHY}`);
});

test("a Land that stands reads Approved · dry run first, with its stand line, until the dry run ends", () => {
  for (const s of ["needed", "waiting"] as const) assert.equal(dryRunChip(dr(s, { land: "e1" })).label, "Approved · dry run first");
  assert.equal(dryRunLine(dr("running", { land: "e1" }), "master").stand, "Your Land stands: it lands by itself once its dry run passes.");
  assert.equal(dryRunLine(dr("passed", { land: "e1" }), "master").stand, undefined);
});

test("a stop is said as a stop, by whom, never as something to fix", () => {
  const chat = (s: string) => (s === "s1" ? "Playbooks chat" : undefined);
  for (const by of ["operator", "chat", "restart", "superseded"] as const) {
    const line = dryRunLine(dr("stopped", { stopped: { by, session: "s1", at: "x" } }), "master", chat).text;
    assert.match(line, /Run it again\.$/, by);
    assert.doesNotMatch(line, /fix/i, by);
  }
  assert.equal(stoppedBy({ by: "chat", session: "s1", at: "x" }, chat), "by Playbooks chat");
  assert.equal(stoppedBy({ by: "restart", at: "x" }), "by a Sova restart");
  const machine = dryRunLine(dr("machine"), "master").text;
  assert.match(machine, /^Dry run couldn't run: .+ That's the machine, not this branch: run it again\.$/);
  assert.doesNotMatch(machine, /fix/i);
});

test("a failure master shares never says fix it, and names whose it is", () => {
  const m = failureLine(failure("master"), "master");
  assert.match(m, /Fails on master too: not this branch's\.$/);
  assert.doesNotMatch(m, /fix/i);
  assert.match(failureLine(failure("branch"), "master"), /^Playbook tests fails at a1b2c3d: 4 failing tests \(a, b, c \+1 more\)\. This branch's change breaks it\.$/);
  assert.match(failureLine(failure("unclear"), "main"), /Can't tell whose failure: it fails on main alone too\.$/);
  // The server's own line wins when it already says whose it is.
  assert.equal(failureLine(failure("master", { line: "Playbook tests fails on master too: not this branch's" }), "master"), "Playbook tests fails on master too: not this branch's.");
  assert.equal(testsWords([{ file: "x.test.ts" }]), "1 failing test (x.test.ts)");
});

test("an older commit's dry run is a note, never the state", () => {
  const d = dr("needed", { older: { commit: OLD, verdict: "failed" } });
  assert.equal(dryRunChip(d).label, "Needs a dry run");
  const l = dryRunLine(d, "master");
  assert.equal(l.text, `Needs a dry run: ${WHY}`);
  assert.equal(l.older, "Dry run failed at 0f9e8d7, an older commit.");
  assert.equal(olderNote({ commit: OLD, verdict: "passed" }), "Dry run passed at 0f9e8d7, an older commit.");
  // The same commit is no older one.
  assert.equal(dryRunLine(dr("needed", { older: { commit: HEAD, verdict: "void" } }), "master").older, undefined);
});

test("the row's buttons by state: Land with Run, Stop while it runs or waits, Fix on a failure", () => {
  assert.deepEqual(dryRunActions(dr("needed")), { primary: "land", run: "run", menu: [] });
  assert.deepEqual(dryRunActions(dr("needed", { run: "mr_0" })), { primary: "land", run: "again", menu: [] });
  assert.deepEqual(dryRunActions(dr("stopped", { run: "mr_1" })), { primary: "land", run: "again", menu: [] });
  assert.deepEqual(dryRunActions(dr("machine", { run: "mr_1" })), { primary: "land", run: "again", menu: [] });
  assert.deepEqual(dryRunActions(dr("running", { run: "mr_1" })), { primary: "land", stop: true, menu: [] });
  assert.deepEqual(dryRunActions(dr("waiting")), { primary: "land", stop: true, menu: [] });
  assert.deepEqual(dryRunActions(dr("passed", { run: "mr_1" })), { primary: "land", menu: [] });
  assert.deepEqual(dryRunActions(dr("failed", { run: "mr_1", failure: failure("branch") })), { primary: "fix", menu: ["fix-new-chat", "again", "land"] });
  // Master shares it: Run Dry Run Again stays a button; Land Anyway only where a Land stands on it.
  assert.deepEqual(dryRunActions(dr("failed", { run: "mr_1", failure: failure("master") })), { primary: "fix", run: "again", menu: ["fix-new-chat", "land"] });
  assert.deepEqual(dryRunActions(dr("failed", { run: "mr_1", land: "e1", failure: failure("master") }), false), { primary: "fix", run: "again", menu: ["fix-new-chat", "land-anyway"] });
});

test("the Dry runs tab's chip reads each verdict in dry-run words", () => {
  assert.equal(trialChip({ verdict: "void" }).label, "Dry run stopped");
  assert.equal(trialChip({ verdict: "machine" }).label, "Dry run couldn't run");
  assert.equal(trialChip({ verdict: "failed", failure: failure("unclear") }).label, "Can't tell whose failure");
  assert.equal(trialChip({ verdict: "running" }).live, true);
});

test("small words", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(nth), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  assert.equal(whoStarted({ kind: "operator" }), "you");
  assert.equal(whoStarted({ kind: "land", entry: "e1" }), "your Land");
  assert.equal(whoStarted({ kind: "chat", session: "s1" }, () => "Playbooks"), "Playbooks");
  assert.equal(whoStarted({ kind: "chat" }), "its chat");
  assert.equal(scopeWords({ ran: [{ id: "a", label: "A" }, { id: "b", label: "B" }], skipped: Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, label: `${i}` })) }), "Runs 2 of 9 checks: the ones this branch adds or changes.");
  assert.equal(scopeWords({ ran: [], skipped: [{ id: "a", label: "A" }] }), "Runs the setup steps only: it changes no check.");
  assert.equal(landFirstLine(HEAD, `${WHY}.`), `A dry run of a1b2c3d runs first: ${WHY}. Once it passes, it lands by itself.`);
  const e = explainerWords("master");
  assert.equal(e.parts.length, 3);
  assert.doesNotMatch(JSON.stringify(e), /trial/i);
  assert.match(e.parts[0]!.body, /master's checks/);
});

test("a worktree row whose Land runs its dry run first reads Approved · dry run first, then Dry run running", async () => {
  const { queueRow } = await import("./merge-queue");
  const base = { status: "active" as const, exists: true, branch: "feat/play", readiness: undefined, mergeServed: true as const };
  const waiting = queueRow({ ...base, queue: { state: "queued", commit: HEAD, position: 2, standing: { phase: "dry-run" } } });
  assert.equal(waiting.key, "queued");
  assert.equal(waiting.label, "Approved · dry run first · 2nd");
  const running = queueRow({ ...base, queue: { state: "queued", commit: HEAD, position: 1, standing: { phase: "dry-run", run: "mr_1" } } });
  assert.equal(running.key, "checking");
  assert.equal(running.label, "Dry run running");
  assert.equal(running.remove, true);
});
