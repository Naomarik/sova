// A playbook's description file: the strict parse (every key known
// at every level, every reference checked, the exact path and fault), the folder check, and input values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCycleSettings, checkInputValue, cycleOf, fillSlots, inputValueText, membersOf, parsePlaybookSpec, stepsOf, validatePlaybookFiles, type PlaybookSpec } from "./playbook-format";

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
  teams: {
    fixers: { label: "Fixers", goal: "Propose a fix for {{target}}", members: {
      consultant: { label: "Consultant", brief: "Proposes the fix", kind: "planning", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "claude-code/claude-fable-5-2" }], count: { input: "rivals" }, fresh: "cycle" },
    } },
    bench: { goal: "Run and grade every arm", members: {
      runner: { label: "Runner", brief: "Runs one test model", notes: "references/roles/runner.md", kind: "routine", per: { input: "testModels" }, only: true, models: [{ model: "zai/glm-5.3", effort: "low" }] },
      grader: { label: "Grader", brief: "Grades blind", kind: "investigation", sees: "blind", optional: true, startsOff: true, count: 1 },
    } },
    scouts: { goal: "Find what changed since {{latest}}" },
  },
  steps: [
    { id: "measure", label: "Agree what is measured", goal: "A chart of {{target}}", teams: ["scouts"], stop: "always", asks: ["the bars change"], report: "chart", phase: "phases/measure.md" },
    { id: "cycle", label: "Improve and re-test", repeat: { max: 5, askEvery: 2, until: "rule", rule: "phases/stop-rule.md", carry: "the winner is the next base" }, steps: [
      { id: "fix", label: "Fix", teams: ["fixers"] },
      { id: "run", label: "Run", teams: ["bench"], stop: "optional", startsOff: true },
      { id: "talk", label: "Talk it over" },
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
  assert.deepEqual(s.teams.map((t) => [t.id, t.label, t.goal, t.members.map((m) => m.id)]), [
    ["fixers", "Fixers", "Propose a fix for {{target}}", ["consultant"]],
    ["bench", "bench", "Run and grade every arm", ["runner", "grader"]],
    ["scouts", "scouts", "Find what changed since {{latest}}", []],
  ], "a team without members is its goal alone; an unnamed team is called by its id");
  const [consultant, runner, grader] = membersOf(s);
  assert.deepEqual([runner!.team, runner!.brief, runner!.notes], ["bench", "Runs one test model", "references/roles/runner.md"]);
  assert.ok(consultant);
  assert.deepEqual(consultant!.models.map((m) => m.choice), [{ backend: "claude-code", model: "claude-opus-5-5", effort: "high" }, { backend: "claude-code", model: "claude-fable-5-2", effort: "medium" }], "an entry naming no effort gets the default, never an empty one");
  assert.deepEqual(runner!.models[0]!.choice, { backend: "pi", model: "zai/glm-5.3", effort: "low" });
  assert.deepEqual(consultant!.count, { input: "rivals" });
  assert.deepEqual(grader!.count, { n: 1 });
  assert.equal(cycleOf(s)?.settings.askEvery, 2);
  assert.deepEqual(stepsOf(s.steps).map((x) => [x.id, x.teams, x.goal]), [["measure", ["scouts"], "A chart of {{target}}"], ["fix", ["fixers"], undefined], ["run", ["bench"], undefined], ["talk", [], undefined]], "a step without teams is the main chat's alone");
  assert.deepEqual(s.commands, ["session.create", "session.list"], "a command that only looks may be listed too: looking is free");
});

test("a description that sets nothing else is a plain playbook: no teams, nothing declared about the main chat", () => {
  const s = ok({ version: 1, listed: false });
  assert.equal(s.listed, false);
  assert.deepEqual(s.run, { where: "this-chat", whereFixed: false, worktree: "none", needs: [] });
  assert.deepEqual([s.teams, s.steps, s.inputs, s.facts, s.commands], [[], [], [], [], []]);
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
  const paths = objectPaths(FULL, "playbook.json").filter((p) => p !== "teams" && !p.endsWith(".members") && !p.endsWith(".on")); // their keys are names
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
    ["effort", (r) => (r.teams.fixers.members.consultant.models[1].effort = "huge"), `teams.fixers.members.consultant.models[1].effort: must be one of "off", "minimal", "low", "medium", "high", "xhigh", "max".`],
    ["model ref", (r) => (r.teams.bench.members.runner.models[0].model = "glm"), `teams.bench.members.runner.models[0].model: must be a model ref, "provider/id" ("claude-code/claude-opus-5-5", "zai/glm-5.3").`],
    ["repeated model", (r) => r.teams.bench.members.runner.models.push({ model: "zai/glm-5.3", effort: "low" }), "teams.bench.members.runner.models[1]: repeats zai/glm-5.3."],
    ["only without models", (r) => ((r.teams.bench.members.grader.only = true), delete r.teams.bench.members.grader.models), `teams.bench.members.grader.only: "only these models" needs a "models" list.`],
    ["member without brief", (r) => delete r.teams.bench.members.grader.brief, "teams.bench.members.grader.brief: is required: one line saying what this member is for."],
    ["brief of two lines", (r) => (r.teams.bench.members.grader.brief = "Grades\nblind"), "teams.bench.members.grader.brief: is one line."],
    ["brief too long", (r) => (r.teams.bench.members.grader.brief = "x".repeat(161)), "teams.bench.members.grader.brief: is at most 160 characters."],
    ["team without goal", (r) => delete r.teams.scouts.goal, "teams.scouts.goal: is required: one line saying what the team is for."],
    ["a prompt page", (r) => (r.teams.bench.members.grader.prompt = "roles/grader.md"), /^teams\.bench\.members\.grader: unknown key "prompt" \(a member has a one-line "brief", not a prompt page; working detail goes in a "notes" page under references\/\)\. Known: /],
    ["old roles", (r) => (r.roles = {}), /^playbook\.json: unknown key "roles" \("roles" is now "teams": each team has a goal and the members it must have\)\. Known: /],
    ["old step roles", (r) => (r.steps[0].roles = ["main"]), /^steps\[0\]: unknown key "roles" \(/],
    ["main as a team", (r) => (r.teams.main = { goal: "g" }), "teams.main: the main chat is the one you chose; a playbook doesn't declare it."],
    ["main as a member", (r) => (r.teams.scouts.members = { main: { label: "M", brief: "b" } }), "teams.scouts.members.main: the main chat is the one you chose; a playbook doesn't declare it."],
    ["member named twice", (r) => (r.teams.scouts.members = { grader: { label: "G", brief: "b" } }), `teams.scouts.members.grader: "grader" is already a member of team "bench"; a member's name is unique in the playbook.`],
    ["member named as a team", (r) => (r.teams.scouts.members = { bench: { label: "B", brief: "b" } }), `teams.scouts.members.bench: "bench" is a team's name; a member's name is unique in the playbook.`],
    ["notes outside", (r) => (r.teams.bench.members.runner.notes = "../x.md"), `teams.bench.members.runner.notes: must be a markdown file inside the playbook's folder, like "phases/measure.md".`],
    ["count and per", (r) => (r.teams.bench.members.runner.count = 2), `teams.bench.members.runner: has "count" and "per"; use one.`],
    ["count names a text", (r) => (r.teams.fixers.members.consultant.count = { input: "target" }), `teams.fixers.members.consultant.count.input: must name a number input ("rivals").`],
    ["per names a number", (r) => (r.teams.bench.members.runner.per = { input: "rivals" }), `teams.bench.members.runner.per.input: must name a multi, list or models input ("knobs", "cases", "testModels").`],
    ["startsOff not optional", (r) => (r.teams.bench.members.grader.optional = false), `teams.bench.members.grader.startsOff: needs "optional": true (only a member you may turn off can start off).`],
    ["unknown team in a step", (r) => r.steps[0].teams.push("judges"), `steps[0].teams[1]: must be a declared team: "fixers", "bench", "scouts".`],
    ["team twice in a step", (r) => r.steps[0].teams.push("scouts"), `steps[0].teams[1]: "scouts" is named twice.`],
    ["unused team", (r) => (r.teams.extra = { goal: "Spare" }), "teams.extra: no step names it."],
    ["slot in a goal", (r) => (r.teams.scouts.goal = "Find {{nope}}"), `teams.scouts.goal: "{{nope}}" isn't an input or fact ("target", "rivals", "fast", "kind", "knobs", "cases", "testModels", "latest").`],
    ["slot in a step goal", (r) => (r.steps[1].steps[0].goal = "Fix {{run}}"), `steps[1].steps[0].goal: "{{run}}" isn't an input or fact ("target", "rivals", "fast", "kind", "knobs", "cases", "testModels", "latest").`],
    ["two groups", (r) => r.steps.push(clone(FULL.steps[1])), `steps[2]: a playbook has at most one repeating group ("cycle" is one).`],
    ["nested group", (r) => r.steps[1].steps.push({ id: "in", label: "In", repeat: { max: 2 }, steps: [] }), "steps[1].steps[3]: a repeating group holds plain steps only."],
    ["askEvery past max", (r) => (r.steps[1].repeat.askEvery = 6), "steps[1].repeat.askEvery: must be a whole number from 1 to 5."],
    ["until rule without one", (r) => delete r.steps[1].repeat.rule, `steps[1].repeat.until: "rule" needs the stop rule in "rule".`],
    ["optional stop off", (r) => (r.steps[0].startsOff = true), `steps[0].startsOff: needs "stop": "optional" (only an optional stop can start off).`],
    ["duplicate step id", (r) => (r.steps[1].steps[0].id = "measure"), `steps: the step id "measure" is used twice.`],
    ["choice default", (r) => (r.inputs[3].default = "c"), `inputs[3].default: must be one of the options' ids: "a", "b".`],
    ["number default", (r) => (r.inputs[1].default = 4), "inputs[1].default: must be from 1 to 3."],
    ["slot clash", (r) => (r.facts[0].id = "rivals"), `facts[0].id: "rivals" is used twice (inputs and facts share their names).`],
    ["each cycle without one", (r) => ((r.steps = [r.steps[0], ...r.steps[1].steps]), delete r.teams.fixers.members.consultant.fresh), `inputs[4].each: "cycle" needs a repeating group in "steps".`],
    ["fresh cycle without one", (r) => ((r.steps = [r.steps[0], ...r.steps[1].steps]), delete r.inputs[4].each), `teams.fixers.members.consultant.fresh: "cycle" needs a repeating group in "steps".`],
    ["powers in this chat", (r) => (r.run.where = "this-chat"), `run.where: a playbook that asks for powers runs in a new chat (a chat's powers are fixed at its first message); use "new-chat" or leave it out.`],
    ["bad power", (r) => (r.run.permissions.grant = ["everything"]), /^run\.permissions\.grant: must be a list of /],
    ["create mode", (r) => (r.run.mode = "create"), `run.mode: a playbook never runs in Create mode; use "normal" or "delegate".`],
    ["unknown command", (r) => r.commands.push("no.such"), "commands[2]: must be a command id from Sova's catalogue (`sova list`)."],
    ["a command twice", (r) => r.commands.push("session.create"), `commands[2]: "session.create" is listed twice.`],
    ["steps and machine", (r) => (r.machine = {}), `playbook.json: has both "steps" and "machine"; use one.`],
    ["teams without steps", (r) => delete r.steps, `playbook.json: declares teams but no "steps" (or "machine") that use them.`],
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
  teams: { research: { goal: "Read every changelog entry", members: { judge: { label: "Judge", brief: "Says when the research is complete" } } } },
  machine: {
    initial: "find",
    states: {
      find: { label: "Find the version", on: { found: "research", "nothing-to-do": "quiet" } },
      research: { label: "Research", goal: "Complete research", teams: ["research"], phase: "phases/research.md", on: { incomplete: { to: "research", when: "the judge finds gaps", limit: 3 }, done: "report" } },
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
  assert.deepEqual(s.machine?.states.find((x) => x.id === "research")?.teams, ["research"]);
  const cases: [(m: any) => void, string][] = [
    [(m) => (m.initial = "nope"), `machine.initial: must name a state: "find", "research", "report", "upgrade", "end", "quiet".`],
    [(m) => (m.states.find.on.found = "nowhere"), `machine.states.find.on.found: moves to "nowhere", which isn't a state: "find", "research", "report", "upgrade", "end", "quiet".`],
    [(m) => delete m.states.find.on.found, `machine.states: "research", "report", "upgrade", "end" can't be reached from "find".`],
    [(m) => (m.states.upgrade.on = { again: "upgrade" }), `machine.states: from "upgrade" the run can never finish.`],
    [(m) => (m.states.report.quiet = true), "machine.states.report.quiet: only a final state (no moves) can end quietly."],
    [(m) => (m.states.find.on.Found = "research"), "machine.states.find.on.Found: an event's name is lowercase letters, digits and dashes."],
    [(m) => (m.states.find.teams = ["nobody"]), `machine.states.find.teams[0]: must be a declared team: "research".`],
  ];
  for (const [mutate, expected] of cases) {
    const raw = clone(MACHINE);
    mutate(raw.machine);
    assert.equal(err(raw), expected);
  }
});

test("the folder check names each page the description points at that isn't there", () => {
  const s = ok(FULL);
  const all = ["PLAYBOOK.md", "references/roles/runner.md", "phases/measure.md", "phases/stop-rule.md"];
  assert.deepEqual(validatePlaybookFiles(s, all), []);
  assert.deepEqual(validatePlaybookFiles(s, all.filter((f) => f !== "references/roles/runner.md" && f !== "phases/stop-rule.md")), [
    `teams.bench.members.runner.notes: "references/roles/runner.md" isn't in the playbook's folder.`,
    `steps[1].repeat.rule: "phases/stop-rule.md" isn't in the playbook's folder.`,
  ]);
  const m = ok(MACHINE);
  assert.deepEqual(validatePlaybookFiles(m, []), [`machine.states.research.phase: "phases/research.md" isn't in the playbook's folder.`]);
});

test("cycle settings on the card: ask-every never past the cap, the cap within 1 to 50", () => {
  for (const max of [0, 1, 50, 51]) for (const askEvery of [0, 1, max, max + 1]) {
    const fine = max >= 1 && max <= 50 && askEvery >= 1 && askEvery <= max;
    assert.equal(checkCycleSettings({ max, askEvery, until: "rule" }) === null, fine, `${max}/${askEvery}`);
  }
});

test("input values: what each type accepts, and the words a slot gets", () => {
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

test("a goal's {{slots}} fill with your choices' words; a slot with no words stays as written", () => {
  assert.equal(fillSlots("Find {{ latest }} for {{target}} and {{x}}", { latest: "1.5.0", target: "pi" }), "Find 1.5.0 for pi and {{x}}");
});
