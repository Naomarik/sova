// Run: pnpm exec tsx --test server/project-coding-runtime.test.ts
// A project's coding sessions against REAL hosted runtimes, in a throwaway PI_CODING_AGENT_DIR whose
// only extension is this repo's mode extension and whose default (mode.json) is the busy host's
// delegate · align · spec. A git client project and a plain folder project, in the OS temp dir
// (deleted after). No model request is made: no auth exists, so each first turn fails after the
// session was created, its worktree cut and its mode set — which is what is checked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-coding-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
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
const { acquireChat, disposeAllChats, disposeHeldChat, onAgentStarted } = await import("./chat-manager");
const { addTodo } = await import("./overseer-todos");
const { resolveChatMode } = await import("./mode-state");
const { settled } = await import("./workspace-git");
const { offersMerge } = await import("../src/lib/coding-worktrees");
const { noteBuildStarted, readBuild, readBuilds, withWorktreePath } = await import("./build-loadout");
const { seedBuild } = await import("./org-test-fixtures");
const { envelopeFor, hostOf } = await import("./org-engine");
const { pipelineInfo } = await import("./project-pipeline");
/** A project's builds with their worktree folders on this host. */
const buildsOf = async (orgId: string, projectId: string, root: string) => Promise.all(readBuilds(orgId, projectId).map(async (r) => ({ ...r, worktree: (await withWorktreePath(r, root))?.worktree })));

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
  const project = await orgs.addProject(org.id, { name: "Portal", root: client });
  const plainRoot = join(tmp, "plain");
  mkdirSync(plainRoot);
  const plain = await orgs.addProject(org.id, { name: "Plain", root: plainRoot });
  await orgs.addPerson(org.id, { name: "Tony", role: "IT", voice: "Direct." });

  let started: { path: string; sessionId: string } | null = null;

  test("Start coding session: its own worktree cut from HEAD, on its statechart at once, mode set and pinned before the prompt", async () => {
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
    const row = (await buildsOf(org.id, project.id, client)).find((r) => r.kind === "operator-coding");
    assert.ok(row?.worktree && row.path, JSON.stringify(row));
    started = { path: row.path, sessionId: row.sessionId };
    assert.equal(row.title, "Build the login page", "its title travels with the build, for a host without its file");
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
    const w = (await buildsOf(org.id, project.id, client)).find((r) => r.sessionId === started!.sessionId)!.worktree!;
    let info = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info.worktrees.available, true);
    assert.deepEqual(info.codingModeNow, { mode: "normal", minorModes: ["spec"] });
    const rowOf = () => info.worktrees.sessions.find((s) => s.sessionId === started!.sessionId);
    const r0 = rowOf();
    assert.deepEqual(r0 && { state: r0.state, merged: r0.merged, ahead: r0.ahead, startedBy: r0.startedBy, branch: r0.branch, target: r0.target }, { state: "open", merged: false, ahead: 0, startedBy: "operator", branch: w.branch, target: "master" });
    await po.ensureProjectOverseer(org.id, project.id);
    await assert.rejects(po.mergeCodingWorktree(org.id, project.id, started.sessionId), /has nothing to merge into master/);
    writeFileSync(join(w.path, "login.txt"), "login\n");
    // Uncommitted: refused, and the overseer is told (soon), so it can ask the session to commit.
    await assert.rejects(po.mergeCodingWorktree(org.id, project.id, started.sessionId), /uncommitted changes in 1 file \(login.txt\)/);
    const memo = store.readMemo(p);
    assert.ok(
      memo.pending.some((r) => r.startsWith('Merge Branch for "Build the login page" was refused: The worktree has uncommitted changes in 1 file')),
      JSON.stringify(memo.pending),
    );
    assert.ok(memo.soonAt, "a look soon");
    git(w.path, "add", "login.txt");
    git(w.path, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "login");
    // The reasons noted from here on (the watch keeps them until its next look).
    const seen = store.readMemo(p).pending.length;
    info = await po.mergeCodingWorktree(org.id, project.id, started.sessionId);
    assert.equal(readFileSync(join(client, "login.txt"), "utf8"), "login\n");
    // Merged: the overseer is told, soon, so it never waits on a merge that already happened (NEW-MS-3).
    const merged = store.readMemo(p);
    assert.deepEqual(merged.pending.slice(seen), [`The operator merged "Build the login page" (${w.branch}) into master.`]);
    assert.ok(merged.soonAt, "a look soon");
    assert.deepEqual([rowOf()?.state, rowOf()?.merged, !!rowOf()?.mergedAt], ["merged", true, true]);
    // The session is sent more work and commits again: git, not the record, says it is merged.
    const firstMerge = rowOf()!.mergedAt;
    writeFileSync(join(w.path, "logout.txt"), "logout\n");
    git(w.path, "add", "logout.txt");
    git(w.path, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "logout");
    info = await po.projectOverseerInfo(org.id, project.id);
    assert.deepEqual(
      [rowOf()?.state, rowOf()?.merged, rowOf()?.newSinceMerge, rowOf()?.mergedAt],
      ["open", false, 1, firstMerge],
      "a merged branch with a new commit is open again, and its last merge stays as history",
    );
    assert.equal(offersMerge(rowOf()!), true, "Merge Branch is offered again");
    info = await po.mergeCodingWorktree(org.id, project.id, started.sessionId);
    assert.equal(readFileSync(join(client, "logout.txt"), "utf8"), "logout\n");
    assert.deepEqual([rowOf()?.state, rowOf()?.merged, rowOf()?.newSinceMerge], ["merged", true, undefined]);
    assert.equal(offersMerge(rowOf()!), false);
    info = await po.removeCodingWorktree(org.id, project.id, started.sessionId);
    assert.equal(existsSync(w.path), false);
    assert.equal(git(client, "branch", "--list", w.branch), "", "a merged branch goes with it");
    assert.deepEqual([rowOf()?.state, !!rowOf()?.removedAt, rowOf()?.merged, rowOf()?.branchGone], ["removed", true, true, true], "removed with its branch: still merged, nothing left to merge");
    assert.equal(offersMerge(rowOf()!), false, "merged and deleted: the record says merged, nothing to offer");
    const row = readBuilds(org.id, project.id).find((r) => r.sessionId === started!.sessionId)!;
    assert.ok(row.removed && row.merged?.commit, JSON.stringify(row));
    await assert.rejects(po.removeCodingWorktree(org.id, project.id, started.sessionId), /already removed/);
  });

  test("a coding row from another host: its recorded title, no link, not 'missing'", async () => {
    const gone = join(tmp, "elsewhere");
    await seedBuild(org.id, project.id, { sessionId: "01a0e321-a85c-74d4-9349-c48f99e8336d", kind: "operator-coding", path: join(gone, "s.jsonl"), title: "Add pickup hours", worktree: { path: join(gone, "wt"), branch: "sova/add-pickup-hours-abc123", base: git(client, "rev-parse", "HEAD"), target: "master" } });
    const info = await po.projectOverseerInfo(org.id, project.id);
    const row = info.worktrees.sessions.find((s) => s.sessionId === "01a0e321-a85c-74d4-9349-c48f99e8336d");
    assert.deepEqual(row && { title: row.title, path: row.path, branch: row.branch }, { title: "Add pickup hours", path: null, branch: "sova/add-pickup-hours-abc123" });
  });

  test("a coding session in a worktree is told to commit on its branch; one in the root is not", () => {
    const told = po.codingFirstPrompt("Build the API", { branch: "sova/api-abc123", target: "master" });
    assert.equal(
      told,
      "Build the API\n\nYou work in your own git worktree on the branch sova/api-abc123. Commit your work on this branch before you end your turn: uncommitted changes can't be merged. Before you end your turn, also merge master into your branch and resolve any conflicts.",
    );
    assert.equal(po.codingFirstPrompt("Tidy up", undefined), "Tidy up");
  });

  test("the overseer's sova_create_session: a worktree too, and the mode it asked for within the ceiling", async () => {
    writeDefault("delegate", ["align", "spec"]);
    await po.ensureProjectOverseer(org.id, project.id);
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_create_session")!;
    // Unattended at L1: refused before anything. At L3, delegate without the operator's opt-in: refused.
    await assert.rejects(tool.execute("t1", { gap: "none", prompt: "Build it" }, undefined, undefined, undefined as never), /needs L3/);
    store.patchPoSettings(store.projectOverseerPaths(org.id, project.id), { autonomy: "L3", holdMin: 0 });
    // q7: unattended, a build names the gap whose promoted decisions it builds; with none it is refused.
    await assert.rejects(tool.execute("t1b", { gap: "none", prompt: "Build it" }, undefined, undefined, undefined as never), /Without a gap, a coding session starts only in a turn the operator started/);
    // In a turn the operator started it may start one tied to no gap.
    const asked = po.toolsForTest(org.id, project.id, { attended: true }).find((t) => t.name === "sova_create_session")!;
    const before = readBuilds(org.id, project.id).length;
    await assert.rejects(asked.execute("t2", { gap: "none", prompt: "Build it", mode: "delegate" }, undefined, undefined, undefined as never), /Delegate is off/);
    assert.equal(readBuilds(org.id, project.id).length, before, "nothing created");
    await asked.execute("t3", { gap: "none", prompt: "Build the API", title: "API" }, undefined, undefined, undefined as never).catch(() => {});
    const row = (await buildsOf(org.id, project.id, client)).find((r) => r.kind === "coding");
    assert.ok(row?.worktree && row.path, JSON.stringify(row));
    assert.match(row.worktree.branch, /^sova\/api-[0-9a-f]{6}$/);
    assert.equal(row.title, "API");
    // Untitled: the build still carries one, the prompt's first line (never Sova's commit paragraph).
    const before2 = readBuilds(org.id, project.id).length;
    await asked.execute("t4", { gap: "none", prompt: "Fix the footer\nIt overlaps the menu on phones." }, undefined, undefined, undefined as never).catch(() => {});
    const rows2 = readBuilds(org.id, project.id);
    assert.equal(rows2.length, before2 + 1);
    assert.equal(rows2.at(-1)!.title, "Fix the footer");
    const info2 = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info2.worktrees.sessions.find((s) => s.sessionId === rows2.at(-1)!.sessionId)?.title, "Fix the footer");
    assert.deepEqual(modeEntries(row.path).at(-1)?.data.active, { version: 1, mode: "normal", strict: false, minorModes: ["spec"] });
  });

  test("a plain folder: runs in the root with the reason; Automatic without a spec is normal", async () => {
    const p = store.projectOverseerPaths(org.id, plain.id);
    const todo = addTodo({ text: "Tidy up" }, p.todos, p.ideas);
    await po.codeItem(org.id, plain.id, { todoId: todo.id }).catch(() => null);
    const row = readBuilds(org.id, plain.id).find((r) => r.kind === "operator-coding");
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
      assert.ok(readBuilds(org.id, plain.id).some((r) => r.sessionId === made.sessionId), "listed and counted");
      assert.doesNotMatch(readFileSync(made.path, "utf8"), /"role":"user"/, "no prompt reached it");
    } finally {
      writeFileSync(settingsFile, had);
    }
  });

  test("New Coding Session: a worktree, pinned, the commit paragraph as a note, nothing sent, no reason to look", async () => {
    writeDefault("delegate", ["align", "spec"]);
    const { Hono } = await import("hono");
    const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
    const { readTodos } = await import("./overseer-todos");
    const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
    const app = new Hono();
    registerProjectOverseerRoutes(app);
    const p = store.projectOverseerPaths(org.id, project.id);
    await po.ensureProjectOverseer(org.id, project.id);
    const pendingBefore = store.readMemo(p).pending;
    const todosBefore = JSON.stringify(readTodos(p.todos));
    const res = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 201);
    const made = (await res.json()) as { path: string; sessionId: string; worktree?: { branch: string; path: string }; modeNotSet?: string };
    assert.equal(made.modeNotSet, undefined);
    assert.match(made.worktree?.branch ?? "", /^sova\/coding-[0-9a-f]{6}$/);
    const row = readBuilds(org.id, project.id).find((r) => r.sessionId === made.sessionId)!;
    assert.deepEqual([row.kind, row.title, row.worktree?.branch], ["operator-coding", undefined, made.worktree!.branch], "the operator's, untitled, in its worktree");
    const lines = readFileSync(made.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, made.worktree!.path);
    assert.deepEqual(modeEntries(made.path).at(-1)?.data.active, { version: 1, mode: "normal", strict: false, minorModes: ["spec"] }, "the project's mode, not the host's default");
    assert.ok(!lines.some((e) => e.type === "message"), "nothing was sent: no user message, no reply");
    const notes = lines.filter((e) => e.type === "custom_message" && e.customType === po.CODING_WORKTREE_NOTE);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].content, po.codingWorktreeParagraph({ branch: made.worktree!.branch, target: "master" }));
    assert.equal(notes[0].display, true);
    // Persisted, and the model gets it: reopened from the file, it is in the context as a user message.
    await disposeHeldChat(made.path, "test: reopen");
    const chat = await acquireChat(made.path);
    const llm = convertToLlm(chat.session.sessionManager.buildSessionContext().messages);
    assert.ok(llm.some((m) => m.role === "user" && JSON.stringify(m.content).includes(`on the branch ${made.worktree!.branch}`)), JSON.stringify(llm));
    // Only its own: an earlier test's merge may still reach the watch in this window (master notes every merge).
    const added = store.readMemo(p).pending.filter((t) => !pendingBefore.includes(t));
    assert.deepEqual(added.filter((t) => t.includes(made.sessionId) || t.includes(made.worktree!.branch)), [], "no reason to look");
    assert.equal(JSON.stringify(readTodos(p.todos)), todosBefore, "no to-do touched");
    const info = await po.projectOverseerInfo(org.id, project.id);
    const listed = info.worktrees.sessions.find((s) => s.sessionId === made.sessionId);
    assert.deepEqual(listed && { startedBy: listed.startedBy, title: listed.title, branch: listed.branch }, { startedBy: "operator", title: "", branch: made.worktree!.branch });
    // The overseer sees it, as the operator's.
    const list = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_list_sessions")!;
    const out = ((await list.execute("t", {}, undefined, undefined, undefined as never)).content[0] as { text: string }).text;
    assert.ok(out.includes(`- ${made.sessionId} "Untitled coding session" · started by the operator · idle · ${made.worktree!.branch} · no commits yet`), out);
    // Clean Up's husk sweep never takes it; an ordinary empty session of the same age is taken.
    const { cleanupSessions, idOf } = await import("./sessions-index");
    const husk = join(agentDir, "sessions", "--tmp-husk--", "2026-09-28T00-00-00-000Z_01a0e999-0000-7000-8000-000000000001.jsonl");
    mkdirSync(dirname(husk), { recursive: true });
    writeFileSync(husk, `${JSON.stringify({ type: "session", version: 3, id: "01a0e999-0000-7000-8000-000000000001", timestamp: new Date().toISOString(), cwd: tmp })}\n`);
    await disposeHeldChat(made.path, "test: sweep");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(husk, old, old);
    utimesSync(made.path, old, old);
    const swept = await cleanupSessions({ mode: "husks", dryRun: true });
    assert.ok(swept.deletedIds.includes(idOf(husk)), "the control husk is a candidate");
    assert.ok(!swept.deletedIds.includes(made.sessionId), "the project's coding session is not");
    rmSync(husk);
  });

  test("New Coding Session in a plain folder: in the root, with the reason and no note; an unknown project is 404", async () => {
    const { Hono } = await import("hono");
    const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
    const app = new Hono();
    registerProjectOverseerRoutes(app);
    const made = await po.startCoding(org.id, plain.id, {});
    assert.deepEqual([made.worktree, made.note], [undefined, "it isn't a Git repository."]);
    assert.equal(JSON.parse(readFileSync(made.path, "utf8").split("\n")[0]!).cwd, plainRoot);
    assert.doesNotMatch(readFileSync(made.path, "utf8"), /sova-coding-worktree|"type":"message"/);
    const res = await app.request(`/api/orgs/${org.id}/projects/prj_zzzzzzzz/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
  });

  test("New Coding Session whose mode can't be set: started and listed, and it says so", async () => {
    const settingsFile = join(agentDir, "settings.json");
    const had = readFileSync(settingsFile, "utf8");
    writeFileSync(settingsFile, JSON.stringify({ extensions: [] }));
    try {
      const made = await po.startCoding(org.id, project.id, {});
      assert.equal(made.modeNotSet, "Started, but its mode could not be set. Set it from the chat's mode menu before you send.");
      const info = await po.projectOverseerInfo(org.id, project.id);
      assert.ok(info.worktrees.sessions.some((s) => s.sessionId === made.sessionId), "listed");
      assert.doesNotMatch(readFileSync(made.path, "utf8"), /sova-coding-worktree|"type":"message"/, "no note, nothing sent");
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

  test("F20 (r3): at L3 the item statechart's own build of a gap's promoted decisions gets the project's mode, then its first prompt", async () => {
    writeDefault("delegate", ["align"]);
    // Automatic (no coding mode set): normal · spec, for a project with a spec.
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L3", holdMin: 0, codingMode: null });
    const projectSid = `project/${org.id}/${project.id}`;
    const itemSid = `item/${org.id}/${project.id}/g_build1`;
    const envelope = envelopeFor(org.id, project.id, { by: "overseer", attended: true });
    assert.equal((await hostOf(org.id).act(projectSid, "gap/file", { gapId: "g_build1", ideaId: "§gap/login" }, envelope, { settle: true })).taken, true);
    const before = readBuilds(org.id, project.id).length;
    // A promoted decision of the gap, as its decision session reports it: the statechart builds it itself.
    await hostOf(org.id).act(
      itemSid,
      "link/moved",
      { from: `decision/${org.id}/${project.id}/d_login1`, statechart: "decision", states: ["promoted"], running: true, exported: { state: "promoted", statement: "The login page asks for email and password.", record: "§req/login" } },
      envelopeFor(org.id, project.id, { by: "statechart", attended: false }),
      { settle: true },
    );
    let row: ReturnType<typeof readBuilds>[number] | undefined;
    const sidOf = (r: { sessionId: string }) => `build/${org.id}/${project.id}/${r.sessionId}`;
    for (let i = 0; i < 200 && !(row && hostOf(org.id).configuration(sidOf(row))?.includes("ready")); i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = readBuilds(org.id, project.id).slice(before).find((r) => r.title === "Build §gap/login");
    }
    assert.ok(row?.path, `the statechart started a build: ${JSON.stringify(readBuilds(org.id, project.id).slice(before))}`);
    const sid = sidOf(row);
    const d = hostOf(org.id).data(sid) ?? {};
    assert.ok(hostOf(org.id).configuration(sid)?.includes("ready"), "its setup ended");
    assert.equal(d["modeNotSet"], undefined, "its mode was set");
    assert.deepEqual(modeEntries(row.path).at(-1)?.data.active, { version: 1, mode: "normal", strict: false, minorModes: ["spec"] }, "the project's mode, never the default's");
    assert.match((await buildsOf(org.id, project.id, client)).find((r) => r.sessionId === row!.sessionId)?.worktree?.branch ?? "", /^sova\/build-gap-login-[0-9a-f]{6}$/, "its branch is named after its title");
    // No auth here: the runtime takes the prompt and its turn fails, so the file may never show it; the statechart's
    // log shows the first prompt sent and answered.
    const rows = hostOf(org.id).log.rows({ sessions: [sid] });
    const setup = rows.map((r) => r.after.find((x) => ["making-worktree", "setting-mode", "prompting", "ready", "not-started"].includes(x)));
    assert.deepEqual([...new Set(setup)], ["making-worktree", "setting-mode", "prompting", "ready"], "mode set, then the first prompt");
    assert.ok(rows.some((r) => r.event === "effect/done" && r.before.includes("prompting") && r.after.includes("ready")), "the prompt was taken");
    assert.equal(d["promptError"], undefined);
  });

  test("F20: the statechart's own build whose mode can't be set is not prompted, and its Pipeline row says so", async () => {
    const settingsFile = join(agentDir, "settings.json");
    const had = readFileSync(settingsFile, "utf8");
    writeFileSync(settingsFile, JSON.stringify({ extensions: [] }));
    try {
      await po.patchProjectOverseer(org.id, project.id, { autonomy: "L3", holdMin: 0 });
      const envelope = envelopeFor(org.id, project.id, { by: "overseer", attended: true });
      await hostOf(org.id).act(`project/${org.id}/${project.id}`, "gap/file", { gapId: "g_build2", ideaId: "§gap/logout" }, envelope, { settle: true });
      const before = readBuilds(org.id, project.id).length;
      await hostOf(org.id).act(
        `item/${org.id}/${project.id}/g_build2`,
        "link/moved",
        { from: `decision/${org.id}/${project.id}/d_logout1`, statechart: "decision", states: ["promoted"], running: true, exported: { state: "promoted", statement: "Logout clears the session.", record: "§req/logout" } },
        envelopeFor(org.id, project.id, { by: "statechart", attended: false }),
        { settle: true },
      );
      let row: ReturnType<typeof readBuilds>[number] | undefined;
      for (let i = 0; i < 200 && !(row && hostOf(org.id).configuration(`build/${org.id}/${project.id}/${row.sessionId}`)?.includes("ready")); i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = readBuilds(org.id, project.id).slice(before).find((r) => r.title === "Build §gap/logout");
      }
      assert.ok(row?.modeNotSet, "its mode was not set");
      assert.doesNotMatch(readFileSync(row.path!, "utf8"), /"role":"user"/, "no prompt reached it");
      const b = pipelineInfo(org.id, project.id).rows.find((r) => r.gap === "§gap/logout")?.builds.find((x) => x.sessionId === row!.sessionId);
      assert.equal(b?.notPrompted, "Started, but not prompted: its mode could not be set.");
    } finally {
      writeFileSync(settingsFile, had);
    }
  });

  test("F21: a build's turn start reaches its statechart: the Pipeline reads it working, and the at-once cap counts it", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    store.patchPoSettings(p, { autonomy: "L3", holdMin: 0, caps: { codingRunning: 1, createPerTurn: null, createPerDay: null } });
    const asked = po.toolsForTest(org.id, project.id, { attended: true }).find((t) => t.name === "sova_create_session")!;
    // Another build may still run from an earlier test: the cap counts only this one's.
    for (const s of hostOf(org.id).sessions("build")) if (s.data.turn === "working") await hostOf(org.id).act(s.id, "turn/ended", {}, { by: "system" } as never);
    const before = readBuilds(org.id, project.id).length;
    await asked.execute("f21a", { gap: "none", prompt: "Cap test", title: "Cap test" }, undefined, undefined, undefined as never).catch((e: Error) => assert.fail(e.message));
    const row = readBuilds(org.id, project.id).slice(before).find((r) => r.title === "Cap test")!;
    assert.ok(row?.path);
    const sid = `build/${org.id}/${project.id}/${row.sessionId}`;
    // The runtime's own agent_start (its session's event; no model runs here) reaches the statechart.
    const seen: string[] = [];
    const off = onAgentStarted((path) => seen.push(path));
    const chat = await acquireChat(row.path!);
    (chat.session as unknown as { _emit(e: unknown): void })._emit({ type: "agent_start" });
    off();
    assert.ok(seen.includes(row.path!), "agent_start reached the listener");
    for (let i = 0; i < 100 && hostOf(org.id).data(sid)?.turn !== "working"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(hostOf(org.id).log.rows({ sessions: [sid] }).some((r) => r.event === "turn/started"), "its statechart heard the turn start");
    // Mid-turn (as agent_start leaves it): the Pipeline's turn is working, and a second build is over the cap.
    assert.equal(readBuild(org.id, project.id, row.sessionId)?.turn, "working");
    await assert.rejects(
      () => asked.execute("f21b", { gap: "none", prompt: "Second", title: "Second" }, undefined, undefined, undefined as never),
      /1 of its coding sessions are running, and the limit is 1 at once\./,
    );
    await hostOf(org.id).act(sid, "turn/ended", {}, { by: "system" } as never);
    store.patchPoSettings(p, { caps: { codingRunning: 2 } });
  });

  test("the operator's Start coding on a §gap/… idea: the gap's own build when it has promoted decisions to build, else a plain one", async () => {
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L1", holdMin: 0 });
    const idea = po.toolsForTest(org.id, project.id, { attended: true }).find((t) => t.name === "sova_idea")!;
    await idea.execute("gx", { op: "add", id: "§gap/export", title: "Export to CSV" }, undefined, undefined, undefined as never);
    const itemSid = po.itemOfGap(org.id, project.id, "§gap/export")!;
    assert.ok(itemSid);
    const gapBuilds = () => pipelineInfo(org.id, project.id).rows.find((r) => r.gap === "§gap/export")?.builds ?? [];
    // Nothing promoted yet: a plain coding session, as before.
    const plain = await po.codeItem(org.id, project.id, { ideaId: "§gap/export" }).catch((e: Error) => assert.fail(e.message));
    assert.ok(!gapBuilds().some((b) => b.sessionId === plain.sessionId), "not the gap's");
    // A promoted decision of the gap: Start coding is the gap's build, on its Pipeline row.
    await hostOf(org.id).act(
      itemSid,
      "link/moved",
      { from: `decision/${org.id}/${project.id}/d_export1`, statechart: "decision", states: ["promoted"], running: true, exported: { state: "promoted", statement: "Export writes CSV.", record: "§req/export" } },
      envelopeFor(org.id, project.id, { by: "statechart", attended: false }),
      { settle: true },
    );
    const onGap = await po.codeItem(org.id, project.id, { ideaId: "§gap/export" }).catch((e: Error) => assert.fail(e.message));
    assert.ok(gapBuilds().some((b) => b.sessionId === onGap.sessionId), "the gap's build");
    assert.equal(readBuild(org.id, project.id, onGap.sessionId)?.kind, "operator-coding", "still the operator's (never on the overseer's caps)");
  });

  test("gathering sessions stay mode-less, whatever the project's coding mode and the default", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    // No hold (q10): the unattended start goes at once, so its session exists to open.
    store.patchPoSettings(p, { codingMode: { mode: "delegate", minorModes: ["spec"] }, holdMin: 0 });
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("g1", { gap: "none", person: "Tony", why: "Nobody has said this yet.", public_title: "Hosting", goal: "Where it runs", question: "Where does it run?" }, undefined, undefined, undefined as never);
    const path = (out.details as { path: string }).path;
    const chat = await acquireChat(path);
    assert.equal(chat.special, "baton");
    assert.equal(chat.session.extensionRunner.getCommand("mode"), undefined, "no mode extension");
    assert.deepEqual(modeEntries(path), [], "no mode entry");
  });
});
