// Start, end to end in process: what it writes into the run folder, the one message the conducting chat
// gets, the marks on the chats, and the card that can't be started again, before and after a restart. The
// chat, the prompt and this computer's models are stand-ins (StartHost); everything else is Sova's own.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checkInputValue, inputValueText, type InputValue } from "../../shared/playbook-format";
import { resolveRoleModel } from "../../shared/playbook-models";
import type { WorkerChoice } from "../../shared/protocol";
import type { CardEnv } from "./plan";
import type { StartChat, StartHost } from "./start";

process.env.SOVA_SHARED_BASE = join(scratchAgentDir, "shared");
const store = await import("./store");
const { startRun, RunRefused } = await import("./start");
const { PLAYBOOK_RUN, MODE } = await import("../harness/state-kinds");
const PLAYBOOK_MODE_TYPE = MODE.type;
const { firstValues } = await import("./answers");
const { runView } = await import("./view");
const { runCard } = await import("./plan");
const { loadPlaybook, refOf } = await import("./env");

after(() => dropScratchAgentDir());

/** A playbook of the user's own: a choice, and a team with one runner per test model and a blind grader. */
function playbook(id: string, extra: Record<string, unknown> = {}): void {
  const dir = join(scratchAgentDir, "sova", "playbooks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), `---\ntitle: ${id}\n---\nConduct the trial.\n`);
  writeFileSync(
    join(dir, "playbook.json"),
    JSON.stringify({
      version: 1,
      inputs: [
        { id: "topic", label: "Topic", type: "text", ask: "always", required: true, default: "the parser" },
        { id: "models", label: "Test models", type: "models", ask: "always", required: true, default: [{ model: "zai/glm-5.3", effort: "low" }, { model: "zai/glm-5.2", effort: "low" }] },
      ],
      teams: {
        arms: {
          goal: "Run {{topic}} on every test model and grade it",
          members: {
            runner: { label: "Runner", brief: "Runs {{topic}} on one test model", kind: "routine", per: { input: "models" }, models: [{ model: "zai/glm-5.3", effort: "low" }] },
            grader: { label: "Grader", brief: "Grades blind", only: true, sees: "blind", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "zai/glm-5.3", effort: "high" }] },
          },
        },
      },
      steps: [
        { id: "baseline", label: "Baseline", stop: "always" },
        { id: "run", label: "Run the arms", teams: ["arms"] },
      ],
      ...extra,
    }),
  );
}
playbook("trial");
playbook("delegated", { run: { mode: "delegate" } });
playbook("powered", { run: { permissions: { remove: [], grant: [], oneAtATime: false, limits: {}, overseerMayStart: false } } });

let chats = 0;
function chatFile(): { id: string; path: string } {
  const id = `chat-${++chats}`;
  const path = join(scratchAgentDir, "sessions", "--proj--", `2026-11-16T00-00-0${chats}-000Z_${id}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-16T00:00:00.000Z", cwd: scratchAgentDir })}\n`);
  return { id, path };
}

/** Stand-in chats: what each was set to, and every mark written on it. */
class Chats {
  sent: { path: string; text: string }[] = [];
  marks: { path: string; data: unknown }[] = [];
  set: { path: string; what: string; to: string }[] = [];
  snapshots: string[] = [];
  titles: { id: string; title: string }[] = [];
  refuse: string | null = null;
  /** Chats that already have a message of the person's. */
  written = new Set<string>();
  /** Chats pinned to a mode (a mode entry on their branch). */
  pinned = new Set<string>();
  /** What the chat's file says would refuse the message (a terminal holds it…). */
  blocked = new Map<string, string>();
  readonly made: { id: string; path: string }[] = [];
  chat(path: string): StartChat {
    const self = this;
    const mirror = { model: { ref: "ollama-cloud/qwen" } as { ref: string } | null, thinking: "low", mode: { mode: "normal", minorModes: [] as string[] }, cwd: scratchAgentDir };
    return {
      mirror,
      async setModel(ref) {
        self.set.push({ path, what: "model", to: ref });
        mirror.model = { ref };
      },
      async setThinking(level) {
        self.set.push({ path, what: "thinking", to: level });
        mirror.thinking = level;
      },
      async switchMode(patch) {
        self.set.push({ path, what: "mode", to: `${patch.mode ?? mirror.mode.mode}${patch.minorModes ? `+${patch.minorModes.join(",")}` : ""}` });
        mirror.mode = { mode: patch.mode ?? mirror.mode.mode, minorModes: patch.minorModes ? [...patch.minorModes] : mirror.mode.minorModes };
      },
      async pinMode() {
        self.set.push({ path, what: "pin", to: mirror.mode.mode });
      },
      async branch() {
        return [
          ...(self.written.has(path) ? [{ kind: "user", id: "u1", parentId: null, blocks: [{ type: "text", text: "hi" }] }] : []),
          ...(self.pinned.has(path) ? [{ kind: "state", id: "m1", parentId: null, key: PLAYBOOK_MODE_TYPE, data: {} }] : []),
        ] as never;
      },
      async appendState(kind, data) {
        self.marks.push({ path, data: { type: kind.type, ...(data as object) } });
      },
    };
  }
  host(): Partial<StartHost> {
    const held = new Map<string, StartChat>();
    return {
      chat: async (path) => held.get(path) ?? held.set(path, this.chat(path)).get(path)!,
      prompt: async (path, text) => {
        if (this.refuse) return { ok: false, error: this.refuse };
        this.sent.push({ path, text });
        return { ok: true };
      },
      applyProfile: async (path) => {
        this.snapshots.push(path);
        return { ok: true };
      },
      title: (id, title) => void this.titles.push({ id, title }),
      preflight: async (path) => this.blocked.get(path) ?? null,
      env: async () => fakeEnv(),
    };
  }
  request = async (url: string) => {
    assert.equal(url, "/api/sessions");
    const c = chatFile();
    this.made.push(c);
    return new Response(JSON.stringify(c), { status: 201 });
  };
}

