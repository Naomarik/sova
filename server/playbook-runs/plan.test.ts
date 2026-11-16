import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkInputValue, inputValueText, parsePlaybookSpec, type InputValue, type PlaybookSpec } from "../../shared/playbook-format";
import { resolveRoleModel } from "../../shared/playbook-models";
import type { WorkerChoice } from "../../shared/protocol";
import { runBlock, runMessage } from "./message";
import { freezePlan, runCard, type CardEnv } from "./plan";
import type { PlaybookRunRecord } from "./store";

const raw = {
  version: 1,
  run: { where: "this-chat", worktree: "new" },
  inputs: [
    { id: "subject", label: "Under test", type: "text", ask: "always", required: true },
    { id: "testModels", label: "Test models", type: "models", ask: "always", required: true, default: [{ model: "zai/glm-5.3", effort: "low" }, { model: "claude-code/claude-haiku-5-5", effort: "low" }] },
    { id: "depth", label: "Depth", type: "number", integer: true, min: 1, max: 5, ask: "optional", required: false, default: 2 },
  ],
  roles: {
    main: { label: "Conductor", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "zai/glm-5.3" }] },
    runner: { label: "Runner", prompt: "roles/runner.md", per: { input: "testModels" }, kind: "routine", models: [{ model: "zai/glm-5.3", effort: "low" }] } as Record<string, unknown>,
    grader: { label: "Grader", prompt: "roles/grader.md", only: true, sees: "blind", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "ollama-cloud/deepseek-v4.1-flash", effort: "high" }] },
    critic: { label: "Critic", prompt: "roles/critic.md", optional: true, startsOff: true, kind: "planning" },
  },
  steps: [
    { id: "baseline", label: "Baseline", roles: ["main"], stop: "always" },
    {
      id: "rounds",
      label: "Rounds",
      repeat: { max: 3, askEvery: 1, until: "rule", rule: "two rounds in a row with no win", carry: "the winner becomes the next base" },
      steps: [
        { id: "run", label: "Run the arms", roles: ["runner", "grader"], team: true },
        { id: "review", label: "Review", roles: ["main", "critic"], stop: "optional" },
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
    denial: (c) => off(c),
    name,
    routes: { planning: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "medium" }, fallback: null } },
    chat: { backend: "pi", model: "zai/glm-5.3", effort: "" },
    team: { coordinator: { model: "claude-code/claude-opus-5-5", effort: "medium" }, monitor: { model: "ollama-cloud/deepseek-v4.1-flash", effort: "low" } },
    prompts: { main: "Conduct.", runner: "Run {{subject}} on {{each}}, depth {{depth}}, into {{run}}; scripts in {{folder}}/scripts.", grader: "Grade {{subject}}.", critic: "Critique." },
    commandLabel: (id) => id,
    resolve: (input, as) => resolveRoleModel(input, { routes: { planning: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "medium" }, fallback: null } }, chat: { backend: "pi", model: "zai/glm-5.3", effort: "" }, denial: (c) => off(c), name: (c) => `${name(c).label} · ${name(c).provider}` }),
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

  test("a role skips a model that can't run, and says why", () => {
    const s = spec();
    const main = runCard(record(s, { choices: { subject: "x" } }), s, env()).view.roles.find((r) => r.id === "main")!;
    assert.equal(main.resolved?.model, "zai/glm-5.3");
    assert.match(main.resolved?.reason ?? "", /turned off/);
    // The list, then (not an only-these role) this chat's own model.
    assert.deepEqual(main.models.map((m) => [m.model, m.usable]), [["claude-code/claude-opus-5-5", false], ["zai/glm-5.3", true], ["zai/glm-5.3", true]]);
  });

  test("an only-these role with none that can run blocks Start, naming it", () => {
    const s = spec();
    const card = runCard(record(s, { choices: { subject: "x" } }), s, env((c) => (c.backend === "claude-code" || c.model.startsWith("ollama-cloud/") ? "off" : null)));
    const grader = card.view.roles.find((r) => r.id === "grader")!;
    assert.equal(grader.runnable, false);
    assert.match(card.view.startBlocked ?? "", /^Grader has no model that can run here/);
  });

  test("one helper per item, a team per team step with its coordinator and monitor counted", () => {
    const s = spec();
    const card = runCard(record(s, { choices: { subject: "x" } }), s, env());
    const runner = card.view.roles.find((r) => r.id === "runner")!;
    assert.equal(runner.count, 2);
    assert.equal(runner.team, "run");
    assert.deepEqual(card.view.teams.map((t) => [t.id, t.roles, t.coordinator.modelLabel, t.monitor.modelLabel]), [["run", ["runner", "grader"], "claude-opus-5-5", "ollama-cloud/deepseek-v4.1-flash"]]);
    // 2 runners + 1 grader + coordinator and monitor; the critic starts off.
    assert.deepEqual(card.view.helpers, { total: 5, limit: 24 });
    assert.deepEqual(card.view.steps.map((x) => [x.id, x.runs, x.stopOn, !!x.cycle]), [["baseline", "main", true, false], ["run", "team", false, true], ["review", "main", true, true]]);
  });

  test("an optional role turned on joins its step; a stop turned off is off", () => {
    const s = spec();
    const card = runCard(record(s, { choices: { subject: "x" }, roles: { critic: { on: true } }, stops: { review: false } }), s, env());
    const review = card.view.steps.find((x) => x.id === "review")!;
    assert.deepEqual([review.runs, review.stopOn], ["helpers", false]);
    assert.equal(card.view.helpers.total, 6);
  });

  test("more helpers than one chat runs at once keeps Start off", () => {
    const s = spec((r) => {
      delete r.roles.runner.per;
      r.roles.runner.count = 23;
    });
    const card = runCard(record(s, { choices: { subject: "x" } }), s, env());
    assert.match(card.view.startBlocked ?? "", /needs 26 helpers, and one chat runs at most 24/);
  });

  test("View Prompt shows the brief exactly: slots filled, the blind rule, the note", () => {
    const s = spec();
    const card = runCard(record(s, { choices: { subject: "the read tool" }, roles: { grader: { note: "Be strict." } } }), s, env());
    assert.equal(card.view.roles.find((r) => r.id === "runner")!.prompt, "Run the read tool on zai/glm-5.3 (low), depth 2, into (the run folder, made at Start); scripts in /pb/ab/scripts.\n");
    assert.equal(card.view.roles.find((r) => r.id === "grader")!.prompt, "Grade the read tool.\n\nYou judge blind: you are never told which arm or version produced what you are given, and you must not try to find out.\n\nNote for this run: Be strict.\n");
  });

  test("a prompt that places {{note}} itself gets the note there, once", () => {
    const s = spec();
    const e = env();
    e.prompts.grader = "Grade {{subject}}. Note: {{note}}";
    const card = runCard(record(s, { choices: { subject: "x" }, roles: { grader: { note: "Be strict." } } }), s, e);
    assert.equal(card.view.roles.find((r) => r.id === "grader")!.prompt, "Grade x. Note: Be strict.\n\nYou judge blind: you are never told which arm or version produced what you are given, and you must not try to find out.\n");
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
    assert.deepEqual(runCard(record(s, { choices: { subject: "x" } }), s, env()).view.cycle, { steps: ["run", "review"], max: 3, maxCap: 50, askEvery: 1, rule: "two rounds in a row with no win" });
    const edited = runCard(record(s, { choices: { subject: "x" }, cycle: { max: 2, askEvery: 3 } }), s, env());
    assert.match(edited.view.startBlocked ?? "", /cycle settings don't fit/);
  });
});

