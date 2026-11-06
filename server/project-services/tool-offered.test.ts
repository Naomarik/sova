import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { HEntry, HookCtx } from "../../shared/harness";

/**
 * Which chats are offered project_verbs (§app.project-services/tool-offered): the rule, one row per thing that
 * offers it and each that doesn't, then the gate: what it sets on the chat's tools, and when it sets nothing.
 * Real files and real git; a stand-in pi that counts every tool change.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "sova-tool-offered-")));
const agentDir = join(base, "agent");
mkdirSync(join(agentDir, "sova", "project-services"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.SOVA_CHAT_STATE_ROOT;

const { projectVerbsOffered } = await import("./tools");
const { atRegisteredPlace, offeredToolExtension } = await import("../served-tools");
const { playbookTurnText } = await import("../../shared/playbooks");
const { renderBlock } = await import("../../shared/playbook-delivery");
const { stateView } = await import("../harness/state-view");
const { WORKTREES } = await import("../harness/state-kinds");
const { clearProjectCache } = await import("../project-root");
const { targetDir } = await import("../targets");
const { defaultRemoteOf } = await import("../files");

after(() => rmSync(base, { recursive: true, force: true }));

const sova = join(agentDir, "sova");
beforeEach(() => {
  clearProjectCache();
  rmSync(join(sova, "merge-served.json"), { force: true });
  rmSync(join(sova, "project-services", "registry.json"), { force: true });
});

let n = 0;
const folder = (git = true): string => {
  const dir = join(base, `p${++n}`);
  mkdirSync(dir, { recursive: true });
  if (git) {
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", dir, ...args], { stdio: "ignore" });
    g("init", "-q", "-b", "master");
    g("commit", "-qm", "base", "--allow-empty");
  }
  return dir;
};
const define = (dir: string, text = "{}\n") => {
  mkdirSync(join(dir, ".sova"), { recursive: true });
  writeFileSync(join(dir, ".sova", "project.json"), text);
};
const linked = (main: string): string => {
  const at = `${main}-tree`;
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "side", at], { stdio: "ignore" });
  return at;
};
const playbook = (front: string): { title: string; dir: string; body: string } => {
  const dir = join(base, `pb${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), `---\ntitle: T\n${front}---\n# Body\n`);
  return { title: "T", dir, body: "# Body\n" };
};
const user = (text: string): HEntry => ({ kind: "user", blocks: [{ type: "text", text }] }) as unknown as HEntry;
const ctxOf = (cwd: string, opts: { branch?: HEntry[]; trees?: string[] } = {}): HookCtx =>
  ({
    cwd,
    sessionId: "s1",
    branch: () => opts.branch ?? [],
    state: () => stateView(opts.trees ? ([{ kind: "state", key: WORKTREES.type, data: { version: 1, trees: opts.trees.map((path) => ({ path, branch: "side", base: "abc", session: "s1", status: "active", how: "created", at: 1 })) } }] as never) : []),
  }) as unknown as HookCtx;

const offers: [string, () => HookCtx | Promise<HookCtx>][] = [
  ["the folder it works in has a definition", () => { const d = folder(); define(d); return ctxOf(d); }],
  ["a definition that doesn't parse counts", () => { const d = folder(); define(d, "not json"); return ctxOf(d); }],
  ["a plain folder (no git) with a definition", () => { const d = folder(false); define(d); return ctxOf(d); }],
  ["a subfolder of a checkout with a definition", () => { const d = folder(); define(d); mkdirSync(join(d, "sub")); return ctxOf(join(d, "sub")); }],
  ["a linked worktree whose own files have one", () => { const d = folder(); const t = linked(d); define(t); return ctxOf(t); }],
  ["a linked worktree, only the main folder has one", () => { const d = folder(); const t = linked(d); define(d); return ctxOf(t); }],
  ["a tracked worktree has one, the chat's folder doesn't", () => { const d = folder(); const t = linked(d); define(t); return ctxOf(d, { trees: [t] }); }],
  ["the merge queue serves the project", () => { const d = folder(); writeFileSync(join(sova, "merge-served.json"), JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z", roots: [{ root: d, target: "master" }] })); return ctxOf(d); }],
  ["a copy is registered for the project", () => { const d = folder(); writeFileSync(join(sova, "project-services", "registry.json"), JSON.stringify({ version: 1, instances: [{ project: d }], shared: [] })); return ctxOf(d); }],
  ["a setup playbook on the branch", () => ctxOf(folder(), { branch: [user(playbookTurnText(playbook("proposes: pipeline\n"), ""))] }) ],
  ["a setup playbook with the user's own text after it", () => ctxOf(folder(), { branch: [user(playbookTurnText(playbook("proposes: definition\n"), "only the API"))] }) ],
  ["a setup playbook a schedule fired, plain", () => ctxOf(folder(), { branch: [user(`Scheduled run.\n\n${playbookTurnText(playbook("proposes: deploy\n"), "")}`)] }) ],
  ["a setup playbook a schedule fired, as a block", () => { const p = playbook("proposes: release\n"); return ctxOf(folder(), { branch: [user(`Scheduled run.\n\n${renderBlock({ id: "x", dir: p.dir, entry: "PLAYBOOK.md" }, "abc", { load: "full", body: p.body }, [])}`)] }); }],
];
for (const [name, ctx] of offers) test(`offered: ${name}`, async () => assert.equal(await projectVerbsOffered(await ctx()), true));

const refuses: [string, () => HookCtx | Promise<HookCtx>][] = [
  ["a git folder with nothing", () => ctxOf(folder())],
  ["a plain folder with nothing", () => ctxOf(folder(false))],
  ["a definition in a parent of a plain folder", () => { const d = folder(false); define(d); mkdirSync(join(d, "sub")); return ctxOf(join(d, "sub")); }],
  ["another project is the one served and registered", () => { const other = folder(); writeFileSync(join(sova, "merge-served.json"), JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z", roots: [{ root: other, target: "master" }] })); writeFileSync(join(sova, "project-services", "registry.json"), JSON.stringify({ version: 1, instances: [{ project: other }], shared: [] })); return ctxOf(folder()); }],
  ["a playbook that proposes nothing", () => ctxOf(folder(), { branch: [user(playbookTurnText(playbook(""), ""))] })],
  ["a playbook whose proposes: isn't a known one", () => ctxOf(folder(), { branch: [user(playbookTurnText(playbook("proposes: everything\n"), ""))] })],
  ["a message that only mentions a setup playbook's folder", () => ctxOf(folder(), { branch: [user(`Playbook: T — ${playbook("proposes: pipeline\n").dir}`)] })],
  ["a playbook's head in the model's words, not a user's", () => ctxOf(folder(), { branch: [{ kind: "assistant", blocks: [{ type: "text", text: playbookTurnText(playbook("proposes: pipeline\n"), "") }] } as unknown as HEntry] })],
  ["a folder that doesn't exist", () => ctxOf(join(base, "gone"))],
  ["a relative folder", () => ctxOf("somewhere")],
  ["files on another computer, even with its project's definition, queue and copy", () => {
    // The placeholder is a real local folder holding all of them, so only its being another computer's can say no.
    const remote = targetDir("box", "/work");
    mkdirSync(remote, { recursive: true });
    define(remote);
    writeFileSync(join(sova, "project-services", "registry.json"), JSON.stringify({ version: 1, instances: [{ project: remote }], shared: [] }));
    writeFileSync(join(sova, "merge-served.json"), JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z", roots: [{ root: remote, target: "master" }] }));
    return ctxOf(remote);
  }],
];
test("the control for the row on another computer: the same files in a local folder offer it", async () => {
  const d = folder(false);
  define(d);
  assert.equal(await projectVerbsOffered(ctxOf(d)), true);
  assert.equal(defaultRemoteOf(targetDir("box", "/work"))?.target, "box");
});
for (const [name, ctx] of refuses) test(`not offered: ${name}`, async () => assert.equal(await projectVerbsOffered(await ctx()), false));

test("the message starting a run offers it before it is on the branch", async () => {
  const text = playbookTurnText(playbook("proposes: pipeline\n"), "");
  assert.equal(await projectVerbsOffered(ctxOf(folder()), text), true);
  assert.equal(await projectVerbsOffered(ctxOf(folder()), "do the thing"), false);
});

// ---- the gate ----------------------------------------------------------------------------------------

const REGISTERED = ["read", "bash", "edit", "note_tool", "project_verbs", "queue_push", "spec"];
function gate(answers: boolean[]) {
  let tools = [...REGISTERED];
  const sets: string[][] = [];
  const hooks = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
  const asked: (string | undefined)[] = [];
  const pi = {
    getActiveTools: () => [...tools],
    getAllTools: () => REGISTERED.map((name) => ({ name })),
    setActiveTools: (next: string[]) => {
      sets.push(next);
      tools = [...next];
    },
    on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => void hooks.set(event, [...(hooks.get(event) ?? []), fn]),
  };
  const ext = offeredToolExtension({ name: "x", factory: (_pi: unknown) => {} }, "project_verbs", async (_ctx, prompt) => {
    asked.push(prompt);
    return answers.shift() ?? false;
  });
  ext.factory(pi as never);
  const ctx = { cwd: base, sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [], getSessionFile: () => "/x.jsonl" } };
  const fire = async (event: string, payload: unknown = {}) => {
    for (const fn of hooks.get(event) ?? []) await fn(payload, ctx);
  };
  return { fire, sets, asked, tools: () => tools, setTools: (t: string[]) => (tools = t) };
}

test("offered from the start: nothing is ever set, so nothing about the chat changes", async () => {
  const g = gate([true]);
  await g.fire("session_start");
  await g.fire("before_agent_start", { prompt: "go" });
  await g.fire("turn_end");
  await g.fire("before_agent_start", { prompt: "again" });
  assert.deepEqual(g.sets, []);
  assert.deepEqual(g.tools(), REGISTERED);
  assert.deepEqual(g.asked, [undefined], "and once yes, the rule isn't asked again");
});

test("not offered: removed once as the chat opens, then no more changes however often it is asked", async () => {
  const g = gate([]);
  await g.fire("session_start");
  for (let i = 0; i < 3; i++) {
    await g.fire("before_agent_start", { prompt: "go" });
    await g.fire("turn_end");
  }
  assert.deepEqual(g.sets, [REGISTERED.filter((t) => t !== "project_verbs")]);
  assert.equal(g.asked.length, 7, "asked as it opens, at each message, after each step");
});

test("arriving: after a step, in a fresh chat's place, one change only, and it stays when the rule says no again", async () => {
  const g = gate([false, false, true]);
  await g.fire("session_start");
  await g.fire("before_agent_start", { prompt: "go" });
  await g.fire("turn_end");
  assert.deepEqual(g.tools(), REGISTERED, "the same tools in the same order as a chat that had it from its start");
  assert.equal(g.sets.length, 2, "the removal at opening and the one arrival");
  await g.fire("turn_end");
  await g.fire("before_agent_start", { prompt: "the definition is gone" });
  assert.deepEqual(g.tools(), REGISTERED);
  assert.equal(g.sets.length, 2);
});

test("arriving at a message: the prompt is what the rule reads", async () => {
  const g = gate([false, true]);
  await g.fire("session_start");
  await g.fire("before_agent_start", { prompt: "Playbook: …" });
  assert.deepEqual(g.asked, [undefined, "Playbook: …"]);
  assert.ok(g.tools().includes("project_verbs"));
});

test("opening again judges it again: a chat that lost its setup loses the tool", async () => {
  const g = gate([true, false]);
  await g.fire("session_start");
  await g.fire("session_start");
  assert.ok(!g.tools().includes("project_verbs"));
});

test("a tool the registry doesn't hold (a profile's removal) is never set", async () => {
  const ext = gate([true]);
  ext.setTools(["read"]);
  await ext.fire("session_start");
  assert.deepEqual(ext.tools().at(-1), "project_verbs", "the control: registered, it is set");
  let sets = 0;
  const hooks: ((e: unknown, c: unknown) => Promise<unknown>)[] = [];
  offeredToolExtension({ name: "x", factory: (_pi: unknown) => {} }, "project_verbs", async () => true).factory({
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read" }],
    setActiveTools: () => void sets++,
    on: (e: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => void (e === "session_start" && hooks.push(fn)),
  } as never);
  await hooks[0]!({}, { cwd: base, sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [], getSessionFile: () => "/x.jsonl" } });
  assert.equal(sets, 0);
});

test("atRegisteredPlace: before the first active tool registered after it, whatever else was added or is missing", () => {
  const reg = ["read", "bash", "a", "t", "b", "c"];
  assert.deepEqual(atRegisteredPlace(["read", "bash", "a", "b", "c"], "t", reg), ["read", "bash", "a", "t", "b", "c"]);
  assert.deepEqual(atRegisteredPlace(["read", "c", "b"], "t", reg), ["read", "t", "c", "b"], "an appended later tool stays where it is");
  assert.deepEqual(atRegisteredPlace(["read", "bash"], "t", reg), ["read", "bash", "t"], "nothing later is active");
  assert.deepEqual(atRegisteredPlace(["read", "b", "a"], "t", reg), ["read", "t", "b", "a"], "an earlier tool appended late doesn't count");
});
