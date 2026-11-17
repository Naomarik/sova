import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkInputValue, inputValueText, parsePlaybookSpec, type InputValue, type PlaybookSpec } from "../../shared/playbook-format";
import { resolveRoleModel } from "../../shared/playbook-models";
import type { WorkerChoice } from "../../shared/protocol";
import { runBlock, runMessage } from "./message";
import { parseRunMessage } from "../../shared/playbook-run";
import { freezePlan, runCard, type CardEnv } from "./plan";
import type { PlaybookRunRecord } from "./store";

const raw = {
  version: 1,
  run: { where: "this-chat", worktree: "new" },
  inputs: [
    { id: "subject", label: "Under test", type: "text", multiline: true, ask: "always", required: true },
    { id: "testModels", label: "Test models", type: "models", ask: "always", required: true, default: [{ model: "zai/glm-5.3", effort: "low" }, { model: "claude-code/claude-haiku-5-5", effort: "low" }] },
    { id: "depth", label: "Depth", type: "number", integer: true, min: 1, max: 5, ask: "optional", required: false, default: 2 },
  ],
  teams: {
    arms: {
      label: "Arms",
      goal: "Run {{subject}} on every test model and grade it",
      members: {
        runner: { label: "Runner", brief: "Runs {{subject}} on one test model", notes: "references/roles/runner.md", per: { input: "testModels" }, kind: "routine", models: [{ model: "zai/glm-5.3", effort: "low" }] } as Record<string, unknown>,
        grader: { label: "Grader", brief: "Grades blind", only: true, sees: "blind", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "ollama-cloud/deepseek-v4.1-flash", effort: "high" }] } as Record<string, unknown>,
      },
    },
    review: { label: "Review", goal: "Find what the round missed", members: { critic: { label: "Critic", brief: "Argues against the winner", optional: true, startsOff: true, kind: "planning", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "zai/glm-5.3" }] } } },
    scouts: { goal: "Look around {{subject}}" },
  },
  steps: [
    { id: "look", label: "Look around", teams: ["scouts"] },
    { id: "baseline", label: "Baseline", goal: "A baseline of {{subject}}", stop: "always" },
    {
      id: "rounds",
      label: "Rounds",
      repeat: { max: 3, askEvery: 1, until: "rule", rule: "two rounds in a row with no win", carry: "the winner becomes the next base" },
      steps: [
        { id: "run", label: "Run the arms", teams: ["arms"] },
        { id: "review", label: "Review", teams: ["review"], stop: "optional" },
      ],
    },
  ],
  commands: [],
};

function spec(over: (r: typeof raw) => void = () => {}): PlaybookSpec {
  const r = structuredClone(raw);
  over(r);
  const s = parsePlaybookSpec(r);
  if ("error" in s) throw new Error(s.error);
  return s;
}

function record(s: PlaybookSpec, edits: PlaybookRunRecord["edits"] = {}): PlaybookRunRecord {
  const choices: Record<string, unknown> = {};
  for (const i of s.inputs) if (i.default !== undefined) choices[i.id] = i.default;
  return {
    v: 1,
    id: "pr_aaaaaaaaaaaa",
    playbook: { source: "sova", id: "ab", dir: "/pb/ab", entry: "PLAYBOOK.md", title: "A/B" },
    cwd: "/proj",
    shownIn: { id: "chat-a", path: "/s/chat-a.jsonl" },
    revision: 3,
    initial: { choices, origins: Object.fromEntries(s.inputs.map((i) => [i.id, "default" as const])) },
    edits,
    state: "draft",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

/** Opus can't run here; everything else can. */
function env(off: (c: WorkerChoice) => string | null = (c) => (c.model === "claude-opus-5-5" ? "claude-opus-5-5 is turned off in Settings → Models" : null)): CardEnv {
  const name = (c: WorkerChoice) => ({ label: c.model, provider: c.backend === "claude-code" ? "claude-code-cli" : c.model.split("/")[0]! });
  return {
    needs: null,
    denial: (c) => off(c),
    name,
    routes: { planning: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "medium" }, fallback: null } },
    chat: { backend: "pi", model: "zai/glm-5.3", effort: "" },
    team: { coordinator: { model: "claude-code/claude-opus-5-5", effort: "medium" }, monitor: { model: "ollama-cloud/deepseek-v4.1-flash", effort: "low" } },
    page: (rel) => (rel === "phases/stop.md" ? "# Stop rule\n\nStop after **two rounds** in a row with no win.\n\nMore detail.\n" : rel === "phases/list.md" ? "# Stop rule\n\nStop going round when any of these holds:\n\n- Every model passes.\n- Two rounds with no win.\n\nOtherwise go round.\n" : null),
    commandLabel: (id) => id,
    commandChanges: (id) => id !== "session.list",
    resolve: (input) => resolveRoleModel(input, { routes: { planning: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "medium" }, fallback: null } }, chat: { backend: "pi", model: "zai/glm-5.3", effort: "" }, denial: (c) => off(c), name: (c) => `${name(c).label} · ${name(c).provider}` }),
    checkValue: (i, v) => checkInputValue(i, v),
    valueText: (i, v) => inputValueText(i, v as InputValue),
  };
}

