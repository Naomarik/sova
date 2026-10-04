import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { approveLabel, approveWhat, elapsedWord, failedLine, liveWord, memoryWord, openWord, playbookLabel, provenTail, reviewDefProblem, reviewProofWord, runStrip, runWord, serviceFacts, shareWord, STANDING_CHIP } from "./project-software";

const base: ProjectRuntimeView = {
  projectId: "prj_1",
  standing: "registered",
  playbookState: "idle",
  def: { state: "present", hash: "sha256:abcdef0123456789" },
  commit: "c1",
  suite: 2,
  services: [
    {
      name: "web",
      kind: "process",
      scope: "checkout",
      ports: [{ name: "http", port: 4000 }],
      requires: [],
      isolation: { method: "ports", why: "PORT is read" },
      live: [
        { instance: "i1", label: "main", state: "ready", rssBytes: 1 },
        { instance: "i2", label: "feat-x", state: "starting" },
      ],
      memory: { peakBytes: 1_400_000_000, steadyBytes: 512_000_000 },
    },
  ],
  orphans: [],
  data: [{ name: "db", kind: "dir", sensitive: true }],
  sources: ["bb.edn"],
  drift: null,
  approved: { hash: "sha256:abcdef0123456789", at: "2026-10-03T00:00:00.000Z" },
  proof: { hash: "sha256:abcdef0123456789", suite: 2, pass: true, confined: false, at: "2026-10-03T00:00:00.000Z" },
  confinedProof: null,
  registered: { hash: "sha256:abcdef0123456789", suite: 2, commit: "c1", at: "2026-10-03T00:00:00.000Z" },
  playbook: null,
  can: { approve: null, onboard: true },
  feed: [],
};

test("the standing's chip: a word and a tone for each, never hue alone", () => {
  assert.deepEqual(
    Object.values(STANDING_CHIP).map((c) => c.word),
    ["Unregistered", "Awaiting approval", "Checking", "Registered", "Out of date", "Failed"],
  );
});

test("a service's facts, where it runs and the memory measured", () => {
  const s = base.services[0]!;
  assert.equal(serviceFacts(s), "process · checkout · ports");
  assert.equal(liveWord(s), "main ready · feat-x starting");
  assert.equal(memoryWord(s.memory), "peak 1.4 GB · steady 512 MB");
  assert.equal(memoryWord({ peakBytes: null, steadyBytes: null }), null, "nothing read: no figure");
  assert.equal(liveWord({ ...s, live: [] }), null);
});

test("the proof line, the failure, and the actions", () => {
  assert.equal(provenTail(base), "at abcdef012345 (suite v2)");
  assert.equal(provenTail({ ...base, proof: { ...base.proof!, pass: false } }), null, "a failed proof proves nothing");
  assert.equal(failedLine(base), null);
  assert.equal(failedLine({ ...base, standing: "failed", proof: { ...base.proof!, pass: false, failed: { check: "ready", detail: "web never listened" } } }), "Failed at ready: web never listened");
  assert.equal(failedLine({ ...base, standing: "failed", def: { state: "invalid", error: "services.web.cmd is required" } }), "The definition on main is invalid: services.web.cmd is required");
  assert.equal(playbookLabel(base), "Run Again", "once registered");
  assert.equal(playbookLabel({ ...base, registered: null }), "Run Playbook");
  assert.equal(approveLabel(base), null, "nothing waits: no button");
  const waiting = { ...base, can: { approve: "sha256:feedface00112233", approveBranch: "sova/project-verbs", onboard: false } };
  assert.equal(approveLabel(waiting), "Approve feedface0011");
  assert.match(approveWhat(waiting)!, /proposes on sova\/project-verbs/);
});

test("the playbook's run in words", () => {
  assert.equal(runWord(base), null);
  const pb = { sessionId: "s1", playbookId: "project-verbs", label: "Project verbs", approves: "definition" as const, startedBy: "operator" as const, startedAt: "" };
  assert.equal(runWord({ ...base, playbookState: "running", playbook: pb }), "The Project verbs playbook is running");
  assert.equal(runWord({ ...base, playbookState: "proposed", playbook: { ...pb, branch: "sova/v" } }), "The Project verbs playbook proposes a definition on sova/v");
  assert.equal(runWord({ ...base, playbook: { ...pb, result: "no-change" } }), "The last Project verbs run finished with no change");
});

test("a live run's strip: working or idle, its now line, how long; waiting says its questions (§app.project-runtime/run-progress)", () => {
  const started = "2026-10-04T10:00:00.000Z";
  const t = Date.parse(started);
  const pb = { sessionId: "s1", playbookId: "project-verbs", label: "Project verbs", approves: "definition" as const, startedBy: "operator" as const, startedAt: started };
  assert.equal(runStrip({ ...base, playbook: pb }, t), null, "idle: no strip");
  assert.deepEqual(runStrip({ ...base, playbookState: "running", playbook: { ...pb, live: { working: true, now: "Conform run 3 of 6" } } }, t + 12 * 60_000), { state: "Working", now: "Conform run 3 of 6", questions: null, elapsed: "12 min" });
  assert.deepEqual(runStrip({ ...base, playbookState: "waiting", playbook: { ...pb, questions: 2, live: { working: false, questions: 2 } } }, t + 125 * 60_000), { state: "Waiting for your answers", now: null, questions: "2 open questions in its session", elapsed: "2 h 5 min" });
  assert.equal(runStrip({ ...base, playbookState: "running", playbook: { ...pb, live: { working: false } } }, t + 1000)!.state, "Idle");
  assert.equal(elapsedWord(30_000), "under 1 min");
  assert.equal(elapsedWord(120 * 60_000), "2 h");
});

test("a proposed run's review in words, from the branch's definition and its conformance (§app.project-runtime/run-report)", () => {
  const r = { def: { state: "present" as const, hash: "sha256:ab" }, services: [], data: [], share: null, open: null, proof: null };
  assert.equal(shareWord(r), "Shares nothing");
  assert.equal(shareWord({ ...r, share: { endpoints: ["web.http"], allow: false } }), "Never shared");
  assert.equal(shareWord({ ...r, share: { endpoints: ["web.http", "api.http"], allow: true } }), "Shares web.http, api.http");
  assert.equal(openWord(r), "No entry point");
  assert.equal(openWord({ ...r, open: { endpoint: "web.http", path: "/app" } }), "Opens at web.http/app");
  assert.equal(reviewProofWord(r), "No conformance of this definition yet");
  assert.equal(reviewProofWord({ ...r, proof: { hash: "sha256:ab", suite: 4, pass: true, confined: true, at: "" } }), "Conformance passed (confined, suite v4)");
  assert.equal(reviewProofWord({ ...r, proof: { hash: "sha256:ab", suite: 4, pass: false, confined: true, at: "", failed: { check: "ready", detail: "web never listened" } } }), "Conformance failed at ready: web never listened");
  assert.equal(reviewDefProblem(r), null);
  assert.equal(reviewDefProblem({ ...r, def: { state: "absent" } }), "Its branch has no .sova/project.json.");
  assert.equal(reviewDefProblem({ ...r, def: { state: "invalid", error: "$.services: required" } }), "The definition on its branch is invalid: $.services: required");
});
