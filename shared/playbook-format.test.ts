// A playbook's description file: the strict parse (every key known
// at every level, every reference checked, the exact path and fault), the folder check, and input values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCycleSettings, checkInputValue, cycleOf, inputValueText, parsePlaybookSpec, stepsOf, validatePlaybookFiles, validatePromptSlots, type PlaybookSpec } from "./playbook-format";

/** A description using every key the format has (the A/B cycle's shape, cut down). */
const FULL = {
  version: 1,
  listed: true,
  run: { where: "new-chat", worktree: "new", mode: "delegate", minorModes: ["vis"], permissions: { grant: ["sessions.read"] }, needs: ["project"] },
  inputs: [
    { id: "target", label: "What is under test", help: "a file", type: "text", ask: "always", required: true, multiline: true, default: "x" },
    { id: "rivals", label: "Rival consultants", type: "number", min: 1, max: 3, integer: true, default: 1 },
    { id: "fast", label: "Fast", type: "toggle", ask: "once", default: true },
    { id: "kind", label: "Kind", type: "choice", options: [{ id: "a", label: "A", help: "trade-off" }, { id: "b", label: "B" }], default: "a" },
    { id: "knobs", label: "Knobs", type: "multi", each: "cycle", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], default: ["b"] },
    { id: "cases", label: "Cases", type: "list", ask: "optional", default: ["one"] },
    { id: "testModels", label: "Test models", type: "models", default: [{ model: "zai/glm-5.3", effort: "low" }] },
  ],
  facts: [{ id: "latest", label: "Latest", help: "looked up" }],
  roles: {
    main: { label: "Conductor", prompt: "PLAYBOOK.md", kind: "planning", models: [{ model: "claude-code/claude-fable-5-2", effort: "high" }], only: false },
    consultant: { label: "Consultant", prompt: "roles/consultant.md", kind: "planning", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "claude-code/claude-fable-5-2" }], count: { input: "rivals" }, fresh: "cycle" },
    runner: { label: "Runner", prompt: "roles/runner.md", kind: "routine", per: { input: "testModels" }, only: true, models: [{ model: "zai/glm-5.3", effort: "low" }] },
    grader: { label: "Grader", prompt: "roles/grader.md", kind: "investigation", sees: "blind", optional: true, startsOff: true, count: 1 },
  },
  steps: [
    { id: "measure", label: "Agree what is measured", roles: ["main"], stop: "always", asks: ["the bars change"], report: "chart", phase: "phases/measure.md" },
    { id: "cycle", label: "Improve and re-test", repeat: { max: 5, askEvery: 2, until: "rule", rule: "phases/stop-rule.md", carry: "the winner is the next base" }, steps: [
      { id: "fix", label: "Fix", roles: ["consultant"], team: false },
      { id: "run", label: "Run", roles: ["runner", "grader"], stop: "optional", startsOff: true },
    ] },
  ],
  commands: ["session.create", "session.list"],
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ok = (raw: unknown): PlaybookSpec => {
  const r = parsePlaybookSpec(raw);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const err = (raw: unknown): string => {
  const r = parsePlaybookSpec(raw);
  assert.ok("error" in r, "expected a refusal");
  return r.error;
};

test("the full description reads as written, with derived values where it leaves one out", () => {
  const s = ok(FULL);
  assert.deepEqual(s.run, { where: "new-chat", whereFixed: true, worktree: "new", mode: "delegate", minorModes: ["vis"], permissions: s.run.permissions, needs: ["project"] });
  assert.deepEqual(s.run.permissions?.grant, ["sessions.read"]);
  assert.deepEqual(s.roles.map((r) => r.id), ["main", "consultant", "runner", "grader"]);
  const consultant = s.roles[1]!;
  assert.deepEqual(consultant.models.map((m) => m.choice), [{ backend: "claude-code", model: "claude-opus-5-5", effort: "high" }, { backend: "claude-code", model: "claude-fable-5-2", effort: "medium" }], "an entry naming no effort gets the default, never an empty one");
  assert.deepEqual(s.roles[2]!.models[0]!.choice, { backend: "pi", model: "zai/glm-5.3", effort: "low" });
  assert.deepEqual(consultant.count, { input: "rivals" });
  assert.deepEqual(s.roles[3]!.count, { n: 1 });
  assert.equal(cycleOf(s)?.settings.askEvery, 2);
  assert.deepEqual(stepsOf(s.steps).map((x) => [x.id, x.team]), [["measure", false], ["fix", false], ["run", true]]);
  assert.deepEqual(s.commands, ["session.create", "session.list"], "a command that only looks may be listed too: looking is free");
});

test("a description that sets nothing else is a plain playbook with a main chat", () => {
  const s = ok({ version: 1, listed: false });
  assert.equal(s.listed, false);
  assert.deepEqual(s.run, { where: "this-chat", whereFixed: false, worktree: "none", needs: [] });
  assert.deepEqual(s.roles.map((r) => [r.id, r.label, r.models.length]), [["main", "Main chat", 0]]);
  assert.deepEqual([s.steps, s.inputs, s.facts, s.commands], [[], [], [], []]);
  assert.equal(ok({ version: 1 }).listed, true);
});

/** Every object the description holds, by its path in error messages. */
function objectPaths(v: unknown, path: string, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => objectPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    out.push(path);
    for (const [k, x] of Object.entries(v)) objectPaths(x, path === "playbook.json" ? k : `${path}.${k}`, out);
  }
  return out;
}
const at = (root: Record<string, unknown>, path: string): Record<string, unknown> => {
  if (path === "playbook.json") return root;
  return path.split(/\.|(?=\[)/).reduce<unknown>((o, k) => (k.startsWith("[") ? (o as unknown[])[Number(k.slice(1, -1))] : (o as Record<string, unknown>)[k]), root) as Record<string, unknown>;
};

test("rule: an unknown key anywhere is refused with its exact path, and nothing else is", () => {
  const paths = objectPaths(FULL, "playbook.json").filter((p) => p !== "roles" && !p.endsWith(".on")); // roles' keys are role ids
  assert.ok(paths.length > 25, "the walk reaches every level");
  for (const p of paths) {
    const raw = clone(FULL) as unknown as Record<string, unknown>;
    at(raw, p).zzz = 1;
    assert.match(err(raw), new RegExp(`^${p.replace(/[.[\]]/g, "\\$&")}: unknown key "zzz"\\. Known: `), p);
  }
});

test("each fault is refused with its exact path and words", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mutation of the raw JSON
  const cases: [string, (r: any) => void, string | RegExp][] = [
    ["version", (r) => (r.version = 2), "version: must be 1."],
    ["effort", (r) => (r.roles.consultant.models[1].effort = "huge"), `roles.consultant.models[1].effort: must be one of "off", "minimal", "low", "medium", "high", "xhigh", "max".`],
    ["model ref", (r) => (r.roles.runner.models[0].model = "glm"), `roles.runner.models[0].model: must be a model ref, "provider/id" ("claude-code/claude-opus-5-5", "zai/glm-5.3").`],
    ["repeated model", (r) => r.roles.runner.models.push({ model: "zai/glm-5.3", effort: "low" }), "roles.runner.models[1]: repeats zai/glm-5.3."],
    ["only without models", (r) => ((r.roles.grader.only = true), delete r.roles.grader.models), `roles.grader.only: "only these models" needs a "models" list.`],
    ["helper without prompt", (r) => delete r.roles.grader.prompt, `roles.grader.prompt: is required: a helper's prompt page, like "roles/grader.md".`],
    ["prompt outside", (r) => (r.roles.grader.prompt = "../x.md"), `roles.grader.prompt: must be a markdown file inside the playbook's folder, like "roles/grader.md".`],
    ["main count", (r) => (r.roles.main.count = 2), `roles.main: "count" is for helper roles only; the main chat is always one.`],
    ["count and per", (r) => (r.roles.runner.count = 2), `roles.runner: has "count" and "per"; use one.`],
    ["count names a text", (r) => (r.roles.consultant.count = { input: "target" }), `roles.consultant.count.input: must name a number input ("rivals").`],
    ["per names a number", (r) => (r.roles.runner.per = { input: "rivals" }), `roles.runner.per.input: must name a multi, list or models input ("knobs", "cases", "testModels").`],
    ["startsOff not optional", (r) => (r.roles.grader.optional = false), `roles.grader.startsOff: needs "optional": true (only a role you may turn off can start off).`],
    ["unknown role in a step", (r) => r.steps[0].roles.push("judge"), `steps[0].roles[1]: must be a declared role: "main", "consultant", "runner", "grader".`],
    ["unused role", (r) => (r.roles.extra = { label: "Extra", prompt: "roles/extra.md" }), "roles.extra: no step names it."],
    ["two groups", (r) => r.steps.push(clone(FULL.steps[1])), `steps[2]: a playbook has at most one repeating group ("cycle" is one).`],
    ["nested group", (r) => r.steps[1].steps.push({ id: "in", label: "In", repeat: { max: 2 }, steps: [] }), "steps[1].steps[2]: a repeating group holds plain steps only."],
    ["askEvery past max", (r) => (r.steps[1].repeat.askEvery = 6), "steps[1].repeat.askEvery: must be a whole number from 1 to 5."],
    ["until rule without one", (r) => delete r.steps[1].repeat.rule, `steps[1].repeat.until: "rule" needs the stop rule in "rule".`],
    ["team of one role", (r) => (r.steps[1].steps[0].team = true), "steps[1].steps[0].team: a team is two or more helper roles; one role's helpers (however many) run as separate helpers."],
    ["team of main and one role", (r) => (r.steps[0].roles = ["main", "grader"], r.steps[0].team = true), "steps[0].team: a team is two or more helper roles; one role's helpers (however many) run as separate helpers."],
    ["optional stop off", (r) => (r.steps[0].startsOff = true), `steps[0].startsOff: needs "stop": "optional" (only an optional stop can start off).`],
    ["duplicate step id", (r) => (r.steps[1].steps[0].id = "measure"), `steps: the step id "measure" is used twice.`],
    ["choice default", (r) => (r.inputs[3].default = "c"), `inputs[3].default: must be one of the options' ids: "a", "b".`],
    ["number default", (r) => (r.inputs[1].default = 4), "inputs[1].default: must be from 1 to 3."],
    ["slot clash", (r) => (r.facts[0].id = "rivals"), `facts[0].id: "rivals" is used twice (inputs and facts share their names).`],
    ["each cycle without one", (r) => ((r.steps = [r.steps[0], ...r.steps[1].steps]), delete r.roles.consultant.fresh), `inputs[4].each: "cycle" needs a repeating group in "steps".`],
    ["fresh cycle without one", (r) => ((r.steps = [r.steps[0], ...r.steps[1].steps]), delete r.inputs[4].each), `roles.consultant.fresh: "cycle" needs a repeating group in "steps".`],
    ["powers in this chat", (r) => (r.run.where = "this-chat"), `run.where: a playbook that asks for powers runs in a new chat (a chat's powers are fixed at its first message); use "new-chat" or leave it out.`],
    ["bad power", (r) => (r.run.permissions.grant = ["everything"]), /^run\.permissions\.grant: must be a list of /],
    ["create mode", (r) => (r.run.mode = "create"), `run.mode: a playbook never runs in Create mode; use "normal" or "delegate".`],
    ["unknown command", (r) => r.commands.push("no.such"), "commands[2]: must be a command id from Sova's catalogue (`sova list`)."],
    ["a command twice", (r) => r.commands.push("session.create"), `commands[2]: "session.create" is listed twice.`],
    ["steps and machine", (r) => (r.machine = {}), `playbook.json: has both "steps" and "machine"; use one.`],
    ["helpers without steps", (r) => delete r.steps, `playbook.json: declares helper roles but no "steps" (or "machine") that use them.`],
  ];
  for (const [name, mutate, expected] of cases) {
    const raw = clone(FULL);
    mutate(raw);
    const got = err(raw);
    if (typeof expected === "string") assert.equal(got, expected, name);
    else assert.match(got, expected, name);
  }
});

