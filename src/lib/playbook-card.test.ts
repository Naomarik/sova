import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookRoleView, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";
import {
  cardChip,
  cycleLine,
  hasEdits,
  playbookCommandIn,
  roleWhy,
  splitChoices,
  stackEdits,
  stepRunsLine,
  stepsSummary,
  stopCount,
} from "./playbook-card";

const role = (extra: Partial<PlaybookRoleView> = {}): PlaybookRoleView => ({
  id: "runner",
  label: "Runner",
  main: false,
  count: 1,
  optional: false,
  on: true,
  only: false,
  chain: [],
  models: [],
  options: [],
  resolved: { model: "zai/glm-5.3", modelLabel: "glm-5.3", provider: "zai", effort: "low", source: "list" },
  runnable: true,
  note: "",
  prompt: "",
  ...extra,
});
const step = (extra: Partial<PlaybookStepView> = {}): PlaybookStepView => ({ id: "s", title: "S", stop: "never", stopOn: false, runs: "main", roles: [], ...extra });
const team: PlaybookTeamView = { id: "research", label: "Research", roles: ["a"], coordinator: { modelLabel: "Opus 5.5" }, monitor: { modelLabel: "Haiku 5.5" } };

test("every step says who runs it: the main chat, a team with its coordinator and monitor, or separate helpers by name", () => {
  const roles = [role({ id: "main", label: "Main chat", main: true }), role({ id: "runner", count: 3 }), role({ id: "grader", label: "Grader" }), role({ id: "judge", label: "Judge", optional: true, on: false })];
  assert.equal(stepRunsLine(step({ runs: "main" }), roles, [team]), "The main chat");
  assert.equal(stepRunsLine(step({ runs: "team", team: "research" }), roles, [team]), "A team, Research, with its coordinator and monitor");
  // A role turned off for this run isn't named.
  assert.equal(stepRunsLine(step({ runs: "helpers", roles: ["runner", "grader", "judge"] }), roles, [team]), "Separate helpers: Runner × 3, Grader");
});

test("stops count the always stops and the optional ones turned on", () => {
  const steps = [step({ stop: "always" }), step({ stop: "optional", stopOn: true }), step({ stop: "optional", stopOn: false }), step({ stop: "never", stopOn: true })];
  assert.equal(stopCount(steps), 2);
  assert.equal(stepsSummary(steps), "Steps · 4 · stops for you 2 times");
  assert.equal(stepsSummary([step({ stop: "always" })]), "Steps · 1 · stops for you once");
  assert.equal(stepsSummary([step()]), "Steps · 1 · never stops for you");
});

test("the cycle line says the cap and when it asks", () => {
  assert.equal(cycleLine({ steps: [], max: 5, maxCap: 10, askEvery: 1, until: "rule" }), "Up to 5 cycles; asks you after each cycle.");
  assert.equal(cycleLine({ steps: [], max: 3, maxCap: 10, askEvery: 3, until: "rule" }), "Up to 3 cycles; asks you after every 3 cycles.");
});

test("a role's why: the resolver's reason when it gave one, else where the model came from; only-roles say so", () => {
  assert.equal(roleWhy(role()), "First choice");
  assert.equal(roleWhy(role({ resolved: { model: "x/y", modelLabel: "y", provider: "x", source: "profile", reason: "Opus 5.5 is turned off, so your profile's model" } })), "Opus 5.5 is turned off, so your profile's model");
  assert.equal(roleWhy(role({ only: true })), "First choice · Only these models");
  assert.equal(roleWhy(role({ only: true, resolved: null, runnable: false })), "Only these models");
});

test("edits not yet saved stack: the later wins key by key, and a cleared pick stays an edit", () => {
  const a = stackEdits({ choices: { n: 1 }, roles: { r: { note: "x", pick: { model: "a/b" } } } }, { choices: { m: 2 }, roles: { r: { pick: null } } });
  assert.deepEqual(a, { choices: { n: 1, m: 2 }, roles: { r: { note: "x", pick: null } } });
  assert.equal(hasEdits({}), false);
  assert.equal(hasEdits({ choices: {} }), false);
  assert.equal(hasEdits(a), true);
});

test("optional choices go under More Options unless a required one is empty", () => {
  const c = (id: string, ask: "always" | "once" | "optional", required = false, value: unknown = "v") => ({ id, label: id, type: "text" as const, value, origin: "default" as const, required, ask });
  const { shown, more } = splitChoices([c("a", "always"), c("b", "once"), c("c", "optional"), c("d", "optional", true, null)]);
  assert.deepEqual(shown.map((x) => x.id), ["a", "b", "d"]);
  assert.deepEqual(more.map((x) => x.id), ["c"]);
});

test("the chip: ready, blocked, or started", () => {
  const v = (extra: Partial<PlaybookRunView>) => ({ state: "draft", startBlocked: null, ...extra }) as PlaybookRunView;
  assert.deepEqual(cardChip(v({})), { label: "Ready to start", tone: "success" });
  assert.deepEqual(cardChip(v({ startBlocked: "Pick a test model." })), { label: "Can't start yet", tone: "warn" });
  assert.deepEqual(cardChip(v({ state: "started" })), { label: "Started", tone: "accent" });
});

test("a typed playbook command is the whole message's start, by a name that has a card", () => {
  const names = new Set(["ab-cycle"]);
  assert.deepEqual(playbookCommandIn("/ab-cycle", names), { name: "ab-cycle", words: "" });
  assert.deepEqual(playbookCommandIn("  /ab-cycle tool text,\nthree cycles ", names), { name: "ab-cycle", words: "tool text,\nthree cycles" });
  assert.equal(playbookCommandIn("/ab-cyclex", names), null);
  assert.equal(playbookCommandIn("run /ab-cycle", names), null);
  assert.equal(playbookCommandIn("/other", names), null);
});
