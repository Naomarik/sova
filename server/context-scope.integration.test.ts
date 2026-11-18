// The context-file scope in real chats (server/context-scope.ts): real pi runtimes built by the chat manager in this
// process, in folders under this file's own throwaway home (the runner gives each file one), with a context file in
// every folder on the way. For each place, what the new chat's card lists (read before the chat is held, through pi's
// own loader for the folder, and again from the held runtime) is exactly what its runtime loaded and its prompt
// carries: the home folder, a project's top and a folder inside it, a worktree's folder beside the project, a plain
// folder, a worker whose parent has no entry, a worker in another worktree than its parent, and a chat whose folder
// is gone (opened in the home folder). pi itself lists every folder's file up to `/` (the P44 canary): without the scope
// each place here would also load HOME-RULES and CODE-RULES (and WORKTREES-RULES, NOTES-RULES where they lie above).
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { WorkerStart } from "../shared/chat-runtime";
import { piRuntime, piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";

for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-context-scope-int-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionsDir = join(agentDir, "sessions", "--tmp-context-scope--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, defaultProvider: "scripted", defaultModel: "scripted", extensions: [join(REPO, "pi-config/extensions/subagents")] }));

// This file's own home (os.homedir(): Bun reads it once, the runner set it), and a context file in each folder.
const home = realpathSync(homedir());
assert.ok(home.startsWith(realpathSync(tmpdir())) || home.includes("sova-test-home"), "a throwaway home, never the operator's");
const MARK: Record<string, string> = {};
const rules = (dir: string, mark: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), `${mark}\n`);
  MARK[mark] = join(dir, "AGENTS.md");
};
rules(agentDir, "AGENT-DIR-RULES");
rules(home, "HOME-RULES");
const proj = join(home, "code", "proj");
rules(join(home, "code"), "CODE-RULES");
rules(proj, "PROJ-RULES");
rules(join(proj, "sub"), "PROJ-SUB-RULES");
// A sibling of `sub`: the project's list has it, but a chat in `sub` never meets it, so its card never lists it.
rules(join(proj, "other"), "PROJ-OTHER-RULES");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: "ignore" });
git(proj, "init", "-q");
git(proj, "add", "-A");
git(proj, "commit", "-qm", "init");
// A worktree beside the project, in a folder of worktrees that holds a file of its own.
const wt = join(home, "code", ".worktrees", "proj-x");
rules(dirname(wt), "WORKTREES-RULES");
git(proj, "worktree", "add", "-q", "-b", "x", wt);
writeFileSync(join(wt, "AGENTS.md"), "PX-RULES\n");
MARK["PX-RULES"] = join(wt, "AGENTS.md");
writeFileSync(join(wt, "sub", "AGENTS.md"), "PX-SUB-RULES\n");
MARK["PX-SUB-RULES"] = join(wt, "sub", "AGENTS.md");
rules(join(home, "notes"), "NOTES-RULES");
rules(join(home, "notes", "deep"), "NOTES-DEEP-RULES");
// A project folder whose AGENTS.md is a link out of the repository (to the notes').
mkdirSync(join(proj, "linked-out"), { recursive: true });
symlinkSync(MARK["NOTES-RULES"]!, join(proj, "linked-out", "AGENTS.md"));

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const cm = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { registerProjectIn } = await import("./projects/spaces");
const { clearSetupCache, getSessionSetup } = await import("./session-setup");
await registerProjectIn("standalone", proj, { name: "Scope Project", origin: "folder" });

const starts: WorkerStart[] = [];
cm.setWorkerHostSource(() => ({
  async start(req) {
    starts.push(req);
    return { chatId: `w${starts.length}`, sessionId: `w${starts.length}`, sessionFile: "", workerId: req.spec.parent.workerId, kind: "worker", pid: null, state: "open" };
  },
  async send() {
    return { queued: false };
  },
  async abort() {},
  async stop() {},
  watch: () => () => {},
  list: async () => [],
}));

