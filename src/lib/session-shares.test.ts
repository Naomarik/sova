// The operator app's words for session share links (§app.session-share/sheet, /shares-page).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionShare, SessionSharePresence } from "../../shared/session-share";
import { cleanLabels, createBlocked, expiresWord, imagesBlocked, isStalePreview, modeLine, openedLine, presenceWord, ShareApiError, shareLine, sharingTabLabel, sliceLine, thumbsLine, viewingNow, visitLine } from "./session-shares";

test("labels are trimmed, capped, deduplicated case-insensitively, and never the anyone row's label", () => {
  assert.deepEqual(cleanLabels([" Ana ", "ana", "", "Ben", "Anyone with the link", "x".repeat(80)]), ["Ana", "Ben", "x".repeat(60)]);
});

test("expiry reads in days, rounded, then hours", () => {
  const now = Date.parse("2026-09-30T00:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(expiresWord(at(30 * 86400e3 - 5000), now), "Expires in 30 days");
  assert.equal(expiresWord(at(36 * 3600e3), now), "Expires in 2 days");
  assert.equal(expiresWord(at(25 * 3600e3), now), "Expires tomorrow");
  assert.equal(expiresWord(at(5 * 3600e3 + 10), now), "Expires in 5 hours");
  assert.equal(expiresWord(at(10 * 60e3), now), "Expires within the hour");
  assert.equal(expiresWord(at(-1), now), "Expired");
});

test("presence, opened and mode lines", () => {
  assert.equal(presenceWord("viewing"), "Viewing now");
  assert.equal(presenceWord("open"), "Open in a tab");
  assert.equal(presenceWord("away"), null);
  assert.equal(openedLine(0, undefined, () => "x"), "Not opened yet");
  assert.equal(openedLine(3, "2026-09-30T00:00:00Z", () => "2h ago"), "Opened 3× · last 2h ago");
  assert.equal(modeLine({ mode: "live", cutAt: null }, () => "x"), "Follows live");
  assert.equal(modeLine({ mode: "snapshot", cutAt: "2026-09-30T00:00:00Z" }, () => "Sep 30 12:00 AM"), "Snapshot up to Sep 30 12:00 AM");
});

test("a visit line names the kind, device and time, and a visit's length", () => {
  const rel = () => "1h ago";
  assert.equal(visitLine({ kind: "visit", at: "2026-09-30T00:00:00Z", lastSeenAt: "2026-09-30T00:06:00Z", device: "iPhone" }, rel), "Opened · iPhone · 1h ago · 6 min");
  assert.equal(visitLine({ kind: "preview", at: "2026-09-30T00:00:00Z", device: "Slack", bot: true }, rel), "Link preview · Slack (automated) · 1h ago");
});


const thumbs = (total: number, loaded: number[], failed: number[] = []) => ({ total, loaded: new Set(loaded), failed: new Set(failed) });
const ready = { title: "Plan", recipients: 1, max: 20, preview: "ready" as const };

test("Create waits for the preview and for every image it shares to load; a failed one keeps it blocked", () => {
  assert.equal(createBlocked({ ...ready, preview: "loading", thumbs: thumbs(0, []) }), "Reading the conversation first.");
  assert.match(createBlocked({ ...ready, preview: "failed", thumbs: thumbs(0, []) }) ?? "", /couldn't be read/);
  assert.match(createBlocked({ ...ready, thumbs: thumbs(3, [0, 1]) }) ?? "", /^Loading the images first/);
  assert.match(createBlocked({ ...ready, thumbs: thumbs(3, [0, 1], [2]) }) ?? "", /^An image didn't load/);
  assert.equal(createBlocked({ ...ready, thumbs: thumbs(3, [0, 1, 2]) }), null);
  assert.equal(createBlocked({ ...ready, thumbs: thumbs(0, []) }), null);
  // The form's own rules come first.
  assert.equal(createBlocked({ ...ready, title: " ", thumbs: thumbs(0, []) }), "Give the share a title.");
  assert.equal(createBlocked({ ...ready, recipients: 0, thumbs: thumbs(0, []) }), "Add a person, or turn on Anyone with the link.");
  assert.equal(createBlocked({ ...ready, recipients: 21, thumbs: thumbs(0, []) }), "At most 20 links per share.");
  // Update to Now and Stop Following Live use the image part alone.
  assert.equal(imagesBlocked(thumbs(1, [0])), null);
  assert.match(imagesBlocked(thumbs(1, [], [0])) ?? "", /didn't load/);
});

test("the images line counts what loaded and what failed", () => {
  assert.equal(thumbsLine(thumbs(0, [])), null);
  assert.equal(thumbsLine(thumbs(3, [0])), "Loading images · 1 of 3");
  assert.equal(thumbsLine(thumbs(3, [0, 1], [2])), "1 of 3 images didn't load, so nothing can be shared until it does.");
  assert.equal(thumbsLine(thumbs(3, [0, 1, 2])), null);
});

test("only a 409 stale-preview reads as a stale preview", () => {
  assert.equal(isStalePreview(new ShareApiError("gone", 409, "stale-preview")), true);
  assert.equal(isStalePreview(new ShareApiError("x", 400, "preview-required")), false);
  assert.equal(isStalePreview(new ShareApiError("x", 409, "conflict")), false);
  assert.equal(isStalePreview(new Error("x")), false);
});

test("a sliced share's rows say which messages; a whole session keeps its mode line", () => {
  const abs = () => "Sep 30 12:00 AM";
  assert.equal(shareLine({ mode: "snapshot", cutAt: "2026-09-30T00:00:00Z", span: { first: 12, last: 18, total: 40 } }, abs), "Messages 12–18 of 40");
  assert.equal(shareLine({ mode: "live", cutAt: null, span: { first: 12, last: null, total: 40 } }, abs), "From message 12 · follows live");
  assert.equal(shareLine({ mode: "snapshot", cutAt: "2026-09-30T00:00:00Z" }, abs), "Snapshot up to Sep 30 12:00 AM");
  assert.equal(sliceLine({ span: { first: 3, last: 3, total: 9 } }), "Message 3 of 9");
  assert.equal(sliceLine({}), "The whole session.");
});

test("the Sharing tab counts recipients viewing now, never a background tab, and says so in its name", () => {
  const share = (presences: SessionSharePresence[], extra: Partial<SessionShare> = {}): SessionShare => ({
    id: "ss_1",
    sessionId: "s",
    sessionTitle: "t",
    title: "t",
    mode: "snapshot",
    cutAt: null,
    createdAt: "2026-09-30T00:00:00Z",
    recipients: presences.map((presence, i) => ({ id: `r_${i}`, label: `P${i}`, state: "live", createdAt: "", expiresAt: "", presence, opened: 1 })),
    ...extra,
  });
  assert.equal(viewingNow([]), 0);
  assert.equal(viewingNow([share(["open", "away"])]), 0);
  assert.equal(viewingNow([share(["viewing", "open"]), share(["viewing"])]), 2);
  // A stopped share serves no page, whatever its last presence said.
  assert.equal(viewingNow([share(["viewing"], { stoppedAt: "2026-09-30T00:00:00Z" })]), 0);
  assert.equal(sharingTabLabel(0), "Sharing");
  assert.equal(sharingTabLabel(2), "Sharing, 2 viewing now");
});
