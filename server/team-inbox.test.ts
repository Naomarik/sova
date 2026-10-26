// Run: pnpm test -- server/team-inbox.test.ts
// A team member's inbox, read-only (§app.subagents-pane/member-inbox): the server folds each
// member's items.jsonl with the extension's own fold, and never writes it. Files are written by the
// extension's own writer (InboxStore) where it can, by hand for a torn line. Uses a throwaway
// PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-team-inbox-test-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-team-inbox-test--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { getMemberInbox, getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");
const { countsOf, inboxBody, inboxView, itemsFileOf, mailboxRootOf, readItems, validSegment, INBOX_LIST_CAP } = await import("./team-inbox");
const { InboxStore, MAIN_THREAD, SOVA } = await import("../pi-config/extensions/subagents/inbox.ts");

after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const seat = (n: number, role: string) => ({ workerId: `ag_0${n}`, role, backend: "pi", ownedPaths: [], groupId: "run_01", addedAt: T0 });
const lead = { role: "lead", workerId: "ag_01" };
const dev = { role: "dev", workerId: "ag_02" };
const dev2 = { role: "dev-2", workerId: "ag_03" };

/** A session with one team of three, and the mailbox root its extension would use. */
function session(id: string) {
  const path = canonicalPath(join(sessionsDir, `2026-10-23T10-00-00-000Z_${id}.jsonl`));
  writeFileSync(path, jsonl(
    { type: "session", version: 3, id, timestamp: iso(0), cwd: "/tmp/team-inbox-test" },
    { type: "message", id: "e1", parentId: null, timestamp: iso(0), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "custom", id: "t1", parentId: "e1", timestamp: iso(1), customType: "subagents-team-v1", data: { version: 1, op: "create", team: { id: "team_01", name: "crew", objective: "ship", createdAt: T0 }, members: [seat(1, "lead"), seat(2, "dev"), seat(3, "dev-2")] } },
  ));
  const mailbox = mailboxRootOf(agentDir, id)!;
  return { path, mailbox };
}