const MACHINE = {
  version: 1,
  roles: { judge: { label: "Judge", prompt: "roles/judge.md" } },
  machine: {
    initial: "find",
    states: {
      find: { label: "Find the version", on: { found: "research", "nothing-to-do": "quiet" } },
      research: { label: "Research", roles: ["main", "judge"], phase: "phases/research.md", on: { incomplete: { to: "research", when: "the judge finds gaps", limit: 3 }, done: "report" } },
      report: { label: "The report", stop: "always", report: "verdict", on: { yes: "upgrade", no: "end" } },
      upgrade: { label: "Upgrade", on: { done: "end" } },
      end: { label: "Done" },
      quiet: { label: "Nothing to do", quiet: true },
    },
  },
};

test("a state machine is read and checked: every move lands on a state, every state is reachable and can finish", () => {
  const s = ok(MACHINE);
  assert.deepEqual(s.steps, []);
  assert.equal(s.machine?.initial, "find");
  assert.deepEqual(s.machine?.states.find((x) => x.id === "research")?.on.incomplete, { to: "research", when: "the judge finds gaps", limit: 3 });
  assert.equal(s.machine?.states.find((x) => x.id === "research")?.team, false);
  const cases: [(m: any) => void, string][] = [
    [(m) => (m.initial = "nope"), `machine.initial: must name a state: "find", "research", "report", "upgrade", "end", "quiet".`],
    [(m) => (m.states.find.on.found = "nowhere"), `machine.states.find.on.found: moves to "nowhere", which isn't a state: "find", "research", "report", "upgrade", "end", "quiet".`],
    [(m) => delete m.states.find.on.found, `machine.states: "research", "report", "upgrade", "end" can't be reached from "find".`],
    [(m) => (m.states.upgrade.on = { again: "upgrade" }), `machine.states: from "upgrade" the run can never finish.`],
    [(m) => (m.states.report.quiet = true), "machine.states.report.quiet: only a final state (no moves) can end quietly."],
    [(m) => (m.states.find.on.Found = "research"), "machine.states.find.on.Found: an event's name is lowercase letters, digits and dashes."],
  ];
  for (const [mutate, expected] of cases) {
    const raw = clone(MACHINE);
    mutate(raw.machine);
    assert.equal(err(raw), expected);
  }
});

