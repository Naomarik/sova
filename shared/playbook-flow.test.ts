// A playbook's flow drawing for its card: derived from the parsed playbook.json alone, the same
// playbook always gives the same source, and every source reads cleanly in Sova's own vis parser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cycleOf, parsePlaybookSpec, stepsOf, type PlaybookSpec } from "./playbook-format";
import { playbookFlowSource, type FlowOptions, type FlowSource } from "./playbook-flow";
import { parseVis } from "../src/vis/parse";

const ok = (raw: unknown): PlaybookSpec => {
  const r = parsePlaybookSpec(raw);
  if ("error" in r) throw new Error(r.error);
  return r;
};
/** The source as the vis renderer reads it: no refusal, no warning; its nodes and edges. */
function drawn(src: FlowSource) {
  const r = parseVis(src.kind, src.body);
  assert.ok(r.ok, `vis refused it: ${!r.ok ? `line ${r.line}: ${r.message}` : ""}\n${src.body}`);
  assert.deepEqual(r.warnings, [], src.body);
  return r.spec as unknown as { nodes: { id: string; label: string; note?: string; tone?: string; shape: string }[]; edges: { from: string; to: string; label?: string; dashed: boolean }[]; groups?: { label: string; nodes: string[] }[]; caption?: string; title?: string };
}

const STEPS_RAW = {
  version: 1,
  teams: {
    bench: { label: "Bench", goal: "Run and grade", members: { runner: { label: "Runner", brief: "Runs one model" } } },
    fixers: { label: "Fixers", goal: "Propose a fix" },
  },
  steps: [
    { id: "measure", label: "Agree what \"good\" is", stop: "always" },
    { id: "cycle", label: "Improve", repeat: { max: 5, askEvery: 2, rule: "two rounds without a win" }, steps: [
      { id: "fix", label: "Fix", teams: ["fixers"] },
      { id: "run", label: "Run and score", teams: ["bench", "fixers"], stop: "optional", startsOff: true },
    ] },
    { id: "review", label: "Review", teams: ["bench"], stop: "optional" },
  ],
};
const STEPS = ok(STEPS_RAW);

test("the same playbook gives the same source, and it reads in Sova's vis flow", () => {
  const a = playbookFlowSource(STEPS, { title: "A/B cycle" });
  assert.deepEqual(playbookFlowSource(ok(JSON.parse(JSON.stringify(STEPS_RAW))), { title: "A/B cycle" }), a, "parsed again, the same source");
  assert.equal(a.kind, "flow");
  const d = drawn(a);
  assert.equal(d.title, "A/B cycle");
  assert.deepEqual(d.nodes.map((n) => [n.label, n.note]), [
    ['Agree what "good" is', "Main chat · stops for you"],
    ["Fix", "Fixers"],
    ["Run and score", "Bench + Fixers · optional stop: off"],
    ["Review", "Bench · optional stop: on"],
  ], "steps in order, the teams in each, every stop point marked always or optional");
});

test("a stop's mark follows the card: an optional stop you turn on reads on", () => {
  const d = drawn(playbookFlowSource(STEPS, { stops: { run: true, review: false } }));
  assert.deepEqual(d.nodes.slice(2).map((n) => n.note), ["Bench + Fixers · optional stop: on", "Bench · optional stop: off"]);
});

test("the repeating group is a framed loop labelled with its cap and how often it asks; the card's settings win", () => {
  const d = drawn(playbookFlowSource(STEPS));
  const id = (label: string) => d.nodes.find((n) => n.label === label)!.id;
  assert.deepEqual(d.groups?.map((g) => [g.label, g.nodes]), [["Improve (repeats)", [id("Fix"), id("Run and score")]]]);
  const back = d.edges.find((e) => e.from === id("Run and score") && e.to === id("Fix"));
  assert.deepEqual([back?.dashed, back?.label], [true, "again: at most 5 · asks you every 2 · or until its stop rule"]);
  assert.ok(d.edges.some((e) => e.from === id("Run and score") && e.to === id("Review") && !e.dashed), "the run leaves the loop to the next step");
  const edited = drawn(playbookFlowSource(STEPS, { cycle: { max: 3, askEvery: 1, until: "max" } }));
  assert.ok(edited.edges.some((e) => e.label === "again: at most 3 · asks you after each"));
});

