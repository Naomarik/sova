import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookRunView } from "../../shared/playbook-run";
import { cantRunCount, teamAddsLine } from "./playbook-card";
import { normalizeRunView } from "./playbook-run-view";

/** A run whose plan was frozen before teams had goals and members (al_2 a21): its team rows were
    roles plus a coordinator and a monitor, and its steps said "runs" instead of naming teams. */
const oldShape = {
  id: "pr_aaaaaaaaaaaa",
  revision: 3,
  playbook: { source: "sova", id: "zz", title: "Card check", dir: "/p" },
  state: "started",
  choices: [],
  roles: [{ id: "writer", label: "Writer" }],
  teams: [{ id: "write", label: "Write and read together", roles: ["writer", "reader"], coordinator: { modelLabel: "Qwen3 4B" }, monitor: { modelLabel: "Qwen3 4B" } }],
  steps: [{ id: "agree", title: "Agree the topic", stop: "always", stopOn: true, runs: "main", roles: ["main"] }],
  cycle: null,
  howItRuns: "Runs in this chat.",
  commands: [],
  helpers: { total: 5, limit: 24 },
  startBlocked: "This run has started.",
} as unknown as PlaybookRunView;

test("an older run's team without members or a goal reads as an empty team, and the card's counts don't throw", () => {
  // Today's card read t.members.filter on this shape and threw before it drew.
  assert.throws(() => cantRunCount(oldShape.teams));
  const v = normalizeRunView(oldShape);
  assert.deepEqual(v.teams.map((t) => ({ id: t.id, label: t.label, goal: t.goal, steps: t.steps, note: t.note, members: t.members })), [
    { id: "write", label: "Write and read together", goal: "", steps: [], note: "", members: [] },
  ]);
  assert.equal(cantRunCount(v.teams), 0);
  assert.equal(teamAddsLine(v.teams[0]!), "No required members: the team adds whoever it needs.");
  assert.deepEqual(v.steps[0]!.teams, []);
  assert.deepEqual(v.who, { teams: 1, members: 0 });
  // What the older view did carry stays.
  assert.equal(v.howItRuns, "Runs in this chat.");
  assert.deepEqual(v.helpers, { total: 5, limit: 24 });
});

test("a member missing its newer fields gets them, empty", () => {
  const v = normalizeRunView({ ...oldShape, teams: [{ id: "t", label: "T", goal: "g", steps: ["s"], note: "", members: [{ id: "m", label: "M" }] }] } as unknown as PlaybookRunView);
  const m = v.teams[0]!.members[0]!;
  assert.deepEqual({ brief: m.brief, note: m.note, chain: m.chain, models: m.models, options: m.options, resolved: m.resolved, on: m.on, runnable: m.runnable, count: m.count }, {
    brief: "", note: "", chain: [], models: [], options: [], resolved: null, on: true, runnable: true, count: 1,
  });
  assert.deepEqual(v.who, { teams: 1, members: 1 });
});

test("a whole view comes back with the same values", () => {
  const whole = normalizeRunView(oldShape);
  assert.deepEqual(normalizeRunView(whole), whole);
});
