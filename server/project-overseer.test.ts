// Run: pnpm exec tsx --test server/project-overseer.test.ts. A throwaway PI_CODING_AGENT_DIR (with
// this tree's pi-config extensions linked in, so "no pi-config extension loads" is a real claim), an
// org workspace and a project root in the OS temp dir; ~/.pi is never touched. No model is called.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { PROJECT_OVERSEER_ENTRY, type ProjectOverseerSettings } from "../shared/project-overseer";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { PO_BUILTINS, TOOL_NEEDS } = await import("./project-overseer-tools");
const { acquireChat, disposeAllChats, ModeRefusedError, BusyError } = await import("./chat-manager");
const { promptSession } = await import("./overseer");
const { canonicalPath } = await import("./paths");
const { settled } = await import("./workspace-git");
const baton = await import("./baton");
const { readView } = await import("./share/hub");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  await settled(join(root, "ws2"));
  await settled(join(root, "ws3"));
  await settled(join(root, "ws4"));
  await settled(join(root, "ws5"));
  rmSync(root, { recursive: true, force: true });
});

describe("a project overseer", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

  test("GET before the first open: no conversation, L0 while the roster is empty", async () => {
    const info = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info.exists, false);
    assert.equal(info.path, null);
    assert.equal(info.settings.autonomy, "L1");
    assert.equal(info.effective.autonomy, "L0");
    assert.match(info.effective.reason ?? "", /roster has no active people/);
  });

  test("created in the org's workspace sessions dir, cwd = the project root, marker + state in the repo", async () => {
    const made = await po.ensureProjectOverseer(org.id, project.id);
    assert.equal(dirname(made.path), canonicalPath(join(root, "ws", "sessions")));
    const lines = readFileSync(made.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, join(root, "proj"));
    assert.deepEqual(lines[1].data, { v: 1, orgId: org.id, projectId: project.id });
    assert.equal(lines[1].customType, PROJECT_OVERSEER_ENTRY);
    const p = store.projectOverseerPaths(org.id, project.id);
    assert.equal(store.readPoState(p)?.current, made.id);
    assert.ok(p.dir.startsWith(join(root, "ws", "projects", project.id)), "state lives in the workspace repo");
    assert.ok(existsSync(p.settings));
    assert.deepEqual(store.projectOverseerOfPath(made.path), { orgId: org.id, projectId: project.id });
    assert.equal((await po.ensureProjectOverseer(org.id, project.id)).id, made.id, "single conversation per project");
  });

  test("opens as a project overseer: its tools + read-only file tools, no pi-config extension, no modes", async () => {
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const chat = await acquireChat(path);
    assert.equal(chat.special, "project-overseer");
    assert.equal(chat.overseer, false, "not the Overseer");
    const want = [...Object.keys(TOOL_NEEDS), ...PO_BUILTINS].sort();
    assert.deepEqual([...chat.session.getActiveToolNames()].sort(), want);
    assert.deepEqual(chat.session.getAllTools().map((t) => t.name).sort(), want, "no bash, edit, write or extension tool");
    const loaded = chat.runtime.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    assert.deepEqual(loaded, ["<inline:sova-project-overseer>"]);
    await assert.rejects(() => chat.switchMode({ mode: "delegate" } as never), ModeRefusedError);
  });

  test("operator sends go through the kind's own userSend; a fresh runtime is unattended (fail closed)", async () => {
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const chat = await acquireChat(path);
    assert.ok(chat.specialEntry?.userSend, "the kind hands operator sends through its own userSend");
    assert.equal(po.attendedForTest(org.id, project.id), false, "starts unattended (fail closed)");
  });

  test("the Overseer's prompt route refuses to write into it", async () => {
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const r = await promptSession(path, "hello");
    assert.deepEqual(r, { ok: false, status: 409, error: "That is a project overseer's own conversation." });
  });

  test("a copy of the file with another id is an ordinary session", async () => {
    const { path, id } = await po.ensureProjectOverseer(org.id, project.id);
    const other = "01b0dd00-0000-7000-8000-00000000abcd";
    const copy = join(dirname(path), basename(path).replace(id, other));
    copyFileSync(path, copy);
    assert.equal(store.projectOverseerOfPath(canonicalPath(copy)), null);
    rmSync(copy);
  });

  test("clear: a new conversation; the old one is read-only history; settings stay", async () => {
    const before = await po.ensureProjectOverseer(org.id, project.id);
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L2" });
    const info = await po.clearProjectOverseer(org.id, project.id);
    assert.notEqual(info.id, before.id);
    assert.equal(info.settings.autonomy, "L2");
    assert.deepEqual(info.history.map((h) => h.id), [before.id]);
    assert.ok(store.projectOverseerOfPath(before.path), "still recognised as its conversation");
    await assert.rejects(() => acquireChat(before.path), BusyError);
  });

  test("past 20 cleared conversations, the oldest is archived, and its file stays in the workspace", async () => {
    const { isArchived } = await import("./archived-sessions");
    await po.ensureProjectOverseer(org.id, project.id);
    const first = store.readPoState(store.projectOverseerPaths(org.id, project.id))!;
    const oldest = first.history.at(-1) ?? first.current;
    const oldestPath = join(orgs.orgDir(org.id), "sessions", readdirSync(join(orgs.orgDir(org.id), "sessions")).find((f) => f.endsWith(`_${oldest}.jsonl`))!);
    let info = await po.projectOverseerInfo(org.id, project.id);
    while (info.history.some((h) => h.id === oldest) || info.id === oldest) info = await po.clearProjectOverseer(org.id, project.id);
    assert.equal(info.history.length, store.HISTORY_MAX, "20 kept as history");
    assert.ok(isArchived(oldest), "the one that fell off is archived");
    assert.ok(existsSync(oldestPath), "and its file is still in the workspace repo");
  });

  test("PATCH is strict", async () => {
    await assert.rejects(() => po.patchProjectOverseer(org.id, project.id, { autonomy: "L9" }), /autonomy must be one of/);
    await assert.rejects(() => po.patchProjectOverseer(org.id, project.id, { caps: { nope: 1 } }), /Unknown cap/);
    await assert.rejects(() => po.patchProjectOverseer(org.id, project.id, { tokenBudget: -1 }), /tokenBudget/);
  });

  test("with an active person on the roster the setting is in force", async () => {
    orgs.addPerson(org.id, { name: "Tony", role: "IT", decides: ["invoicing"] });
    const info = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info.effective.autonomy, "L2");
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.match(prompt, /Level in force now: \*\*L2/);
    assert.match(prompt, /Tony \(id p_[a-z0-9]+\) — IT; decides: invoicing/);
  });
});

