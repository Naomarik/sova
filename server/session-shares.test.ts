// Run: pnpm exec tsx --test server/session-shares.test.ts. §app.session-share/link, /snapshot and
// /slice in-process: the review findings (a previewed snapshot, a view read in flight, the strict
// parse, a raced write) and the store's recipient limits, through the operator's routes and the
// share routes without a listener. A throwaway PI_CODING_AGENT_DIR in the OS temp dir, deleted
// after; no model is called. The share listener over HTTP and /ws/s, and the cases that build on
// its state, are session-shares.integration.test.ts.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { SessionShare, SessionShareMinted, SessionSharePreview, SessionShareView } from "../shared/session-share";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-session-shares-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");

const SID = "019a0000-0000-7000-8000-00000000abcd";
const dir = join(root, "agent", "sessions", "--tmp-proj--");
mkdirSync(dir, { recursive: true });
const FILE = join(dir, `2026-09-01T00-00-00-000Z_${SID}.jsonl`);
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let seq = 0;
let parent: string | null = null;
function append(role: "user" | "assistant", text: string, image = false): string {
  const id = `e${++seq}`;
  const content: unknown[] = [{ type: "text", text }];
  if (image) content.push({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
  const at = new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString();
  appendFileSync(FILE, `${JSON.stringify({ type: "message", id, parentId: parent, timestamp: at, message: { role, content, timestamp: Date.parse(at) } })}\n`);
  parent = id;
  return id;
}
writeFileSync(FILE, `${JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/proj" })}\n`);
append("user", "How do I share a session?", true);
append("assistant", "Use the Share sheet.");

const { registerSessionShareRoutes } = await import("./session-shares-routes");
const { createShareApp } = await import("./share/routes");
const store = await import("./session-shares");
const { sharesFile } = store;
const { stopSessionShareLive } = await import("./share/session-live");

const app = new Hono();
registerSessionShareRoutes(app);
// The share routes in-process; the same routes behind the share listener: session-shares.integration.test.ts.
const shareApp = createShareApp();
after(() => {
  stopSessionShareLive();
  rmSync(root, { recursive: true, force: true });
});

const op = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await app.request(path, { method: init.method ?? "GET", ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } } : {}) });
  return { status: r.status, body: (await r.json()) as never };
};
const tokenOf = (link: string) => link.split("/s/")[1]!;
const view = async (token: string) => {
  const r = await shareApp.request(`/api/s/${token}`);
  return { status: r.status, body: (await r.json()) as SessionShareView & { code?: string; why?: string }, robots: r.headers.get("x-robots-tag") };
};

// ---- review findings (M1 B3, B4, B5): each test fails on the code before the fix -----------------

async function mint(mode: "snapshot" | "live", labels = ["Ana"]) {
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as SessionShareView & { cut: string };
  const r = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Review", mode, ...(mode === "snapshot" ? { cut: pv.cut } : {}), expiresInDays: 30, recipients: labels, anyone: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body as SessionShareMinted;
  return { share: m.share, tokens: m.links.map((l) => tokenOf(l.link)), preview: pv };
}

test("B5 a snapshot is the previewed one: an image appended after the preview is never published", async () => {
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as SessionShareView & { cut: string };
  const seen = pv.images;
  append("user", "UNSEEN-AFTER-PREVIEW", true);
  const r = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Review", mode: "snapshot", cut: pv.cut, expiresInDays: 30, recipients: ["Ana"], anyone: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await view(tokenOf((r.body as SessionShareMinted).links[0]!.link));
  assert.equal(v.body.images, seen, "no image the preview didn't show");
  assert.ok(!JSON.stringify(v.body).includes("UNSEEN-AFTER-PREVIEW"));
  // Paging and images of that preview stay on its cut.
  assert.ok(pv.cut, "the preview names its cut");
  const again = (await op(`/api/session-shares/preview?session=${SID}&cut=${pv.cut}`)).body as SessionShareView;
  assert.equal(again.images, seen);
  const none = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Review", mode: "snapshot", expiresInDays: 30, recipients: ["Ana"], anyone: false } });
  assert.equal(none.status, 400, "a snapshot needs the preview's cut");
  const stale = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Review", mode: "snapshot", cut: "no-such-entry", expiresInDays: 30, recipients: ["Ana"], anyone: false } });
  assert.deepEqual([stale.status, (stale.body as { code: string }).code], [409, "stale-preview"]);
});

test("B3 a view read in flight when its link is revoked answers the dead link, not the view", async () => {
  const { share, tokens } = await mint("live");
  // The build itself revokes the link before it answers, so the revoke always lands mid-read
  // (a timed revoke raced the build on a fast host).
  const { whileGranted } = await import("./share/session-routes");
  let built = false;
  const got = await whileGranted(tokens[0]!, async () => {
    store.revokeRecipient(share.id, share.recipients[0]!.id);
    built = true;
    return "the view";
  });
  assert.ok(built, "the build ran: the link opened when the read started");
  assert.deepEqual(got.ok ? got : got.access.status, 410, "revoked while the view was built: nothing is sent");
  assert.equal((await view(tokens[0]!)).status, 410, "and the route answers the dead link");
});

