import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybookMemberView, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";
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
  choiceOriginLine,
  isChatChoice,
  chatNowOf,
  controlLabel,
  type RunChatNow,
  withPlaybookRows,
  withoutPlaybookRows,
  cantRunCount,
  LEGACY_WHO_NOTE,
  flowNote,
  flowSummary,
  helpersLine,
  memberTitle,
  memberWhy,
  teamAddsLine,
  teamEyebrow,
  whoSummary,
  splitChoices,
  isFreeText,
  answerFoldLabel,
  stackEdits,
  stepRunsLine,
  stepsSummary,
  stripLine,
  stopCount,
} from "./playbook-card";

const member = (extra: Partial<PlaybookMemberView> = {}): PlaybookMemberView => ({
  id: "runner",
  label: "Runner",
  brief: "Runs the round's cases on one test model",
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
  ...extra,
});
const step = (extra: Partial<PlaybookStepView> = {}): PlaybookStepView => ({ id: "s", title: "S", stop: "never", stopOn: false, teams: [], ...extra });
const team = (extra: Partial<PlaybookTeamView> = {}): PlaybookTeamView => ({ id: "run", label: "Run", goal: "Run every case on every test model", steps: [], note: "", members: [member()], ...extra });

test("a step says who works in it: the main chat alone, one team, or its teams by name; a team the card doesn't have isn't named", () => {
  const teams = [team(), team({ id: "grade", label: "Grading" }), team({ id: "fix", label: "Fix" })];
  assert.equal(stepRunsLine(step(), teams), "The main chat");
  assert.equal(stepRunsLine(step({ teams: ["run"] }), teams), "Run team");
  assert.equal(stepRunsLine(step({ teams: ["run", "grade"] }), teams), "Run and Grading teams");
  assert.equal(stepRunsLine(step({ teams: ["fix", "run", "grade"] }), teams), "Fix, Run, and Grading teams");
  assert.equal(stepRunsLine(step({ teams: ["gone", "grade"] }), teams), "Grading team");
  assert.equal(stepRunsLine(step({ teams: ["gone"] }), teams), "The main chat");
  // An older run's team per step carries the step's own title: it isn't said twice.
  const own = [team({ id: "s1", label: "Find what fails" })];
  assert.equal(stepRunsLine(step({ title: "Find what fails", teams: ["s1"] }), own), "Its own team");
  assert.equal(stepRunsLine(step({ title: "Score the round", teams: ["s1"] }), own), "Find what fails team");
});

test("Who runs, folded: the teams and the required members as the server counted them, each singular at 1, no members said in words, no team the main chat alone; members that can't run are said", () => {
  assert.equal(whoSummary({ teams: 6, members: 8 }), "Who runs · 6 teams · 8 required members");
  assert.equal(whoSummary({ teams: 1, members: 1 }), "Who runs · 1 team · 1 required member");
  assert.equal(whoSummary({ teams: 2, members: 0 }), "Who runs · 2 teams · no required members");
  assert.equal(whoSummary({ teams: 1, members: 0 }), "Who runs · 1 team · no required members");
  assert.equal(whoSummary({ teams: 0, members: 0 }), "Who runs · the main chat alone");
  assert.equal(whoSummary({ teams: 2, members: 3 }, 1), "Who runs · 2 teams · 3 required members · 1 can't run");
  assert.equal(whoSummary({ teams: 2, members: 3 }, 0), "Who runs · 2 teams · 3 required members");
});

test("a member keeps Start off when it is on and none of its models can run; one turned off, or a team with no member, doesn't", () => {
  const blocked = member({ id: "g", only: true, resolved: null, runnable: false });
  assert.equal(cantRunCount([team(), team({ members: [] })]), 0);
  assert.equal(cantRunCount([team({ members: [member(), blocked] }), team({ members: [blocked] })]), 2);
  assert.equal(cantRunCount([team({ members: [{ ...blocked, optional: true, on: false }] })]), 0);
});

test("a team's block: its name and the steps it works in by their numbers over its goal; under its members, that it adds anyone else, and a team with none says so", () => {
  const steps = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" }), step({ id: "d" })];
  assert.equal(teamEyebrow(team({ steps: ["b"] }), steps), "Run team · step 2");
  assert.equal(teamEyebrow(team({ steps: ["a", "c"] }), steps), "Run team · steps 1 and 3");
  assert.equal(teamEyebrow(team({ steps: ["a", "c", "d"] }), steps), "Run team · steps 1, 3, and 4");
  assert.equal(teamEyebrow(team({ steps: [] }), steps), "Run team");
  assert.equal(teamEyebrow(team({ steps: ["gone"] }), steps), "Run team");
  assert.equal(teamAddsLine(team()), "The team adds anyone else it needs.");
  assert.equal(teamAddsLine(team({ members: [] })), "No required members: the team adds whoever it needs.");
});

