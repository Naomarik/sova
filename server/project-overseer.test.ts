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
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { PO_BUILTINS, TOOL_NEEDS } = await import("./project-overseer-tools");
const { acquireChat, disposeAllChats, ModeRefusedError, BusyError } = await import("./chat-manager");
const { promptSession } = await import("./session-prompt");
const { canonicalPath } = await import("./paths");
const { settled } = await import("./workspace-git");
const baton = await import("./baton");
const { envelopeFor, holdByRef, hostOf } = await import("./org-engine");
const { readView } = await import("./share/hub");
const { editProject } = await import("./projects/spaces");
const { watchSid } = await import("./projects/sids");
const orgPart = await import("./overseer-org-part");
const { fakeLooks, noteWatchReason, seedBuild } = await import("./org-test-fixtures");
const { stateRoot } = await import("./state-root");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  await settled(join(root, "ws2"));
  await settled(join(root, "ws3"));
  await settled(join(root, "ws4"));
  await settled(join(root, "ws5"));
  await settled(join(root, "ws-knobs"));
  await settled(join(root, "ws-loop"));
  po.setClockForTest(null);
  rmSync(root, { recursive: true, force: true });
});

describe("a project overseer", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

  test("GET before the first open: no conversation, L0 while the roster is empty", async () => {
    const info = await po.projectOverseerInfo(project.id);
    assert.equal(info.exists, false);
    assert.equal(info.path, null);
    assert.equal(info.settings.autonomy, "L1");
    assert.equal(info.effective.autonomy, "L0");
    assert.match(info.effective.reason ?? "", /roster has no active people/);
  });

  test("created in the org's workspace sessions dir, cwd = the project root, marker + state in the repo", async () => {
    const made = await po.ensureProjectOverseer(project.id);
    assert.equal(dirname(made.path), canonicalPath(join(root, "ws", "sessions")));
    const lines = readFileSync(made.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, join(root, "proj"));
    assert.deepEqual(lines[1].data, { v: 1, projectId: project.id });
    assert.equal(lines[1].customType, PROJECT_OVERSEER_ENTRY);
    const p = store.projectOverseerPaths(project.id);
    assert.equal(store.readPoState(p)?.current, made.id);
    assert.ok(p.dir.startsWith(join(root, "ws", "projects", project.id)), "state lives in the workspace repo");
    assert.ok(existsSync(p.settings));
    assert.deepEqual(store.projectOverseerOfPath(made.path), { projectId: project.id });
    assert.equal((await po.ensureProjectOverseer(project.id)).id, made.id, "single conversation per project");
  });

  test("opens as a project overseer: its tools + read-only file tools, no pi-config extension, no modes", async () => {
    const { path } = await po.ensureProjectOverseer(project.id);
    const chat = await acquireChat(path);
    assert.equal(chat.special, "project-overseer");
    assert.equal(chat.overseer, false, "not the Overseer");
    // A placed project: the org part's reads (no statechart act names them) come with its tools.
    const want = [...new Set([...Object.keys(TOOL_NEEDS), "sova_decisions", "sova_offer", "sova_send_status", ...PO_BUILTINS])].sort();
    assert.deepEqual([...chat.session.getActiveToolNames()].sort(), want);
    assert.deepEqual(chat.session.getAllTools().map((t) => t.name).sort(), want, "no bash, edit, write or extension tool");
    const loaded = chat.runtime.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    assert.deepEqual(loaded, ["<inline:sova-project-overseer>"]);
    await assert.rejects(() => chat.switchMode({ mode: "delegate" } as never), ModeRefusedError);
  });

  test("operator sends go through the kind's own userSend; a fresh runtime is unattended (fail closed)", async () => {
    const { path } = await po.ensureProjectOverseer(project.id);
    const chat = await acquireChat(path);
    assert.ok(chat.specialEntry?.userSend, "the kind hands operator sends through its own userSend");
    assert.equal(po.attendedForTest(project.id), false, "starts unattended (fail closed)");
  });

  test("the Overseer's prompt route refuses to write into it", async () => {
    const { path } = await po.ensureProjectOverseer(project.id);
    const r = await promptSession(path, "hello");
    assert.deepEqual(r, { ok: false, status: 409, error: "That is a project overseer's own conversation." });
  });

  test("a copy of the file with another id is an ordinary session", async () => {
    const { path, id } = await po.ensureProjectOverseer(project.id);
    const other = "01b0dd00-0000-7000-8000-00000000abcd";
    const copy = join(dirname(path), basename(path).replace(id, other));
    copyFileSync(path, copy);
    assert.equal(store.projectOverseerOfPath(canonicalPath(copy)), null);
    rmSync(copy);
  });

  test("clear: a new conversation; the old one is read-only history; settings stay", async () => {
    const before = await po.ensureProjectOverseer(project.id);
    await po.patchProjectOverseer(project.id, { autonomy: "L2" });
    const info = await po.clearProjectOverseer(project.id);
    assert.notEqual(info.id, before.id);
    assert.equal(info.settings.autonomy, "L2");
    assert.deepEqual(info.history.map((h) => h.id), [before.id]);
    assert.ok(store.projectOverseerOfPath(before.path), "still recognised as its conversation");
    await assert.rejects(() => acquireChat(before.path), BusyError);
  });

  test("past 20 cleared conversations, the oldest is archived, and its file stays in the workspace", async () => {
    const { isArchived } = await import("./archived-sessions");
    await po.ensureProjectOverseer(project.id);
    const first = store.readPoState(store.projectOverseerPaths(project.id))!;
    const oldest = first.history.at(-1) ?? first.current;
    const oldestPath = join(orgs.orgDir(org.id), "sessions", readdirSync(join(orgs.orgDir(org.id), "sessions")).find((f) => f.endsWith(`_${oldest}.jsonl`))!);
    let info = await po.projectOverseerInfo(project.id);
    while (info.history.some((h) => h.id === oldest) || info.id === oldest) info = await po.clearProjectOverseer(project.id);
    assert.equal(info.history.length, store.HISTORY_MAX, "20 kept as history");
    assert.ok(isArchived(oldest), "the one that fell off is archived");
    assert.ok(existsSync(oldestPath), "and its file is still in the workspace repo");
  });

  test("PATCH is strict", async () => {
    await assert.rejects(() => po.patchProjectOverseer(project.id, { autonomy: "L9" }), /autonomy must be one of/);
    await assert.rejects(() => po.patchProjectOverseer(project.id, { caps: { nope: 1 } }), /Unknown cap/);
  });

  test("the removed token budget: an old file's is ignored and dropped at the next save; a stale PATCH's is ignored", async () => {
    const p = store.projectOverseerPaths(project.id);
    const raw = JSON.parse(readFileSync(p.settings, "utf8"));
    writeFileSync(p.settings, JSON.stringify({ ...raw, tokenBudget: 5 }));
    assert.ok(!("tokenBudget" in store.readPoSettings(p)));
    const info = await po.patchProjectOverseer(project.id, { tokenBudget: 7, watchGapMin: 11 } as never);
    assert.ok(!("tokenBudget" in info.settings));
    assert.ok(!("tokenBudget" in info.usage));
    const saved = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.equal(saved.watchGapMin, 11);
    assert.ok(!("tokenBudget" in saved), "dropped on the save");
  });

  test("with an active person on the roster the setting is in force", async () => {
    await orgs.addPerson(org.id, { name: "Tony", role: "IT", decides: ["invoicing"] });
    const info = await po.projectOverseerInfo(project.id);
    assert.equal(info.effective.autonomy, "L2");
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
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
  const project = await orgs.addProject(org.id, { name: "Reach", root: projRoot });
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
  const run = async (name: string, params: Record<string, unknown>) => {
    const chat = await acquireChat((await po.ensureProjectOverseer(project.id)).path);
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
    const chat = await acquireChat((await po.ensureProjectOverseer(project.id)).path);
    const files = chat.runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
    assert.deepEqual(files.map((f) => f.path), [join(projRoot, "AGENTS.md")]);
    assert.doesNotMatch(chat.session.systemPrompt, /HOST-/);
    assert.match(chat.session.systemPrompt, /PROJECT context/);
  });

  test("a project root may not be, hold or sit inside an org's workspace, nor sit inside Sova's state", async () => {
    mkdirSync(join(root, "ws4", "inner"), { recursive: true });
    mkdirSync(join(agentDir, "sova", "x"), { recursive: true });
    for (const bad of [join(root, "ws4"), join(root, "ws4", "inner"), root, join(agentDir, "sova", "x")])
      await assert.rejects(orgs.addProject(org.id, { name: "Bad", root: bad }), /(is inside|holds) .*, which Sova keeps for itself, so it can't be a project\.|Sova.s own state can.t be a project/, bad);
    await assert.rejects(editProject(project.id, { root: join(root, "ws4") }), /which Sova keeps for itself/);
    assert.equal((await orgs.addProject(org.id, { name: "Beside", root: box })).root, box, "beside the workspace is fine");
  });
});

describe("the operator's to-dos and ideas are their own list, never a reason to look", async () => {
  const org = await orgs.createOrg({ name: "Queue", dir: join(root, "ws5") });
  mkdirSync(join(root, "proj5"));
  const project = await orgs.addProject(org.id, { name: "Queue", root: join(root, "proj5") });
  await po.ensureProjectOverseer(project.id);
  const p = store.projectOverseerPaths(project.id);
  const { Hono } = await import("hono");
  const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
  const { readTodos } = await import("./overseer-todos");
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const post = (what: string, b: unknown) =>
    app.request(`/api/projects/${project.id}/overseer/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  test("adding a to-do or an idea notes no reason; the prompt carries no to-do text; a look's message never points at them", async () => {
    const before = store.readMemo(p).pending.length;
    assert.equal((await post("todos", { text: "Name in a note who owns the approval threshold" })).status, 201);
    assert.equal((await post("ideas", { id: "§ops/duplicates", title: "Detect duplicate invoices" })).status, 201);
    assert.equal(readTodos(p.todos).todos.length, 1, "the to-do was added");
    assert.equal(store.readMemo(p).pending.length, before, "no reason to look");
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
    assert.doesNotMatch(prompt, /approval threshold/, "the to-do's words stay out of the prompt");
    assert.match(prompt, /to-do items are their own list/);
    assert.match(prompt, /never because\s+a to-do or an idea exists/);
    // A look's message (the watch statechart's), as Run Now starts one.
    const { looks } = fakeLooks(org.id);
    await noteWatchReason(org.id, project.id, { kind: "baton/done", params: { title: "Menu" }, key: "baton/done:menu" });
    assert.equal((await po.lookNow(project.id)).started, true);
    const look = looks.at(-1)!.text;
    assert.match(look, /The gathering session "Menu" reached its goal\./);
    assert.doesNotMatch(look, /to-do|todo|idea item/i);
  });
});

describe("its gathering sessions, as the person sees them", async () => {
  const org = await orgs.createOrg({ name: "Acme Team", dir: join(root, "ws2") });
  // Its looks run nothing here (these tests are about what it starts, not its runs).
  fakeLooks(org.id);
  mkdirSync(join(root, "proj2"));
  const project = await orgs.addProject(org.id, { name: "Books", root: join(root, "proj2") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "Finance", decides: ["invoicing"] });
  await po.ensureProjectOverseer(project.id);
  await po.patchProjectOverseer(project.id, { model: "ollama-cloud/own-model", thinking: "low" });

  test("sova_start_gathering (unattended at L1): owned by the overseer, no link minted, the goal never in the outsider view", async () => {
    const tool = po.toolsForTest(project.id).find((t) => t.name === "sova_start_gathering")!;
    const goal = "SECRET-GOAL-TEXT: find out whether Tony will accept net-60 terms without the board";
    const sp = store.projectOverseerPaths(project.id);
    const was = store.readPoSettings(sp);
    // With a hold (q10) the unattended start waits for the operator to cancel it: nothing exists yet.
    store.writePoSettings(sp, { ...was, holdMin: 10 });
    const held = await tool.execute("t0", { gap: "none", person: "Tony", why: "Nobody has said this yet.", public_title: "Payment terms", goal, question: "What payment terms do we offer?" }, undefined, undefined, undefined as never);
    assert.match((held.content as { text: string }[])[0]!.text, /^Held: starting "Payment terms" with Tony waits until .+ so the operator can cancel it/);
    assert.ok((held.details as { held?: string }).held);
    assert.equal(baton.allBatons().filter((b) => b.publicTitle === "Payment terms").length, 0, "held: no session yet");
    const h = holdByRef(org.id, (held.details as { held: string }).held)!;
    assert.equal((await hostOf(org.id).act(h.sessionId, "hold/cancel", { id: h.id }, envelopeFor(org.id, project.id, { by: "operator", attended: true }), { settle: true })).taken, true);
    // With none it starts at once.
    store.writePoSettings(sp, { ...was, holdMin: 0 });
    const out = await tool.execute("t1", { gap: "none", person: "Tony", why: "Nobody has said this yet.", public_title: "Payment terms", goal, question: "What payment terms do we offer?" }, undefined, undefined, undefined as never);
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
    const info = await po.projectOverseerInfo(project.id);
    assert.deepEqual(info.started.map((s) => [s.kind, s.title, s.path !== null]), [["gathering", "Payment terms", true]]);
  });

  test("people's events are kept even while it is busy; its own reconcile events only when idle; repeats fold", async () => {
    const p = store.projectOverseerPaths(project.id);
    const before = store.readMemo(p).pending.length;
    const watch = watchSid(project.id);
    const done = { kind: "baton/done", params: { title: "Payment terms" }, key: "baton/done:pt", by: "person" };
    const drafted = { kind: "reconcile/drafted", params: { n: 2 }, key: "reconcile/drafted:a,b", by: "overseer" };
    // Busy: one of its runs is going on.
    await hostOf(org.id).act(watch, "turn/started", { look: false }, { by: "system" });
    await noteWatchReason(org.id, project.id, done);
    await noteWatchReason(org.id, project.id, drafted);
    await hostOf(org.id).act(watch, "turn/ended", {}, { by: "system" });
    assert.deepEqual(store.readMemo(p).pending.slice(before), ['The gathering session "Payment terms" reached its goal.'], "its own act while it runs is no news");
    await noteWatchReason(org.id, project.id, done);
    await noteWatchReason(org.id, project.id, drafted);
    assert.deepEqual(store.readMemo(p).pending.slice(before), ['The gathering session "Payment terms" reached its goal.', "2 decisions are drafted and promotable."], "repeats fold; idle, its own reconcile events are kept");
  });

  test("its coding sessions' finished turns are reasons to look soon; the operator's never are", async () => {
    const p = store.projectOverseerPaths(project.id);
    const now = Date.now();
    // A look a minute before (master's memo.lastRunAt): the gap has not passed, so the reasons wait for their soon look.
    po.setClockForTest(() => now - 60_000);
    try {
      assert.equal((await po.lookNow(project.id)).started, true);
    } finally {
      po.setClockForTest(null);
    }
    const before = store.readMemo(p).pending.length;
    const mine = join(root, "coding-mine.jsonl");
    const theirs = join(root, "coding-theirs.jsonl");
    for (const f of [mine, theirs]) writeFileSync(f, "{}\n");
    await seedBuild(org.id, project.id, { sessionId: "S-MINE-1", kind: "coding", path: mine, createdAt: now });
    await seedBuild(org.id, project.id, { sessionId: "S-THEIRS-1", kind: "operator-coding", path: theirs, createdAt: now });
    const settledAt = async (path: string, at: number) => {
      po.setClockForTest(() => at);
      try {
        po.noteCodingSettled(path);
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        po.setClockForTest(null);
      }
    };
    await settledAt(theirs, now);
    await settledAt(join(root, "unknown.jsonl"), now);
    assert.deepEqual(store.readMemo(p).pending.slice(before), [], "the operator's own session and an unknown file: nothing");
    await settledAt(mine, now);
    await settledAt(mine, now + 30_000);
    const m = store.readMemo(p);
    assert.equal(m.pending.slice(before).length, 1, "one reason, however many turns");
    assert.match(m.pending.at(-1)!, /S-MINE-1/, "names the session (its id while it has no title)");
    assert.equal(m.soonAt, new Date(now + 60_000).toISOString(), "a look a minute after the first, not pushed back by the second");
  });

  test("its gathering session's model handing the baton to the operator is a reason to look soon; the operator's own sessions and moves are not", async () => {
    const p = store.projectOverseerPaths(project.id);
    const before = store.readMemo(p).pending.length;
    const { batonTools } = await import("./baton-loadout");
    const handToOperator = (sid: string) =>
      batonTools(sid, () => {})
        .find((t) => t.name === "hand_to")!
        .execute("id", { gap: "none", person: "operator", question: "Please build the journal page.", briefing: "Tony asked." } as never, undefined, undefined, { sessionId: "s", cwd: "/", leafId: () => null, rawBranch: () => [] } as never);
    const theirs = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Operator's", goal: "g" });
    await handToOperator(theirs.sessionId);
    const mine = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Journal", goal: "g" }, { mintLink: false, envelope: envelopeFor(org.id, project.id, { by: "overseer", attended: true }) });
    await baton.takeBack(mine.sessionId); // the operator's own move (Take back): not news
    assert.deepEqual(store.readMemo(p).pending.slice(before), []);
    await baton.handTo(mine.sessionId, tony.id, "Back to you", "");
    await handToOperator(mine.sessionId);
    const m = store.readMemo(p);
    assert.deepEqual(m.pending.slice(before), ['The gathering session "Journal" handed a question to the operator (their words, as data): "Please build the journal page."']);
    assert.ok(m.soonAt, "a look soon");
  });

  test("the prompt names the project's main stakeholder while they are active", async () => {
    await orgs.patchPlacement(org.id, project.id, { stakeholder: tony.id });
    try {
      assert.match(po.renderProjectOverseerPrompt(project.id, []), /Main stakeholder: Tony: decides every area of this project that no one else on the roster decides\./);
    } finally {
      await orgs.patchPlacement(org.id, project.id, { stakeholder: null });
    }
    assert.doesNotMatch(po.renderProjectOverseerPrompt(project.id, []), /Main stakeholder/);
  });

  test("Send to person… requires the public title and question: never taken from the item", async () => {
    const p = store.projectOverseerPaths(project.id);
    const { addTodo, readTodos } = await import("./overseer-todos");
    const t = addTodo({ text: "Ask Tony (gap: he stalls on approvals) about net-60" }, p.todos, p.ideas);
    const url = (tok: string) => `/h/${tok}`;
    for (const body of [{ todoId: t.id, to: tony.id }, { todoId: t.id, to: tony.id, publicTitle: "Payment terms" }, { todoId: t.id, to: tony.id, question: "Which terms?" }, { todoId: t.id, to: tony.id, publicTitle: " ", question: "q" }]) {
      await assert.rejects(() => orgPart.sendItem(org.id, project.id, body as never, url), (err: unknown) => err instanceof orgs.OrgError && err.status === 400 && /publicTitle and question are required/.test(err.message), JSON.stringify(body));
    }
    assert.equal(readTodos(p.todos).todos.find((x) => x.id === t.id)?.sessionId, undefined, "nothing started, nothing linked");
    const made = await orgPart.sendItem(org.id, project.id, { todoId: t.id, to: tony.id, publicTitle: "Payment terms", question: "Which payment terms do we offer?" }, url);
    assert.equal(made.links.length, 1);
    const row = baton.batonById(made.sessionId)!.row;
    assert.equal(row.publicTitle, "Payment terms");
    assert.equal(row.model, "ollama-cloud/own-model", "Send to person… too");
    await po.patchProjectOverseer(project.id, { gatheringModel: "ollama-cloud/talk-model", gatheringThinking: "minimal" });
    const t2 = addTodo({ text: "Second" }, p.todos, p.ideas);
    const made2 = await orgPart.sendItem(org.id, project.id, { todoId: t2.id, to: tony.id, publicTitle: "Bank", question: "Which bank?" }, url);
    assert.deepEqual([baton.batonById(made2.sessionId)!.row.model, baton.batonById(made2.sessionId)!.row.thinking], ["ollama-cloud/talk-model", "minimal"]);
    const view = JSON.stringify(await readView(row, baton.batonById(made.sessionId)!.dir, tony.id));
    assert.doesNotMatch(view, /stalls|gap/, "the item's own text never reaches the person");
    assert.equal(readTodos(p.todos).todos.find((x) => x.id === t.id)?.sessionId, made.sessionId);
  });

  test("a look that may not start leaves the news waiting", async () => {
    const p = store.projectOverseerPaths(project.id);
    await po.patchProjectOverseer(project.id, { watch: false });
    const { looks } = fakeLooks(org.id);
    await noteWatchReason(org.id, project.id, { kind: "baton/closed", params: { title: "Bank" }, key: "baton/closed:bank" });
    const before = store.readMemo(p);
    // Past any gap: the watch's own looks wait while watching is off.
    po.setClockForTest(() => Date.now() + 3 * 3_600_000);
    try {
      hostOf(org.id).fireDue();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      po.setClockForTest(null);
    }
    // The old ticker's "watching is off" was its own return value, never recorded or shown: the watch statechart's switch is that rule now.
    assert.ok(hostOf(org.id).configuration(watchSid(project.id))?.includes("watch-off"), "watching is off");
    assert.equal(looks.length, 0, "no look while watching is off");
    assert.deepEqual(store.readMemo(p).pending, before.pending);
    assert.deepEqual(store.readMemo(p).lastRun, before.lastRun);
  });
});

describe("promotion: an out-of-area decision is never the overseer's", async () => {
  const reconcile = await import("./reconcile");
  const decisions = await import("./decisions");
  const { recordDecision } = await import("./org-test-fixtures");
  const org = await orgs.createOrg({ name: "Acme", dir: join(root, "ws3") });
  mkdirSync(join(root, "proj3"));
  const project = await orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj3") });
  await orgs.addPerson(org.id, { name: "Tony", role: "Finance", decides: ["invoicing"] });
  const ana = await orgs.addPerson(org.id, { name: "Ana", role: "IT", decides: ["hosting"] });
  await po.ensureProjectOverseer(project.id);
  // A person with no say over invoicing states an invoicing rule in her own gathering session.
  const b = await baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Hosting", goal: "g", question: "q" });
  const ts = new Date().toISOString();
  const last = JSON.parse(readFileSync(b.path, "utf8").trim().split("\n").at(-1)!).id;
  const lines = [
    { type: "message", id: "u0000001", parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Invoices are due in 90 days." }] } },
    { type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: "u0000001", by: ana.id }, id: "s0000001", parentId: "u0000001", timestamp: ts },
  ];
  appendFileSync(b.path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const decisionId = await recordDecision(b.path, { area: "invoicing", ownerArea: "invoicing", statement: "Invoices are due in 90 days.", quote: "Invoices are due in 90 days." });
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
    await po.patchProjectOverseer(project.id, { autonomy: "L2" });
    const tools = po.toolsForTest(project.id);
    const run = (name: string, params: object) => tools.find((t) => t.name === name)!.execute("t", params, undefined, undefined, undefined as never);
    await run("sova_reconcile", {});
    const row = reconcile.listDecisions(org.id, project.id).decisions.find((d) => d.id === decisionId)!;
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
    assert.throws(() => store.projectOverseerPaths("../../etc", "/ws"), /Unknown project/);
    assert.throws(() => store.projectOverseerPaths("prj_x/../o", "/ws"), /Unknown project/);
  });
  test("a hand-edited settings file never breaks it: bad fields fall back", () => {
    const s = store.parsePoSettings({ autonomy: "L7", caps: { gatherPerTurn: -3, createPerTurn: 4 }, watch: "yes" });
    assert.equal(s.autonomy, "L1");
    assert.equal(s.caps.gatherPerTurn, store.DEFAULT_PO_CAPS.gatherPerTurn);
    assert.equal(s.caps.createPerTurn, 4);
    assert.equal(s.watch, true);
  });
});

describe("limits: Unlimited, at once, pace (§app.project-overseer/limits)", () => {
  test("an old file without the new keys reads the defaults", () => {
    const s = store.parsePoSettings({ autonomy: "L3", caps: { gatherPerTurn: 3 } });
    assert.deepEqual([s.caps.gatherPerDay, s.caps.promotePerDay, s.caps.createPerDay, s.caps.promptsPerDay, s.caps.unattendedPerDay], [6, 60, 4, 12, 12]);
    assert.deepEqual([s.watchGapMin, s.soonLookSec], [10, 60]);
  });
  test("the file: null is Unlimited where allowed; at once never (the default), and above its maximum it is the maximum", () => {
    const s = store.parsePoSettings({ caps: { gatherPerDay: null, unattendedPerDay: null, gatherPerTurn: null, gatheringsOpen: null, codingRunning: 50 }, soonLookSec: null, watchGapMin: 0 });
    assert.deepEqual([s.caps.gatherPerDay, s.caps.unattendedPerDay, s.caps.gatherPerTurn, s.soonLookSec], [null, null, null, null]);
    assert.equal(s.caps.gatheringsOpen, store.DEFAULT_PO_CAPS.gatheringsOpen);
    assert.equal(s.caps.codingRunning, 10);
    assert.equal(s.watchGapMin, 10, "below the floor: the default");
  });
});

describe("limits through PATCH, held items and their retry", async () => {
  const org = await orgs.createOrg({ name: "Knobs", dir: join(root, "ws-knobs") });
  mkdirSync(join(root, "proj-knobs"));
  const project = await orgs.addProject(org.id, { name: "Shop", root: join(root, "proj-knobs") });
  await orgs.addPerson(org.id, { name: "Alperen", role: "Owner", decides: ["menu"] });
  await po.ensureProjectOverseer(project.id);
  const p = store.projectOverseerPaths(project.id);

  test("Unlimited is accepted where allowed and saved as null; at once never, with the sentence", async () => {
    const info = await po.patchProjectOverseer(project.id, { caps: { gatherPerDay: null, unattendedPerDay: null }, soonLookSec: null, watchGapMin: 5 });
    assert.deepEqual([info.settings.caps.gatherPerDay, info.settings.caps.unattendedPerDay, info.settings.soonLookSec, info.settings.watchGapMin], [null, null, null, 5]);
    assert.equal(JSON.parse(readFileSync(p.settings, "utf8")).caps.gatherPerDay, null);
    const refusals: [unknown, RegExp][] = [
      [{ caps: { codingRunning: null } }, /^Coding sessions running can't be Unlimited: it's what stops a burst\.$/],
      [{ caps: { gatheringsOpen: null } }, /^Gathering sessions open can't be Unlimited: it's what stops a burst\.$/],
      [{ caps: { codingRunning: 11 } }, /^Coding sessions running must be a whole number from 0 to 10\.$/],
      [{ caps: { gatheringsOpen: 21 } }, /^Gathering sessions open must be a whole number from 0 to 20\.$/],
      [{ caps: { promptsPerDay: 1.5 } }, /^Prompts to coding sessions \(on its own, each day\) must be a whole number from 0 to 1000, or Unlimited\.$/],
      [{ watchGapMin: 0 }, /^Looks at most every must be a whole number of minutes from 1 to 1440\.$/],
      [{ soonLookSec: 10 }, /^The soon look must be a whole number of seconds from 30 to 3600, or Off\.$/],
    ];
    const before = readFileSync(p.settings, "utf8");
    for (const [body, why] of refusals) await assert.rejects(() => po.patchProjectOverseer(project.id, body), (e: Error) => e instanceof orgs.OrgError && e.status === 400 && why.test(e.message), JSON.stringify(body));
    assert.equal(readFileSync(p.settings, "utf8"), before, "a refused PATCH writes nothing");
  });

  const watch = watchSid(project.id);
  /** Run `f` with the engines' clock at `at`, their due timers fired first. */
  const at = async <T>(t: number, f: () => Promise<T> | T = () => undefined as T): Promise<T> => {
    po.setClockForTest(() => t);
    try {
      hostOf(org.id).fireDue();
      const out = await f();
      await new Promise((r) => setTimeout(r, 20));
      return out;
    } finally {
      po.setClockForTest(null);
    }
  };
  const soonReason = { kind: "baton/done", params: { title: "Menu" }, by: "person" };
  const { looks } = fakeLooks(org.id);

  test("the watch hint's inputs: the pace reaches the watch loop, and soon Off sets no soon look", async () => {
    const t0 = Date.now() + 3_600_000;
    await po.patchProjectOverseer(project.id, { soonLookSec: null });
    await at(t0, () => noteWatchReason(org.id, project.id, { ...soonReason, key: "menu-1" }));
    assert.equal(store.readMemo(p).soonAt, null, "Off: it waits for the normal pace");
    await at(t0 + 60_000, () => po.lookNow(project.id));
    await po.patchProjectOverseer(project.id, { soonLookSec: 120 });
    await at(t0 + 120_000, () => noteWatchReason(org.id, project.id, { ...soonReason, key: "menu-2" }));
    assert.equal(store.readMemo(p).soonAt, new Date(t0 + 120_000 + 120_000).toISOString());
    await at(t0 + 180_000, () => po.lookNow(project.id));
  });

  test("a held item becomes a reason when its time comes: soon, except the message allowance's", async () => {
    await po.patchProjectOverseer(project.id, { soonLookSec: 60 });
    const refusedAt = new Date(Date.now() + 86_400_000);
    refusedAt.setHours(14, 11, 0, 0);
    const midnight = store.nextMidnight(refusedAt);
    const before = store.readMemo(p).pending.length;
    await at(refusedAt.getTime(), () => hostOf(org.id).act(watch, "limit/refused", { kind: "gather", ledger: "day", used: 6, max: 6 }, { by: "system" }));
    assert.deepEqual(store.readMemo(p).held.map((h) => [h.key, h.why, h.retryAt]), [["day:gather", "Today's allowance is used: 6 of 6 gathering sessions started on its own.", midnight.toISOString()]]);
    // A look a minute before midnight: the next is inside the 5-minute gap unless something wants it soon.
    assert.equal(await at(midnight.getTime() - 60_000, () => po.lookNow(project.id)).then((r) => r.started), true);
    await at(midnight.getTime() - 1);
    assert.equal(store.readMemo(p).held.length, 1, "not yet");
    await at(midnight.getTime());
    const m = store.readMemo(p);
    assert.deepEqual(m.pending, ["Today's allowance is back: it may start gathering sessions again (refused 2:11 PM)."]);
    assert.equal(m.soonAt, new Date(midnight.getTime() + 60_000).toISOString());
    assert.deepEqual(m.held, []);
    await at(midnight.getTime() + 60_000);
    assert.deepEqual(store.readMemo(p).lastRun?.reasons, m.pending, "the soon look, inside the gap");
    // The message allowance's is released at the refusal (C12), at the normal pace.
    await at(midnight.getTime() + 180_000, () => hostOf(org.id).act(watch, "limit/refused", { kind: "prompt", ledger: "message", used: 5, max: 5 }, { by: "system" }));
    const m2 = store.readMemo(p);
    assert.deepEqual(m2.pending, ["The operator's last message reached its limit on prompts to coding sessions; it may go on within today's allowance."]);
    assert.equal(m2.soonAt, null, "the message allowance's waits for the normal pace");
    assert.deepEqual(m2.held, []);
  });

  test("a PATCH that raises a limit or sets it Unlimited releases its held items at once; lowering one doesn't", async () => {
    await hostOf(org.id).act(watch, "limit/refused", { kind: "create", ledger: "day", used: 4, max: 4 }, { by: "system" });
    await hostOf(org.id).act(watch, "limit/refused", { kind: "prompt", ledger: "day", used: 12, max: 12 }, { by: "system" });
    assert.deepEqual(store.readMemo(p).held.map((h) => h.key), ["day:create", "day:prompt"]);
    await po.patchProjectOverseer(project.id, { caps: { createPerDay: 2, gatherPerTurn: 2 } });
    assert.equal(store.readMemo(p).held.length, 2, "lowered: nothing released");
    await po.patchProjectOverseer(project.id, { caps: { createPerDay: 3 } });
    let m = store.readMemo(p);
    assert.deepEqual(m.held.map((h) => h.key), ["day:prompt"]);
    assert.ok(m.pending.includes("You raised the limit on coding sessions started."), JSON.stringify(m.pending));
    await po.patchProjectOverseer(project.id, { caps: { promptsPerDay: null } });
    m = store.readMemo(p);
    assert.deepEqual(m.held, []);
    assert.ok(m.pending.includes("You raised the limit on prompts to coding sessions."));
    // A per-message refusal is released at the refusal (F-130: its retry is now): nothing waits for a raise.
    await hostOf(org.id).act(watch, "limit/refused", { kind: "create", ledger: "message", used: 2, max: 2 }, { by: "system" });
    m = store.readMemo(p);
    assert.deepEqual(m.held, [], "a message allowance's refusal holds nothing");
    assert.ok(m.pending.includes("The operator's last message reached its limit on coding sessions started; it may go on within today's allowance."), JSON.stringify(m.pending));
    await po.patchProjectOverseer(project.id, { caps: { createPerTurn: 3 } });
    assert.deepEqual(store.readMemo(p).pending, m.pending, "raising it releases nothing more");
  });

  test("an old watch.json is never read: the watch statechart's loop is the one shown", () => {
    const old = join(stateRoot(), "project-overseers", `${org.id}-${project.id}`, "watch.json");
    mkdirSync(dirname(old), { recursive: true });
    const since = new Date().toISOString();
    writeFileSync(old, JSON.stringify({ version: 1, pending: ["Old news."], held: [{ key: "budget", what: "coding tokens", why: "The coding token budget is spent.", since, retryAt: null }] }));
    const m = store.readMemo(p);
    assert.ok(!m.pending.includes("Old news."));
    assert.ok(!m.held.some((h) => h.key === "budget"));
  });

  test("a look past the looks per day is held until midnight, and shown", async () => {
    await po.patchProjectOverseer(project.id, { caps: { unattendedPerDay: 1 }, watch: true });
    // A day of its own (the held-item test's looks fall on the day after tomorrow), then its one look (Run Now's counts too).
    // Moved by whole hours into 10:xx local, so its two hours never cross midnight (bun test runs in UTC).
    const ahead = new Date(Date.now() + 4 * 86_400_000);
    const t = ahead.getTime() + (10 - ahead.getHours()) * 3_600_000;
    await po.patchProjectOverseer(project.id, { caps: { unattendedPerDay: 12 } });
    await at(t);
    assert.equal(await at(t, () => po.lookNow(project.id)).then((r) => r.started), true);
    await po.patchProjectOverseer(project.id, { caps: { unattendedPerDay: 1 } });
    assert.equal(store.readMemo(p).perDay[store.dayKey(new Date(t))], 1, "its one look today");
    await at(t + 61 * 60_000, () => noteWatchReason(org.id, project.id, { kind: "baton/closed", params: { title: "B" }, key: "cap-b" }));
    await at(t + 2 * 60 * 60_000);
    const m = store.readMemo(p);
    assert.deepEqual(m.pending, ['The gathering session "B" was closed.'], "the news keeps");
    assert.equal(m.held.find((h) => h.key === "looks")?.retryAt, store.nextMidnight(new Date(t)).toISOString());
    const info = await po.projectOverseerInfo(project.id);
    assert.deepEqual(info.usage.held.map((h) => h.key), ["looks"]);
    assert.deepEqual(info.usage.allowance.today.promote, { used: 0, max: 60 });
    assert.deepEqual(info.usage.allowance.message.promote, { used: 0, max: 20 });
    assert.equal(info.usage.allowance.today.gather.max, null, "Unlimited, as set above");
  });

  test("the prompt says every start names its gap, what the statecharts do by themselves, the holds and the corrections", () => {
    const prompt = po.renderProjectOverseerPrompt(project.id, po.toolsForTest(project.id));
    assert.match(prompt, /Every start names its gap \(`gap: "§gap\/<name>"`\), or\s+`gap: "none"`/);
    assert.match(prompt, /Don't do these again by hand: read the feed first\./);
    assert.match(prompt, /wait past the hold for your review: approve\s+them early or cancel them with `sova_hold` \(a reason is required\)/);
    assert.match(prompt, /`gap: "none"` builds only in a\s+turn the operator started\./);
    assert.match(prompt, /`sova_correct` and a reason/);
    assert.match(prompt, /\(`sova_set_state`\) is\s+only for a turn the operator started/);
    for (const t of ["sova_pipeline", "sova_hold", "sova_correct", "sova_set_state"]) assert.match(prompt, new RegExp(t), t);
  });

  test("the prompt lists every limit, Unlimited ones as no limit, and forbids promising a look nobody scheduled", async () => {
    await po.patchProjectOverseer(project.id, { caps: { gatherPerDay: null } });
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
    assert.match(prompt, /on your own each day: gathering sessions no limit, /);
    assert.doesNotMatch(prompt, /coding tokens|token budget/);
    assert.match(prompt, /Never say you'll do something "on your next look"/);
  });
});

describe("a standalone project's prompt names nothing of an organization", async () => {
  const { registerProjectIn } = await import("./projects/spaces");
  mkdirSync(join(root, "proj-alone"));
  const { project } = await registerProjectIn("standalone", join(root, "proj-alone"), { name: "Alone", origin: "folder" });
  await po.ensureProjectOverseer(project.id);

  test("its level reads as a standalone project's, and its limits leave out gathering sessions and promotions", async () => {
    await po.patchProjectOverseer(project.id, { autonomy: "L1" });
    const prompt = po.renderProjectOverseerPrompt(project.id, po.toolsForTest(project.id));
    assert.match(prompt, /L1 — Gather: may also publish preview links of its coding sessions' apps\./);
    assert.match(prompt, /each message the operator sends: coding sessions \S+, prompts to them \S+; on your own each day: coding sessions /);
    assert.match(prompt, /at once: \d+ coding sessions running/);
    assert.doesNotMatch(prompt, /gathering session|promotion|roster/i);
  });
});

describe("a project with no overseer conversation never looks", async () => {
  const org = await orgs.createOrg({ name: "Quiet", dir: join(root, "ws-quiet") });
  mkdirSync(join(root, "proj-quiet"));
  const project = await orgs.addProject(org.id, { name: "Quiet", root: join(root, "proj-quiet") });
  await orgs.addPerson(org.id, { name: "Alperen", role: "Owner" });
  const { looks } = fakeLooks(org.id);

  test("news with no overseer: no look, whatever time passes (the watch's exists region)", async () => {
    await noteWatchReason(org.id, project.id, { kind: "baton/closed", params: { title: "S" }, key: "q1", by: "person" });
    po.setClockForTest(() => Date.now() + 86_400_000);
    try {
      hostOf(org.id).fireDue();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      po.setClockForTest(null);
    }
    assert.equal(looks.length, 0);
    assert.ok(hostOf(org.id).configuration(watchSid(project.id))?.includes("no-overseer"));
  });
});

describe("the watch loop's decision, on its watch statechart", async () => {
  const org = await orgs.createOrg({ name: "Loop", dir: join(root, "ws-loop") });
  mkdirSync(join(root, "proj-loop"));
  const project = await orgs.addProject(org.id, { name: "Loop", root: join(root, "proj-loop") });
  await orgs.addPerson(org.id, { name: "Alperen", role: "Owner", decides: ["menu"] });
  await po.ensureProjectOverseer(project.id);
  await po.patchProjectOverseer(project.id, { autonomy: "L1" });
  const p = store.projectOverseerPaths(project.id);
  const watch = watchSid(project.id);
  const { looks } = fakeLooks(org.id);
  // Days ahead, moved by whole hours into 10:xx local (minutes, seconds and ms kept): the looks below
  // span about an hour and count per local day, so a start late in the evening would split them at
  // midnight (bun test runs in UTC, node in the host's zone).
  const ahead = new Date(Date.now() + 3 * 86_400_000);
  let t = ahead.getTime() + (10 - ahead.getHours()) * 3_600_000;
  /** The engines' clock moved to `t`, their due timers fired. */
  const to = async (next: number) => {
    t = next;
    po.setClockForTest(() => t);
    try {
      hostOf(org.id).fireDue();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      po.setClockForTest(null);
    }
  };
  let n = 0;
  const news = async (kind = "baton/closed") => {
    po.setClockForTest(() => t);
    try {
      await noteWatchReason(org.id, project.id, { kind, params: { title: `S${++n}` }, key: `k${n}`, by: "person" });
    } finally {
      po.setClockForTest(null);
    }
  };
  const turn = (event: "turn/started" | "turn/ended") => hostOf(org.id).act(watch, event, { look: false }, { by: "system" });
  const runNow = async () => {
    po.setClockForTest(() => t);
    try {
      return await po.lookNow(project.id);
    } finally {
      po.setClockForTest(null);
    }
  };
  await to(t);

  test("runs on news, when idle, ≥ the gap after the last look, under the daily cap", async () => {
    const seen = looks.length;
    await to(t + 3_600_000);
    assert.equal(looks.length, seen, "no news: no look");
    await news();
    await to(t + 20_000);
    assert.equal(looks.length, seen + 1, "news: a look on the next tick");
    const last = t;
    await news();
    await to(last + 10 * 60_000 - 40_000);
    assert.equal(looks.length, seen + 1, "inside the 10-minute gap");
    await to(last + 10 * 60_000 + 20_000);
    assert.equal(looks.length, seen + 2, "past the gap");
    // Busy: the look waits for its run to end.
    await news();
    await turn("turn/started");
    await to(t + 11 * 60_000);
    assert.equal(looks.length, seen + 2, "busy");
    await turn("turn/ended");
    await to(t + 20_000);
    assert.equal(looks.length, seen + 3, "idle again: it looks");
  });

  test("Run Now skips the gap and the news check, never the daily cap or a busy overseer", async () => {
    const seen = looks.length;
    assert.deepEqual(await runNow(), { started: true }, "right after a look, nothing new");
    await turn("turn/started");
    assert.deepEqual(await runNow(), { started: false, why: "busy" });
    await turn("turn/ended");
    const today = Object.values(store.readMemo(p).perDay)[0] ?? 0;
    await po.patchProjectOverseer(project.id, { caps: { unattendedPerDay: today } });
    assert.deepEqual(await runNow(), { started: false, why: `the daily limit of ${today} unattended runs is reached` });
    assert.equal(store.readMemo(p).lastRun?.outcome, "skipped");
    assert.equal(looks.length, seen + 1);
    await po.patchProjectOverseer(project.id, { caps: { unattendedPerDay: 12 } });
  });

  test("an event wanting a look soon lets it run once its time comes, whatever the gap; never over the other rules", async () => {
    // Past the gap twice: what the last test left (a raised limit's reason) is looked at first.
    await to(t + 11 * 60_000);
    await to(t + 11 * 60_000);
    const seen = looks.length;
    await news();
    await to(t + 20_000);
    assert.equal(looks.length, seen + 1);
    await news("baton/done");
    await to(t + 40_000);
    assert.equal(looks.length, seen + 1, "not yet due");
    await to(t + 40_000);
    assert.equal(looks.length, seen + 2, "due: the gap is skipped");
    // Never with watching off.
    await po.patchProjectOverseer(project.id, { watch: false });
    await news("baton/done");
    await to(t + 2 * 60_000);
    assert.equal(looks.length, seen + 2, "watching is off");
    await po.patchProjectOverseer(project.id, { watch: true });
    await to(t + 20_000);
    assert.equal(looks.length, seen + 3);
  });

  test("the project's own gap, and Unlimited looks per day", async () => {
    await po.patchProjectOverseer(project.id, { watchGapMin: 2, caps: { unattendedPerDay: null } });
    const seen = looks.length;
    for (let i = 0; i < 20; i++) {
      await news();
      await to(t + 2 * 60_000 + 20_000);
    }
    assert.equal(looks.length, seen + 20, "one every 2 minutes, past any daily count");
    // Unlimited (null) is no count at all: one day's unattended looks go past the default 12.
    assert.ok(Math.max(...Object.values(store.readMemo(p).perDay)) > 12, JSON.stringify(store.readMemo(p).perDay));
  });

  test("the gap's boundary, to the millisecond: the first 20 s tick at or after last look + gap (the project's own 2 minutes)", async () => {
    await po.patchProjectOverseer(project.id, { watchGapMin: 2, soonLookSec: null, caps: { unattendedPerDay: null } });
    await news();
    await to(t + 3 * 60_000 + 7_000); // a look off the tick grid, so the gap's end is too
    const seen = looks.length;
    const last = Date.parse(store.readMemo(p).lastRunAt!);
    const due = Math.ceil((last + 2 * 60_000) / 20_000) * 20_000;
    assert.ok(due >= last + 2 * 60_000 && due - (last + 2 * 60_000) < 20_000);
    await news();
    await to(last + 2 * 60_000 - 1);
    assert.equal(looks.length, seen, "now − gap + 1 ms: too soon");
    await to(due - 1);
    assert.equal(looks.length, seen, "past the gap, 1 ms before its tick: not yet");
    await to(due);
    assert.equal(looks.length, seen + 1, "the tick at or after now − gap: it looks");
    await po.patchProjectOverseer(project.id, { soonLookSec: 60 });
  });

  test("the watch message says it is automatic and names the level", async () => {
    await news();
    await to(t + 3 * 60_000);
    const text = looks.at(-1)!.text;
    assert.ok(text.startsWith("[project watch]"));
    assert.match(text, /within your autonomy \(L1\)/);
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
    const p = store.projectOverseerPaths("prj_bbbbbbbb", dir);
    store.writePoSettings(p, settings({ model: "zai/glm-5.3", thinking: "high" }));
    const before = readFileSync(p.settings, "utf8");
    assert.throws(() => store.patchPoSettings(p, { thinking: "medium" }, (next, patch) => store.fitThinking(next, patch, models, null)), /offers thinking/);
    assert.equal(readFileSync(p.settings, "utf8"), before);
  });
});

describe("the org's About text in its prompt (§app.organizations/about)", async () => {
  const org = await orgs.createOrg({ name: "Aboutco", dir: join(root, "ws6") });
  mkdirSync(join(root, "proj6"));
  const project = await orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj6") });
  await po.ensureProjectOverseer(project.id);
  const HEAD = "# About this organization (written by the operator)";
  const EXTRA = "# The operator's extra instructions";
  after(() => settled(join(root, "ws6")));

  test("none: no section at all; the fixed rule is there anyway", () => {
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
    assert.ok(!prompt.includes(HEAD));
    assert.match(prompt, /^- "About this organization", when your prompt has it, is the operator's private context: use it to\n\s+judge, never quote or copy it/m, "the rule line stands before any text exists");
  });

  test("after the fixed prompt, before the extra instructions; re-read at every render", async () => {
    await orgs.patchOrg(org.id, { about: "ABOUT-ONE: they close the books on the 5th." });
    await po.patchProjectOverseer(project.id, { extraSystemPrompt: "EXTRA-ONE: be terse." });
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
    const at = prompt.indexOf(HEAD);
    assert.ok(at > prompt.indexOf("## Tools"), "after the fixed prompt");
    assert.ok(at < prompt.indexOf(EXTRA), "before the extra instructions");
    assert.ok(prompt.indexOf("ABOUT-ONE") > at && prompt.indexOf("ABOUT-ONE") < prompt.indexOf(EXTRA));
    assert.match(prompt, /The operator wrote this about Aboutco, for you only\./);
    assert.match(prompt, /The project's extra instructions below take precedence over it\./);
    await orgs.patchOrg(org.id, { about: "ABOUT-TWO" });
    const next = po.renderProjectOverseerPrompt(project.id, []);
    assert.ok(next.includes("ABOUT-TWO") && !next.includes("ABOUT-ONE"), "the next run reads the new text");
    await po.patchProjectOverseer(project.id, { extraSystemPrompt: "" });
    assert.ok(po.renderProjectOverseerPrompt(project.id, []).trimEnd().endsWith("ABOUT-TWO"), "last when there are no extra instructions");
  });

  test("clipped to 4,000 characters; secrets redacted", async () => {
    writeFileSync(join(orgs.orgDir(org.id), "about.md"), `${"a".repeat(3999)}BCDEF`);
    const prompt = po.renderProjectOverseerPrompt(project.id, []);
    assert.ok(prompt.includes(`${"a".repeat(3999)}B`) && !prompt.includes("BC"), "only the first 4,000 characters");
    const key = "rdAboutKey-7fQ2mZ9xL4vN8pR1sT6uW3yA5bC0dE";
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ about: { type: "api_key", key } }));
    await orgs.patchOrg(org.id, { about: `The staging key is ${key}.` });
    const redacted = po.renderProjectOverseerPrompt(project.id, []);
    assert.ok(!redacted.includes(key), "a secret is redacted");
    assert.match(redacted, /The staging key is \S+\./);
    rmSync(join(agentDir, "auth.json"));
    await orgs.patchOrg(org.id, { about: "" });
    assert.ok(!po.renderProjectOverseerPrompt(project.id, []).includes(HEAD), "cleared: the section goes");
  });
});
