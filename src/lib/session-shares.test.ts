// The operator app's words for session share links (§app.session-share/sheet, /shares-page).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewView } from "../../shared/preview-links";
import type { OrgLinkRow, SessionShare, SessionSharePresence, SharesOverview } from "../../shared/session-share";
import {
  cleanLabels,
  copyableLink,
  createBlocked,
  expiresWord,
  imagesBlocked,
  isShareChanged,
  isStalePreview,
  linkMoved,
  modeLine,
  openedLine,
  presenceWord,
  readShares,
  ShareApiError,
  shareLine,
  sharesCardLine,
  sharesCounts,
  sharingTabLabel,
  sliceLine,
  thumbsLine,
  viewingNow,
  visitLine,
} from "./session-shares";

test("Copy Link: only a live row's own link, and none once its activity says the newest link is another (§app.session-share/sheet)", () => {
  const row = { state: "live" as const, createdAt: "2026-10-01T00:00:00.000Z", link: "https://share.example.invalid/s/aaa" };
    assert.equal(copyableLink(row), row.link);
    assert.equal(copyableLink(row, { createdAt: row.createdAt }), row.link, "activity agrees");
    assert.equal(copyableLink(row, {}), row.link, "an older host's activity carries no time: nothing moved");
    assert.equal(copyableLink(row, { createdAt: "2026-10-02T00:00:00.000Z" }), undefined, "relinked elsewhere: hidden until the share is read again");
    assert.equal(linkMoved(row, { createdAt: "2026-10-02T00:00:00.000Z" }), true);
    assert.equal(copyableLink({ ...row, state: "expired" }), undefined);
    assert.equal(copyableLink({ ...row, state: "off" }), undefined);
    assert.equal(copyableLink({ state: "live", createdAt: row.createdAt }), undefined, "a link made before tokens were kept: no Copy Link");
});

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

test("only a 409 share-changed reads as a share changed meanwhile", () => {
  assert.equal(isShareChanged(new ShareApiError("x", 409, "share-changed")), true);
  assert.equal(isShareChanged(new ShareApiError("x", 409, "stale-preview")), false);
  assert.equal(isShareChanged(new ShareApiError("x", 400, "share-changed")), false);
});

// ---- the overview's Shares card (§chat.transcript/landing-page) ------------------------------------

const liveShare = (id: string, presences: SessionSharePresence[], extra: Partial<SessionShare> = {}): SessionShare => ({
  id,
  sessionId: "s",
  sessionTitle: "t",
  title: "t",
  mode: "snapshot",
  cutAt: null,
  createdAt: "2026-09-30T00:00:00Z",
  recipients: presences.map((presence, i) => ({ id: `r_${i}`, label: `P${i}`, state: "live", createdAt: "", expiresAt: "", presence, opened: 1 })),
  ...extra,
});
const orgLink = (presence?: SessionSharePresence): OrgLinkRow => ({ kind: "owner", orgId: "o", orgName: "O", personId: "p", personName: "P", state: "live", createdAt: "", expiresAt: "", opened: 0, visits: [], ...(presence ? { presence } : {}) });
const preview = (id: string, state: PreviewView["state"], extra: Partial<PreviewView> = {}): PreviewView => ({ id, projectId: "p", port: 5173, createdAt: "", expiresAt: "", createdBy: "operator", state, ...extra });

test("the Shares card reads every host and this host's previews at once; a host that fails is kept with its error", async () => {
  const asked: (string | null)[] = [];
  const read = await readShares([null, "peer-a", "peer-b"], {
    overview: async (host) => {
      asked.push(host);
      if (host === "peer-b") throw new Error("offline");
      return { sessionShares: [liveShare(`ss_${host ?? "here"}`, ["viewing"])], orgLinks: [] } satisfies SharesOverview;
    },
    previews: async () => [preview("pv_a", "active")],
  });
  assert.deepEqual(asked, [null, "peer-a", "peer-b"]);
  assert.deepEqual(
    read.hosts.map((h) => [h.host, !!h.overview, h.error]),
    [
      [null, true, null],
      ["peer-a", true, null],
      ["peer-b", false, "offline"],
    ],
  );
  assert.equal(read.previews?.length, 1);
  // Previews that fail read as null, never as none.
  const noPreviews = await readShares([null], { overview: async () => ({ sessionShares: [], orgLinks: [] }), previews: () => Promise.reject(new Error("503")) });
  assert.equal(noPreviews.previews, null);
});

test("the Shares card counts live links only, leaves out a host that didn't answer, and counts a person's own preview link", () => {
  const counts = sharesCounts({
    hosts: [
      { host: null, overview: { sessionShares: [liveShare("ss_1", ["viewing", "open"]), liveShare("ss_2", ["viewing"], { stoppedAt: "2026-09-30T00:00:00Z" })], orgLinks: [orgLink("viewing"), orgLink()] }, error: null },
      { host: "peer", overview: null, error: "offline" },
    ],
    previews: [preview("pv_a", "active"), preview("pv_b", "active", { siblingOf: "pv_a", sentTo: "ana" }), preview("pv_c", "off"), preview("pv_d", "expired")],
  });
  // ss_2 is stopped: neither its link nor its old presence counts.
  assert.deepEqual(counts, { sessionShares: 1, orgLinks: 2, previewLinks: 2, viewing: 2, total: 5 });
  assert.equal(sharesCardLine(counts!), "1 session share · 2 organization links · 2 preview links · 2 viewing now");
  // Nothing answered: no counts at all (the card keeps reading), never a row of zeros.
  assert.equal(sharesCounts({ hosts: [{ host: null, overview: null, error: "x" }], previews: null }), null);
});

test("the Shares card's line: singulars, no viewing clause at 0, and the empty line", () => {
  assert.equal(sharesCardLine({ sessionShares: 0, orgLinks: 0, previewLinks: 0, viewing: 0, total: 0 }), "No public links are open.");
  assert.equal(sharesCardLine({ sessionShares: 2, orgLinks: 1, previewLinks: 0, viewing: 0, total: 3 }), "2 session shares · 1 organization link · 0 preview links");
  assert.equal(sharesCardLine({ sessionShares: 0, orgLinks: 0, previewLinks: 1, viewing: 0, total: 1 }), "0 session shares · 0 organization links · 1 preview link");
});