// ---- re-review R2: the recipient limits hold on every write path -------------------------------

const newShare = (labels: string[], anyone: boolean) =>
  store.createShare({ sessionId: SID, sessionPath: FILE, title: "Limits", mode: "live", cut: null, days: 30, labels, anyone });
/** Expire these recipients' links now (as time would). */
function expire(shareId: string, recipientIds: string[]): void {
  const doc = JSON.parse(readFileSync(sharesFile(), "utf8"));
  for (const l of doc.links) if (l.shareId === shareId && recipientIds.includes(l.recipientId) && !l.revokedAt) l.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(sharesFile(), JSON.stringify(doc), { mode: 0o600 });
}
const liveOf = (shareId: string) => store.getShare(shareId)!.links.filter((l) => store.linkState(l, store.getShare(shareId)!.share) === "live");
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "threw";
  }
};

test("R2 expire → add Anyone → Extend: still one live Anyone link; the old one stays expired", () => {
  const { share, tokens } = newShare(["Ana"], true);
  const oldAnyone = tokens.find((t) => t.label === "Anyone with the link")!;
  expire(share.id, [oldAnyone.recipientId]);
  const fresh = store.addRecipient(share.id, { anyone: true });
  const r = store.extendShare(share.id, 30);
  const anyones = liveOf(share.id).filter((l) => l.anyone);
  assert.equal(anyones.length, 1, "one live Anyone");
  assert.equal(anyones[0]!.recipientId, fresh.recipientId);
  assert.equal(r.kept, 1);
  // Control: an expired named link with no conflict comes back.
  const ana = tokens.find((t) => t.label === "Ana")!;
  expire(share.id, [ana.recipientId]);
  assert.deepEqual(store.extendShare(share.id, 7), { renewed: 2, kept: 1 });
  assert.ok(liveOf(share.id).some((l) => l.recipientId === ana.recipientId));
});

test("R2 20 expire → add one → Extend: at most 20 live links", () => {
  const labels = Array.from({ length: 20 }, (_, i) => `P${i}`);
  const { share, tokens } = newShare(labels, false);
  expire(share.id, tokens.map((t) => t.recipientId));
  store.addRecipient(share.id, { label: "Zed" });
  const r = store.extendShare(share.id, 30);
  assert.equal(liveOf(share.id).length, 20);
  assert.equal(r.kept, 1);
});

test("R2 an expired name, the same name added again, then Extend: the name is live once", () => {
  const { share, tokens } = newShare(["Ana"], false);
  expire(share.id, [tokens[0]!.recipientId]);
  store.addRecipient(share.id, { label: "ana" });
  store.extendShare(share.id, 30);
  assert.equal(liveOf(share.id).filter((l) => l.label.toLowerCase() === "ana").length, 1);
});

test("R2 expire → add → relink: a relink that would break a limit is refused and writes nothing; within the limits it works", () => {
  const { share, tokens } = newShare(["Ana"], true);
  const oldAnyone = tokens.find((t) => t.label === "Anyone with the link")!;
  expire(share.id, [oldAnyone.recipientId]);
  const fresh = store.addRecipient(share.id, { anyone: true });
  const before = readFileSync(sharesFile(), "utf8");
  assert.equal(codeOf(() => store.relinkRecipient(share.id, oldAnyone.recipientId)), "anyone-exists");
  assert.equal(readFileSync(sharesFile(), "utf8"), before, "nothing written");
  assert.equal(codeOf(() => store.relinkRecipient(share.id, fresh.recipientId)), null, "control: relinking the live Anyone");
  assert.equal(liveOf(share.id).filter((l) => l.anyone).length, 1);
  // The 20 ceiling: 20 live, then an expired one relinked is refused; with room, it works.
  const labels = Array.from({ length: 20 }, (_, i) => `Q${i}`);
  const big = newShare(labels, false);
  expire(big.share.id, [big.tokens[0]!.recipientId]);
  const zed = store.addRecipient(big.share.id, { label: "Zed" });
  assert.equal(codeOf(() => store.relinkRecipient(big.share.id, big.tokens[0]!.recipientId)), "too-many");
  assert.equal(liveOf(big.share.id).length, 20);
  store.revokeRecipient(big.share.id, zed.recipientId);
  assert.equal(codeOf(() => store.relinkRecipient(big.share.id, big.tokens[0]!.recipientId)), null);
  assert.equal(liveOf(big.share.id).length, 20);
});

// ---- slices (§app.session-share/slice) ----------------------------------------------------------

const { sourceKey } = await import("./share/session-routes");
const texts = (v: SessionShareView) => v.items.map((i) => i.text);
const storedShare = (id: string) => (JSON.parse(readFileSync(sharesFile(), "utf8")) as { shares: Record<string, unknown>[] }).shares.find((x) => x.id === id)!;

