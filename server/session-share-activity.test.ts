// Run: pnpm exec tsx --test server/session-share-activity.test.ts. §app.session-share/visits and
// /presence: a session link's visits land in the host-local log with no person, and the presence
// rules (visibility frame, strict frames, sockets per link, 4410 closes). Throwaway agent dir.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { WebSocket } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-session-activity-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const visits = await import("./visits");
const presence = await import("./session-share-presence");
const { stateRoot } = await import("./state-root");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const tab = (c: string) => c.repeat(22).slice(0, 22);
const ana = { via: "session" as const, shareId: "ss_aaaaaaaaaaaa", recipientId: "r_anaaaaaaa" };
const ben = { via: "session" as const, shareId: "ss_aaaaaaaaaaaa", recipientId: "r_benbbbbbb" };

describe("session share visits (§app.session-share/visits)", () => {
  const file = () => join(stateRoot(), visits.SESSION_VISITS_FILE);

  test("a visit lands in the host-local log, 0600, with the share and recipient and nothing else", () => {
    const t = Date.parse("2026-09-30T10:00:00Z");
    const id = visits.recordOpen(ana, { tab: tab("A"), userAgent: IPHONE, now: t });
    assert.ok(id);
    assert.equal(visits.recordOpen(ana, { tab: tab("A"), userAgent: IPHONE, now: t + 60_000 }), id, "a reload continues it");
    assert.equal(statSync(file()).mode & 0o777, 0o600);
    const line = JSON.parse(readFileSync(file(), "utf8").split("\n")[0]!);
    assert.deepEqual(Object.keys(line).sort(), ["at", "device", "id", "kind", "recipientId", "shareId", "tab", "via"]);
    assert.equal(line.via, "session");
    assert.equal(line.device, "Safari · iPhone");
    assert.ok(!readFileSync(file(), "utf8").includes("Mozilla"), "no raw user agent");
  });

  test("previews, refusals and sockets follow the same rules; readSessionVisits folds per recipient", () => {
    const t = Date.parse("2026-09-30T12:00:00Z");
    assert.equal(visits.recordShellFetch(ben, SLACK, t), true);
    assert.equal(visits.recordOpen(ben, { userAgent: SLACK, now: t + 1000 }), null, "a previewer is never a visit");
    const v = visits.recordOpen(ben, { tab: tab("B"), userAgent: IPHONE, now: t + 2000 });
    const h = visits.socketOpened(ben, { tab: tab("B"), userAgent: IPHONE, now: t + 3000 });
    assert.ok(v && h);
    visits.socketClosed(h, t + 4 * 60_000);
    assert.equal(visits.recordRefused(ben, IPHONE, t + 5 * 60_000), true);
    const rows = visits.readSessionVisits(ben.shareId, ben.recipientId);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["refused", "visit", "preview"],
    );
    assert.equal(rows[1]!.lastSeenAt, new Date(t + 4 * 60_000).toISOString());
    assert.deepEqual(visits.visitSummary(rows), { opened: 1, lastAt: new Date(t + 4 * 60_000).toISOString() });
    assert.equal(visits.readSessionVisits(ana.shareId, ana.recipientId).length, 1, "Ana's log is hers");
  });

  test("an org's visits.jsonl is untouched by session links", () => {
    assert.ok(!existsSync(join(stateRoot(), visits.VISITS_FILE)));
  });
});

/** A socket as presence uses one. */
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close", code, reason);
  }
}
const sock = () => new FakeSocket();
const asWs = (s: FakeSocket) => s as unknown as WebSocket;
const key = (recipientId: string, hash = `h-${recipientId}`) => ({ shareId: "ss_bbbbbbbbbbbb", recipientId, hash });

