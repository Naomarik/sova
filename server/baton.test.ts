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
const { settled } = await import("./workspace-git");

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
  const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  const maria = orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
  orgs.addPerson(org.id, { name: "Bob", status: "proposed", role: "Accountant", contact: { email: "b@x.y" }, referral: { why: "books", referredBy: "Maria" } });
  orgs.addPerson(org.id, { name: "Old Timer", status: "left" });

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
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server" });
    assert.ok(c.token && c.path.startsWith(join(realpathSync(dir), "sessions")));
    const lines = readFileSync(c.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.deepEqual(lines.slice(1).map((e) => e.customType), [BATON_ENTRY, BATON_HANDOFF_ENTRY]);
    assert.deepEqual(lines[2].data, { v: 1, n: 1, from: OPERATOR, to: tony.id, question: "Hosting", briefing: "" });
    const row = baton.batonById(c.sessionId)!.row;
    assert.deepEqual([row.state, row.holder, row.handoffs.length], ["open", tony.id, 1]);
    await settled(dir);
    const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" });
    assert.ok(tracked.includes("baton.json") && tracked.includes(row.file));
    const history = execFileSync("git", ["-C", dir, "log", "-p", "--all"], { encoding: "utf8" });
    for (const f of readdirSync(dir).filter((f) => !f.startsWith(".")))
      if (!statSync(join(dir, f)).isDirectory()) assert.ok(!readFileSync(join(dir, f), "utf8").includes(c.token!), `${f} has no token`);
    assert.ok(!history.includes(c.token!) && !history.includes(links.hashToken(c.token!)), "neither the token nor its hash is ever committed");
  });

  test("the state machine: holder writes, the baton moves, old links read, the operator's answer clears Needs you, done ends writing", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Payroll", goal: "g" });
    const sid = c.sessionId;
    assert.equal(baton.linkAccess(c.token!).ok && (baton.linkAccess(c.token!) as { canWrite: boolean }).canWrite, true);
    baton.noteMessage(sid, tony.id);
    assert.throws(() => baton.noteMessage(sid, maria.id), /not your turn/);
    assert.throws(() => baton.noteMessage(sid, OPERATOR), /holds the baton/);
    assert.throws(() => baton.handTo(sid, tony.id, "q", "b"), /already hold/);

    const { n } = baton.handTo(sid, maria.id, "Which format?", "Tony says…");
    assert.equal(n, 2);
    const old = baton.linkAccess(c.token!);
    assert.ok(old.ok && !old.canWrite && old.reason === "moved-on", "the old link still reads, never writes");
    assert.deepEqual(baton.batonSummaryField(c.path)?.sendLink?.to, "Maria Lopez", "Maria has no link yet: send one");
    const { token: mariaToken } = baton.rotateLink(sid);
    assert.equal(baton.batonSummaryField(c.path)?.sendLink, undefined);
    assert.ok((baton.linkAccess(mariaToken) as { canWrite: boolean }).canWrite);
    const again = baton.rotateLink(sid);
    assert.deepEqual(baton.linkAccess(mariaToken), { ok: false, status: 410 }, "a new link turns off the one before");

    baton.handTo(sid, OPERATOR, "Bonuses in?", "");
    let row = baton.batonById(sid)!.row;
    assert.equal(row.state, "needs-you");
    assert.deepEqual(baton.batonSummaryField(c.path)?.needsYou?.from, "Maria Lopez");
    assert.ok(!(baton.linkAccess(again.token) as { canWrite: boolean }).canWrite);
    assert.throws(() => baton.rotateLink(sid), /No person holds/);
    baton.noteMessage(sid, OPERATOR);
    row = baton.batonById(sid)!.row;
    assert.deepEqual([row.state, row.holder], ["open", OPERATOR]);
    assert.equal(baton.batonSummaryField(c.path)?.needsYou, undefined);

    baton.markDone(sid);
    assert.throws(() => baton.noteMessage(sid, OPERATOR), /done/);
    const done = baton.linkAccess(again.token);
    assert.ok(done.ok && !done.canWrite && done.reason === "done", "after done a link still reads");
    baton.closeBaton(sid);
    assert.deepEqual(baton.linkAccess(again.token), { ok: false, status: 410 }, "after close every link is gone");
    assert.deepEqual(baton.linkAccess(c.token!), { ok: false, status: 410 });
  });

  test("the budget: at the limit a message is refused with BudgetSpent", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Budget", goal: "g" });
    for (let i = 0; i < baton.MESSAGES_MAX; i++) baton.noteMessage(c.sessionId, tony.id);
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), baton.BudgetSpent);
    const access = baton.linkAccess(c.token!);
    assert.ok(access.ok && !access.canWrite && access.reason === "budget");
  });

  test("input limits", () => {
    const base = { orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "T", goal: "g" };
    assert.throws(() => baton.createBaton({ ...base, publicTitle: "x".repeat(121) }), /at most 120/);
    assert.throws(() => baton.createBaton({ ...base, goal: "" }), /goal is required/);
    assert.throws(() => baton.createBaton({ ...base, to: "Pedro" }), /not on the roster/);
    assert.throws(() => baton.createBaton({ ...base, projectId: "nope" }), /Unknown project/);
  });
});