test("a run started before teams had goals: its blocks are headed by the old team's name, so the line over it says only its steps, and no block says the team adds anyone", () => {
  const steps = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })];
  assert.equal(teamEyebrow(team({ steps: ["a", "c"] }), steps, true), "Steps 1 and 3");
  assert.equal(teamEyebrow(team({ steps: ["b"] }), steps, true), "Step 2");
  assert.equal(teamEyebrow(team({ steps: [] }), steps, true), "");
  assert.equal(teamAddsLine(team(), true), null);
  assert.equal(teamAddsLine(team({ members: [] }), true), null);
  // Its folded line counts groups and roles, never "required members", and says when it is from.
  assert.equal(whoSummary({ teams: 8, members: 12 }, 0, true), "Who runs · 8 groups · 12 roles · started before teams");
  assert.equal(whoSummary({ teams: 1, members: 1 }, 0, true), "Who runs · 1 group · 1 role · started before teams");
  assert.equal(whoSummary({ teams: 2, members: 0 }, 0, true), "Who runs · 2 groups · no roles · started before teams");
  assert.equal(whoSummary({ teams: 0, members: 0 }, 0, true), "Who runs · the main chat alone");
  assert.equal(whoSummary({ teams: 8, members: 12 }, 0, false), "Who runs · 8 teams · 12 required members");
  assert.equal(LEGACY_WHO_NOTE, "Started before teams had goals: these are the helpers it ran with, grouped as that run grouped them.");
});

test("a member run several times says how many; the helpers line counts where the run starts and says the coordinators and monitors are in it", () => {
  assert.equal(memberTitle(member()), "Runner");
  assert.equal(memberTitle(member({ count: 3 })), "Runner × 3");
  assert.equal(helpersLine({ total: 9, limit: 24 }), "Starts with 9 helpers, each team's coordinator and monitor included; a chat runs up to 24 at once.");
  assert.equal(helpersLine({ total: 1, limit: 24 }), "Starts with 1 helper, each team's coordinator and monitor included; a chat runs up to 24 at once.");
});

test("Flow, folded: its steps, the ones that repeat by number, or that the playbook is drawn as states; the note says what the drawing follows", () => {
  const steps = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })];
  const cycle = { steps: ["b", "c"], max: 5, maxCap: 10, askEvery: 1 };
  assert.equal(flowSummary({ flow: { kind: "flow", body: "" }, steps, cycle }), "Flow · 3 steps · steps 2 and 3 repeat");
  assert.equal(flowSummary({ flow: { kind: "flow", body: "" }, steps, cycle: { ...cycle, steps: ["b"] } }), "Flow · 3 steps · step 2 repeats");
  assert.equal(flowSummary({ flow: { kind: "flow", body: "" }, steps, cycle: null }), "Flow · 3 steps");
  assert.equal(flowSummary({ flow: { kind: "flow", body: "" }, steps: [step()], cycle: null }), "Flow · 1 step");
  assert.equal(flowSummary({ flow: { kind: "state", body: "" }, steps, cycle }), "Flow · states and the moves between them");
  assert.equal(flowNote("draft"), "Drawn from this card: change a stop or the cycle's settings and the drawing follows.");
  for (const state of ["starting", "started"] as const) assert.equal(flowNote(state), "The plan as it was at Start. Progress comes in the chat's messages.");
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

test("a member's why: the resolver's reason when it gave one, else where the model came from; only-these members say so", () => {
  assert.equal(memberWhy(member()), "First choice");
  assert.equal(memberWhy(member({ resolved: { model: "x/y", modelLabel: "y", provider: "x", source: "profile", reason: "Opus 5.5 is turned off, so your profile's model" } })), "Opus 5.5 is turned off, so your profile's model");
  assert.equal(memberWhy(member({ only: true })), "First choice · Only these models");
  assert.equal(memberWhy(member({ only: true, resolved: null, runnable: false })), "Only these models");
});

