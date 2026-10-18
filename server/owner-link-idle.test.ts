// Run: pnpm exec tsx --test server/owner-link-idle.test.ts. The owner link's lifetime (al_1 q13,
// DECISIONS 10): it turns itself off after 7 days unused (a sliding deadline, no absolute cap),
// a use moves the deadline (written at most once an hour), and a link that turned off unused can
// ask the operator for a new one, once, which Needs you counts until a new link is made.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-idle-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const plinks = await import("./person-links");
const owner = await import("./owner");

after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);

describe("the owner link turns itself off after 7 days unused", () => {
  test("a new link's deadline is 7 days out", () => {
    const now = Date.now();
    const { record } = plinks.mintOwnerLink(org.id, alp.id, now);
    assert.equal(plinks.OWNER_IDLE_DAYS, 7);
    assert.equal(Date.parse(record.expiresAt) - now, 7 * DAY);
  });

  test("unused for 7 days: 410, named as turned off unused", () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 7 * DAY - 1);
    const a = owner.ownerAccess(token);
    assert.equal(a.ok, false);
    assert.equal(!a.ok && a.status, 410);
    assert.equal(!a.ok && a.why, "idle");
  });

  test("a use moves the deadline; there is no absolute cap", () => {
    const t0 = Date.now() - 100 * DAY;
    const { token, record } = plinks.mintOwnerLink(org.id, alp.id, t0);
    // Used every 6 days for 100 days: never off.
    for (let t = t0 + 6 * DAY; t < Date.now(); t += 6 * DAY) {
      assert.equal(owner.ownerAccess(token, t).ok, true, `alive at day ${Math.round((t - t0) / DAY)}`);
      plinks.noteOwnerLinkUse(record.hash, t);
    }
    assert.equal(owner.ownerAccess(token).ok, true);
  });

  test("a use is written at most once an hour", () => {
    const now = Date.now();
    const { record } = plinks.mintOwnerLink(org.id, alp.id, now);
    plinks.noteOwnerLinkUse(record.hash, now + 10 * 60_000);
    assert.equal(plinks.ownerLinksOf(org.id).at(-1)!.expiresAt, record.expiresAt, "under an hour: unchanged");
    plinks.noteOwnerLinkUse(record.hash, now + HOUR + 1);
    assert.equal(Date.parse(plinks.ownerLinksOf(org.id).at(-1)!.expiresAt), now + HOUR + 1 + 7 * DAY);
    assert.equal(Date.parse(plinks.ownerLinksOf(org.id).at(-1)!.lastUsedAt!), now + HOUR + 1);
  });

  test("a dead link's use changes nothing", () => {
    const { record } = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 8 * DAY);
    plinks.noteOwnerLinkUse(record.hash);
    assert.equal(plinks.ownerLinksOf(org.id).at(-1)!.expiresAt, record.expiresAt);
  });
});

describe("Ask for a new link", () => {
  test("only a link that turned off unused may ask; at most once a day; Needs you counts it until a new link", () => {
    const live = plinks.mintOwnerLink(org.id, alp.id);
    assert.equal(owner.askForNewLink(live.token).status, 409, "a live link has nothing to ask");
    const rotatedAway = live.token;
    const idle = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 8 * DAY);
    assert.equal(owner.askForNewLink(rotatedAway).status, 410, "a replaced link gets the generic answer, no ask");
    assert.equal(owner.askForNewLink("A".repeat(43)).status, 404);
    assert.equal(owner.ownerLinkNeeds(org.id), 0, "turned off unused, not asked: nothing yet");
    assert.equal(owner.askForNewLink(idle.token).status, 202);
    const asked = plinks.findPersonLink(idle.token)!.askedAt;
    assert.ok(asked);
    assert.equal(owner.askForNewLink(idle.token).status, 202, "asking again is fine");
    assert.equal(plinks.findPersonLink(idle.token)!.askedAt, asked, "and records nothing new within a day");
    assert.equal(owner.askForNewLink(idle.token, Date.now() + 86_400_000 + 1).status, 202);
    assert.notEqual(plinks.findPersonLink(idle.token)!.askedAt, asked, "a day later it asks again");
    assert.equal(owner.ownerLinkNeeds(org.id), 1);
    assert.equal(owner.ownerPageInfo(org.id).link!.askedAt, plinks.findPersonLink(idle.token)!.askedAt, "the Owner card says when they last asked");
    plinks.mintOwnerLink(org.id, alp.id);
    assert.equal(owner.ownerLinkNeeds(org.id), 0, "a new link answers the ask");
  });

  test("an ask from a person who is no longer the owner is the generic answer", async () => {
    const kim = await orgs.addPerson(org.id, { name: "Kim Lee" });
    const idle = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 8 * DAY);
    await owner.setOwner(org.id, kim.id);
    assert.equal(owner.askForNewLink(idle.token).status, 410);
    assert.equal(owner.ownerLinkNeeds(org.id), 0);
    await owner.setOwner(org.id, alp.id);
  });
});
