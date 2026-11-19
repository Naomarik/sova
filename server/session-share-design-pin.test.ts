// A snapshot's designs are the ones its preview showed (§app.session-share/snapshot, /lookbook): the
// design cut the operator's preview answers (`designsAt`) is the one Create, Update to Now and Stop
// Following store and the share then serves, through the operator's routes in process. A link with
// no stored cut (made before designs were shared) reads at the later of its cut entry's time and its
// creation, and session-shares.json never carries the design cut (an older Sova must still parse
// it). A throwaway PI_CODING_AGENT_DIR; no socket, no model.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { SessionShare, SessionShareMinted, SessionSharePreview, SessionShareView } from "../shared/session-share";
import { LB_SESSION_ID, writeLookbookChat } from "./session-share-lookbook.test.helper";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-lb-pin-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");
const fx = writeLookbookChat(join(root, "agent"));

const { registerSessionShareRoutes } = await import("./session-shares-routes");
const { stopSessionShareLive } = await import("./share/session-live");
const { createShare, getShare, sharesFile, validateSharesFile } = await import("./session-shares");
const { designCutOf } = await import("./session-share-design-cuts");
const app = new Hono();
registerSessionShareRoutes(app);
after(() => stopSessionShareLive());

const iso = (s: number) => new Date(Date.UTC(2026, 8, 30, 0, 0, s)).toISOString();
const op = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
  const r = await app.request(path, { method: init.method ?? "GET", ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } } : {}) });
  return { status: r.status, body: (await r.json()) as T };
};
/** A's versions a view shows, e.g. [1, 2]. */
const aVersions = (v: SessionShareView): number[] => v.lookbooks?.flatMap((lb) => lb.designs.filter((d) => d.label === "A").flatMap((d) => d.versions.map((x) => x.n))) ?? [];
/** What the minted share serves now, as the operator's share preview reads it (the share's own source). */
const served = async (id: string) => (await op<SessionShareView>(`/api/session-shares/${id}/preview`)).body;
const mint = (body: Record<string, unknown>) => op<SessionShareMinted>("/api/session-shares", { method: "POST", body: { sessionId: LB_SESSION_ID, title: "Lookbook", expiresInDays: 30, recipients: ["Ana"], anyone: false, ...body } });

test("Create: the share serves the designs its preview showed, at the preview's design cut", async () => {
  // The first read pins now; versions are all older, so A shows v1–v3.
  const before = Date.now();
  const first = (await op<SessionSharePreview>(`/api/session-shares/preview?session=${LB_SESSION_ID}`)).body;
  assert.ok(first.designsAt && Date.parse(first.designsAt) >= before - 1000 && Date.parse(first.designsAt) <= Date.now(), `the first read pins now: ${first.designsAt}`);
  // A later read (Show earlier, a document) passes the pin back; one between A2 and A3 shows A1–A2.
  const pinned = (await op<SessionSharePreview>(`/api/session-shares/preview?session=${LB_SESSION_ID}&cut=${fx.cut}&designsAt=${iso(15)}`)).body;
  assert.equal(pinned.designsAt, iso(15));
  assert.deepEqual(aVersions(pinned), [1, 2]);
  const made = await mint({ mode: "snapshot", cut: pinned.cut, designsAt: pinned.designsAt });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.share.id;
  assert.equal(designCutOf(getShare(id)!.share), pinned.designsAt, "the stored cut is the preview's");
  assert.deepEqual((await served(id)).lookbooks, pinned.lookbooks, "the share serves exactly the previewed Lookbooks");
  // Each previewed document is the one the link serves, byte for byte, under the same headers; a
  // version past the pin is in neither.
  const { sessionShareDesign } = await import("./session-share-view");
  const { sourceOf } = await import("./share/session-routes");
  const q = `session=${LB_SESSION_ID}&cut=${pinned.cut}&designsAt=${pinned.designsAt}`;
  for (const [label, n, kind] of [["A", 1, "page"], ["A", 2, "tile"], ["B", 1, "still"], ["A", 2, "tile-still"]] as const) {
    const r = await app.request(`/api/session-shares/preview/d/${label}/${n}/${kind}?${q}`);
    assert.equal(r.status, 200, `${label}/${n}/${kind}`);
    assert.match(r.headers.get("content-security-policy") ?? "", kind.includes("still") ? /^sandbox;/ : /^sandbox allow-scripts allow-forms;/);
    const doc = await r.text();
    assert.equal(doc, await sessionShareDesign(sourceOf(getShare(id)!.share), label, n, kind), `${label}/${n}/${kind}: previewed as shared`);
    assert.deepEqual(await (await app.request(`/api/session-shares/preview/d/${label}/${n}/${kind}?${q}&as=json`)).json(), { doc }, "the srcdoc form carries the same document");
  }
  assert.equal((await app.request(`/api/session-shares/preview/d/A/3/page?${q}`)).status, 404, "A3 finished after the pin");
  // Without a pin, the mint takes now.
  const now = await mint({ mode: "snapshot", cut: fx.cut });
  assert.ok(Date.parse(designCutOf(getShare(now.body.share.id)!.share)!) >= before, "no designsAt: now");
  assert.deepEqual(aVersions(await served(now.body.share.id)), [1, 2, 3]);
  // A pin in the future or not a time is refused, never taken as now.
  for (const bad of [new Date(Date.now() + 3_600_000).toISOString(), "yesterday", 5]) assert.equal((await mint({ mode: "snapshot", cut: fx.cut, designsAt: bad })).status, 400, String(bad));
});