describe("its reach: the project root only", async () => {
  // A context file in the agent dir and one above the root (the host's), one in the root (the project's).
  const box = join(root, "p4");
  const projRoot = join(box, "proj");
  mkdirSync(projRoot, { recursive: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "HOST-AGENT-DIR context\n");
  writeFileSync(join(box, "AGENTS.md"), "HOST-ABOVE-ROOT context\n");
  writeFileSync(join(projRoot, "AGENTS.md"), "PROJECT context\n");
  writeFileSync(join(projRoot, "README.md"), "inside\n");
  writeFileSync(join(box, "outside.txt"), "outside\n");
  const org = await orgs.createOrg({ name: "Reach", dir: join(root, "ws4") });
  const project = orgs.addProject(org.id, { name: "Reach", root: projRoot });
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
  const run = async (name: string, params: Record<string, unknown>) => {
    const chat = await acquireChat((await po.ensureProjectOverseer(org.id, project.id)).path);
    try {
      return text((await chat.session.getToolDefinition(name)!.execute("tc", params as never, undefined, undefined, undefined as never)) as never);
    } catch (err) {
      return `ERROR: ${(err as Error).message}`;
    }
  };

  test("its file tools read the root and refuse the org's workspace, the folder above and the agent dir", async () => {
    assert.match(await run("read", { path: "README.md" }), /inside/);
    for (const p of ["../outside.txt", join(root, "ws4", "org.json"), join(agentDir, "AGENTS.md")]) assert.match(await run("read", { path: p }), /^ERROR: .*outside the project root/, p);
    assert.match(await run("ls", { path: join(root, "ws4") }), /^ERROR: .*outside the project root/);
    assert.match(await run("grep", { pattern: "context", path: box }), /^ERROR: .*outside the project root/);
    assert.match(await run("find", { pattern: "*", path: root }), /^ERROR: .*outside the project root/);
  });

  test("only the project's own context files load, never the host's", async () => {
    const chat = await acquireChat((await po.ensureProjectOverseer(org.id, project.id)).path);
    const files = chat.runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
    assert.deepEqual(files.map((f) => f.path), [join(projRoot, "AGENTS.md")]);
    assert.doesNotMatch(chat.session.systemPrompt, /HOST-/);
    assert.match(chat.session.systemPrompt, /PROJECT context/);
  });

  test("a project root may not be, hold or sit inside an org's workspace, nor sit inside Sova's state", () => {
    mkdirSync(join(root, "ws4", "inner"), { recursive: true });
    mkdirSync(join(agentDir, "sova", "x"), { recursive: true });
    for (const bad of [join(root, "ws4"), join(root, "ws4", "inner"), root, join(agentDir, "sova", "x")])
      assert.throws(() => orgs.addProject(org.id, { name: "Bad", root: bad }), /must not be, hold or sit inside/, bad);
    assert.throws(() => orgs.patchProject(org.id, project.id, { root: join(root, "ws4") }), /must not be/);
    assert.equal(orgs.addProject(org.id, { name: "Beside", root: box }).root, box, "beside the workspace is fine");
  });
});

describe("the operator's queued items reach its next run", async () => {
  const org = await orgs.createOrg({ name: "Queue", dir: join(root, "ws5") });
  mkdirSync(join(root, "proj5"));
  const project = orgs.addProject(org.id, { name: "Queue", root: join(root, "proj5") });
  await po.ensureProjectOverseer(org.id, project.id);
  const p = store.projectOverseerPaths(org.id, project.id);
  const { Hono } = await import("hono");
  const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
  const { updateTodo, readTodos } = await import("./overseer-todos");
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const post = (what: string, b: unknown) =>
    app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  test("a to-do or idea the operator adds is a reason to look; the to-do's own words are in the prompt", async () => {
    assert.equal((await post("todos", { text: "Name in a note who owns the approval threshold" })).status, 201);
    assert.ok(store.readMemo(p).pending.some((r) => /queued a to-do/.test(r)), "a reason to look");
    assert.equal((await post("ideas", { id: "§ops/duplicates", title: "Detect duplicate invoices" })).status, 201);
    assert.ok(store.readMemo(p).pending.some((r) => /added an idea/.test(r)));
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.match(prompt, /- \[td_[^\]]+\] Name in a note who owns the approval threshold$/m);
    assert.match(po.watchText([], "L1", 1), /1 open to-do item for you, listed in full in your prompt: work on it too\./);
    assert.match(po.watchText([], "L1", 3), /3 open to-do items for you, listed in full in your prompt: work on them too\./);
    assert.doesNotMatch(po.watchText([], "L1", 0), /to-do/);
  });

  test("bounded: the first 20 open ones in full, done ones left out, the rest counted", async () => {
    for (let i = 1; i <= 24; i++) await post("todos", { text: `Queued item number ${i}` });
    const first = readTodos(p.todos).todos[0]!;
    updateTodo(first.id, { done: true }, p.todos);
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.doesNotMatch(prompt, /approval threshold/, "a done to-do is not carried");
    assert.match(prompt, /24 open, 1 done\./);
    assert.match(prompt, /Queued item number 20$/m);
    assert.doesNotMatch(prompt, /Queued item number 21$/m);
    assert.match(prompt, /… and 4 more \(sova_todos lists them all\)/);
  });
});