describe("the reader", () => {
  test("a torn last line and unknown lines are skipped; the rest folds; a missing file is none", async () => {
    const { mailbox } = session("torn");
    const store = new InboxStore(mailbox, { now: () => T0 });
    const a = store.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "Please review src/a.ts\nthen report." });
    const b = store.add({ teamId: "team_01", from: SOVA, to: dev, kind: "notice", body: "Wrap up: context 78%", urgent: true });
    store.setStatus("ag_02", [a.id], "addressed", "done, see commit");
    const file = itemsFileOf(mailbox, "team_01", "ag_02");
    appendFileSync(file, '{"v":1,"op":"wat"}\nnot json\n{"v":1,"op":"add","item":{"id":"i_zz","te');
    const items = await readItems(file);
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.id).sort(), [a.id, b.id].sort());
    assert.equal(items.find((i) => i.id === a.id)?.note, "done, see commit");
    assert.deepEqual(countsOf(items), { open: 1, urgent: 1, total: 2, closedByMember: 1, closedAutomatically: 0 });
    assert.equal(await readItems(itemsFileOf(mailbox, "team_01", "ag_09")), null, "no file, no inbox");
  });

  test("a moved item leaves the old holder and shows at the new one, same id and sender, with whom it was first sent to", async () => {
    const { mailbox } = session("moved");
    const store = new InboxStore(mailbox, { now: () => T0 });
    const q = store.add({ teamId: "team_01", from: lead, to: dev, kind: "question", body: "Which port?" });
    const kept = store.add({ teamId: "team_01", from: lead, to: dev2, kind: "message", body: "Yours already" });
    store.move(q.id, dev2, "handover");
    const old = (await readItems(itemsFileOf(mailbox, "team_01", "ag_02")))!;
    const now = (await readItems(itemsFileOf(mailbox, "team_01", "ag_03")))!;
    assert.deepEqual(old.map((i) => i.id), [], "gone from the old holder's view");
    const moved = now.find((i) => i.id === q.id);
    assert.ok(moved, "the same id at the new holder");
    assert.deepEqual(moved.from, lead, "the original sender");
    const view = inboxView("team_01", "ag_03", now);
    assert.deepEqual(view.items.find((i) => i.id === q.id)?.movedFrom?.map((m) => [m.role, m.why]), [["dev", "handover"]]);
    assert.ok(view.items.some((i) => i.id === kept.id), "the holder's own items unchanged");
  });

  test("compaction rewrites the file (rename): the reader sees the new fold, open items all kept", async () => {
    const { mailbox } = session("compact");
    const store = new InboxStore(mailbox, { now: () => T0, keepClosed: 2 });
    const ids = Array.from({ length: 6 }, (_, n) => store.add({ teamId: "team_01", from: MAIN_THREAD, to: dev, kind: "message", body: `m${n}` }).id);
    const file = itemsFileOf(mailbox, "team_01", "ag_02");
    const before = (await readItems(file))!;
    assert.equal(before.length, 6);
    store.setStatus("ag_02", ids.slice(0, 4), "addressed");
    const inoBefore = statSync(file).ino;
    store.compact("ag_02");
    assert.notEqual(statSync(file).ino, inoBefore, "a rewrite, not an append");
    const after = (await readItems(file))!;
    assert.deepEqual(after.map((i) => i.id).sort(), [...ids.slice(2)].sort(), "both open items and the newest 2 addressed");
    assert.deepEqual(countsOf(after), { open: 2, urgent: 0, total: 4, closedByMember: 2, closedAutomatically: 0 });
  });

  test("the server never writes an inbox file", async () => {
    const { path, mailbox } = session("nowrite");
    const store = new InboxStore(mailbox, { now: () => T0 });
    const it = store.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "hello" });
    const file = itemsFileOf(mailbox, "team_01", "ag_02");
    const bytes = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    await getSessionInsight(path);
    await getMemberInbox(path, "team_01", "ag_02");
    await getMemberInbox(path, "team_01", "ag_02", it.id);
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal(statSync(file).mtimeMs, mtime);
  });

  test("newest first, capped, and every field but the body on the list", () => {
    const base = { teamId: "team_01", from: lead, to: dev, kind: "message" as const, urgent: false, subject: "s", body: "secret body", status: "new" as const };
    const items = Array.from({ length: INBOX_LIST_CAP + 3 }, (_, n) => ({ ...base, id: `i_${n.toString(36)}`, sentAt: T0 + Math.floor(n / 2) }));
    const view = inboxView("team_01", "ag_02", items);
    assert.equal(view.total, INBOX_LIST_CAP + 3);
    assert.equal(view.items.length, INBOX_LIST_CAP);
    assert.equal(view.items[0]!.id, `i_${(INBOX_LIST_CAP + 2).toString(36)}`, "a later id wins a tie on time");
    assert.ok(!JSON.stringify(view).includes("secret body"), "no body on the list");
    assert.deepEqual(inboxBody(items, "i_1"), { id: "i_1", body: "secret body" });
    assert.equal(inboxBody(items, "i_nope"), null);
  });

  test("how each item was closed: a reply and an unmarked item count as the member, auto apart; only addressed items carry it", async () => {
    const { mailbox } = session("closedby");
    const store = new InboxStore(mailbox, { now: () => T0 });
    const ids = ["done", "reply", "auto", "old", "open"].map((b) => store.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: b }).id);
    const file = itemsFileOf(mailbox, "team_01", "ag_02");
    // The status ops as the extension writes them (closedBy rides on `by`); an older line has none.
    appendFileSync(file, jsonl(
      { v: 1, op: "status", id: ids[0], status: "addressed", at: T0, by: "member" },
      { v: 1, op: "status", id: ids[1], status: "addressed", at: T0, note: "answered in i_99", by: "reply" },
      { v: 1, op: "status", id: ids[2], status: "addressed", at: T0, note: "closed automatically: seen, not closed by dev", by: "auto" },
      { v: 1, op: "status", id: ids[3], status: "addressed", at: T0 },
    ));
    const items = (await readItems(file))!;
    assert.deepEqual(countsOf(items), { open: 1, urgent: 0, total: 5, closedByMember: 3, closedAutomatically: 1 });
    const view = inboxView("team_01", "ag_02", items);
    const by = new Map(view.items.map((i) => [i.id, i.closedBy]));
    assert.deepEqual([...ids].map((id) => by.get(id)), ["member", "reply", "auto", undefined, undefined]);
  });

  test("ids are path segments, never a separator or a dot-dot; an unsaved session has no folder", () => {
    for (const ok of ["team_01", "ag_02", "i_2a"]) assert.ok(validSegment(ok), ok);
    for (const bad of ["", "..", "../x", "a/b", ".hidden", "x".repeat(65), undefined]) assert.ok(!validSegment(bad), String(bad));
    assert.equal(mailboxRootOf(agentDir, null), null);
    assert.equal(mailboxRootOf(agentDir, "a b/c"), join(agentDir, "sova", "teams", "a_b_c", "mailbox"));
  });
});

