// Run: pnpm exec tsx --test server/baton.test.ts. A throwaway PI_CODING_AGENT_DIR and workspace
// dir in the OS temp dir, deleted after; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_ENTRY, BATON_HANDOFF_ENTRY, OPERATOR } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const { commitAll } = await import("./workspace-git");
const feed = await import("./session-feed");

after(() => rmSync(root, { recursive: true, force: true }));

describe("links", () => {
  test("a token is 32 random bytes, only its hash is kept, lookup is by hash", () => {
    const t = links.mintLink({ orgId: "o", sessionId: "s", n: 1, personId: "p" });
    assert.match(t, links.TOKEN_RE);
    const file = readFileSync(join(root, "agent", "sova", "baton-links.json"), "utf8");
    assert.ok(!file.includes(t), "the token itself is never stored");
    assert.ok(file.includes(links.hashToken(t)));
    assert.equal(statSync(join(root, "agent", "sova", "baton-links.json")).mode & 0o777, 0o600);
    assert.equal(links.findLink(t)?.personId, "p");
    assert.equal(links.findLink(`${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`), null);
    assert.equal(links.findLink("short"), null);
  });
  test("revoked and expired links are dead", () => {
    const now = Date.now();
    const t = links.mintLink({ orgId: "o", sessionId: "s2", n: 1, personId: "p" }, now);
    assert.equal(links.linkDead(links.findLink(t)!, now + links.LINK_TTL_MS - 1), false);
    assert.equal(links.linkDead(links.findLink(t)!, now + links.LINK_TTL_MS), true);
    links.revokeLinks((l) => l.sessionId === "s2");
    assert.equal(links.linkDead(links.findLink(t)!, now), true);
  });
});