describe("its gathering sessions, as the person sees them", async () => {
  const org = await orgs.createOrg({ name: "Acme Team", dir: join(root, "ws2") });
  mkdirSync(join(root, "proj2"));
  const project = orgs.addProject(org.id, { name: "Books", root: join(root, "proj2") });
  const tony = orgs.addPerson(org.id, { name: "Tony", role: "Finance", decides: ["invoicing"] });
  await po.ensureProjectOverseer(org.id, project.id);
  await po.patchProjectOverseer(org.id, project.id, { model: "ollama-cloud/own-model", thinking: "low" });

  test("sova_start_gathering (unattended at L1): owned by the overseer, no link minted, the goal never in the outsider view", async () => {
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_start_gathering")!;
    const goal = "SECRET-GOAL-TEXT: find out whether Tony will accept net-60 terms without the board";
    const out = await tool.execute("t1", { person: "Tony", public_title: "Payment terms", goal, question: "What payment terms do we offer?" }, undefined, undefined, undefined as never);
    const id = (out.details as { id: string }).id;
    const hit = baton.batonById(id)!;
    assert.deepEqual(hit.row.owner, { overseerOf: project.id });
    assert.equal(hit.row.model, "ollama-cloud/own-model", "the person talks to the overseer's model, not the new-session default");
    assert.equal(hit.row.thinking, "low");
    assert.equal(hit.row.holder, tony.id);
    assert.equal(baton.liveLinkCount(hit.row), 0, "no link: the operator sends one");
    assert.doesNotMatch(JSON.stringify(out), /\/h\/|token|link:/i, "no link or token in the tool result");
    const view = await readView(hit.row, hit.dir, tony.id);
    const seen = JSON.stringify(view);
    assert.equal(view.publicTitle, "Payment terms");
    assert.doesNotMatch(seen, /SECRET-GOAL-TEXT/, "the goal is not in the outsider view");
    assert.doesNotMatch(seen, new RegExp(join(root, "proj2").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "nor the project root");
    const info = await po.projectOverseerInfo(org.id, project.id);
    assert.deepEqual(info.started.map((s) => [s.kind, s.title, s.path !== null]), [["gathering", "Payment terms", true]]);
  });

  test("people's events are kept even while it is busy; its own reconcile events only when idle; repeats fold", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    po.noteReason(org.id, project.id, "A decision was recorded in \"Payment terms\".");
    po.noteReason(org.id, project.id, "A decision was recorded in \"Payment terms\".");
    po.noteReason(org.id, project.id, "2 decisions are drafted and promotable.", true);
    assert.deepEqual(store.readMemo(p).pending, ["A decision was recorded in \"Payment terms\".", "2 decisions are drafted and promotable."]);
  });

  test("its coding sessions' finished turns are reasons to look soon; the operator's never are", () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    const now = Date.parse("2026-09-27T10:00:00Z");
    store.writeMemo(p, { ...store.readMemo(p), pending: [], soonAt: null });
    const mine = join(root, "coding-mine.jsonl");
    const theirs = join(root, "coding-theirs.jsonl");
    for (const f of [mine, theirs]) writeFileSync(f, "{}\n");
    store.noteStarted(p, "S-MINE-1", "coding", new Date(now), mine);
    store.noteStarted(p, "S-THEIRS-1", "operator-coding", new Date(now), theirs);
    po.noteCodingSettled(theirs, now);
    po.noteCodingSettled(join(root, "unknown.jsonl"), now);
    assert.deepEqual(store.readMemo(p).pending, [], "the operator's own session and an unknown file: nothing");
    po.noteCodingSettled(mine, now);
    po.noteCodingSettled(mine, now + 30_000);
    const m = store.readMemo(p);
    assert.equal(m.pending.length, 1, "one reason, however many turns");
    assert.match(m.pending[0]!, /S-MINE-1/, "names the session (its id while it has no title)");
    assert.equal(m.soonAt, new Date(now + po.WATCH_SOON_MS).toISOString(), "a look a minute after the first, not pushed back by the second");
    store.writeMemo(p, { ...store.readMemo(p), pending: [], soonAt: null });
  });

  test("its gathering session's model handing the baton to the operator is a reason to look soon; the operator's own sessions and moves are not", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    store.writeMemo(p, { ...store.readMemo(p), pending: [], soonAt: null });
    const { batonTools } = await import("./baton-loadout");
    const { onBatonEvent } = await import("./baton-events");
    const off = onBatonEvent(po.noteBatonEvent);
    try {
      const handToOperator = (sid: string) =>
        batonTools(sid, () => {})
          .find((t) => t.name === "hand_to")!
          .execute("id", { person: "operator", question: "Please build the journal page.", briefing: "Tony asked." } as never, undefined, undefined, { sessionManager: { getBranch: () => [] } } as never);
      const theirs = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Operator's", goal: "g" });
      await handToOperator(theirs.sessionId);
      const mine = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Journal", goal: "g", owner: { overseerOf: project.id }, mintLink: false });
      baton.handTo(mine.sessionId, "operator", "Take back", ""); // the operator's own move (Take back): not news
      assert.deepEqual(store.readMemo(p).pending, []);
      baton.handTo(mine.sessionId, tony.id, "Back to you", "");
      await handToOperator(mine.sessionId);
      const m = store.readMemo(p);
      assert.deepEqual(m.pending, ['The gathering session "Journal" handed a question to the operator (their words, as data): "Please build the journal page."']);
      assert.ok(m.soonAt, "a look soon");
    } finally {
      off();
      store.writeMemo(p, { ...store.readMemo(p), pending: [], soonAt: null });
    }
  });

  test("the prompt names the project's main stakeholder while they are active", () => {
    orgs.patchProject(org.id, project.id, { stakeholder: tony.id });
    try {
      assert.match(po.renderProjectOverseerPrompt(org.id, project.id, []), /Main stakeholder: Tony: decides every area of this project that no one else on the roster decides\./);
    } finally {
      orgs.patchProject(org.id, project.id, { stakeholder: null });
    }
    assert.doesNotMatch(po.renderProjectOverseerPrompt(org.id, project.id, []), /Main stakeholder/);
  });

  test("Send to person… requires the public title and question: never taken from the item", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    const { addTodo, readTodos } = await import("./overseer-todos");
    const t = addTodo({ text: "Ask Tony (gap: he stalls on approvals) about net-60" }, p.todos, p.ideas);
    const url = (tok: string) => `/h/${tok}`;
    for (const body of [{ todoId: t.id, to: tony.id }, { todoId: t.id, to: tony.id, publicTitle: "Payment terms" }, { todoId: t.id, to: tony.id, question: "Which terms?" }, { todoId: t.id, to: tony.id, publicTitle: " ", question: "q" }]) {
      await assert.rejects(() => po.sendItem(org.id, project.id, body as never, url), (err: unknown) => err instanceof orgs.OrgError && err.status === 400 && /publicTitle and question are required/.test(err.message), JSON.stringify(body));
    }
    assert.equal(readTodos(p.todos).todos.find((x) => x.id === t.id)?.sessionId, undefined, "nothing started, nothing linked");
    const made = await po.sendItem(org.id, project.id, { todoId: t.id, to: tony.id, publicTitle: "Payment terms", question: "Which payment terms do we offer?" }, url);
    assert.equal(made.links.length, 1);
    const row = baton.batonById(made.sessionId)!.row;
    assert.equal(row.publicTitle, "Payment terms");
    assert.equal(row.model, "ollama-cloud/own-model", "Send to person… too");
    await po.patchProjectOverseer(org.id, project.id, { gatheringModel: "ollama-cloud/talk-model", gatheringThinking: "minimal" });
    const t2 = addTodo({ text: "Second" }, p.todos, p.ideas);
    const made2 = await po.sendItem(org.id, project.id, { todoId: t2.id, to: tony.id, publicTitle: "Bank", question: "Which bank?" }, url);
    assert.deepEqual([baton.batonById(made2.sessionId)!.row.model, baton.batonById(made2.sessionId)!.row.thinking], ["ollama-cloud/talk-model", "minimal"]);
    const view = JSON.stringify(await readView(row, baton.batonById(made.sessionId)!.dir, tony.id));
    assert.doesNotMatch(view, /stalls|gap/, "the item's own text never reaches the person");
    assert.equal(readTodos(p.todos).todos.find((x) => x.id === t.id)?.sessionId, made.sessionId);
  });

  test("a look that may not start leaves the news waiting", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    await po.patchProjectOverseer(org.id, project.id, { watch: false });
    const before = store.readMemo(p).pending;
    const r = await po.lookNow(org.id, project.id);
    assert.equal(r.started, false);
    assert.match(r.why ?? "", /watching is off/);
    assert.deepEqual(store.readMemo(p).pending, before);
  });
});

