// Safe Transport (§app.transport/safe-transport): who is told to wrap up, the wait and its progress,
// and Interrupt and Move, against fake helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bringHelpersToRest, COORDINATOR_WRAP_UP, HELPER_WRAP_UP, type HelperView, interruptWaiting, type SafeDeps, wrapUpTargets } from "./safe-transport";

const h = (workerId: string, working: boolean, team?: { teamId: string; duty?: "coordinator" | "monitor" }): HelperView => ({ workerId, chatId: `c-${workerId}`, name: workerId, working, ...team });

test("wrap-up targets: the coordinator of each team with work going on, each working helper with no coordinator; idle teams left alone", () => {
  const helpers = [
    h("ag_01", false, { teamId: "team_01", duty: "coordinator" }),
    h("ag_02", true, { teamId: "team_01" }),
    h("ag_03", true, { teamId: "team_01" }),
    h("ag_04", true, { teamId: "team_02" }), // a team with no coordinator
    h("ag_05", true), // a solo helper
    h("ag_06", false, { teamId: "team_03", duty: "coordinator" }),
    h("ag_07", false, { teamId: "team_03" }), // an idle team
  ];
  assert.deepEqual(
    wrapUpTargets(helpers).map((t) => [t.helper.workerId, t.text]),
    [
      ["ag_01", COORDINATOR_WRAP_UP],
      ["ag_04", HELPER_WRAP_UP],
      ["ag_05", HELPER_WRAP_UP],
    ],
  );
  assert.deepEqual(wrapUpTargets([h("ag_01", false)]), []);
});

/** Helpers that go idle `after` polls once told (or aborted). */
function fake(helpers: HelperView[], after = 1) {
  const told: string[] = [];
  const aborted: string[] = [];
  const left = new Map<string, number>();
  const deps: SafeDeps = {
    helpers: async () => {
      for (const x of helpers) {
        const n = left.get(x.chatId);
        if (n !== undefined && x.working) {
          if (n <= 0) x.working = false;
          else left.set(x.chatId, n - 1);
        }
      }
      return helpers.map((x) => ({ ...x }));
    },
    tell: async (chatId) => {
      told.push(chatId);
      // A coordinator's word reaches its team.
      const c = helpers.find((x) => x.chatId === chatId)!;
      for (const x of helpers) if (x === c || (c.duty === "coordinator" && x.teamId === c.teamId)) left.set(x.chatId, after);
    },
    abort: async (chatId) => {
      aborted.push(chatId);
      left.set(chatId, 0);
    },
    sleep: async () => undefined,
  };
  return { deps, told, aborted };
}

test("Safe Transport tells them, waits until none works, reports progress, and lists who wrapped up", async () => {
  const helpers = [h("ag_01", true, { teamId: "team_01", duty: "coordinator" }), h("ag_02", true, { teamId: "team_01" }), h("ag_03", false)];
  const f = fake(helpers, 2);
  const progress: number[] = [];
  const r = await bringHelpersToRest("chat-1", "safe", (n) => progress.push(n), f.deps);
  assert.deepEqual(f.told, ["c-ag_01"]);
  assert.deepEqual(f.aborted, []);
  assert.equal(progress[0], 2);
  assert.equal(progress.at(-1), 0);
  assert.deepEqual(r, { interrupted: [], wrapped: ["c-ag_01", "c-ag_02"], stillWorking: [] });
});

test("Interrupt and Move stops working helpers at once; pressed during a wait, it stops the rest", async () => {
  const f = fake([h("ag_01", true), h("ag_02", false)]);
  assert.deepEqual(await bringHelpersToRest("chat-2", "interrupt", () => undefined, f.deps), { interrupted: ["c-ag_01"], wrapped: [], stillWorking: [] });
  assert.deepEqual(f.told, []);

  // A helper that never wraps up on its own: the wait goes on until Interrupt and Move.
  const stuck = fake([h("ag_01", true)], Number.POSITIVE_INFINITY);
  let polls = 0;
  const sleep = stuck.deps.sleep;
  stuck.deps.sleep = async (ms) => {
    if (++polls === 3) assert.equal(interruptWaiting("chat-3"), true);
    return sleep(ms);
  };
  const r = await bringHelpersToRest("chat-3", "safe", () => undefined, stuck.deps);
  assert.deepEqual(r, { interrupted: ["c-ag_01"], wrapped: [], stillWorking: [] });
  assert.deepEqual(stuck.told, ["c-ag_01"]);
  assert.equal(interruptWaiting("chat-3"), false);
});

test("a helper that keeps working after its abort is stopped again each time, and named once the settle time is up", async () => {
  const f = fake([h("ag_01", true)]);
  let aborts = 0;
  f.deps.abort = async () => void aborts++; // never takes
  let t = 0;
  const r = await bringHelpersToRest("chat-4", "interrupt", () => undefined, f.deps, { now: () => (t += 10_000) });
  assert.deepEqual(r, { interrupted: ["c-ag_01"], wrapped: [], stillWorking: ["c-ag_01"] });
  assert.ok(aborts > 1);
});