describe("baton sessions", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  const dir = orgs.orgDir(org.id);
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
  await orgs.addPerson(org.id, { name: "Bob", status: "proposed", role: "Accountant", contact: { email: "b@x.y" }, referral: { why: "books", referredBy: "Maria" } });
  await orgs.addPerson(org.id, { name: "Old Timer", status: "left" });

  test("hand-off targets: active people by id or exact name, the operator; everyone else refused with what to do", () => {
    const roster = orgs.readRoster(org.id);
    assert.deepEqual(baton.resolveTarget(roster, "tony reyes", "Omar"), { ok: true, ref: tony.id });
    assert.deepEqual(baton.resolveTarget(roster, maria.id, "Omar"), { ok: true, ref: maria.id });
    assert.deepEqual(baton.resolveTarget(roster, "operator", "Omar"), { ok: true, ref: OPERATOR });
    assert.deepEqual(baton.resolveTarget(roster, "omar", "Omar"), { ok: true, ref: OPERATOR });
    const stranger = baton.resolveTarget(roster, "Pedro", "Omar");
    assert.ok(!stranger.ok && /not on the roster/.test(stranger.error) && /contact/.test(stranger.error) && /role/.test(stranger.error));
    const proposed = baton.resolveTarget(roster, "Bob", "Omar");
    assert.ok(!proposed.ok && /approve/.test(proposed.error));
    const left = baton.resolveTarget(roster, "Old Timer", "Omar");
    assert.ok(!left.ok && /no longer/.test(left.error));
  });

  test("create: a file in the workspace sessions dir with the marker and hand-off 1, a link for a person, no token in the repo", async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server" });
    assert.ok(c.token && c.path.startsWith(join(realpathSync(dir), "sessions")));
    const lines = readFileSync(c.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.deepEqual(lines.slice(1).map((e) => e.customType), [BATON_ENTRY, BATON_HANDOFF_ENTRY]);
    assert.deepEqual(lines[2].data, { v: 1, n: 1, from: OPERATOR, to: tony.id, question: "Hosting", briefing: "" });
    const row = baton.batonById(c.sessionId)!.row;
    assert.deepEqual([row.state, row.holder, row.handoffs.length], ["open", tony.id, 1]);
    // Nothing commits on its own at creation any more: the hourly commit (or Commit Now) takes whatever changed.
    assert.equal((await commitAll(dir, "test commit")).committed, true);
    const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" });
    assert.ok(tracked.includes(row.file), "the transcript is the workspace's");
    assert.ok(/^charts\/baton\//m.test(tracked), "the baton statechart's snapshot is the workspace's");
    assert.ok(!tracked.includes("baton.json"), "no baton.json (q1): the statechart holds the row");
    const history = execFileSync("git", ["-C", dir, "log", "-p", "--all"], { encoding: "utf8" });
    for (const f of readdirSync(dir).filter((f) => !f.startsWith(".")))
      if (!statSync(join(dir, f)).isDirectory()) assert.ok(!readFileSync(join(dir, f), "utf8").includes(c.token!), `${f} has no token`);
    assert.ok(!history.includes(c.token!) && !history.includes(links.hashToken(c.token!)), "neither the token nor its hash is ever committed");
  });

  test("a Get Link elsewhere moves the link's mint time the strip and the list see; the route answers it", async () => {
    const { batonInfo, registerOrgRoutes } = await import("./org-routes");
    const { Hono } = await import("hono");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Replaced", goal: "g" });
    const row = () => baton.batonById(c.sessionId)!.row;
    const first = batonInfo(row()).linkAt[tony.id];
    assert.equal(first, links.findLink(c.token!)!.createdAt, "the link the session started with");
    assert.equal(baton.batonSummaryField(c.path)?.linkAt, first);
    await new Promise((r) => setTimeout(r, 5));
    const app = new Hono();
    registerOrgRoutes(app);
    const res = (await (await app.request(`/api/baton/${c.sessionId}/link`)).json()) as { link: string; n: number; at: string };
    const token = res.link.split("/h/")[1]!;
    assert.equal(res.at, links.findLink(token)!.createdAt, "Get Link answers its mint time");
    assert.equal(batonInfo(row()).linkAt[tony.id], res.at, "moved to the new link");
    assert.ok(Date.parse(res.at) > Date.parse(first!));
    assert.equal(baton.batonSummaryField(c.path)?.linkAt, res.at, "so the list's field moves and a strip reads again");
    baton.revokeCurrent(c.sessionId);
    assert.deepEqual(batonInfo(row()).linkAt, {}, "a link turned off is no newer link");
  });

  test("the state machine: holder writes, the baton moves, old links read, the operator's answer clears Needs you, done ends writing", async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Payroll", goal: "g" });
    const sid = c.sessionId;
    assert.equal(baton.linkAccess(c.token!).ok && (baton.linkAccess(c.token!) as { canWrite: boolean }).canWrite, true);
    baton.noteMessage(sid, tony.id);
    assert.throws(() => baton.noteMessage(sid, maria.id), /not your turn/);
    assert.throws(() => baton.noteMessage(sid, OPERATOR), /holds the baton/);
    await assert.rejects(baton.handTo(sid, tony.id, "q", "b"), /already hold/);

    const { n } = await baton.handTo(sid, maria.id, "Which format?", "Tony says…");
    assert.equal(n, 2);
    const old = baton.linkAccess(c.token!);
    assert.ok(old.ok && !old.canWrite && old.reason === "moved-on", "the old link still reads, never writes");
    assert.deepEqual(baton.batonSummaryField(c.path)?.sendLink?.to, "Maria Lopez", "Maria has no link yet: send one");
    const { token: mariaToken } = baton.rotateLink(sid);
    assert.equal(baton.batonSummaryField(c.path)?.sendLink, undefined);
    assert.ok((baton.linkAccess(mariaToken) as { canWrite: boolean }).canWrite);
    const again = baton.rotateLink(sid);
    assert.deepEqual(baton.linkAccess(mariaToken), { ok: false, status: 410 }, "a new link turns off the one before");

    await baton.handTo(sid, OPERATOR, "Bonuses in?", "");
    let row = baton.batonById(sid)!.row;
    assert.equal(row.state, "needs-you");
    assert.deepEqual(baton.batonSummaryField(c.path)?.needsYou?.from, "Maria Lopez");
    assert.ok(!(baton.linkAccess(again.token) as { canWrite: boolean }).canWrite);
    assert.throws(() => baton.rotateLink(sid), /No person holds/);
    baton.noteMessage(sid, OPERATOR);
    row = baton.batonById(sid)!.row;
    assert.deepEqual([row.state, row.holder], ["open", OPERATOR]);
    assert.equal(baton.batonSummaryField(c.path)?.needsYou, undefined);

    await baton.markDone(sid);
    assert.throws(() => baton.noteMessage(sid, OPERATOR), /done/);
    const done = baton.linkAccess(again.token);
    assert.ok(done.ok && !done.canWrite && done.reason === "done", "after done a link still reads");
    await baton.closeBaton(sid);
    assert.deepEqual(baton.linkAccess(again.token), { ok: false, status: 410 }, "after close every link is gone");
    assert.deepEqual(baton.linkAccess(c.token!), { ok: false, status: 410 });
  });

  test("the budget: at the limit a message is refused with BudgetSpent", async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Budget", goal: "g" });
    for (let i = 0; i < baton.MESSAGES_MAX; i++) baton.noteMessage(c.sessionId, tony.id);
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), (e: { code?: string }) => e.code === "budget");
    const access = baton.linkAccess(c.token!);
    assert.ok(access.ok && !access.canWrite && access.reason === "budget");
  });

  test("any write to a baton row or its links re-diffs the session list at once, with no timer tick", async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Nudge", goal: "g" });
    let reads = 0;
    const f = feed.configureSessionFeed({ list: async () => [{ path: `p${++reads}` } as never], debounceMs: 0, intervalMs: 60_000 });
    const got: string[] = [];
    const off = f.add((m) => got.push(m.type));
    try {
      await f.idle();
      const base = reads;
      for (const act of [() => baton.rotateLink(c.sessionId), () => baton.extendBudget(c.sessionId, 1)]) {
        const before = reads;
        const changed = got.filter((t) => t === "list_changed").length;
        await act();
        await new Promise((r) => setTimeout(r, 5));
        await f.idle();
        assert.ok(reads > before, "the list was re-read");
        assert.ok(got.filter((t) => t === "list_changed").length > changed, "and list_changed published");
      }
      assert.ok(reads >= base + 2);
    } finally {
      off();
      feed.configureSessionFeed({ list: async () => [] }).stop();
    }
  });

  test("input limits", async () => {
    const base = { orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "T", goal: "g" };
    await assert.rejects(baton.createBaton({ ...base, publicTitle: "x".repeat(121) }), /at most 120/);
    await assert.rejects(baton.createBaton({ ...base, goal: "" }), /goal is required/);
    await assert.rejects(baton.createBaton({ ...base, to: "Pedro" }), /not on the roster/);
    await assert.rejects(baton.createBaton({ ...base, projectId: "nope" }), /Unknown project/);
  });
});