const MACHINE = ok({
  version: 1,
  teams: { research: { label: "Research team", goal: "Read every entry" } },
  machine: {
    initial: "find",
    states: {
      find: { label: "Find the version", on: { found: "research", "nothing-to-do": "quiet" } },
      research: { label: "Research", teams: ["research"], on: { incomplete: { to: "research", limit: 3 }, done: "report" } },
      report: { label: "Report", stop: "always", on: { yes: "end", no: "end" } },
      end: { label: "Done" },
      quiet: { label: "Nothing to do", quiet: true },
    },
  },
});

test("a machine is drawn as a state diagram from its states and named moves", () => {
  const src = playbookFlowSource(MACHINE);
  assert.equal(src.kind, "state");
  const d = drawn(src);
  const label = (id: string) => d.nodes.find((n) => n.id === id)?.label;
  assert.deepEqual(d.edges.map((e) => [label(e.from) ?? e.from, label(e.to) ?? e.to, e.label ?? ""]).filter(([, , l]) => l), [
    ["Find the version", "Research", "found"],
    ["Find the version", "Nothing to do", "nothing-to-do"],
    ["Research", "Research", "incomplete (at most 3×)"],
    ["Research", "Report", "done"],
    ["Report", "Done", "yes"],
    ["Report", "Done", "no"],
  ]);
  assert.deepEqual(d.nodes.filter((n) => n.note).map((n) => [n.label, n.note]), [
    ["Find the version", "Main chat"],
    ["Research", "Research team"],
    ["Report", "Main chat · stops for you"],
    ["Done", "Main chat"],
    ["Nothing to do", "ends quietly"],
  ]);
});

test("progress colours what is known; a run that knows only started or stopped says so and colours nothing", () => {
  const tones = (o: FlowOptions) => drawn(playbookFlowSource(STEPS, o)).nodes.map((n) => n.tone ?? "");
  assert.deepEqual(tones({ progress: { current: "run", done: ["measure", "fix"], state: "running", cycle: 2 } }), ["ok", "ok", "accent", ""]);
  const bare = drawn(playbookFlowSource(STEPS, { progress: { state: "stopped" } }));
  assert.deepEqual([bare.caption, bare.nodes.map((n) => n.tone ?? "")], ["Stopped", ["", "", "", ""]]);
  assert.equal(drawn(playbookFlowSource(STEPS, { progress: { state: "running", cycle: 2 } })).caption, "Running · cycle 2");
  assert.deepEqual(drawn(playbookFlowSource(MACHINE, { progress: { current: "research", done: ["find"] } })).nodes.filter((n) => n.tone).map((n) => [n.label, n.tone]), [["Find the version", "ok"], ["Research", "accent"]]);
});

test("the shipped playbooks draw cleanly: A/B cycle and Pi upgrade", () => {
  for (const file of ["../playbooks/ab-cycle/playbook.json", "../.sova/playbooks/pi-upgrade/playbook.json"]) {
    const spec = ok(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")));
    const d = drawn(playbookFlowSource(spec, { title: file }));
    const want = spec.machine ? spec.machine.states.map((x) => x.label) : stepsOf(spec.steps).map((x) => x.label);
    assert.deepEqual(d.nodes.filter((n) => n.shape !== "start" && n.shape !== "end").map((n) => n.label), want, `${file}: every step drawn, in order`);
    const c = cycleOf(spec);
    if (c) assert.ok(d.groups?.some((g) => g.label === `${c.label} (repeats)` && g.nodes.length === c.steps.length), `${file}: its repeating group is framed`);
  }
});
