// Run: pnpm test -- src/lib/automations-shelf.test.ts
// The Automations region (§app.session-list/automations): one sub-group per schedule with a session to
// show, its rows the schedule's sessions that exist and aren't archived, newest first.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduleInfo, SessionSummary } from "../../shared/protocol";
import { automationGroups, liveKey } from "./automations-shelf";

const session = (id: string, archived = false) => ({ id, path: `/s/${id}.jsonl`, cwd: "/p", title: id, ...(archived ? { archived: true } : {}) }) as SessionSummary;
const schedule = (over: Partial<ScheduleInfo>): ScheduleInfo => ({ id: "s1", root: "/p", projectName: "sova", playbook: "merge-round", title: "Merge round", when: "", state: "active", fires: [], ...over });

test("an automation's own session first, then its fires', archived and unknown ones left out", () => {
  const groups = automationGroups(
    [schedule({ automation: "merge-round", sessions: ["own", "old", "gone", "own"] }), schedule({ id: "s2", title: "Nightly", sessions: ["n1"], fires: [{ at: "", trigger: "daily 02:00", kind: "new" }] }), schedule({ id: "s3", sessions: [] })],
    [session("own"), session("old", true), session("n1")],
  );
  assert.deepEqual(
    groups.map((g) => [g.id, g.label, g.longRunning, g.rows.map((r) => r.id)]),
    [
      ["s1", "Merge round", true, ["own"]],
      ["s2", "Nightly", false, ["n1"]],
    ],
  );
});

test("a header schedule whose fires wake one session reads as long-running", () => {
  const [g] = automationGroups([schedule({ sessions: ["captain"], fires: [{ at: "", trigger: "every 6h", kind: "wake", sessionId: "captain" }] })], [session("captain")]);
  assert.equal(g!.longRunning, true);
});

test("it re-reads when the live sessions change, not on every poll", () => {
  assert.equal(liveKey([session("b"), session("a"), session("z", true)]), "a,b");
  assert.equal(liveKey([session("a"), session("b")]), liveKey([session("b"), session("a")]));
});
