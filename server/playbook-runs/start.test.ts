// Start, end to end in process: what it writes into the run folder, the one message the conducting chat
// gets, the marks on the chats, and the card that can't be started again, before and after a restart. The
// chat, the prompt and this computer's models are stand-ins (StartHost); everything else is Sova's own.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const { PLAYBOOK_RUN } = await import("../harness/state-kinds");
const { firstValues } = await import("./answers");
const { loadPlaybook, refOf } = await import("./env");

after(() => dropScratchAgentDir());

/** A playbook of the user's own: a choice, one helper per test model in a team with a blind grader. */
function playbook(id: string, extra: Record<string, unknown> = {}): void {
  const dir = join(scratchAgentDir, "sova", "playbooks", id);
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), `---\ntitle: ${id}\n---\nConduct the trial.\n`);
  writeFileSync(join(dir, "roles", "runner.md"), "Run {{topic}} on {{each}}. Write into {{run}}; scripts in {{folder}}/scripts.\nThe person's note, if any: {{note}}\n");
  writeFileSync(join(dir, "roles", "grader.md"), "Grade {{topic}}.\n");
  writeFileSync(
    join(dir, "playbook.json"),
    JSON.stringify({
      version: 1,
      inputs: [
        { id: "topic", label: "Topic", type: "text", ask: "always", required: true, default: "the parser" },
        { id: "models", label: "Test models", type: "models", ask: "always", required: true, default: [{ model: "zai/glm-5.3", effort: "low" }, { model: "zai/glm-5.2", effort: "low" }] },
      ],
      roles: {
        main: { label: "Main chat", models: [{ model: "zai/glm-5.3", effort: "high" }] },
        runner: { label: "Runner", prompt: "roles/runner.md", kind: "routine", per: { input: "models" }, models: [{ model: "zai/glm-5.3", effort: "low" }] },
        grader: { label: "Grader", prompt: "roles/grader.md", only: true, sees: "blind", models: [{ model: "claude-code/claude-opus-5-5", effort: "high" }, { model: "zai/glm-5.3", effort: "high" }] },
      },
      steps: [
        { id: "baseline", label: "Baseline", roles: ["main"], stop: "always" },
        { id: "run", label: "Run the arms", roles: ["runner", "grader"], team: true },
      ],
      ...extra,
    }),
  );
}
playbook("trial");
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
  refuse: string | null = null;
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
      async switchMode() {},
      async pinMode() {},
      async branch() {
        return [];
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
      title: () => {},
      env: async (spec, info) => fakeEnv(info.dir, spec),
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
function fakeEnv(dir: string, spec: { roles: { id: string; prompt?: string }[] }): CardEnv {
  const off = (c: WorkerChoice) => (c.backend === "claude-code" ? "is turned off in Settings → Models" : null);
  const name = (c: WorkerChoice) => ({ label: c.model, provider: c.backend === "claude-code" ? "claude-code-cli" : c.model.split("/")[0]! });
  const prompts: Record<string, string> = {};
  for (const r of spec.roles) prompts[r.id] = r.prompt ? readFileSync(join(dir, r.prompt), "utf8") : "Conduct the trial.\n";
  return {
    needs: null,
    denial: (c) => off(c),
    name,
    routes: null,
    chat: { backend: "pi", model: "ollama-cloud/qwen", effort: "low" },
    team: { coordinator: { model: "zai/glm-5.3", effort: "medium" }, monitor: { model: "zai/glm-5.3", effort: "low" } },
    prompts,
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
  if (note) store.changeRun(r.id, (x) => (x.edits = { roles: { runner: { note } } }));
  return { run: store.runById(r.id)!, shownIn, dir: loaded.info.dir };
}

describe("Start", () => {
  test("in this chat: the run folder gets the plan, one brief per helper with its slots filled, and the team's layout; the chat gets one message and the run's mark", async () => {
    const chats = new Chats();
    const { run, shownIn, dir } = await draft("trial", undefined, "Keep it short.");
    const view = await startRun(run.id, run.revision, { request: chats.request, contents: () => [], host: chats.host() });
    assert.equal(view.state, "started");
    assert.deepEqual([view.started!.chat.id, view.started!.newChat, view.started!.fromChat], [shownIn.id, false, undefined]);
    const folder = view.started!.folder;
    assert.equal(folder, join(scratchAgentDir, "shared", shownIn.id, "playbook-runs", run.id));
    assert.equal(readFileSync(join(folder, "briefs", "runner.1-zai-glm-5-3-low.md"), "utf8"), `Run the parser on zai/glm-5.3 (low). Write into ${folder}; scripts in ${dir}/scripts.\nThe person's note, if any: Keep it short.\n`);
    assert.equal(readFileSync(join(folder, "briefs", "runner.2-zai-glm-5-2-low.md"), "utf8").includes("zai/glm-5.2 (low)"), true);
    assert.equal(readFileSync(join(folder, "briefs", "grader.md"), "utf8"), "Grade the parser.\n\nYou judge blind: you are never told which arm or version produced what you are given, and you must not try to find out.\n");
    const team = JSON.parse(readFileSync(join(folder, "teams", "run.json"), "utf8")) as { members: { role: string; model: string; effort: string }[] };
    assert.deepEqual(team.members.map((m) => [m.role, m.model, m.effort]), [["runner-1", "zai/glm-5.3", "low"], ["runner-2", "zai/glm-5.3", "low"], ["grader", "zai/glm-5.3", "high"]]);
    const plan = JSON.parse(readFileSync(join(folder, "plan.json"), "utf8")) as { roles: { id: string; only: boolean; chain: { model: string; why?: string }[]; use: number }[] };
    const grader = plan.roles.find((r) => r.id === "grader")!;
    assert.deepEqual([grader.only, grader.use, grader.chain.map((m) => [m.model, !!m.why])], [true, 1, [["claude-code/claude-opus-5-5", true], ["zai/glm-5.3", false]]]);
    // One message: the instruction, the playbook block, the run block.
    assert.equal(chats.sent.length, 1);
    const text = chats.sent[0]!.text;
    assert.equal(chats.sent[0]!.path, shownIn.path);
    assert.match(text, /^Run the playbook "trial" as its conductor/);
    assert.match(text, /\n<playbook id="trial" dir="[^"]+" entry="PLAYBOOK.md" sha="[0-9a-f]+" load="full">\n---\ntitle: trial\n---\nConduct the trial.\n<\/playbook>\n<run id="pr_/);
    assert.ok(text.includes(`${folder}/teams/run.json (roles: runner, grader)`));
    assert.ok(text.trimEnd().endsWith("</run>"));
    // This chat now runs on the main role's model and effort.
    assert.deepEqual(chats.set, [{ path: shownIn.path, what: "model", to: "zai/glm-5.3" }, { path: shownIn.path, what: "thinking", to: "high" }]);
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

  test("a Start that fails halfway: this chat's model goes back, a chat made for it is named and used again", async () => {
    const chats = new Chats();
    chats.refuse = "the chat is open in a terminal";
    const mine = await draft("trial");
    await assert.rejects(startRun(mine.run.id, mine.run.revision, { request: chats.request, contents: () => [], host: chats.host() }), (e: unknown) => e instanceof RunRefused && e.status === 409 && /the chat is open in a terminal/.test(e.message));
    assert.equal(store.runById(mine.run.id)!.state, "draft");
    assert.deepEqual(chats.set.slice(-2), [{ path: mine.shownIn.path, what: "model", to: "ollama-cloud/qwen" }, { path: mine.shownIn.path, what: "thinking", to: "low" }]);

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
