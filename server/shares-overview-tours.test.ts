// §app.session-share/shares-page: the Shares page's Tour links. Live /t/ links whose source chat still
// owns them, pinned edition and expiry, the kept link, and visits only from opt-in Log visitors keyed
// by the link (never a resume reader). A throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-shares-tours-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_SHARE_PUBLIC_URL = "https://share.example.com";
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { stateRoot } = await import("./state-root");
const { tourEditionAssetsFixture, tourEditionFixture } = await import("../shared/tour-fixtures");
const { publishEdition } = await import("./tours/store");
const { tourShares, TOUR_VISIT_RECIPIENT } = await import("./tours/shares");
const { markTourSessionDeleted } = await import("./tours/deleted");
const { writeVisitorLogging } = await import("./visitor-logging");
const { noteVisitor } = await import("./visitor-identity");
const { recordOpen } = await import("./visits");
const { tourLinkRows, sharesOverview } = await import("./shares-overview");

function chat(withTranscript: boolean) {
  const id = randomUUID(), e = tourEditionFixture(); e.sessionId = id;
  if (withTranscript) {
    const dir = join(root, "agent", "sessions", "--fixture--"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-01-02T03-04-05-000Z_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-02T03:04:05.000Z", cwd: root }) + "\n");
  }
  publishEdition(e, tourEditionAssetsFixture());
  return e;
}
const mint = (e: ReturnType<typeof chat>, days = 7, now = Date.now()) => {
  const shares = tourShares(), p = shares.previewFor(e, "public", undefined, now);
  return shares.create(e.sessionId, e.manifest.id, e.manifest.editionId, p.previewId, new Date(now + days * 86400_000).toISOString(), now);
};

test("Tour links list only live links of owned sources, with the pinned check time, expiry and kept link", async () => {
  const owned = chat(true), orphan = chat(false);
  const live = mint(owned), revoked = mint(owned), expiring = mint(owned, 1, Date.now() - 2 * 86400_000), unowned = mint(orphan);
  tourShares().revoke(owned.sessionId, owned.manifest.id, owned.manifest.editionId, revoked.link.id);
  const rows = await tourLinkRows();
  assert.deepEqual(rows.map((r) => r.id), [live.link.id], "revoked, expired and unowned-source links are not listed");
  const row = rows[0]!;
  assert.equal(row.title, owned.manifest.title); assert.equal(row.checkedAt, owned.manifest.check.checkedAt);
  assert.equal(row.expiresAt, live.link.expiresAt); assert.equal(row.editionId, owned.manifest.editionId);
  assert.equal(row.link, `https://share.example.com/t/${live.token}`, "the kept token makes Copy Link");
  assert.deepEqual([row.opened, row.visits], [0, []], "with Log visitors off nothing was recorded");
  assert.ok(!JSON.stringify(rows).includes(unowned.token) && !JSON.stringify(rows).includes(expiring.token));
  assert.deepEqual((await sharesOverview([])).tourLinks?.map((r) => r.id), [live.link.id], "the overview answer carries them");
  markTourSessionDeleted(stateRoot(), owned.sessionId);
  assert.deepEqual(await tourLinkRows(), [], "a deleted source lists nothing even while its rows linger");
});

test("a tour link's visits are the link's own opt-in visits with their identity, never a reader's", async () => {
  const e = chat(true), made = mint(e);
  writeVisitorLogging({ logVisitors: true, forwardIp: false });
  try {
    const visit = recordOpen({ via: "session", shareId: made.link.id, recipientId: TOUR_VISIT_RECIPIENT }, { tab: "B".repeat(22), userAgent: "Mozilla/5.0 (X11; Linux x86_64) FixtureBrowser/1.0" });
    noteVisitor(visit, { ip: "198.51.100.7", ua: "Mozilla/5.0 (X11; Linux x86_64) FixtureBrowser/1.0", lang: "en-GB" });
    recordOpen({ via: "session", shareId: made.link.id, recipientId: "someone-else" }, { tab: "C".repeat(22), userAgent: "Mozilla/5.0 (X11; Linux x86_64) OtherBrowser/2.0" });
    const row = (await tourLinkRows()).find((r) => r.id === made.link.id)!;
    assert.equal(row.opened, 1); assert.equal(row.visits.length, 1, "only the link's tour visits, not another recipient key");
    assert.equal(row.visits[0]!.id, visit); assert.deepEqual((row.visits[0] as { ip?: string[] }).ip, ["198.51.100.7"]);
  } finally { writeVisitorLogging({ logVisitors: false, forwardIp: false }); }
});