/** Opus can't run here; every zai model can. */
function fakeEnv(): CardEnv {
  const off = (c: WorkerChoice) => (c.backend === "claude-code" ? "is turned off in Settings → Models" : null);
  const name = (c: WorkerChoice) => ({ label: c.model, provider: c.backend === "claude-code" ? "claude-code-cli" : c.model.split("/")[0]! });
  return {
    needs: null,
    denial: (c) => off(c),
    name,
    routes: null,
    chat: { backend: "pi", model: "ollama-cloud/qwen", effort: "low" },
    team: { coordinator: { model: "zai/glm-5.3", effort: "medium" }, monitor: { model: "zai/glm-5.3", effort: "low" } },
    page: (rel) => (rel === "phases/stop.md" ? "# Stop rule\n\nStop after **two rounds** in a row with no win.\n\nMore detail.\n" : null),
    commandLabel: (id) => id,
    commandChanges: () => true,
    resolve: (input) => resolveRoleModel(input, { routes: null, chat: { backend: "pi", model: "ollama-cloud/qwen", effort: "low" }, denial: off, name: (c) => name(c).label }),
    checkValue: (i, v) => checkInputValue(i, v),
    valueText: (i, v) => inputValueText(i, v as InputValue),
  };
}

async function draft(id: string, shownIn = chatFile(), note?: string) {
  const loaded = (await loadPlaybook({ source: "user", id }, scratchAgentDir))!;
  const r = store.createRun({ playbook: refOf(loaded.info), cwd: scratchAgentDir, shownIn, initial: firstValues(loaded.spec!, {}) });
  if (note) store.changeRun(r.id, (x) => (x.edits = { roles: { runner: { note } }, teams: { arms: { note: `Team: ${note}` } } }));
  return { run: store.runById(r.id)!, shownIn, dir: loaded.info.dir };
}