describe("the session's insight and the route's reads", () => {
  test("each member carries its counts when it has a file, none without", async () => {
    const { path, mailbox } = session("counts");
    const store = new InboxStore(mailbox, { now: () => T0 });
    store.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "a" });
    store.add({ teamId: "team_01", from: SOVA, to: dev, kind: "notice", body: "b", urgent: true });
    store.add({ teamId: "team_01", from: MAIN_THREAD, to: dev, kind: "instruction", body: "c", status: "read" });
    const r = store.add({ teamId: "team_01", from: lead, to: dev, kind: "message", body: "d" });
    store.returnItem(r.id, "dev stopped");
    const insight = await getSessionInsight(path);
    const members = new Map(insight.teams[0]!.members.map((m) => [m.workerId, m.inbox]));
    assert.deepEqual(members.get("ag_02"), { open: 2, urgent: 1, total: 4, closedByMember: 0, closedAutomatically: 0 }, "an instruction copy and a returned item are not open");
    assert.equal(members.get("ag_01"), undefined, "no file, no counts");
    assert.ok(!("inbox" in insight.teams[0]!.members[0]!));
  });

  test("the list and one body; another session's member or a bad id is refused", async () => {
    const { path, mailbox } = session("route");
    const store = new InboxStore(mailbox, { now: () => T0 });
    const it = store.add({ teamId: "team_01", from: lead, to: dev, kind: "question", body: "Which port does the server use?", subject: "Port?", urgent: true });
    const list = await getMemberInbox(path, "team_01", "ag_02");
    assert.ok(list.ok);
    assert.deepEqual(list.body, {
      teamId: "team_01",
      workerId: "ag_02",
      total: 1,
      counts: { open: 1, urgent: 1, total: 1, closedByMember: 0, closedAutomatically: 0 },
      items: [{ id: it.id, from: lead, kind: "question", subject: "Port?", urgent: true, status: "new", sentAt: T0 }],
    });
    const one = await getMemberInbox(path, "team_01", "ag_02", it.id);
    assert.deepEqual(one, { ok: true, body: { id: it.id, body: "Which port does the server use?" } });
    const empty = await getMemberInbox(path, "team_01", "ag_01");
    assert.ok(empty.ok && "items" in empty.body && empty.body.items.length === 0, "a member with no file reads empty");
    assert.deepEqual(await getMemberInbox(path, "team_01", "ag_07"), { ok: false, status: 404, error: "No such member in this session's teams" });
    assert.deepEqual(await getMemberInbox(path, "team_09", "ag_02"), { ok: false, status: 404, error: "No such member in this session's teams" });
    assert.deepEqual(await getMemberInbox(path, "../x", "ag_02"), { ok: false, status: 400, error: "Invalid ?team= or ?worker=" });
    assert.deepEqual(await getMemberInbox(path, "team_01", "ag_02", "../../etc"), { ok: false, status: 400, error: "Invalid ?item=" });
    assert.deepEqual(await getMemberInbox(path, "team_01", "ag_02", "i_zzz"), { ok: false, status: 404, error: "No such item in this inbox" });
  });
});