test("the folder check names each page the description points at that isn't there", () => {
  const s = ok(FULL);
  const all = ["PLAYBOOK.md", "roles/consultant.md", "roles/runner.md", "roles/grader.md", "phases/measure.md", "phases/stop-rule.md"];
  assert.deepEqual(validatePlaybookFiles(s, all), []);
  assert.deepEqual(validatePlaybookFiles(s, all.filter((f) => f !== "roles/grader.md" && f !== "phases/stop-rule.md")), [
    `roles.grader.prompt: "roles/grader.md" isn't in the playbook's folder.`,
    `steps[1].repeat.rule: "phases/stop-rule.md" isn't in the playbook's folder.`,
  ]);
  const m = ok(MACHINE);
  assert.deepEqual(validatePlaybookFiles(m, ["roles/judge.md"]), [`machine.states.research.phase: "phases/research.md" isn't in the playbook's folder.`]);
});

test("cycle settings on the card: ask-every never past the cap, the cap within 1 to 50", () => {
  for (const max of [0, 1, 50, 51]) for (const askEvery of [0, 1, max, max + 1]) {
    const fine = max >= 1 && max <= 50 && askEvery >= 1 && askEvery <= max;
    assert.equal(checkCycleSettings({ max, askEvery, until: "rule" }) === null, fine, `${max}/${askEvery}`);
  }
});