describe("the card a run draws", () => {
  test("a required choice left empty keeps Start off, saying which", () => {
    const s = spec();
    const card = runCard(record(s), s, env());
    assert.equal(card.view.startBlocked, "Fill in Under test first.");
    const filled = runCard(record(s, { choices: { subject: "the read tool" } }), s, env());
    assert.equal(filled.view.startBlocked, null);
  });

  test("a folder the playbook can't run in keeps Start off, saying why", () => {
    const s = spec();
    const e = { ...env(), needs: "This playbook runs only in a project's folder: open it from a chat in one." };
    assert.equal(runCard(record(s, { choices: { subject: "x" } }), s, e).view.startBlocked, "This playbook runs only in a project's folder: open it from a chat in one.");
  });

  test("a member skips a model that can't run, and says why", () => {
    const s = spec();
    const critic = runCard(record(s, { choices: { subject: "x" } }), s, env()).view.teams.find((t) => t.id === "review")!.members[0]!;
    assert.equal(critic.resolved?.model, "zai/glm-5.3");
    assert.match(critic.resolved?.reason ?? "", /turned off/);
    assert.equal(critic.models[0]!.model, "claude-code/claude-opus-5-5");
    assert.equal(critic.models[0]!.usable, false);
  });

  test("an only-these member with none that can run blocks Start, naming it", () => {
    const s = spec();
    const card = runCard(record(s, { choices: { subject: "x" } }), s, env((c) => (c.backend === "claude-code" || c.model.startsWith("ollama-cloud/") ? "off" : null)));
    const grader = card.view.teams[0]!.members.find((m) => m.id === "grader")!;
    assert.equal(grader.runnable, false);
    assert.match(card.view.startBlocked ?? "", /^Grader has no model that can run here/);
  });

  test("Who runs: one block per team with its goal and required members, briefs filled; no main chat, coordinator or monitor rows, which still count", () => {
    const s = spec();
    const view = runCard(record(s, { choices: { subject: "the read tool" } }), s, env()).view;
    assert.deepEqual(
      view.teams.map((t) => [t.id, t.label, t.goal, t.steps, t.note, t.members.map((m) => [m.id, m.brief, m.count, m.on])]),
      [
        ["arms", "Arms", "Run the read tool on every test model and grade it", ["run"], "", [["runner", "Runs the read tool on one test model", 2, true], ["grader", "Grades blind", 1, true]]],
        ["review", "Review", "Find what the round missed", ["review"], "", [["critic", "Argues against the winner", 1, false]]],
        ["scouts", "scouts", "Look around the read tool", ["look"], "", []],
      ],
    );
    const runner = view.teams[0]!.members[0]!;
    assert.deepEqual([runner.notes, runner.per, runner.kind], ["references/roles/runner.md", "Test models", "routine"]);
    assert.equal("prompt" in runner, false, "no prompt to view");
    assert.equal("roles" in view, false, "no flat role list, so no Main chat row");
    assert.deepEqual(view.who, { teams: 3, members: 2 }, "a member run twice counts once; one turned off doesn't count");
    // 2 runners + 1 grader, and a coordinator and a monitor for each of the 3 teams (a team with no required member too).
    assert.deepEqual(view.helpers, { total: 9, limit: 24 });
    assert.deepEqual(view.steps.map((x) => [x.id, x.teams, x.stopOn, !!x.cycle]), [["look", ["scouts"], false, false], ["baseline", [], true, false], ["run", ["arms"], false, true], ["review", ["review"], true, true]]);
    assert.equal(view.steps[1]!.goal, "A baseline of the read tool");
    assert.equal(view.choices.find((c) => c.id === "subject")!.multiline, true);
    assert.equal(view.choices.find((c) => c.id === "depth")!.multiline, undefined);
  });

  test("an optional member turned on counts; a stop turned off is off; your notes show where you wrote them", () => {
    const s = spec();
    const view = runCard(record(s, { choices: { subject: "x" }, roles: { critic: { on: true, note: "Be harsh." } }, teams: { arms: { note: "Keep it cheap." } }, stops: { review: false } }), s, env()).view;
    assert.equal(view.steps.find((x) => x.id === "review")!.stopOn, false);
    assert.deepEqual([view.helpers.total, view.who.members], [10, 3]);
    assert.deepEqual([view.teams[0]!.note, view.teams[1]!.members[0]!.note, view.teams[2]!.note], ["Keep it cheap.", "Be harsh.", ""]);
  });

  test("more helpers than one chat runs at once keeps Start off; exactly the limit doesn't", () => {
    const sized = (n: number) =>
      spec((r) => {
        delete r.teams.arms.members.runner.per;
        r.teams.arms.members.runner.count = n;
      });
    const at = sized(17);
    const fits = runCard(record(at, { choices: { subject: "x" } }), at, env()).view;
    assert.deepEqual([fits.helpers.total, fits.startBlocked], [24, null], "17 runners, the grader, and 6 for the three teams");
    const over = sized(18);
    assert.equal(runCard(record(over, { choices: { subject: "x" } }), over, env()).view.startBlocked, "The plan needs 25 helpers, and one chat runs at most 24 at once.");
  });

  test("a stop rule kept on a page reads as that page's first paragraph", () => {
    const s = spec((r) => {
      (r.steps[2] as { repeat: { rule: string } }).repeat.rule = "phases/stop.md";
    });
    assert.equal(runCard(record(s, { choices: { subject: "x" } }), s, env()).view.cycle?.rule, "Stop after two rounds in a row with no win.");
    const listed = spec((r) => {
      (r.steps[2] as { repeat: { rule: string } }).repeat.rule = "phases/list.md";
    });
    assert.equal(runCard(record(listed, { choices: { subject: "x" } }), listed, env()).view.cycle?.rule, "Stop going round when any of these holds: Every model passes; Two rounds with no win.");
  });

  test("each choice says where its value came from; a value you set says so", () => {
    const s = spec();
    const r = record(s, { choices: { subject: "x" } });
    r.initial.origins.depth = "standing";
    const byId = Object.fromEntries(runCard(r, s, env()).view.choices.map((c) => [c.id, c.origin]));
    assert.deepEqual(byId, { subject: "you", testModels: "default", depth: "standing" });
  });

  test("a cycle shows its settings, and the card's edits replace them", () => {
    const s = spec();
    assert.deepEqual(runCard(record(s, { choices: { subject: "x" } }), s, env()).view.cycle, { steps: ["run", "review"], max: 3, maxCap: 50, askEvery: 1, until: "rule", rule: "two rounds in a row with no win" });
    const edited = runCard(record(s, { choices: { subject: "x" }, cycle: { max: 2, askEvery: 3 } }), s, env());
    assert.match(edited.view.startBlocked ?? "", /cycle settings don't fit/);
  });
});

describe("the frozen plan", () => {
  test("keeps each team's goal and note and each required member's brief, notes page, note and whole chain; writes no prompt", () => {
    const s = spec();
    const r = record(s, { choices: { subject: "the read tool" }, roles: { grader: { note: "  Be strict. " } }, teams: { arms: { note: " Keep it cheap. " }, scouts: { note: "  " } } });
    const e = env();
    const card = runCard(r, s, e);
    const { plan, files } = freezePlan(r, s, e, card, false, "2026-11-16T01:00:00.000Z");
    assert.deepEqual(Object.keys(files), ["plan.json"], "no briefs and no team layouts: each coordinator writes the instructions");
    assert.deepEqual(plan.teams, [
      { id: "arms", label: "Arms", goal: "Run the read tool on every test model and grade it", note: "Keep it cheap.", steps: ["run"], members: ["runner", "grader"] },
      { id: "review", label: "Review", goal: "Find what the round missed", steps: ["review"], members: [] },
      { id: "scouts", label: "scouts", goal: "Look around the read tool", steps: ["look"], members: [] },
    ]);
    const grader = plan.members.find((x) => x.id === "grader")!;
    assert.deepEqual(grader.chain.map((m) => [m.model, m.effort, !!m.why]), [["claude-code/claude-opus-5-5", "high", true], ["ollama-cloud/deepseek-v4.1-flash", "high", false]]);
    assert.deepEqual([grader.use, grader.only, grader.team, grader.brief, grader.note, grader.sees], [1, true, "arms", "Grades blind", "Be strict.", "blind"]);
    const runner = plan.members.find((x) => x.id === "runner")!;
    assert.deepEqual([runner.brief, runner.notes, runner.count, runner.items], ["Runs the read tool on one test model", "references/roles/runner.md", 2, ["zai/glm-5.3 (low)", "claude-code/claude-haiku-5-5 (low)"]]);
    assert.equal(plan.members.some((x) => x.id === "critic"), false, "an optional member left off isn't in the plan");
    assert.equal("roles" in plan, false);
    assert.deepEqual(JSON.parse(files["plan.json"]!).teams, plan.teams);
  });

  test("the run block carries the choices, each team's goal, note and required members, which teams work in which step, the cycle and the contents with Sova's commands", () => {
    const s = spec();
    const r = record(s, { choices: { subject: "the read tool" }, roles: { grader: { note: "Be strict." } }, teams: { arms: { note: "Keep it cheap." } } });
    const e = env();
    const { plan } = freezePlan(r, s, e, runCard(r, s, e), false, "2026-11-16T01:00:00.000Z");
    const block = runBlock(plan, "/shared/c/playbook-runs/pr_aaaaaaaaaaaa", { contents: [{ name: "cast", line: "cast: the cast and their models", file: "/k/cast.md" }], sovaScript: "/sova/scripts/sova.mjs" });
    for (const want of [
      '<run id="pr_aaaaaaaaaaaa" playbook="ab" revision="3" folder="/shared/c/playbook-runs/pr_aaaaaaaaaaaa">',
      "- Under test [subject]: the read tool",
      "You run on this chat's own model.",
      "write each member's instructions yourself from the goal, its brief and its notes page",
      "- Team Arms [arms], working in run. Goal: Run the read tool on every test model and grade it. The user's note for the team: Keep it cheap.",
      "  - Runner [runner] ×2, one per item (zai/glm-5.3 (low); claude-code/claude-haiku-5-5 (low)), kind routine: Runs the read tool on one test model. Notes page: references/roles/runner.md. Models in order: zai/glm-5.3 (low) → zai/glm-5.3. When the list runs out, use the kind's model from the user's profile, then this chat's model.",
      "  - Grader [grader]: Grades blind. Models in order: claude-code/claude-opus-5-5 (high) [can't run now: claude-opus-5-5 is turned off in Settings → Models] → ollama-cloud/deepseek-v4.1-flash (high). Only these models: if none of them can run, stop and ask the user; never pick another. Starts on entry 2:",
      "Blind: never tell it which arm or version produced what it judges. The user's note for it: Be strict.",
      "- Team scouts [scouts], working in look. Goal: Look around the read tool.\n  Required members: none; it picks its own.",
      "1. Look around [look]: team scouts.",
      "2. Baseline [baseline]: you alone. Goal: A baseline of the read tool. STOP after it",
      '3. Run the arms [run] (in cycle "rounds"): team Arms.',
      'Cycle "Rounds" (steps run, review): at most 3 cycles; stop and ask the user after every cycle and at the end. Stop going round once the stop rule is met: two rounds in a row with no win. Into the next cycle: the winner becomes the next base.',
      "Do the work in a new worktree",
      "- cast: the cast and their models — /k/cast.md",
      "`node /sova/scripts/sova.mjs list`",
      "Actions only the user's own click may do (Land, Start on a card, approvals, restarting Sova) are refused to you",
      "</run>",
    ])
      assert.ok(block.includes(want), `missing: ${want}\n---\n${block}`);
    for (const gone of ["briefs/", "teams/", "Critic", "Conductor"]) assert.ok(!block.includes(gone), `still says ${gone}`);
    const msg = runMessage(plan, '<playbook id="ab">…</playbook>', block);
    assert.match(msg, /^Run the playbook "A\/B" as its conductor/);
    // The page folds exactly this message: what Start builds, the thread recognizes.
    assert.deepEqual(parseRunMessage(msg), { runId: "pr_aaaaaaaaaaaa", playbook: "ab", title: "A/B", revision: 3 });
    assert.equal(parseRunMessage(msg.replace("</run>", "")), null);
  });
});