describe("promotion: an out-of-area decision is never the overseer's", async () => {
  const reconcile = await import("./reconcile");
  const decisions = await import("./decisions");
  const { BATON_DECISION_ENTRY } = await import("../shared/baton");
  const org = await orgs.createOrg({ name: "Acme", dir: join(root, "ws3") });
  mkdirSync(join(root, "proj3"));
  const project = orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj3") });
  orgs.addPerson(org.id, { name: "Tony", role: "Finance", decides: ["invoicing"] });
  const ana = orgs.addPerson(org.id, { name: "Ana", role: "IT", decides: ["hosting"] });
  await po.ensureProjectOverseer(org.id, project.id);
  // A person with no say over invoicing states an invoicing rule in her own gathering session.
  const b = baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Hosting", goal: "g", question: "q" });
  const ts = new Date().toISOString();
  const last = JSON.parse(readFileSync(b.path, "utf8").trim().split("\n").at(-1)!).id;
  const lines = [
    { type: "message", id: "u0000001", parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Invoices are due in 90 days." }] } },
    { type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: "u0000001", by: ana.id }, id: "s0000001", parentId: "u0000001", timestamp: ts },
    { type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, area: "invoicing", statement: "Invoices are due in 90 days.", quote: "Invoices are due in 90 days.", by: ana.id }, id: "d0000001", parentId: "s0000001", timestamp: ts },
  ];
  appendFileSync(b.path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  reconcile.setReconcileDeps({
    provider: () => ({
      id: "chain",
      label: "fake",
      async decide(req: any) {
        const answers: Record<string, any> = {};
        for (const [qid, q] of Object.entries<any>(req.questions)) {
          if (q.type === "boolean") answers[qid] = { type: "boolean", p: 0.05 };
          else {
            const choice = decisions.areaKeyOf(req.state?.new?.[qid]?.name ?? "invoicing");
            answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
          }
        }
        return { answers, provider: "jev", model: "fake", latencyMs: 1 };
      },
    }) as never,
    excluded: () => false,
  });
  after(() => reconcile.setReconcileDeps(null));

  test("sova_promote passes by: overseer (real reconciler): an out-of-area drafted decision is refused and its reason reaches the model", async () => {
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L2" });
    const tools = po.toolsForTest(org.id, project.id);
    const run = (name: string, params: object) => tools.find((t) => t.name === name)!.execute("t", params, undefined, undefined, undefined as never);
    await run("sova_reconcile", {});
    const row = reconcile.listDecisions(org.id, project.id).decisions.find((d) => d.markerId === "d0000001")!;
    assert.equal(row.state, "drafted");
    assert.equal(row.authorOwnsArea, false);
    await assert.rejects(() => run("sova_promote", { ids: [row.id] }), new RegExp(`Promoted 0, refused 1: ${row.id} \\(outside Ana's decision area`));
    assert.equal(reconcile.listDecisions(org.id, project.id).decisions.find((d) => d.id === row.id)!.state, "drafted", "not promoted");
  });
});

