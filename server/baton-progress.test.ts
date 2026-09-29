// Run: pnpm exec tsx --test server/baton-progress.test.ts. What the session list says of a baton
// session's progress (§app.organizations/org-sessions): `written` once someone it was sent to has
// written, `opened` once a person opened one of its links, `settle` for a settle session; and the
// startup backfill for rows from before those marks. A throwaway PI_CODING_AGENT_DIR and workspace.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_SENT_ENTRY, OPERATOR } from "../shared/baton";
import type { Conflict } from "../shared/decisions";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-progress-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { liveLinks } = await import("./baton-links");
const { recordOpen } = await import("./visits");
const { writeConflicts } = await import("./decisions");
const { backfillBatonMarks } = await import("./baton-marks");

after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const sara = await orgs.addPerson(org.id, { name: "Sara Haddad", role: "Owner" });
const ali = await orgs.addPerson(org.id, { name: "Ali Nasser", role: "IT" });
const start = (to: string | string[], extra: Record<string, unknown> = {}) =>
  baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "Logo", goal: "Which logo?", ...extra });
const field = (path: string) => baton.batonSummaryField(path)!;
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Append a user message and its sent marker, chained on the file's last entry, as the runtime writes them. */
function writeSent(path: string, by: string, at = "2026-09-01T10:00:00.000Z"): void {
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  const msg = { type: "message", id: `m${lines.length}`, parentId: last.id ?? null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.parse(at) } };
  const sent = { type: "custom", customType: BATON_SENT_ENTRY, id: `s${lines.length}`, parentId: msg.id, timestamp: at, data: { v: 1, targetId: msg.id, by } };
  appendFileSync(path, `${JSON.stringify(msg)}\n${JSON.stringify(sent)}\n`);
}

describe("written", () => {
  test("a fresh session is not written; the operator writing in a person's session doesn't count; the person does", () => {
    const c = start(sara.id);
    assert.equal(field(c.path).written, undefined);
    // The operator can write here only after taking it back; that message is never Sara's.
    assert.equal(baton.wroteForIt(baton.batonById(c.sessionId)!.row, OPERATOR), false, "the operator is not who it was sent to");
    assert.equal(baton.wroteForIt(baton.batonById(c.sessionId)!.row, sara.id), true);
    baton.noteMessage(c.sessionId, sara.id);
    assert.equal(field(c.path).written, true);
    assert.ok(baton.batonById(c.sessionId)!.row.wroteAt, "kept on the registry row");
  });

  test("an offer is written once any invitee writes", () => {
    const c = start([sara.id, ali.id]);
    assert.equal(field(c.path).written, undefined);
    baton.noteMessage(c.sessionId, ali.id);
    assert.equal(field(c.path).written, true);
  });

  test("a session sent to the operator is written once the operator writes", () => {
    const c = start(OPERATOR);
    assert.equal(field(c.path).written, undefined);
    baton.noteMessage(c.sessionId, OPERATOR);
    assert.equal(field(c.path).written, true);
  });
});

describe("opened", () => {
  test("a person opening a link marks it opened; a link previewer doesn't; opened is not written", () => {
    const c = start(sara.id);
    const link = liveLinks(c.sessionId, 1)[0]!;
    recordOpen(link, { userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" });
    assert.equal(field(c.path).opened, undefined, "a preview is no person");
    recordOpen(link, { userAgent: CHROME });
    assert.equal(field(c.path).opened, true);
    assert.equal(field(c.path).written, undefined);
  });
});

describe("settle", () => {
  test("a session started for a conflict carries its area; an ordinary one carries none", () => {
    const plain = start(sara.id);
    assert.equal(field(plain.path).settle, undefined);
    const s = baton.createBaton({ orgId: org.id, projectId: project.id, to: ali.id, publicTitle: "Settle: invoicing", goal: "g", settle: { conflictId: "cf_12345678", area: "invoicing" }, mintLink: false });
    assert.deepEqual(baton.batonById(s.sessionId)!.row.conflict, { id: "cf_12345678", area: "invoicing" });
    assert.deepEqual(field(s.path).settle, { area: "invoicing" });
  });
});

describe("backfill of rows from before the marks", () => {
  test("wroteAt from the transcript's first message by someone it was sent to; conflict from the conflict naming the session", async () => {
    const byPerson = start(sara.id);
    const byOperator = start(ali.id);
    const toOperator = start(OPERATOR);
    writeSent(byPerson.path, OPERATOR, "2026-09-01T09:00:00.000Z");
    writeSent(byPerson.path, sara.id, "2026-09-01T10:00:00.000Z");
    writeSent(byOperator.path, OPERATOR);
    writeSent(toOperator.path, OPERATOR, "2026-09-02T08:00:00.000Z");
    const conflict: Conflict = {
      id: "cf_abcdefgh", orgId: org.id, projectId: project.id, areaKey: "hosting", a: "x:1", b: "y:2", p: 0.9, routedTo: ali.id,
      routeReason: "Ali decides hosting.", batonSessionId: byOperator.sessionId, state: "open", createdAt: "2026-09-01T00:00:00.000Z",
    };
    writeConflicts(org.id, project.id, [conflict]);
    const changed = await backfillBatonMarks();
    assert.deepEqual(changed.sort(), [byPerson.sessionId, byOperator.sessionId, toOperator.sessionId].sort());
    assert.equal(baton.batonById(byPerson.sessionId)!.row.wroteAt, "2026-09-01T10:00:00.000Z", "the person's message, not the operator's earlier one");
    assert.equal(baton.batonById(byOperator.sessionId)!.row.wroteAt, undefined);
    assert.equal(baton.batonById(toOperator.sessionId)!.row.wroteAt, "2026-09-02T08:00:00.000Z");
    assert.deepEqual(baton.batonById(byOperator.sessionId)!.row.conflict, { id: "cf_abcdefgh", area: "hosting" }, "the conflict's area key when no decision names it");
    assert.deepEqual(field(byOperator.path).settle, { area: "hosting" });
    assert.deepEqual(await backfillBatonMarks(), [], "a second pass changes nothing");
  });
});
