import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookRoleView, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";
import type { PlaybookInfo } from "../../shared/protocol";
import {
  cardChip,
  cycleLine,
  cycleStepsLine,
  foldedLine,
  hasEdits,
  playbookCommandIn,
  playbookRows,
  playbooksRunHere,
  runStatus,
  controlLabel,
  type RunChatNow,
  withPlaybookRows,
  withoutPlaybookRows,
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

test("the cycle's steps by number: one repeats, several repeat", () => {
  assert.equal(cycleStepsLine([3]), "Step 3 repeats");
  assert.equal(cycleStepsLine([3, 4]), "Steps 3 and 4 repeat");
  assert.equal(cycleStepsLine([3, 4, 5]), "Steps 3, 4, and 5 repeat");
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

test("a started run's state is its conducting chat's: a question wins over nothing going on, work over both, and only a chat with nothing running takes an answer", () => {
  const started = { state: "started", startBlocked: "This run has started." } as PlaybookRunView;
  const now = (extra: Partial<RunChatNow> = {}): RunChatNow => ({ working: false, helpersWorking: 0, needsYou: null, done: false, ...extra });
  // Every reading of the chat, by what it holds: the label and whether the card takes an answer.
  const rows: [Partial<RunChatNow>, string, boolean][] = [
    [{ working: true }, "Running", false],
    [{ working: true, needsYou: "A question waits.", done: true }, "Running", false],
    [{ helpersWorking: 2 }, "Running", false],
    [{ helpersWorking: 1, needsYou: "A question waits." }, "Running", false],
    [{ needsYou: "A question waits." }, "Needs you", true],
    [{ needsYou: "A question waits.", done: true }, "Needs you", true],
    [{ done: true }, "Done", false],
    [{}, "Idle", true],
  ];
  for (const [chat, label, answer] of rows) {
    const s = runStatus(started, now(chat));
    assert.equal(s.label, label, JSON.stringify(chat));
    assert.equal(!!s.answer, answer, JSON.stringify(chat));
    assert.equal(!!s.live, label === "Running", JSON.stringify(chat));
  }
  assert.equal(runStatus(started, now({ working: true, helpersWorking: 3 })).detail, "This chat is working, with 3 helpers working.");
  assert.equal(runStatus(started, now({ helpersWorking: 1 })).detail, "1 helper working; this chat picks up when they report.");
  assert.equal(runStatus(started, now({ needsYou: "A dialog is waiting on you." })).detail, "A dialog is waiting on you.");
});

test("a run with no reading of its chat says only what the run itself knows: its draft state, starting, or started", () => {
  const v = (extra: Partial<PlaybookRunView>) => ({ state: "draft", startBlocked: null, ...extra }) as PlaybookRunView;
  const busy: RunChatNow = { working: true, helpersWorking: 2, needsYou: null, done: false };
  // A draft's state never reads the chat, whatever the chat is doing.
  for (const now of [null, busy]) {
    assert.equal(runStatus(v({}), now).label, "Ready to start");
    assert.equal(runStatus(v({ startBlocked: "Pick a test model." }), now).label, "Can't start yet");
    assert.equal(runStatus(v({ state: "starting" }), now).label, "Starting");
  }
  assert.deepEqual(runStatus(v({ state: "started" }), null), { label: "Started", tone: "accent" });
  assert.equal(controlLabel("A/B cycle", { label: "Needs you" }, false), "A/B cycle: Needs you. Open its card.");
  assert.equal(controlLabel("A/B cycle", { label: "Running" }, true), "A/B cycle: Running. Minimize its card.");
});

test("a typed playbook command is the whole message's start, by a name that has a card", () => {
  const names = new Set(["ab-cycle"]);
  assert.deepEqual(playbookCommandIn("/ab-cycle", names), { name: "ab-cycle", words: "" });
  assert.deepEqual(playbookCommandIn("  /ab-cycle tool text,\nthree cycles ", names), { name: "ab-cycle", words: "tool text,\nthree cycles" });
  assert.equal(playbookCommandIn("/ab-cyclex", names), null);
  assert.equal(playbookCommandIn("run /ab-cycle", names), null);
  assert.equal(playbookCommandIn("/other", names), null);
});

test("a started card's folded line says its revision, when and where it runs", () => {
  const v = { state: "started", startBlocked: "This run has started.", started: { at: "2026-11-17T00:27:00Z", revision: 3, chat: { id: "c", path: "/a.jsonl" }, newChat: false, folder: "/f" } } as unknown as PlaybookRunView;
  const clock = () => "00:27";
  assert.equal(foldedLine(v, "/a.jsonl", clock), "Revision 3, started 00:27 in this chat");
  assert.equal(foldedLine(v, "/b.jsonl", clock), "Revision 3, started 00:27 in another chat");
  assert.equal(foldedLine({ ...v, started: { ...v.started!, chat: { id: "c", path: "/a.jsonl", title: "Card check run" } } }, "/b.jsonl", clock), "Revision 3, started 00:27 in Card check run");
});

test("the page's / rows: playbooks with a description (or a broken one), the project's shelf first; the chat's own names win", () => {
  const pb = (source: "sova" | "user" | "project", id: string, extra: Record<string, unknown> = {}) => ({ source, id, title: id, dir: `/${source}/${id}`, body: "", description: "", ...extra }) as unknown as PlaybookInfo;
  const rows = playbookRows([pb("sova", "ab-cycle", { spec: {} }), pb("project", "ab-cycle", { spec: {} }), pb("sova", "plain"), pb("user", "broken", { specError: "x" })]);
  assert.deepEqual(rows.map((r) => [r.name, r.playbook?.source]), [["ab-cycle", "project"], ["broken", "user"]]);
  const merged = withPlaybookRows([{ name: "broken", source: "prompt" }, { name: "compact", source: "builtin" }], rows);
  assert.deepEqual(merged.map((r) => [r.name, r.source]), [["broken", "prompt"], ["compact", "builtin"], ["ab-cycle", "builtin"]]);
  // Where no playbooks run, every playbook row goes, the server's included; the chat's own stay.
  assert.deepEqual(withoutPlaybookRows(merged).map((r) => r.name), ["broken", "compact"]);
});

test("playbook cards run in ordinary chats only: never the Overseer, a project overseer or a baton chat", () => {
  assert.equal(playbooksRunHere({}), true);
  assert.equal(playbooksRunHere({ overseer: true }), false);
  assert.equal(playbooksRunHere({ projectOverseer: true }), false);
  assert.equal(playbooksRunHere({ baton: true }), false);
});