after(async () => {
  cm.setWorkerHostSource(null);
  await cm.disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof cm.acquireChat>>;

let seq = 0;
/** A web session file whose header names `cwd`. */
function sessionFile(cwd: string): string {
  const id = `01a5c222-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-17T00-00-${String(seq).padStart(2, "0")}-000Z_${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-17T00:00:00.000Z", cwd }) + "\n");
  markOwned(path);
  return path;
}

/** The marks whose text a runtime's prompt carries. */
const prompted = (chat: Chat) => Object.keys(MARK).filter((m) => piSession(chat).systemPrompt.includes(m)).sort();
/** The context files the runtime's loader handed pi (after every override). */
const loaded = (chat: Chat) => piRuntime(chat).services.resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path).sort();
/** The context rows a new chat's card lists as loading at its start (a row it only may meet later is scanOnly). */
async function card(path: string): Promise<string[]> {
  clearSetupCache();
  const setup = await getSessionSetup(path, { fresh: true });
  assert.equal(setup.state, "ok", JSON.stringify(setup));
  if (setup.state !== "ok") return [];
  for (const f of setup.context.filter((f) => f.scanOnly)) assert.ok(f.path.startsWith(realpathSync(setup.cwd) + "/"), `a later row lies inside the chat's folder: ${f.path}`);
  return setup.context.filter((f) => !f.scanOnly && !f.off).map((f) => f.path).sort();
}

/** The card before the chat is held, the runtime, the prompt and the card after all name exactly `marks`. */
async function agrees(path: string, marks: string[], open: () => Promise<Chat> = () => cm.acquireChat(path)): Promise<Chat> {
  const want = marks.map((m) => MARK[m]!).sort();
  assert.deepEqual(await card(path), want, "the card of a chat nobody holds (pi's loader for its folder)");
  const chat = await open();
  assert.deepEqual(loaded(chat), want, "what the runtime loaded");
  assert.deepEqual(prompted(chat), [...marks].sort(), "what its prompt carries");
  assert.deepEqual(await card(path), want, "the card of the held chat");
  return chat;
}

const settledOnce = (path: string) =>
  new Promise<void>((done) => {
    const off = cm.onChatEvent((e) => {
      if (e.chatId === path && e.type === "settled") {
        off();
        done();
      }
    });
  });

/** One turn, its model's reply scripted (`tools` first). */
async function turn(chat: Chat, tools: { name: string; arguments: Record<string, unknown> }[] = [], text = "go") {
  const model = new ScriptedModel().attach(piSession(chat));
  model.reply(...tools.map((t) => ({ toolCall: t })), { text: "done" });
  const settled = settledOnce(chat.path);
  chat.handle({ send: () => {} }, { type: "prompt", text });
  await settled;
}

test("each chat starts with the agent folder's file and its own folder's up to its repository's top, and its card says exactly that", async () => {
  // [the chat's folder, the files it starts with besides the agent folder's]
  const cases: [string, string[]][] = [
    [home, ["HOME-RULES"]],
    [proj, ["PROJ-RULES"]],
    [join(proj, "sub"), ["PROJ-RULES", "PROJ-SUB-RULES"]],
    [join(wt, "sub"), ["PX-RULES", "PX-SUB-RULES"]],
    [join(home, "notes", "deep"), ["NOTES-DEEP-RULES"]],
    // Only real files of the project: a link out of it never loads.
    [join(proj, "linked-out"), ["PROJ-RULES"]],
  ];
  for (const [cwd, marks] of cases) {
    const path = sessionFile(cwd);
    try {
      await agrees(path, ["AGENT-DIR-RULES", ...marks]);
    } catch (err) {
      (err as Error).message = `${cwd}: ${(err as Error).message}`;
      throw err;
    } finally {
      await cm.disposeHeldChat(path, "test done");
    }
  }
});

test("workers are scoped from their own folder: one whose parent has no entry, and one in another worktree than its parent", async () => {
  const parentPath = sessionFile(proj);
  const parent = await cm.acquireChat(parentPath);
  const from = starts.length;
  await turn(parent, [{ name: "agent_spawn", arguments: { prompt: "do it", name: "w", model: "scripted/scripted", wake: false } }], "spawn");
  assert.equal(starts.length, from + 1, "one worker started");
  const spec = starts[from]!.spec as (typeof starts)[number]["spec"] & { loadout?: unknown };
  assert.equal(spec.loadout, undefined, "its parent has no entry, so it is handed none");
  for (const [cwd, marks] of [
    [join(proj, "sub"), ["PROJ-RULES", "PROJ-SUB-RULES"]],
    [join(wt, "sub"), ["PX-RULES", "PX-SUB-RULES"]],
  ] as const) {
    const path = sessionFile(cwd);
    cm.setWorkerSpec(path, { ...spec, cwd });
    try {
      await agrees(path, ["AGENT-DIR-RULES", ...marks]);
    } finally {
      await cm.disposeHeldChat(path, "test done");
      cm.setWorkerSpec(path, null);
    }
  }
  await cm.disposeHeldChat(parentPath, "test done");
});

test("a chat whose folder is gone opens in the home folder but is scoped by its stored folder: the agent folder's file alone", async () => {
  const path = sessionFile(join(proj, "gone", "deeper"));
  const chat = await cm.acquireChat(path);
  try {
    assert.equal(chat.cwdFallback?.cwd && realpathSync(chat.cwdFallback.cwd), home, "it runs in the home folder");
    assert.deepEqual(loaded(chat), [MARK["AGENT-DIR-RULES"]]);
    assert.deepEqual(prompted(chat), ["AGENT-DIR-RULES"]);
  } finally {
    await cm.disposeHeldChat(path, "test done");
  }
});
