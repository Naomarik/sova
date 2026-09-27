// Run: pnpm exec tsx --test server/project-coding-runtime.test.ts
// A project's coding sessions against REAL hosted runtimes, in a throwaway PI_CODING_AGENT_DIR whose
// only extension is this repo's mode extension and whose default (mode.json) is the busy host's
// delegate · align · spec. A git client project and a plain folder project, in the OS temp dir
// (deleted after). No model request is made: no auth exists, so each first turn fails after the
// session was created, its worktree cut and its mode set — which is what is checked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-coding-")));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
const writeDefault = (mode: string, minorModes: string[]) => writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode, strict: false, minorModes }));
writeDefault("delegate", ["align", "spec"]);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const { server } = await import("./index");
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { addTodo } = await import("./overseer-todos");
const { resolveChatMode } = await import("./mode-state");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
  await settled(join(tmp, "ws"));
  rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const modeEntries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "mode");
type Chat = Awaited<ReturnType<typeof acquireChat>>;
const held = (chat: Chat) => ({ mode: chat.modeState.mode, minorModes: [...chat.modeState.minorModes] });
const onBranch = (chat: Chat) => {
  const s = resolveChatMode(chat.session.sessionManager.getBranch());
  return { mode: s.mode, minorModes: [...s.minorModes] };
};