describe("the frozen plan", () => {
  test("keeps every role's whole chain, writes one brief per helper and the team's layout", () => {
    const s = spec();
    const r = record(s, { choices: { subject: "the read tool" } });
    const e = env();
    const card = runCard(r, s, e);
    const { plan, files } = freezePlan(r, s, e, card, false, "2026-11-16T01:00:00.000Z", "/shared/c/playbook-runs/pr_aaaaaaaaaaaa");
    const grader = plan.roles.find((x) => x.id === "grader")!;
    assert.deepEqual(grader.chain.map((m) => [m.model, m.effort, !!m.why]), [["claude-code/claude-opus-5-5", "high", true], ["ollama-cloud/deepseek-v4.1-flash", "high", false]]);
    assert.equal(grader.use, 1);
    assert.equal(grader.only, true);
    assert.deepEqual(plan.roles.find((x) => x.id === "runner")!.briefs, ["briefs/runner.1-zai-glm-5-3-low.md", "briefs/runner.2-claude-code-claude-haiku-5-5-low.md"]);
    assert.equal(files["briefs/runner.2-claude-code-claude-haiku-5-5-low.md"], "Run the read tool on claude-code/claude-haiku-5-5 (low), depth 2, into /shared/c/playbook-runs/pr_aaaaaaaaaaaa; scripts in /pb/ab/scripts.\n");
    const team = JSON.parse(files["teams/run.json"]!) as { name: string; members: { role: string; backend: string; model: string; effort?: string; prompt: string }[] };
    assert.deepEqual(team.members.map((m) => [m.role, m.backend, m.model, m.effort]), [["runner-1", "pi", "zai/glm-5.3", "low"], ["runner-2", "pi", "zai/glm-5.3", "low"], ["grader", "pi", "ollama-cloud/deepseek-v4.1-flash", "high"]]);
    assert.equal(team.members[1]!.prompt, files["briefs/runner.2-claude-code-claude-haiku-5-5-low.md"]);
    assert.ok(files["plan.json"]);
    assert.equal(plan.roles.some((x) => x.id === "critic"), false, "an optional role left off isn't in the plan");
  });

  test("the run block carries the choices, the cast, team or separate helpers, the steps, the cycle and the contents with Sova's commands", () => {
    const s = spec();
    const r = record(s, { choices: { subject: "the read tool" } });
    const e = env();
    const { plan } = freezePlan(r, s, e, runCard(r, s, e), false, "2026-11-16T01:00:00.000Z", "/shared/c/playbook-runs/pr_aaaaaaaaaaaa");
    const block = runBlock(plan, "/shared/c/playbook-runs/pr_aaaaaaaaaaaa", { contents: [{ name: "cast", line: "cast: the cast and their models", file: "/k/cast.md" }], sovaScript: "/sova/scripts/sova.mjs" });
    for (const want of [
      '<run id="pr_aaaaaaaaaaaa" playbook="ab" revision="3" folder="/shared/c/playbook-runs/pr_aaaaaaaaaaaa">',
      "- Under test [subject]: the read tool",
      "- Grader [grader]: claude-code/claude-opus-5-5 (high) [can't run now: claude-opus-5-5 is turned off in Settings → Models] → ollama-cloud/deepseek-v4.1-flash (high). Only these models: if none of them can run, stop and ask the user; never pick another.",
      'Runs in team "run".',
      "- Run the arms [run]: /shared/c/playbook-runs/pr_aaaaaaaaaaaa/teams/run.json (roles: runner, grader)",
      "1. Baseline [baseline]: you. STOP after it",
      'Cycle "Rounds" (steps run, review): at most 3 cycles; stop and ask the user after every cycle and at the end. Stop going round once the stop rule is met: two rounds in a row with no win. Into the next cycle: the winner becomes the next base.',
      "Do the work in a new worktree",
      "- cast: the cast and their models — /k/cast.md",
      "`node /sova/scripts/sova.mjs list`",
      "Actions only the user's own click may do (Land, Start on a card, approvals, restarting Sova) are refused to you",
      "</run>",
    ])
      assert.ok(block.includes(want), `missing: ${want}\n---\n${block}`);
    const msg = runMessage(plan, "<playbook id=\"ab\">…</playbook>", block);
    assert.match(msg, /^Run the playbook "A\/B" as its conductor/);
  });
});