describe("Start", () => {
  test("in this chat: the run folder gets the plan with each team's goal and note and each required member's brief, note and models; the chat gets one message and the run's mark, and keeps its own model", async () => {
    const chats = new Chats();
    const { run, shownIn } = await draft("trial", undefined, "Keep it short.");
    const view = await startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    assert.equal(view.state, "started");
    assert.deepEqual([view.started!.chat.id, view.started!.newChat, view.started!.fromChat], [shownIn.id, false, undefined]);
    const folder = view.started!.folder;
    assert.equal(folder, join(scratchAgentDir, "shared", shownIn.id, "playbook-runs", run.id));
    assert.deepEqual(readdirSync(folder).sort(), ["plan.json"], "no briefs and no team layouts: each team's coordinator writes the instructions");
    type Plan = { teams: { id: string; goal: string; note?: string; members: string[] }[]; members: { id: string; brief: string; note?: string; only: boolean; chain: { model: string; why?: string }[]; use: number }[] };
    const plan = JSON.parse(readFileSync(join(folder, "plan.json"), "utf8")) as Plan;
    assert.deepEqual(plan.teams.map((t) => [t.id, t.goal, t.note, t.members]), [["arms", "Run the parser on every test model and grade it", "Team: Keep it short.", ["runner", "grader"]]]);
    const runner = plan.members.find((m) => m.id === "runner")!;
    assert.deepEqual([runner.brief, runner.note], ["Runs the parser on one test model", "Keep it short."]);
    const grader = plan.members.find((r) => r.id === "grader")!;
    assert.deepEqual([grader.only, grader.use, grader.chain.map((m) => [m.model, !!m.why])], [true, 1, [["claude-code/claude-opus-5-5", true], ["zai/glm-5.3", false]]]);
    // One message: the instruction, the playbook block, the run block.
    assert.equal(chats.sent.length, 1);
    const text = chats.sent[0]!.text;
    assert.equal(chats.sent[0]!.path, shownIn.path);
    assert.match(text, /^Run the playbook "trial" as its conductor/);
    assert.match(text, /\n<playbook id="trial" dir="[^"]+" entry="PLAYBOOK.md" sha="[0-9a-f]+" load="full">\n---\ntitle: trial\n---\nConduct the trial.\n<\/playbook>\n<run id="pr_/);
    assert.ok(text.includes("- Team arms [arms], working in run. Goal: Run the parser on every test model and grade it. The user's note for the team: Team: Keep it short."));
    assert.ok(text.includes("  - Runner [runner] ×2, one per item (zai/glm-5.3 (low); zai/glm-5.2 (low)), kind routine: Runs the parser on one test model."));
    assert.ok(text.trimEnd().endsWith("</run>"));
    // An empty chat is named for the run, not by the message's first words.
    assert.deepEqual(chats.titles, [{ id: shownIn.id, title: "trial (playbook)" }]);
    // The main chat runs on what you chose: its model and effort aren't touched.
    assert.deepEqual(chats.set, []);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(chats.marks.map((m) => [m.path, (m.data as { type: string; conducts: boolean }).type, (m.data as { conducts: boolean }).conducts]), [[shownIn.path, PLAYBOOK_RUN.type, true]]);
    // Not startable again, before and after a restart.
    await assert.rejects(startRun(run.id, view.revision, { request: chats.request, contents: () => [], host: chats.host() }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /already started/.test(e.message));
    store.forgetPlaybookRuns();
    assert.equal(store.runById(run.id)!.state, "started");
    await assert.rejects(startRun(run.id, view.revision, { request: chats.request, contents: () => [], host: chats.host() }), /already started/);
  });

  test("a playbook asking for powers of its own runs in a new chat set up for it; the first chat's card says where and can't start again after a restart", async () => {
    const chats = new Chats();
    const { run, shownIn } = await draft("powered");
    const view = await startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    const made = chats.made[0]!;
    assert.deepEqual([view.started!.chat.id, view.started!.newChat, view.started!.fromChat?.id], [made.id, true, shownIn.id]);
    assert.deepEqual(chats.snapshots, [made.path]);
    assert.equal(chats.sent[0]!.path, made.path);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      chats.marks.map((m) => [m.path, (m.data as { conducts: boolean }).conducts, (m.data as { chat?: { id: string } }).chat?.id]),
      [[made.path, true, undefined], [shownIn.path, false, made.id]],
    );
    store.forgetPlaybookRuns();
    assert.deepEqual(store.runsOfChat(shownIn.id).map((r) => [r.id, r.state]), [[run.id, "started"]]);
    assert.deepEqual(store.runsOfChat(made.id).map((r) => r.id), [run.id]);
    await assert.rejects(startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() }), /already started/);
    assert.equal(chats.made.length, 1);
  });

  test("a chat Sova knows would refuse the message is never changed", async () => {
    const chats = new Chats();
    const { run, shownIn } = await draft("delegated");
    chats.blocked.set(shownIn.path, "This chat is open in a terminal (pid 7), so Sova must not write to it.");
    await assert.rejects(startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /open in a terminal/.test(e.message));
    assert.deepEqual(chats.set, [], "no model, effort or mode was touched");
    assert.equal(chats.sent.length, 0);
    assert.equal(store.runById(run.id)!.state, "draft");
  });

  test("a chat that already runs a playbook starts no other, in it or in a new chat: nothing is sent, made or changed", async () => {
    const chats = new Chats();
    const first = await draft("trial");
    const here = await draft("delegated", first.shownIn);
    const elsewhere = await draft("powered", first.shownIn);
    await startRun(first.run.id, first.run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    chats.sent = [];
    chats.set = [];
    for (const { run } of [here, elsewhere])
      await assert.rejects(
        startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() }),
        (e: unknown) => e instanceof RunRefused && e.status === 409 && e.message === "This chat already runs the playbook trial, and a chat runs one playbook. Start this one in a new chat.",
      );
    assert.deepEqual([chats.sent.length, chats.made.length, chats.set.length], [0, 0, 0]);
    assert.deepEqual([store.runById(here.run.id)!.state, store.runById(elsewhere.run.id)!.state], ["draft", "draft"]);
  });

  test("a started run's flow drawing says what it can't show: that it started, and that which step it's on isn't tracked; a draft's says nothing of a run", async () => {
    const chats = new Chats();
    const { run } = await draft("trial");
    const caption = "caption: Started · which step it's on isn't tracked yet";
    const spec = (await loadPlaybook({ source: "user", id: "trial" }, scratchAgentDir))!.spec!;
    assert.ok(!runCard(run, spec, fakeEnv()).view.flow!.body.includes("caption:"), "before Start: no run to speak of");
    const view = await startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    assert.ok(view.flow!.body.includes(caption), view.flow!.body);
    store.forgetPlaybookRuns();
    assert.ok((await runView(store.runById(run.id)!)).flow!.body.includes(caption), "the record keeps it after a restart");
  });

  test("a chat that already has a message keeps its name", async () => {
    const chats = new Chats();
    const { run, shownIn } = await draft("trial");
    chats.written.add(shownIn.path);
    await startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    assert.deepEqual(chats.titles, []);
  });

  test("two Starts at once start one run", async () => {
    const chats = new Chats();
    const { run } = await draft("trial");
    const both = await Promise.allSettled([0, 1].map(() => startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() })));
    assert.deepEqual(both.map((b) => b.status).sort(), ["fulfilled", "rejected"]);
    const refused = both.find((b) => b.status === "rejected") as PromiseRejectedResult;
    assert.match(String(refused.reason.message), /This run is starting/);
    assert.equal(chats.sent.length, 1);
  });

  test("a settings read that fails puts the card back to a draft, saying why", async () => {
    const chats = new Chats();
    const { run } = await draft("trial");
    const host = { ...chats.host(), env: async () => { throw new Error("team-defaults.json is unreadable"); } };
    await assert.rejects(startRun(run.id, run.revision, { request: chats.request, contents: () => [], host }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /couldn't be read: team-defaults.json is unreadable/.test(e.message));
    assert.equal(store.runById(run.id)!.state, "draft");
  });

  test("a stale revision starts nothing", async () => {
    const chats = new Chats();
    const { run } = await draft("trial");
    store.changeRun(run.id, (x) => x.revision++);
    await assert.rejects(startRun(run.id, run.revision - 1, { request: chats.request, contents: () => [], host: chats.host() }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /changed since you saw it/.test(e.message));
    assert.equal(store.runById(run.id)!.state, "draft");
    assert.equal(chats.sent.length, 0);
  });

  test("a Start that fails halfway: this chat's mode goes back, a chat made for it is named and used again", async () => {
    const chats = new Chats();
    chats.refuse = "the chat is open in a terminal";
    const mine = await draft("trial");
    await assert.rejects(startRun(mine.run.id, mine.run.revision, { request: chats.request, contents: () => [], host: chats.host() }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /the chat is open in a terminal/.test(e.message));
    assert.equal(store.runById(mine.run.id)!.state, "draft");
    assert.deepEqual(chats.set, [], "a playbook that sets no mode touches nothing in the chat");

    // A playbook that switches this chat's mode: a refused message switches it back, re-pinned only if it was pinned.
    const modes = () => chats.set.filter((x) => x.what === "mode" || x.what === "pin").map((x) => [x.what, x.to]);
    const unpinned = await draft("delegated");
    chats.set = [];
    await assert.rejects(startRun(unpinned.run.id, unpinned.run.revision, { request: chats.request, contents: () => [], host: chats.host() }), /the chat is open in a terminal/);
    assert.deepEqual(modes(), [["mode", "delegate"], ["pin", "delegate"], ["mode", "normal+"]], "an unpinned chat isn't pinned again");
    const pinned = await draft("delegated");
    chats.pinned.add(pinned.shownIn.path);
    chats.set = [];
    await assert.rejects(startRun(pinned.run.id, pinned.run.revision, { request: chats.request, contents: () => [], host: chats.host() }), /the chat is open in a terminal/);
    assert.deepEqual(modes(), [["mode", "delegate"], ["pin", "delegate"], ["mode", "normal+"], ["pin", "normal"]], "a pinned chat is pinned to its own mode again");

    const powered = await draft("powered");
    await assert.rejects(startRun(powered.run.id, powered.run.revision, { request: chats.request, contents: () => [], host: chats.host() }), /A chat was made for the run \(chat-\d+\); pressing Start again uses it/);
    assert.equal(chats.made.length, 1);
    chats.refuse = null;
    const view = await startRun(powered.run.id, store.runById(powered.run.id)!.revision, { request: chats.request, contents: () => [], host: chats.host() });
    assert.equal(chats.made.length, 1, "the half-made chat is used, not a second one");
    assert.equal(view.started!.chat.id, chats.made[0]!.id);
    assert.ok(existsSync(join(view.started!.folder, "plan.json")));
  });
});