test("edits not yet saved stack: the later wins key by key, a member's and a team's fields one by one, and a cleared pick stays an edit", () => {
  const a = stackEdits({ choices: { n: 1 }, roles: { r: { note: "x", pick: { model: "a/b" } } }, teams: { t: { note: "first" } } }, { choices: { m: 2 }, roles: { r: { pick: null } }, teams: { t: { note: "second" }, u: { note: "" } } });
  assert.deepEqual(a, { choices: { n: 1, m: 2 }, roles: { r: { note: "x", pick: null } }, teams: { t: { note: "second" }, u: { note: "" } } });
  assert.equal(hasEdits({ teams: { t: { note: "" } } }), true);
  assert.equal(hasEdits({ teams: {} }), false);
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

test("only an answer in the person's own words folds: a text or a list, never a pick, a number, a switch or a set of models", () => {
  const folds = (["text", "number", "toggle", "choice", "multi", "list", "models"] as const).filter((type) => isFreeText({ type }));
  assert.deepEqual(folds, ["text", "list"]);
  assert.equal(answerFoldLabel(false), "Show All");
  assert.equal(answerFoldLabel(true), "Show Less");
});

test("the chip: ready, blocked, or started", () => {
  const v = (extra: Partial<PlaybookRunView>) => ({ state: "draft", startBlocked: null, ...extra }) as PlaybookRunView;
  assert.deepEqual(cardChip(v({})), { label: "Ready to start", tone: "success" });
  assert.deepEqual(cardChip(v({ startBlocked: "Pick a test model." })), { label: "Can't start yet", tone: "warn" });
  assert.deepEqual(cardChip(v({ state: "started" })), { label: "Started", tone: "accent" });
});

test("a started run's state is its conducting chat's: a question wins over nothing going on, work over both, and only a chat with nothing running takes an answer", () => {
  const started = { state: "started", startBlocked: "This run has started." } as PlaybookRunView;
  const now = (extra: Partial<RunChatNow> = {}): RunChatNow => ({ working: false, helpersWorking: 0, needsYou: null, ...extra });
  // Every reading of the chat, by what it holds: the label and whether the card takes an answer.
  const rows: [Partial<RunChatNow>, string, boolean][] = [
    [{ working: true }, "Running", false],
    [{ working: true, needsYou: "A question waits." }, "Running", false],
    [{ helpersWorking: 2 }, "Running", false],
    [{ helpersWorking: 1, needsYou: "A question waits." }, "Running", false],
    [{ needsYou: "A question waits." }, "Needs you", true],
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

test("a finished-looking chat reads Idle, never Done", () => {
  const started = { state: "started", startBlocked: "This run has started." } as PlaybookRunView;
  // The session list reads a chat whose last turn said the work is finished as Idle · Done. Phase 1
  // can't tell a finished run from one waiting at a stop, so the strip never claims Done.
  const now = chatNowOf({ state: "idle", reason: null, word: "Done" }, false, 0);
  assert.deepEqual(Object.keys(now).sort(), ["helpersWorking", "needsYou", "working"]);
  const s = runStatus(started, now);
  assert.equal(s.label, "Idle");
  assert.equal(s.answer, true, "it still takes Continue or Stop Here");
  assert.doesNotMatch(s.detail ?? "", /done/i);
  // An older reading that still says done changes nothing.
  assert.equal(runStatus(started, { ...now, done: true } as typeof now).label, "Idle");
});

test("a run with no reading of its chat says only what the run itself knows: its draft state, starting, or started", () => {
  const v = (extra: Partial<PlaybookRunView>) => ({ state: "draft", startBlocked: null, ...extra }) as PlaybookRunView;
  const busy: RunChatNow = { working: true, helpersWorking: 2, needsYou: null };
  // A draft's state never reads the chat, whatever the chat is doing.
  for (const now of [null, busy]) {
    assert.equal(runStatus(v({}), now).label, "Ready to start");
    assert.equal(runStatus(v({ startBlocked: "Pick a test model." }), now).label, "Can't start yet");
    assert.equal(runStatus(v({ state: "starting" }), now).label, "Starting");
  }
  assert.deepEqual(runStatus(v({ state: "started" }), null), { label: "Started", tone: "accent" });
  assert.equal(controlLabel("A/B cycle", { label: "Needs you" }), "A/B cycle: Needs you. Open its card.");
});

test("once Start is pressed the state says Starting, as the button does, until the server's answer", () => {
  const v = (extra: Partial<PlaybookRunView>) => ({ state: "draft", startBlocked: null, ...extra }) as PlaybookRunView;
  // Pressed: the card saves what you changed and sends Start; the run is still a draft meanwhile.
  assert.equal(runStatus(v({}), null, true).label, "Starting");
  assert.equal(runStatus(v({}), null, true).tone, "accent");
  // Not pressed, the same draft reads as before; the server's own starting and started win either way.
  assert.equal(runStatus(v({}), null, false).label, "Ready to start");
  assert.equal(runStatus(v({ state: "starting" }), null, false).label, "Starting");
  assert.equal(runStatus(v({ state: "started" }), null, true).label, "Started");
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

test("a draft's folded line: what keeps Start off, else its teams (one, several, or the main chat alone), its steps and its stops", () => {
  const draft = (who: PlaybookRunView["who"], startBlocked: string | null = null) => ({ state: "draft", startBlocked, who, steps: [{ stop: "always" }, { stop: "never" }, { stop: "never" }] }) as unknown as PlaybookRunView;
  assert.equal(foldedLine(draft({ teams: 6, members: 8 })), "6 teams · 3 steps · stops for you once");
  assert.equal(foldedLine(draft({ teams: 1, members: 0 })), "1 team · 3 steps · stops for you once");
  assert.equal(foldedLine(draft({ teams: 0, members: 0 })), "The main chat alone · 3 steps · stops for you once");
  assert.equal(foldedLine(draft({ teams: 6, members: 8 }, "Pick the test models.")), "Pick the test models.");
});

test("a strip's second line is how the conducting chat stands when the page reads it, else the run's own folded line", () => {
  const clock = () => "00:27";
  const started = { state: "started", startBlocked: "This run has started.", started: { at: "2026-11-17T00:27:00Z", revision: 3, chat: { id: "c", path: "/a.jsonl" }, newChat: false, folder: "/f" } } as unknown as PlaybookRunView;
  const now = (extra: Partial<RunChatNow> = {}): RunChatNow => ({ working: false, helpersWorking: 0, needsYou: null, ...extra });
  // Every reading of the conducting chat has a sentence, and the strip says exactly that sentence.
  for (const chat of [now({ working: true }), now({ helpersWorking: 2 }), now({ needsYou: "A question waits." }), now()]) {
    const status = runStatus(started, chat);
    assert.ok(status.detail, JSON.stringify(chat));
    assert.equal(stripLine(started, status, "/a.jsonl", clock), status.detail, JSON.stringify(chat));
  }
  // No reading of that chat (the strip is in the chat that only started it): the run's own line.
  assert.equal(stripLine(started, runStatus(started, null), "/b.jsonl", clock), foldedLine(started, "/b.jsonl", clock));
  assert.equal(stripLine(started, runStatus(started, null), "/b.jsonl", clock), "Revision 3, started 00:27 in another chat");
  // Before Start the chat's state is never the strip's line, whatever the chat is doing: what Start
  // needs, else the plan's size.
  const draft = { state: "draft", startBlocked: null, who: { teams: 1, members: 2 }, steps: [{ stop: "always" }, { stop: "none" }] } as unknown as PlaybookRunView;
  const blocked = { ...draft, startBlocked: "Pick a test model." } as PlaybookRunView;
  for (const chat of [null, now({ working: true, helpersWorking: 2 })]) {
    assert.equal(stripLine(draft, runStatus(draft, chat), "/a.jsonl", clock), "1 team · 2 steps · stops for you once");
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

test("a choice's origin line never says Your pick: a value you set says nothing, the others keep their words", () => {
  const c = (origin: string, required = false, value: unknown = "v", ask = "always") => ({ id: "x", label: "X", type: "text", value, origin, required, ask }) as never;
  assert.equal(choiceOriginLine(c("you")), "");
  assert.equal(choiceOriginLine(c("default")), "Default");
  assert.equal(choiceOriginLine(c("last")), "Same as last time");
  assert.equal(choiceOriginLine(c("standing")), "Your standing answer");
  assert.equal(choiceOriginLine(c("message")), "From your message");
  assert.equal(choiceOriginLine(c("you", true, "")), "Needed");
  // An optional empty choice says nothing.
  assert.equal(choiceOriginLine(c("default", false, "")), "");
});

test("a chat-filled choice: Needed while empty and required, From the chat once the chat filled it, its default as Default", () => {
  const c = (value: unknown, origin = "you", required = true) => ({ id: "f", label: "The failure to fix", type: "text", value, origin, required, ask: "chat" }) as never;
  assert.equal(isChatChoice(c("")), true);
  assert.equal(isChatChoice({ ask: "always" }), false);
  assert.equal(choiceOriginLine(c(null)), "Needed");
  assert.equal(choiceOriginLine(c(null, "default", false)), "");
  assert.equal(choiceOriginLine(c("Cheap models pick the wrong chart.")), "From the chat");
  assert.equal(choiceOriginLine(c(["a", "b"])), "From the chat");
  // A default shown read-only as its starting value, or an earlier run's, keeps its own words.
  assert.equal(choiceOriginLine(c("A starting line.", "default")), "Default");
  assert.equal(choiceOriginLine(c("Last time's words.", "last")), "Same as last time");
});

test("a member on a model you picked says no Your pick, only its other notes", () => {
  const m = (only: boolean) => ({ only, resolved: { model: "zai/glm-5.3", modelLabel: "GLM 5.3", provider: "zai", source: "card" } }) as never;
  assert.equal(memberWhy(m(false)), "");
  assert.equal(memberWhy(m(true)), "Only these models");
});