test("Update to Now and Stop Following take the preview's design cut too", async () => {
  const made = await mint({ mode: "snapshot", cut: fx.cut, designsAt: iso(7) });
  const id = made.body.share.id;
  assert.deepEqual(aVersions(await served(id)), [1], "at 00:00:07 only A1 had finished");
  const update = await op<SessionShare>(`/api/session-shares/${id}/update`, { method: "POST", body: { cut: fx.cut, designsAt: iso(22) } });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(designCutOf(getShare(id)!.share), iso(22));
  assert.deepEqual(aVersions(await served(id)), [1, 2, 3]);

  const live = await mint({ mode: "live" });
  const lid = live.body.share.id;
  assert.equal(designCutOf(getShare(lid)!.share), null, "Follow live has no design cut");
  assert.deepEqual(aVersions(await served(lid)), [1, 2, 3]);
  const stop = await op<SessionShare>(`/api/session-shares/${lid}`, { method: "PATCH", body: { mode: "snapshot", cut: fx.cut, designsAt: iso(15) } });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(designCutOf(getShare(lid)!.share), iso(15), "Stop Following pins the previewed design cut");
  assert.deepEqual(aVersions(await served(lid)), [1, 2]);
});

test("a link with no stored design cut reads at the later of its cut entry's time and its creation; the share file stays an older Sova's", async () => {
  // As an older Sova made them: straight into the store, no side file entry.
  const early = createShare({ sessionId: LB_SESSION_ID, sessionPath: fx.sessionPath, title: "Old", mode: "snapshot", cut: { entryId: fx.cut, at: iso(10) }, days: 30, labels: ["Old"], anyone: false }, Date.parse(iso(6)));
  assert.equal(designCutOf(early.share), iso(10), "created before its cut entry: the cut entry's time");
  const late = createShare({ sessionId: LB_SESSION_ID, sessionPath: fx.sessionPath, title: "Old", mode: "snapshot", cut: { entryId: fx.cut, at: iso(10) }, days: 30, labels: ["Old"], anyone: false }, Date.parse(iso(16)));
  assert.equal(designCutOf(late.share), iso(16), "created after it: its creation");
  // Every share these tests made, side-file cuts included, still parses as the share file always has.
  const raw = JSON.parse(readFileSync(sharesFile(), "utf8")) as unknown;
  assert.ok(!("why" in (validateSharesFile(raw) as object)), "the share file validates");
  assert.ok(!readFileSync(sharesFile(), "utf8").includes("designsAt"), "and carries no design cut");
});