describe("the coding sessions' model", () => {
  const none = { model: null, thinking: null, codingModel: null, codingThinking: null, gatheringModel: null, gatheringThinking: null };
  test("the call's choice, else codingModel, else the overseer's setting, else what its runtime runs", () => {
    assert.deepEqual(po.codingChoice({ model: "a/x", thinking: "high" }, { ...none, codingModel: "b/y", model: "c/z" }, { model: "d/w", thinking: "low" }), { model: "a/x", thinking: "high" });
    assert.deepEqual(po.codingChoice({}, { ...none, codingModel: "b/y", codingThinking: "minimal", model: "c/z", thinking: "low" }, { model: "d/w", thinking: "off" }), { model: "b/y", thinking: "minimal" });
    assert.deepEqual(po.codingChoice({}, { ...none, model: "c/z", thinking: "low" }, { model: "d/w", thinking: "off" }), { model: "c/z", thinking: "low" });
    assert.deepEqual(po.codingChoice({}, none, { model: "d/w", thinking: "off" }), { model: "d/w", thinking: "off" });
  });
  test("gathering sessions: the call, else gatheringModel, else the overseer's own; the coding choice never leaks in", () => {
    const s = { ...none, codingModel: "code/m", codingThinking: "high", model: "own/m", thinking: "low" };
    assert.deepEqual(po.sessionChoice("gathering", { model: "call/m" }, s, { model: null, thinking: null }), { model: "call/m", thinking: "low" });
    assert.deepEqual(po.sessionChoice("gathering", {}, { ...s, gatheringModel: "g/m", gatheringThinking: "minimal" }, { model: null, thinking: null }), { model: "g/m", thinking: "minimal" });
    assert.deepEqual(po.sessionChoice("gathering", {}, s, { model: "run/m", thinking: "off" }), { model: "own/m", thinking: "low" });
    assert.deepEqual(po.sessionChoice("gathering", {}, none, { model: "run/m", thinking: "off" }), { model: "run/m", thinking: "off" });
  });
});

