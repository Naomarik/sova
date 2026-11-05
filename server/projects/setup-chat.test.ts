import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { proposalOf, setupContext, setupTitle, trialView } from "./setup-chat";
import { FOLDED_PLAYBOOKS, onboardRunMode, resolvePlaybookId, SETUP_MODE, SETUP_PLAYBOOK_ID } from "./onboard";
import { playbookRunMode } from "../project-coding-mode";
import type { ProjectCodingMode } from "../../shared/project-overseer";

describe("the Setup chat's first message", () => {
  const base = { name: "Rakiba", root: "/w/rakiba", target: "main", served: false, releaseSteps: [], history: [] };

  test("a project with nothing set up: the four headings, no drawing asked", () => {
    const t = setupContext({ ...base, definition: null });
    for (const h of ["## This project", "## Current setup", "## Earlier setup chats", "## The user's note"]) assert.ok(t.includes(h), h);
    assert.match(t, /Nothing is set up yet: main has no \.sova\/project\.json\./);
    assert.match(t, /not set up \(your proposal is merged with Merge Branch\)/);
    assert.doesNotMatch(t, /drawing/);
  });

  test("a project set up: its pipeline sections verbatim, its release steps, a drawing first; earlier chats newest first", () => {
    const t = setupContext({
      ...base,
      served: true,
      definition: { version: 1, merge: { checks: "none" }, release: { playbook: ".sova/playbooks/release" }, open: { endpoint: "web.http" } },
      releaseSteps: ["tag", "publish"],
      history: [
        { sessionId: "a", path: "/s/a.jsonl", startedAt: "1", endedAt: "2", why: "ended" },
        { sessionId: "b", path: "/s/b.jsonl", startedAt: "3", endedAt: "4", why: "fresh", branch: "setup/x" },
      ],
      why: "add a deploy to the VPS",
    });
    assert.match(t, /"checks": "none"/);
    assert.doesNotMatch(t, /"open"/, "only the pipeline sections");
    assert.match(t, /Release playbook steps \(\.sova\/playbooks\/release\): tag, publish/);
    assert.match(t, /Summarise this setup as a drawing/);
    assert.ok(t.indexOf("/s/b.jsonl") < t.indexOf("/s/a.jsonl"));
    assert.match(t, /closed by Start Fresh 4, branch setup\/x/);
    assert.match(t, /add a deploy to the VPS/);
  });

  test("Start Fresh with a proposal open carries on in its folder and branch", () => {
    const t = setupContext({ ...base, definition: null, carryOn: { branch: "setup/x", worktree: "/w/.worktrees/x", from: "/s/b.jsonl" } });
    assert.match(t, /## Carrying on/);
    assert.match(t, /\/w\/\.worktrees\/x\) on its branch setup\/x/);
  });

  test("a Setup chat starts normal with align and vis, spec off; the project's other runs keep the host's default", () => {
    const hostDefault: ProjectCodingMode = { mode: "normal", minorModes: ["spec", "memory"] };
    const run = (id: string) => playbookRunMode(onboardRunMode(id) ?? hostDefault);
    const setup = run(SETUP_PLAYBOOK_ID);
    assert.equal(setup.mode, "normal");
    assert.deepEqual([...setup.minorModes].sort(), ["align", "vis"], "align and vis, nothing else");
    assert.equal(setup.minorModes.includes("spec"), false);
    assert.ok(run("project-verbs").minorModes.includes("spec"), "another playbook run keeps spec");
    assert.ok(run("project-verbs").minorModes.includes("align"));
    // The Start Fresh carry-on chat switches to the same SETUP_MODE (runtime-routes.ts startChat).
    assert.deepEqual([...SETUP_MODE.minorModes].sort(), ["align", "vis"]);
    assert.equal(SETUP_MODE.mode, "normal");
  });

  test("its title, and the folded playbooks open it", () => {
    assert.equal(setupTitle("/w/rakibadesigns", "Rakiba"), "Setup · rakibadesigns");
    for (const id of FOLDED_PLAYBOOKS) assert.equal(resolvePlaybookId(id), SETUP_PLAYBOOK_ID);
    assert.equal(resolvePlaybookId("project-verbs"), "project-verbs");
  });
});

describe("the proposal the tab shows", () => {
  const commit = "c".repeat(40);
  const run: MergeRun = {
    id: "mr_t",
    entry: "trial",
    project: "p",
    branch: "setup/x",
    base: commit,
    commit,
    steps: [
      { id: "copy", kind: "copy", label: "Merge copy", result: "passed", ms: 5, log: "a" },
      { id: "check:unit", kind: "check", label: "Unit", result: "passed", ms: 1200, log: "b", source: "required" },
      { id: "check:e2e", kind: "check", label: "E2E", result: "failed", ms: 3000, log: "c", source: "release" },
    ],
    checks: [],
    verdict: "failed",
    startedAt: "s",
  };
  const trial: MergeTrial = { run: "mr_t", commit, branch: "setup/x", verdict: "failed", why: "E2E fails", by: { kind: "chat", session: "s1" }, startedAt: "s", endedAt: "e", notRun: [{ id: "bench", label: "Bench" }] };

  test("each check from the run's steps, unchanged release checks as not run", () => {
    const v = trialView(trial, run);
    assert.deepEqual(v.checks.map((c) => [c.name, c.kind, c.state]), [["Unit", "merge", "passed"], ["E2E", "release", "failed"], ["Bench", "release", "not-run"]]);
    assert.equal(v.pass, false);
    assert.equal(v.checks[0]!.step, "check:unit");
  });

  test("read from the run's review; Land waits on the gate's reason", () => {
    const view = {
      playbookState: "proposed",
      playbook: { sessionId: "s1", playbookId: "project-setup", label: "Project setup", proposes: "pipeline", startedBy: "operator", startedAt: "", branch: "setup/x", target: "main", commit, branchHash: "sha256:abc", review: { def: { state: "present", hash: "h" }, services: [], data: [], share: null, open: null, proof: null, merge: { checks: "none" } } },
    } as unknown as ProjectRuntimeView;
    const p = proposalOf(view, true, [trial], () => run, "This setup branch's trial at ccccccc did not pass (E2E fails): fix it and run a trial again.")!;
    assert.equal(p.hash, "sha256:abc");
    assert.deepEqual(p.merge, { checks: "none" });
    assert.equal(p.trial?.id, "mr_t");
    assert.deepEqual(p.land, { can: false, why: "This setup branch's trial at ccccccc did not pass (E2E fails): fix it and run a trial again." });
    assert.deepEqual(proposalOf(view, true, [], () => null, null)!.land, { can: true });
    assert.equal(proposalOf({ ...view, playbookState: "running" } as ProjectRuntimeView, true, [], () => null, null), null);
  });
});