test("input values: what each type accepts, and the words a prompt's slot gets", () => {
  const s = ok(FULL);
  const input = (id: string) => s.inputs.find((x) => x.id === id)!;
  assert.equal(checkInputValue(input("rivals"), 2), null);
  assert.equal(checkInputValue(input("rivals"), 2.5), "Rival consultants: must be a whole number.");
  assert.equal(checkInputValue(input("kind"), "c"), "Kind: must be one of A, B.");
  assert.equal(checkInputValue(input("knobs"), ["a", "a"]), "Knobs: must be some of its options.");
  assert.equal(checkInputValue(input("fast"), "yes"), "Fast: must be on or off.");
  assert.equal(inputValueText(input("knobs"), ["a", "b"]), "A, B");
  assert.equal(inputValueText(input("fast"), false), "no");
  assert.equal(inputValueText(input("cases"), ["one", "two"]), "- one\n- two");
  assert.equal(inputValueText(input("testModels"), input("testModels").default as never), "zai/glm-5.3 (low)");
});

test("a helper's prompt {{slots}} name an input, a fact, run or note; {{each}} only where there are several", () => {
  const s = ok({
    version: 1,
    inputs: [{ id: "target", label: "T", type: "text" }],
    facts: [{ id: "latest", label: "L" }],
    roles: { one: { label: "One", prompt: "roles/one.md" }, many: { label: "Many", prompt: "roles/many.md", count: 2 } },
    steps: [{ id: "s", label: "S", roles: ["one", "many"] }],
  });
  const all = "{{target}} {{ latest }} {{run}} {{folder}} {{note}}";
  assert.deepEqual(validatePromptSlots(s, { "roles/one.md": all, "roles/many.md": `${all} {{each}}` }), []);
  assert.deepEqual(validatePromptSlots(s, { "roles/one.md": "{{versoin}} {{each}}", "roles/many.md": "{{each}}" }), [
    `roles.one.prompt: "{{versoin}}" isn't an input or fact ("target", "latest", "run", "folder", "note").`,
    `roles.one.prompt: "{{each}}" is only for a role with "count" or "per".`,
  ]);
});
