import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookRoleView, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";
import type { PlaybookInfo, SlashCommand } from "../../shared/protocol";
import {
  cardChip,
  chatCard,
  chatHolding,
  heldListNote,
  heldRows,
  withoutOtherDrafts,
  cycleLine,
  cycleStepsLine,
  foldedLine,
  hasEdits,
  playbookCommandIn,
  playbookRows,
  playbooksRunHere,
  revealStep,
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
  stripLine,
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
  assert.equal(controlLabel("A/B cycle", { label: "Needs you" }), "A/B cycle: Needs you. Open its card.");
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

test("a strip's second line is how the conducting chat stands when the page reads it, else the run's own folded line", () => {
  const clock = () => "00:27";
  const started = { state: "started", startBlocked: "This run has started.", started: { at: "2026-11-17T00:27:00Z", revision: 3, chat: { id: "c", path: "/a.jsonl" }, newChat: false, folder: "/f" } } as unknown as PlaybookRunView;
  const now = (extra: Partial<RunChatNow> = {}): RunChatNow => ({ working: false, helpersWorking: 0, needsYou: null, done: false, ...extra });
  // Every reading of the conducting chat has a sentence, and the strip says exactly that sentence.
  for (const chat of [now({ working: true }), now({ helpersWorking: 2 }), now({ needsYou: "A question waits." }), now({ done: true }), now()]) {
    const status = runStatus(started, chat);
    assert.ok(status.detail, JSON.stringify(chat));
    assert.equal(stripLine(started, status, "/a.jsonl", clock), status.detail, JSON.stringify(chat));
  }
  // No reading of that chat (the strip is in the chat that only started it): the run's own line.
  assert.equal(stripLine(started, runStatus(started, null), "/b.jsonl", clock), foldedLine(started, "/b.jsonl", clock));
  assert.equal(stripLine(started, runStatus(started, null), "/b.jsonl", clock), "Revision 3, started 00:27 in another chat");
  // Before Start the chat's state is never the strip's line, whatever the chat is doing: what Start
  // needs, else the plan's size.
  const draft = { state: "draft", startBlocked: null, roles: [{ on: true }, { on: false }], steps: [{ stop: "always" }, { stop: "none" }] } as unknown as PlaybookRunView;
  const blocked = { ...draft, startBlocked: "Pick a test model." } as PlaybookRunView;
  for (const chat of [null, now({ working: true, helpersWorking: 2 })]) {
    assert.equal(stripLine(draft, runStatus(draft, chat), "/a.jsonl", clock), "1 roles · 2 steps · stops for you once");
    assert.equal(stripLine(blocked, runStatus(blocked, chat), "/a.jsonl", clock), "Pick a test model.");
    assert.equal(stripLine({ ...draft, state: "starting" } as PlaybookRunView, runStatus({ ...draft, state: "starting" } as PlaybookRunView, chat), "/a.jsonl", clock), "Starting…");
  }
  // A detail that isn't this run's (a draft handed a started run's reading) is never shown.
  assert.equal(stripLine(blocked, { detail: "This chat is working." }, "/a.jsonl", clock), "Pick a test model.");
});

test("a chat shows one card: the run it started or conducts wherever it sits in the list, else its newest draft", () => {
  const r = (id: string, state: string) => ({ id, state }) as PlaybookRunView;
  const started = [r("s", "started"), r("g", "starting")];
  const drafts = [r("d1", "draft"), r("d2", "draft")];
  assert.equal(chatCard([]), null);
  assert.equal(chatCard(drafts)?.id, "d1");
  // Whatever stands around it and in whatever order, the run that isn't a draft is the card.
  for (const run of started) {
    for (const list of [[run], [run, ...drafts], [...drafts, run], [drafts[0]!, run, drafts[1]!]]) assert.equal(chatCard(list)?.id, run.id, list.map((x) => x.id).join());
  }
});

test("a chat is held by a started or starting run, the server's word first; drafts hold nothing", () => {
  const r = (id: string, state: string, title = id) => ({ id, state, playbook: { title } }) as unknown as PlaybookRunView;
  const drafts = [r("d1", "draft"), r("d2", "draft")];
  assert.equal(chatHolding([], null), null);
  assert.equal(chatHolding(drafts, undefined), null);
  for (const state of ["started", "starting"]) assert.deepEqual(chatHolding([...drafts, r("s", state, "A/B cycle")]), { id: "s", title: "A/B cycle" }, state);
  // A run whose card was put away isn't among the chat's cards: only the server knows it.
  const away = { id: "pr_away", title: "Upgrade pi" };
  assert.deepEqual(chatHolding(drafts, away), away);
  assert.deepEqual(chatHolding([r("s", "started")], away), away);
});

test("opening a card makes the chat's other drafts give way; started runs and the opened card stay", () => {
  const r = (id: string, state: string) => ({ id, state }) as PlaybookRunView;
  const list = [r("d1", "draft"), r("d2", "draft"), r("s", "started"), r("g", "starting")];
  assert.deepEqual(withoutOtherDrafts(list, "d2").map((x) => x.id), ["d2", "s", "g"]);
  assert.deepEqual(withoutOtherDrafts(list, "s").map((x) => x.id), ["s", "g"]);
  assert.deepEqual(withoutOtherDrafts(list, "new").map((x) => x.id), ["s", "g"]);
});

test("in a chat a run holds, every playbook's / row says so and that it opens in a new chat; no other row changes", () => {
  const rows: SlashCommand[] = [
    { name: "compact", description: "Compact the session", source: "builtin" },
    { name: "ab-cycle", description: "A/B cycle", source: "builtin", playbook: { source: "sova", id: "ab-cycle" } },
    { name: "mine", description: "My own command", source: "extension" } as SlashCommand,
    { name: "pi-upgrade", description: "Upgrade pi", source: "builtin", playbook: { source: "project", id: "pi-upgrade" } },
  ];
  assert.deepEqual(heldRows(rows, null), rows);
  const held = heldRows(rows, { id: "pr_x", title: "A/B cycle" });
  assert.deepEqual(held.map((c) => c.name), rows.map((c) => c.name));
  for (const [i, c] of held.entries()) {
    if (rows[i]!.playbook) {
      assert.equal(c.description, "This chat already runs A/B cycle. Opens in a new chat.");
      // Still the row that opens that playbook: only its words changed.
      assert.deepEqual(c.playbook, rows[i]!.playbook);
    } else assert.deepEqual(c, rows[i]);
  }
  assert.deepEqual(heldListNote("A/B cycle"), { title: "This chat already runs A/B cycle.", body: "A chat runs one playbook. A playbook with a card opens in a new chat." });
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

test("Open Card goes to the pane that was clicked: the other pane never takes a put-away run's record", () => {
  const paneA = { pane: "A" };
  const paneB = { pane: "B" };
  // Clicked in B, the run put away (among neither pane's cards): B reads its record at once, A leaves it.
  assert.equal(revealStep({ id: "pr_1", store: paneB }, paneB, false), "record");
  assert.equal(revealStep({ id: "pr_1", store: paneB }, paneA, false), "skip");
  // Clicked in B, the run among both panes' cards: only B opens it.
  assert.equal(revealStep({ id: "pr_1", store: paneB }, paneB, true), "open");
  assert.equal(revealStep({ id: "pr_1", store: paneB }, paneA, true), "skip");
  // A way in that names no pane: the chat with the card opens it; else one reads the record after the others had their look.
  assert.equal(revealStep({ id: "pr_1" }, paneA, true), "open");
  assert.equal(revealStep({ id: "pr_1" }, paneA, false), "later");
});