test("slice: the start is part of the share's source; the store accepts `from` and still refuses an unknown key", () => {
  const rec = { id: "ss_aaaaaaaaaaaaaaaa", sessionId: SID, sessionPath: FILE, title: "T", mode: "snapshot" as const, cut: { entryId: "e1", at: null }, createdAt: new Date().toISOString() };
  assert.notEqual(sourceKey(rec), sourceKey({ ...rec, from: { entryId: "e2", at: null } }), "a push begun before a narrowing is dropped");
  assert.equal(sourceKey(rec), sourceKey({ ...rec }));
  const file = (share: Record<string, unknown>) => ({ version: 1, shares: [share], links: [] });
  assert.ok(!("why" in store.validateSharesFile(file({ ...rec, from: { entryId: "e2", at: null } }))));
  assert.deepEqual(store.validateSharesFile(file({ ...rec, from: { entryId: "", at: null } })), { why: "share 0: from" });
  assert.deepEqual(store.validateSharesFile(file({ ...rec, from: null })), { why: "share 0: from" });
  assert.deepEqual(store.validateSharesFile(file({ ...rec, to: "e3" })), { why: "share 0: keys" });
});

// ---- M1 review B1: an end is a snapshot's, never dropped -------------------------------------------

const storedBounds = (id: string) => {
  const x = storedShare(id);
  return { mode: x.mode, cut: (x.cut as { entryId: string } | null)?.entryId ?? null };
};

test("B1 Update to now on a live share refuses an end, valid or malformed, and changes nothing; with none it still answers", async () => {
  const { share, preview } = await mint("live");
  const update = (body?: unknown) =>
    app.request(`/api/session-shares/${share.id}/update`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  for (const body of [{ cut: preview.cut }, { cut: "bad cut!" }, { cut: null }]) {
    const r = await update(body);
    assert.deepEqual([r.status, ((await r.json()) as { code: string }).code], [400, "live-end"], JSON.stringify(body));
    assert.deepEqual(storedBounds(share.id), { mode: "live", cut: null });
  }
  assert.equal((await update()).status, 200, "no body: the live refresh keeps its meaning");
  assert.equal((await update({})).status, 200, "an empty body too");
  assert.deepEqual(storedBounds(share.id), { mode: "live", cut: null });
  // Control: a snapshot's Update to now with the previewed cut still moves its end.
  const snap = await mint("snapshot");
  append("assistant", "UPDATE-CONTROL");
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as SessionSharePreview;
  const moved = await op(`/api/session-shares/${snap.share.id}/update`, { method: "POST", body: { cut: pv.cut } });
  assert.deepEqual([moved.status, (moved.body as SessionShare).cut], [200, pv.cut]);
});

test("B1 a stored live share with an end is refused by the strict parse", () => {
  const rec = { id: "ss_bbbbbbbbbbbbbbbb", sessionId: SID, sessionPath: FILE, title: "T", mode: "live", cut: { entryId: "e1", at: null }, createdAt: new Date().toISOString() };
  assert.deepEqual(store.validateSharesFile({ version: 1, shares: [rec], links: [] }), { why: "share 0: live with a cut" });
});

test("B1 a new end validated while another write switched the share live is refused: nothing publishes past it", async () => {
  const { share, preview } = await mint("snapshot");
  // The other write lands after the PATCH's validation reads, right before its write (a timed
  // write raced the read on a fast host).
  const { patchHooks } = await import("./session-shares-routes");
  patchHooks.validated = () => void store.patchShare(share.id, { mode: "live" });
  const r = await op(`/api/session-shares/${share.id}`, { method: "PATCH", body: { cut: preview.cut } }).finally(() => delete patchHooks.validated);
  assert.deepEqual([r.status, (r.body as { code: string }).code], [409, "share-changed"]);
  assert.deepEqual(storedBounds(share.id), { mode: "live", cut: null }, "the other write stands; the end was not applied, nor acknowledged");
});

// ---- M1 review B2: a reset is owed until a pushed view carries it -----------------------------------

test("B2 a view read in flight when the start moves answers the narrowed view", async () => {
  const s1 = append("user", "FLIGHT-OLD");
  const s2 = append("assistant", "FLIGHT-NEW");
  const created = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Flight", mode: "live", from: s1, expiresInDays: 30, recipients: ["Hal"], anyone: false } });
  const m = created.body as SessionShareMinted;
  const token = tokenOf(m.links[0]!.link);
  // The build itself moves the start before it answers, so the move always lands mid-read (a timed
  // move raced the read of a large file on a fast host).
  const { whileGranted, sourceOf } = await import("./share/session-routes");
  const { sessionShareView } = await import("./session-share-view");
  let builds = 0;
  const got = await whileGranted(token, async (share) => {
    const built = await sessionShareView(sourceOf(share), {});
    if (builds++ === 0) store.patchShare(m.share.id, { from: { entryId: s2, at: null } });
    return built;
  });
  assert.equal(builds, 2, "the read begun before the move is built again");
  assert.ok(got.ok && got.value);
  assert.ok(!texts(got.value).includes("FLIGHT-OLD"), "nothing from before the new start");
  assert.equal(got.value.items[0]!.text, "FLIGHT-NEW");
  const r = await view(token);
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r.body), ["FLIGHT-NEW"], "and the route answers the narrowed view");
});