describe("presence (§app.session-share/presence)", () => {
  beforeEach(() => presence.resetViewers());

  test("viewing while visible, open while hidden, away when closed", () => {
    const s = sock();
    presence.addViewer(key("r_1"), asWs(s));
    assert.equal(presence.presenceOf("ss_bbbbbbbbbbbb", "r_1"), "viewing", "visible until it says otherwise");
    s.emit("message", Buffer.from('{"t":"vis","on":false}'), false);
    assert.equal(presence.presenceOf("ss_bbbbbbbbbbbb", "r_1"), "open");
    const t = sock();
    presence.addViewer(key("r_1"), asWs(t));
    assert.equal(presence.presenceOf("ss_bbbbbbbbbbbb", "r_1"), "viewing", "any visible tab");
    t.close(1000, "");
    s.close(1000, "");
    assert.equal(presence.presenceOf("ss_bbbbbbbbbbbb", "r_1"), "away");
    assert.equal(presence.viewerCount("ss_bbbbbbbbbbbb"), 0);
  });

  test("any other frame closes the socket: 1003, or 1009 when too big", () => {
    for (const [frame, code] of [
      ['{"t":"vis","on":"yes"}', 1003],
      ['{"t":"vis","on":true,"x":1}', 1003],
      ["hello", 1003],
      [`{"t":"vis","on":true,"pad":"${"x".repeat(2000)}"}`, 1009],
    ] as const) {
      const s = sock();
      presence.addViewer(key("r_2"), asWs(s));
      s.emit("message", Buffer.from(frame), false);
      assert.equal(s.closed?.code, code, frame.slice(0, 30));
    }
    const b = sock();
    presence.addViewer(key("r_2"), asWs(b));
    b.emit("message", Buffer.from('{"t":"vis","on":true}'), true);
    assert.equal(b.closed?.code, 1003, "a binary frame");
  });

  test("at most 4 sockets per link, the oldest closed; other links unaffected", () => {
    const socks = Array.from({ length: 5 }, sock);
    const other = sock();
    presence.addViewer(key("r_3", "other"), asWs(other));
    for (const s of socks) presence.addViewer(key("r_3"), asWs(s));
    assert.equal(socks[0]!.closed?.code, 4000);
    assert.ok(socks.slice(1).every((s) => !s.closed));
    assert.equal(other.closed, null);
    assert.equal(presence.viewerCount("ss_bbbbbbbbbbbb"), 5);
  });

  test("a dead link's pages close with 4410 after a gone frame; pushView reaches every page", () => {
    const a = sock();
    const b = sock();
    presence.addViewer(key("r_4"), asWs(a));
    presence.addViewer(key("r_5"), asWs(b));
    const view = { title: "t", sharedAt: "", mode: "snapshot" as const, through: null, items: [], images: 0 };
    assert.equal(presence.pushView("ss_bbbbbbbbbbbb", view), 2);
    assert.deepEqual(JSON.parse(a.sent[0]!), { type: "view", view });
    assert.equal(presence.closeLink("h-r_4", "expired"), 1);
    assert.deepEqual(JSON.parse(a.sent.at(-1)!), { type: "error", code: "gone", why: "expired" });
    assert.equal(a.closed?.code, 4410);
    assert.equal(presence.sweepViewers((k) => (k.recipientId === "r_5" ? { ok: false } : { ok: true })), 1);
    assert.equal(b.closed?.code, 4410);
    const c = sock();
    presence.addViewer(key("r_6"), asWs(c));
    assert.equal(presence.closeShare("ss_bbbbbbbbbbbb"), 1);
    assert.equal(c.closed?.code, 4410);
  });
});

describe("the Shares page's org links (§app.session-share/shares-page)", async () => {
  const orgs = await import("./orgs");
  const baton = await import("./baton");
  const links = await import("./baton-links");
  const plinks = await import("./person-links");
  const { orgLinkRows, sharesOverview } = await import("./shares-overview");
  const org = await orgs.createOrg({ name: "Gate Archery", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "Booking site", root: join(root, "proj") });
  const kim = orgs.addPerson(org.id, { name: "Kim Lee", contact: { email: "kim@example.test" } });
  const alp = orgs.addPerson(org.id, { name: "Alperen Kaya", contact: { email: "alp@example.test" } });
  const s = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Opening hours", goal: "g" });
  const kimToken = baton.rotateLink(s.sessionId).token;
  orgs.setOrgOwner(org.id, alp.id);
  const owner = plinks.mintOwnerLink(org.id, alp.id);
  const t = Date.now();
  visits.recordOpen(links.findLink(kimToken)!, { userAgent: IPHONE, now: t - 60_000 });
  visits.recordOpen({ orgId: org.id, personId: alp.id, via: "owner", gen: owner.record.gen }, { userAgent: IPHONE, now: t - 30_000 });

  test("every live hand-off and owner link, with its person, session, state, expiry and its own visits", async () => {
    const rows = orgLinkRows();
    const handoff = rows.find((r) => r.kind === "handoff")!;
    assert.equal(handoff.orgName, "Gate Archery");
    assert.equal(handoff.personName, "Kim Lee");
    assert.equal(handoff.sessionId, s.sessionId);
    assert.equal(handoff.sessionTitle, "Opening hours");
    assert.equal(handoff.opened, 1);
    assert.equal(handoff.visits.length, 1);
    const own = rows.find((r) => r.kind === "owner")!;
    assert.equal(own.personName, "Alperen Kaya");
    assert.equal(own.state, "live");
    assert.equal(own.opened, 1, "the owner visit is the owner link's, not the hand-off's");
    assert.equal(rows.length, 2);
    assert.equal(handoff.presence, undefined, "no page open");
    assert.equal(own.presence, undefined, "an owner link has no socket");
    assert.deepEqual((await sharesOverview([])).orgLinks, rows);
  });

  test("a hand-off link whose page has an open socket is viewing", async () => {
    const { addWatcher } = await import("./share/hub");
    const page = sock();
    addWatcher(s.sessionId, asWs(page), kimToken);
    assert.equal(orgLinkRows().find((r) => r.kind === "handoff")!.presence, "viewing");
    page.close(1000, "");
    assert.equal(orgLinkRows().find((r) => r.kind === "handoff")!.presence, undefined);
  });

  test("a turned-off link is not listed, and the stores are not written", () => {
    const before = readFileSync(join(stateRoot(), "baton-links.json"), "utf8");
    orgLinkRows();
    assert.equal(readFileSync(join(stateRoot(), "baton-links.json"), "utf8"), before);
    plinks.revokePersonLinks((l) => l.orgId === org.id, "off");
    assert.deepEqual(
      orgLinkRows().map((r) => r.kind),
      ["handoff"],
    );
  });
});