describe("the store", () => {
  test("ids are path segments only in their own shape", () => {
    assert.throws(() => store.projectOverseerPaths("org_x", "../../etc", "/ws"), /Unknown project/);
    assert.throws(() => store.projectOverseerPaths("../o", "prj_x", "/ws"), /Unknown project/);
  });
  test("a hand-edited settings file never breaks it: bad fields fall back", () => {
    const s = store.parsePoSettings({ autonomy: "L7", caps: { gatherPerTurn: -3, createPerTurn: 4 }, tokenBudget: "lots", watch: "yes" });
    assert.equal(s.autonomy, "L1");
    assert.equal(s.caps.gatherPerTurn, store.DEFAULT_PO_CAPS.gatherPerTurn);
    assert.equal(s.caps.createPerTurn, 4);
    assert.equal(s.tokenBudget, store.DEFAULT_TOKEN_BUDGET);
    assert.equal(s.watch, true);
  });
});

describe("the watch loop's decision", () => {
  const base = { pending: ["A decision was recorded"], watch: true, exists: true, idle: true, now: 100 * 60_000, lastRunAt: 0, today: 0, perDay: 12 };
  test("runs on news, when idle, ≥10 min after the last look, under the daily cap", () => {
    assert.deepEqual(po.watchDecision(base), { run: true });
    assert.equal(po.watchDecision({ ...base, pending: [] }).run, false);
    assert.equal(po.watchDecision({ ...base, idle: false }).run, false);
    assert.equal(po.watchDecision({ ...base, watch: false }).run, false);
    assert.equal(po.watchDecision({ ...base, exists: false }).run, false);
    assert.equal(po.watchDecision({ ...base, lastRunAt: base.now - po.WATCH_MIN_GAP_MS + 1 }).run, false);
    assert.equal(po.watchDecision({ ...base, lastRunAt: base.now - po.WATCH_MIN_GAP_MS }).run, true);
    assert.match(po.watchDecision({ ...base, today: 12 }).why ?? "", /daily limit of 12/);
  });
  test("Run Now skips the gap and the news check, never the daily cap or a busy overseer", () => {
    assert.equal(po.watchDecision({ ...base, pending: [], lastRunAt: base.now, force: true }).run, true);
    assert.equal(po.watchDecision({ ...base, force: true, today: 12 }).run, false);
    assert.equal(po.watchDecision({ ...base, force: true, idle: false }).run, false);
  });
  test("an event wanting a look soon lets it run once its time comes, whatever the gap; never over the other rules", () => {
    const soonAt = base.now - 1;
    const recent = { ...base, lastRunAt: base.now - 60_000 };
    assert.equal(po.watchDecision(recent).run, false, "inside the gap");
    assert.equal(po.watchDecision({ ...recent, soonAt }).run, true, "due: the gap is skipped");
    assert.equal(po.watchDecision({ ...recent, soonAt: base.now + 1 }).run, false, "not yet due");
    for (const k of [{ today: 12 }, { watch: false }, { idle: false }, { pending: [] as string[] }]) assert.equal(po.watchDecision({ ...recent, soonAt, ...k }).run, false, JSON.stringify(k));
  });
  test("the watch message says it is automatic and names the level", () => {
    const t = po.watchText(["A decision was recorded in \"Invoicing\"."], "L1");
    assert.ok(t.startsWith(po.WATCH_PREFIX));
    assert.match(t, /within your autonomy \(L1\)/);
  });
});

