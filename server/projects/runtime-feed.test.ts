// The registry's feed lines for a verb playbook's run (§app.project-runtime/onboard): named by its title, a wait
// on the operator's answers said once, the resume after it silent. Pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeFeed, type FeedRow } from "./runtime-feed";

const row = (at: number, before: string[], after: string[], changed: Record<string, unknown> = {}): FeedRow => ({ at, event: "link/moved", before, after, changed });

test("a run that asks: started, waits on your answers, resumes silently, proposes; named by its playbook's title", () => {
  const rows = [
    row(1, ["idle"], ["running"], { playbook: [null, { label: "Project deploy", why: "first deploy" }] }),
    row(2, ["running"], ["waiting"], { "playbook.questions": [null, 2] }),
    row(3, ["waiting"], ["running"]),
    row(4, ["running"], ["proposed"], { "playbook.branch": [null, "sova/deploy-1a2b3c"] }),
  ];
  assert.deepEqual(
    runtimeFeed(rows).map((f) => f.line),
    [
      "The Project deploy playbook proposes a definition on sova/deploy-1a2b3c: approve it, then merge.",
      "The Project deploy playbook waits on your answers in its session.",
      "The Project deploy playbook was started: first deploy.",
    ],
  );
});

test("a run recorded without a title is the Project verbs playbook's", () => {
  assert.deepEqual(runtimeFeed([row(1, ["idle"], ["running"], { playbook: [null, {}] })]).map((f) => f.line), ["The Project verbs playbook was started."]);
});
