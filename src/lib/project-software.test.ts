import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { approveLabel, approveWhat, failedLine, liveWord, memoryWord, playbookLabel, provenTail, runWord, serviceFacts, STANDING_CHIP } from "./project-software";

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
  const pb = { sessionId: "s1", startedBy: "operator" as const, startedAt: "" };
  assert.equal(runWord({ ...base, playbookState: "running", playbook: pb }), "The Project verbs playbook is running");
  assert.equal(runWord({ ...base, playbookState: "proposed", playbook: { ...pb, branch: "sova/v" } }), "The Project verbs playbook proposes a definition on sova/v");
  assert.equal(runWord({ ...base, playbook: { ...pb, result: "no-change" } }), "The last Project verbs run finished with no change");
});