describe("a project's coding sessions", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  // The git client project, with a spec: Automatic is normal · spec.
  const client = join(tmp, "src", "client");
  mkdirSync(join(client, ".sova", "spec"), { recursive: true });
  writeFileSync(join(client, ".sova", "spec", "manifest.json"), "{}\n");
  git(client, "init", "-q", "-b", "master");
  git(client, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "add", "-A");
  git(client, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  const project = orgs.addProject(org.id, { name: "Portal", root: client });
  const plainRoot = join(tmp, "plain");
  mkdirSync(plainRoot);
  const plain = orgs.addProject(org.id, { name: "Plain", root: plainRoot });
  orgs.addPerson(org.id, { name: "Tony", role: "IT", voice: "Direct." });

  let started: { path: string; sessionId: string } | null = null;

  test("Start coding session: its own worktree cut from HEAD, recorded at once, mode set and pinned before the prompt", async () => {
    // The default equals what the project asks for: the extension alone would write no entry.
    writeDefault("normal", ["spec"]);
    const p = store.projectOverseerPaths(org.id, project.id);
    const todo = addTodo({ text: "Build the login page" }, p.todos, p.ideas);
    const err = await po.codeItem(org.id, project.id, { todoId: todo.id }).then(
      () => null,
      (e: Error) => e,
    );
    // No auth here: the prompt is accepted and its turn fails (or it is refused), after everything else.
    if (err) assert.doesNotMatch(err.message, /not prompted|worktree could not/, err.message);
    const row = store.readStarted(p).find((r) => r.kind === "operator-coding");
    assert.ok(row?.worktree && row.path, JSON.stringify(row));
    started = { path: row.path, sessionId: row.sessionId };
    const w = row.worktree;
    assert.equal(w.path, join(tmp, "src", ".worktrees", `client-${w.branch.replace(/^sova\//, "")}`));
    assert.match(w.branch, /^sova\/build-the-login-page-[0-9a-f]{6}$/);
    assert.equal(w.base, git(client, "rev-parse", "HEAD"));
    assert.equal(w.target, "master");
    assert.equal(git(w.path, "symbolic-ref", "--short", "HEAD"), w.branch);
    const header = JSON.parse(readFileSync(row.path!, "utf8").split("\n")[0]!);
    assert.equal(header.cwd, w.path, "the session runs in its worktree");
    const pins = modeEntries(row.path);
    assert.equal(pins.length, 1, "Sova wrote the mode entry although it equals the default");
    assert.deepEqual(pins[0].data.active, { version: 1, mode: "normal", strict: false, minorModes: ["spec"] });
    const chat = await acquireChat(row.path);
    assert.deepEqual(held(chat), { mode: "normal", minorModes: ["spec"] });
    // The default moves; the pinned session doesn't, on its next open.
    writeDefault("delegate", ["align"]);
    await disposeHeldChat(row.path, "test: reopen");
    const again = await acquireChat(row.path);
    assert.deepEqual(held(again), { mode: "normal", minorModes: ["spec"] });
    assert.deepEqual(onBranch(again), { mode: "normal", minorModes: ["spec"] });
  });

  test("the project page lists the worktree; the operator merges it back and removes it", async () => {
    assert.ok(started);
    const p = store.projectOverseerPaths(org.id, project.id);
    const w = store.readStarted(p).find((r) => r.sessionId === started!.sessionId)!.worktree!;
    let info = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info.worktrees.available, true);
    assert.deepEqual(info.codingModeNow, { mode: "normal", minorModes: ["spec"] });
    const rowOf = () => info.worktrees.sessions.find((s) => s.sessionId === started!.sessionId);
    const r0 = rowOf();
    assert.deepEqual(r0 && { state: r0.state, merged: r0.merged, ahead: r0.ahead, startedBy: r0.startedBy, branch: r0.branch, target: r0.target }, { state: "open", merged: false, ahead: 0, startedBy: "operator", branch: w.branch, target: "master" });
    await assert.rejects(po.mergeCodingWorktree(org.id, project.id, started.sessionId), /has nothing to merge into master/);
    writeFileSync(join(w.path, "login.txt"), "login\n");
    git(w.path, "add", "login.txt");
    git(w.path, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "login");
    info = await po.mergeCodingWorktree(org.id, project.id, started.sessionId);
    assert.equal(readFileSync(join(client, "login.txt"), "utf8"), "login\n");
    assert.deepEqual([rowOf()?.state, rowOf()?.merged, !!rowOf()?.mergedAt], ["merged", true, true]);
    info = await po.removeCodingWorktree(org.id, project.id, started.sessionId);
    assert.equal(existsSync(w.path), false);
    assert.equal(git(client, "branch", "--list", w.branch), "", "a merged branch goes with it");
    assert.deepEqual([rowOf()?.state, !!rowOf()?.removedAt, rowOf()?.merged, rowOf()?.branchGone], ["removed", true, true, true], "removed with its branch: still merged, nothing left to merge");
    const row = store.readStarted(p).find((r) => r.sessionId === started!.sessionId)!;
    assert.ok(row.removed && row.merged?.commit, JSON.stringify(row));
    await assert.rejects(po.removeCodingWorktree(org.id, project.id, started.sessionId), /already removed/);
  });

  test("the overseer's sova_create_session: a worktree too, and the mode it asked for within the ceiling", async () => {
    writeDefault("delegate", ["align", "spec"]);
    await po.ensureProjectOverseer(org.id, project.id);
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_create_session")!;
    // Unattended at L1: refused before anything. At L3, delegate without the operator's opt-in: refused.
    await assert.rejects(tool.execute("t1", { prompt: "Build it" }, undefined, undefined, undefined as never), /needs L3/);
    store.patchPoSettings(store.projectOverseerPaths(org.id, project.id), { autonomy: "L3" });
    const before = store.readStarted(store.projectOverseerPaths(org.id, project.id)).length;
    await assert.rejects(tool.execute("t2", { prompt: "Build it", mode: "delegate" }, undefined, undefined, undefined as never), /Delegate is off/);
    assert.equal(store.readStarted(store.projectOverseerPaths(org.id, project.id)).length, before, "nothing created");
    await tool.execute("t3", { prompt: "Build the API", title: "API" }, undefined, undefined, undefined as never).catch(() => {});
    const row = store.readStarted(store.projectOverseerPaths(org.id, project.id)).find((r) => r.kind === "coding");
    assert.ok(row?.worktree && row.path, JSON.stringify(row));
    assert.match(row.worktree.branch, /^sova\/api-[0-9a-f]{6}$/);
    assert.deepEqual(modeEntries(row.path).at(-1)?.data.active, { version: 1, mode: "normal", strict: false, minorModes: ["spec"] });
  });

  test("a plain folder: runs in the root with the reason; Automatic without a spec is normal", async () => {
    const p = store.projectOverseerPaths(org.id, plain.id);
    const todo = addTodo({ text: "Tidy up" }, p.todos, p.ideas);
    await po.codeItem(org.id, plain.id, { todoId: todo.id }).catch(() => null);
    const row = store.readStarted(p).find((r) => r.kind === "operator-coding");
    assert.ok(row?.path && !row.worktree, JSON.stringify(row));
    assert.equal(row.inRoot, "it isn't a Git repository.");
    assert.equal(JSON.parse(readFileSync(row.path!, "utf8").split("\n")[0]!).cwd, plainRoot);
    assert.deepEqual(modeEntries(row.path).at(-1)?.data.active, { version: 1, mode: "normal", strict: false, minorModes: [] });
    const info = await po.projectOverseerInfo(org.id, plain.id);
    assert.deepEqual({ available: info.worktrees.available, reason: info.worktrees.reason }, { available: false, reason: row.inRoot });
    const listed = info.worktrees.sessions.find((s) => s.sessionId === row.sessionId);
    assert.deepEqual(listed && { state: listed.state, branch: listed.branch, inRoot: listed.inRoot }, { state: "root", branch: null, inRoot: "it isn't a Git repository." });
  });

  test("a mode that can't be set sends no prompt; the session stays, listed", async () => {
    // No mode extension in the next runtime: nothing can take the mode.
    const settingsFile = join(agentDir, "settings.json");
    const had = readFileSync(settingsFile, "utf8");
    writeFileSync(settingsFile, JSON.stringify({ extensions: [] }));
    try {
      const p = store.projectOverseerPaths(org.id, plain.id);
      const todo = addTodo({ text: "Never prompted" }, p.todos, p.ideas);
      const made = await po.codeItem(org.id, plain.id, { todoId: todo.id });
      assert.equal(made.notPrompted, "Started, but not prompted: its mode could not be set.");
      assert.ok(store.readStarted(p).some((r) => r.sessionId === made.sessionId), "listed and counted");
      assert.doesNotMatch(readFileSync(made.path, "utf8"), /"role":"user"/, "no prompt reached it");
    } finally {
      writeFileSync(settingsFile, had);
    }
  });

  test("a loadout that loads no extension is handed no extension flag (no \"Unknown option\" line)", async () => {
    const { currentLinkOrigin, extensionFlagsFor } = await import("./chat-manager");
    assert.ok(currentLinkOrigin(), "the listener is bound, so ordinary runtimes get the link flag too");
    assert.deepEqual([...extensionFlagsFor(plainRoot, false, true, true)], [], "the project overseer and baton sessions: none, even with the Claude Code switch on");
    assert.deepEqual([...extensionFlagsFor(plainRoot, false, false, true).keys()], ["claude-code-provider", "sova-link"], "an ordinary session keeps them");
  });

  test("gathering sessions stay mode-less, whatever the project's coding mode and the default", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    store.patchPoSettings(p, { codingMode: { mode: "delegate", minorModes: ["spec"] } });
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("g1", { person: "Tony", public_title: "Hosting", goal: "Where it runs", question: "Where does it run?" }, undefined, undefined, undefined as never);
    const path = (out.details as { path: string }).path;
    const chat = await acquireChat(path);
    assert.equal(chat.special, "baton");
    assert.equal(chat.session.extensionRunner.getCommand("mode"), undefined, "no mode extension");
    assert.deepEqual(modeEntries(path), [], "no mode entry");
  });
});