describe("thinking levels a model doesn't offer", () => {
  const models = [
    { ref: "zai/glm-5.3", thinkingLevels: ["low", "high", "max"] },
    { ref: "p/basic", thinkingLevels: ["off"] },
  ];
  const settings = (over: Partial<ProjectOverseerSettings>) => ({ ...store.defaultPoSettings(), ...over });
  test("pi's clamp: the level itself, else the next offered up, else the next down", () => {
    assert.equal(store.clampLevel("medium", ["low", "high", "max"]), "high");
    assert.equal(store.clampLevel("max", ["low", "medium"]), "medium");
    assert.equal(store.clampLevel("low", ["low", "high"]), "low");
    assert.equal(store.clampLevel("bogus", ["low"]), "low");
  });
  test("a level the patch names is refused with the levels offered; one a model change left behind is moved and kept", () => {
    assert.throws(() => store.fitThinking(settings({ model: "zai/glm-5.3", thinking: "medium" }), { thinking: "medium" }, models, null), { message: "zai/glm-5.3 offers thinking low, high, max." });
    // Coding and gathering pairs fall back to the overseer's model.
    assert.throws(() => store.fitThinking(settings({ model: "zai/glm-5.3", codingThinking: "minimal" }), { codingThinking: "minimal" }, models, null), /zai\/glm-5\.3 offers/);
    const moved = settings({ model: "zai/glm-5.3", thinking: "medium", gatheringModel: "p/basic", gatheringThinking: "low" });
    store.fitThinking(moved, { model: "zai/glm-5.3", gatheringModel: "p/basic" }, models, null);
    assert.deepEqual([moved.thinking, moved.gatheringThinking], ["high", "off"]);
    // A model this host can't list is not judged; the default model stands in for an unset one.
    const unknown = settings({ model: "x/unlisted", thinking: "medium" });
    store.fitThinking(unknown, { thinking: "medium" }, models, null);
    assert.equal(unknown.thinking, "medium");
    assert.throws(() => store.fitThinking(settings({ thinking: "medium" }), { thinking: "medium" }, models, "zai/glm-5.3"), /offers thinking/);
  });
  test("a refused PATCH writes nothing", () => {
    const dir = join(root, "ws-think");
    const p = store.projectOverseerPaths("org_aaaaaaaa", "prj_bbbbbbbb", dir);
    store.writePoSettings(p, settings({ model: "zai/glm-5.3", thinking: "high" }));
    const before = readFileSync(p.settings, "utf8");
    assert.throws(() => store.patchPoSettings(p, { thinking: "medium" }, (next, patch) => store.fitThinking(next, patch, models, null)), /offers thinking/);
    assert.equal(readFileSync(p.settings, "utf8"), before);
  });
});

