// A run started before teams had goals keeps a record frozen in the old shape (a cast of roles, teams as step
// helpers). Reading it, as the page does after a restart, gives today's card: teams with members, never undefined.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PlaybookRunView } from "../../shared/playbook-run";
import type { PlaybookPlan } from "./plan";

const store = await import("./store");
const { runView } = await import("./view");

after(() => dropScratchAgentDir());

const model = (m: string) => ({ chain: [{ model: m, effort: "low" }], models: [{ model: m, effort: "low", label: m, provider: "zai", usable: true }], options: [{ model: m, effort: "low" }], resolved: { model: m, modelLabel: m, provider: "zai", effort: "low", source: "list" }, runnable: true });
const role = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), main: false, kind: "routine", count: 1, optional: false, on: true, only: false, ...model("zai/glm-5.3"), note: "", prompt: `Be the ${id}.`, ...extra });

/** As a run started on 2026-11-16 froze it (trimmed from a real record). */
const oldView = {
  id: "pr_aaaaaaaaaaaa",
  revision: 15,
  playbook: { source: "sova", id: "ab-cycle", title: "A/B cycle", dir: "/pb/ab-cycle" },
  state: "draft",
  choices: [],
  roles: [
    { ...role("main"), label: "Main chat", main: true },
    role("questions", { team: "bench" }),
    role("bench", { team: "bench", note: "Keep it small." }),
    role("grader", { optional: true, on: false, only: true }),
    role("reviewer"),
    role("scribe"),
  ],
  teams: [{ id: "bench", label: "Build the bench and freeze the cases", roles: ["questions", "bench"], coordinator: { modelLabel: "GLM-5.3" }, monitor: { modelLabel: "GLM-5.3" } }],
  steps: [
    { id: "measure", title: "Agree what is measured", stop: "always", stopOn: true, runs: "main", roles: ["main"], report: "chart" },
    { id: "bench", title: "Build the bench and freeze the cases", stop: "never", stopOn: false, runs: "team", team: "bench", roles: ["questions", "bench"] },
    { id: "review", title: "Is it good enough to land?", stop: "never", stopOn: false, runs: "helpers", roles: ["reviewer", "grader"], report: "verdict", cycle: true },
  ],
  cycle: null,
  howItRuns: "Runs in a new chat.",
  commands: [],
  helpers: { total: 5, limit: 24 },
  startBlocked: null,
};

test("a record frozen before teams had goals reads as today's card: its teams with the roles that ran as members, its steps naming their teams", async () => {
  const r = store.createRun({ playbook: { source: "sova", id: "ab-cycle", dir: "/pb/ab-cycle", entry: "PLAYBOOK.md", title: "A/B cycle" }, cwd: scratchAgentDir, initial: { choices: {}, origins: {} } });
  const started = { at: "2026-11-16T21:50:31.000Z", revision: 15, chat: { id: "chat-run", path: "/s/chat-run.jsonl" }, newChat: true, folder: "/shared/chat-run/playbook-runs/x" };
  store.changeRun(r.id, (x) => {
    x.state = "started";
    x.started = started;
    x.plan = { view: oldView } as unknown as PlaybookPlan;
  });
  store.forgetPlaybookRuns();
  const view = (await runView(store.runById(r.id)!)) as PlaybookRunView & { roles?: unknown };
  assert.equal(view.roles, undefined, "no old role list, so no Main chat row");
  assert.deepEqual(
    view.teams.map((t) => [t.id, t.goal, t.steps, t.members.map((m) => [m.id, m.brief, m.note, m.resolved?.model, m.on])]),
    [
      ["bench", "Build the bench and freeze the cases", ["bench"], [["questions", "", "", "zai/glm-5.3", true], ["bench", "", "Keep it small.", "zai/glm-5.3", true]]],
      ["review", "Is it good enough to land?", ["review"], [["reviewer", "", "", "zai/glm-5.3", true]]],
      ["other-helpers", "Helpers this run named outside any team", [], [["scribe", "", "", "zai/glm-5.3", true]]],
    ],
  );
  assert.deepEqual(view.steps.map((s) => [s.id, s.teams, s.report, !!s.cycle]), [["measure", [], "chart", false], ["bench", ["bench"], undefined, false], ["review", ["review"], "verdict", true]]);
  assert.equal(view.steps.some((s) => "roles" in s || "runs" in s), false);
  assert.deepEqual(view.who, { teams: 3, members: 4 });
  assert.equal(view.legacy, true, "the card may say the record predates teams");
  assert.deepEqual([view.state, view.started, view.helpers, view.startBlocked], ["started", started, { total: 5, limit: 24 }, "This run has started."]);
});