describe("after a restart each open session's count is the messages in its transcript", async () => {
  const { appendFileSync } = await import("node:fs");
  const { recountBudgets } = await import("./baton-recount");
  const org = await orgs.createOrg({ name: "Recount", dir: join(root, "ws-recount") });
  mkdirSync(join(root, "proj-recount"));
  const project = await orgs.addProject(org.id, { name: "P", root: join(root, "proj-recount") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Recount", role: "IT" });
  const userRows = (path: string, n: number) => {
    let parent = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1).id;
    for (let i = 0; i < n; i++) {
      const id = `u${Math.random().toString(36).slice(2, 10)}`;
      appendFileSync(path, `${JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `m${i}` }], timestamp: Date.now() } })}\n`);
      parent = id;
    }
  };
  const used = (sid: string) => baton.batonById(sid)!.row.budget.messagesUsed;

  test("three counted, one in the file (two lost to a kill): the count is one; never raised; a done session untouched", async () => {
    const lost = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Lost", goal: "g" });
    for (let i = 0; i < 3; i++) baton.noteMessage(lost.sessionId, tony.id);
    userRows(lost.path, 1);
    const kept = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Kept", goal: "g" });
    baton.noteMessage(kept.sessionId, tony.id);
    userRows(kept.path, 2);
    const done = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Done", goal: "g" });
    baton.noteMessage(done.sessionId, tony.id);
    baton.noteMessage(done.sessionId, tony.id);
    await baton.markDone(done.sessionId);

    const changed = await recountBudgets(orgs.orgDir(org.id));
    assert.equal(used(lost.sessionId), 1);
    assert.equal(used(kept.sessionId), 1, "never raised");
    assert.equal(used(done.sessionId), 2, "a done session keeps its count");
    assert.deepEqual(changed, [lost.sessionId]);
  });
});