describe("the org's About text in its prompt (§app.organizations/about)", async () => {
  const org = await orgs.createOrg({ name: "Aboutco", dir: join(root, "ws6") });
  mkdirSync(join(root, "proj6"));
  const project = orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj6") });
  await po.ensureProjectOverseer(org.id, project.id);
  const HEAD = "# About this organization (written by the operator)";
  const EXTRA = "# The operator's extra instructions";
  after(() => settled(join(root, "ws6")));

  test("none: no section at all; the fixed rule is there anyway", () => {
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.ok(!prompt.includes(HEAD));
    assert.match(prompt, /^- "About this organization", when your prompt has it, is the operator's private context: use it to\n\s+judge, never quote or copy it/m, "the rule line stands before any text exists");
  });

  test("after the fixed prompt, before the extra instructions; re-read at every render", async () => {
    orgs.patchOrg(org.id, { about: "ABOUT-ONE: they close the books on the 5th." });
    await po.patchProjectOverseer(org.id, project.id, { extraSystemPrompt: "EXTRA-ONE: be terse." });
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    const at = prompt.indexOf(HEAD);
    assert.ok(at > prompt.indexOf("## Tools"), "after the fixed prompt");
    assert.ok(at < prompt.indexOf(EXTRA), "before the extra instructions");
    assert.ok(prompt.indexOf("ABOUT-ONE") > at && prompt.indexOf("ABOUT-ONE") < prompt.indexOf(EXTRA));
    assert.match(prompt, /The operator wrote this about Aboutco, for you only\./);
    assert.match(prompt, /The project's extra instructions below take precedence over it\./);
    orgs.patchOrg(org.id, { about: "ABOUT-TWO" });
    const next = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.ok(next.includes("ABOUT-TWO") && !next.includes("ABOUT-ONE"), "the next run reads the new text");
    await po.patchProjectOverseer(org.id, project.id, { extraSystemPrompt: "" });
    assert.ok(po.renderProjectOverseerPrompt(org.id, project.id, []).trimEnd().endsWith("ABOUT-TWO"), "last when there are no extra instructions");
  });

  test("clipped to 4,000 characters; secrets redacted", () => {
    writeFileSync(join(orgs.orgDir(org.id), "about.md"), `${"a".repeat(3999)}BCDEF`);
    const prompt = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.ok(prompt.includes(`${"a".repeat(3999)}B`) && !prompt.includes("BC"), "only the first 4,000 characters");
    const key = "rdAboutKey-7fQ2mZ9xL4vN8pR1sT6uW3yA5bC0dE";
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ about: { type: "api_key", key } }));
    orgs.patchOrg(org.id, { about: `The staging key is ${key}.` });
    const redacted = po.renderProjectOverseerPrompt(org.id, project.id, []);
    assert.ok(!redacted.includes(key), "a secret is redacted");
    assert.match(redacted, /The staging key is \S+\./);
    rmSync(join(agentDir, "auth.json"));
    orgs.patchOrg(org.id, { about: "" });
    assert.ok(!po.renderProjectOverseerPrompt(org.id, project.id, []).includes(HEAD), "cleared: the section goes");
  });
});
