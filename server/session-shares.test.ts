// Run: pnpm exec tsx --test server/session-shares.test.ts. §app.session-share/link and /snapshot end
// to end: the operator's routes mint, relink, revoke, extend, update and stop, and slice (/slice); the share listener's
// /s/, /api/s/, image route and /ws/s answer each link's state; the store file's shape and mode. A
// throwaway PI_CODING_AGENT_DIR in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { WebSocket } from "ws";
import type { SessionShare, SessionShareMinted, SessionShareOutline, SessionSharePreview, SessionShareView } from "../shared/session-share";

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
const { createShareServer } = await import("./share/listener");
const store = await import("./session-shares");
const { sharesFile } = store;
const { pushShareView, stopSessionShareLive, sweepSessionViewers } = await import("./share/session-live");
const { onShareLinksChanged } = await import("./share/links-events");

const app = new Hono();
registerSessionShareRoutes(app);
const server = createShareServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  stopSessionShareLive();
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

const op = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await app.request(path, { method: init.method ?? "GET", ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } } : {}) });
  return { status: r.status, body: (await r.json()) as never };
};
const tokenOf = (link: string) => link.split("/s/")[1]!;
const view = async (token: string) => {
  const r = await fetch(`${base}/api/s/${token}`);
  return { status: r.status, body: (await r.json()) as SessionShareView & { code?: string; why?: string }, robots: r.headers.get("x-robots-tag") };
};

let share: SessionShare;
let ana = "";
let anyone = "";

test("mint: one link per recipient plus the anyone row; the store is 0600 and keeps hashes only", async () => {
  const bad = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "T", mode: "snapshot", expiresInDays: 14, recipients: ["Ana"], anyone: false } });
  assert.equal(bad.status, 400);
  assert.equal((await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "T", mode: "snapshot", expiresInDays: 30, recipients: [], anyone: false } })).status, 400, "no recipient");
  assert.equal((await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "T", mode: "snapshot", expiresInDays: 30, recipients: ["Ana", "ana"], anyone: false } })).status, 400, "a name twice");
  assert.equal((await op("/api/session-shares", { method: "POST", body: { sessionId: "nope", title: "T", mode: "snapshot", expiresInDays: 30, recipients: ["Ana"], anyone: false } })).status, 404);
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as { cut: string };
  const r = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Sharing sessions", mode: "snapshot", cut: pv.cut, expiresInDays: 30, recipients: ["Ana"], anyone: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body as SessionShareMinted;
  share = m.share;
  assert.equal(m.links.length, 2);
  assert.deepEqual(m.links.map((l) => l.label), ["Ana", "Anyone with the link"]);
  for (const l of m.links) assert.match(l.link, /\/s\/[A-Za-z0-9_-]{43}$/);
  ana = tokenOf(m.links[0]!.link);
  anyone = tokenOf(m.links[1]!.link);
  assert.equal(share.mode, "snapshot");
  assert.ok(share.cutAt);
  assert.equal(share.recipients.length, 2);
  assert.ok(share.recipients.every((x) => x.state === "live" && x.presence === "away" && x.opened === 0));
  const days = (Date.parse(share.recipients[0]!.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `${days}`);
  const raw = readFileSync(sharesFile(), "utf8");
  assert.equal(statSync(sharesFile()).mode & 0o777, 0o600);
  assert.ok(!raw.includes(ana) && !raw.includes(anyone), "no token on disk");
  const listed = (await op(`/api/session-shares?session=${SID}`)).body as SessionShare[];
  assert.deepEqual(listed.map((s) => s.id), [share.id]);
});

test("the share listener: shell, view, images; unknown 404; noindex", async () => {
  const shell = await fetch(`${base}/s/${ana}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("x-robots-tag") ?? "", /noindex/);
  const v = await view(ana);
  assert.equal(v.status, 200);
  assert.match(v.robots ?? "", /noindex/);
  assert.equal(v.body.title, "Sharing sessions");
  assert.deepEqual(v.body.items.map((i) => [i.kind, i.text]), [["user", "How do I share a session?"], ["reply", "Use the Share sheet."]]);
  assert.equal(v.body.images, 1);
  const img = await fetch(`${base}/api/s/${ana}/img/0`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/api/s/${ana}/img/1`)).status, 404);
  assert.equal((await view("x".repeat(43))).status, 404);
  assert.equal((await fetch(`${base}/api/s/${ana}/message`, { method: "POST", body: "{}" })).status, 404, "read-only");
});

test("a snapshot stays at its cut; Update to now moves it and pushes the open page", async () => {
  append("user", "And later?");
  append("assistant", "Later text.");
  assert.equal((await view(ana)).body.items.length, 2, "the snapshot is unchanged");
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/s?token=${ana}`);
  await new Promise((r) => ws.once("open", r));
  await new Promise((r) => setTimeout(r, 50));
  const listed = (await op(`/api/session-shares?session=${SID}`)).body as SessionShare[];
  assert.equal(listed[0]!.recipients.find((x) => x.label === "Ana")!.presence, "viewing");
  const pushed = new Promise<SessionShareView>((r) => ws.once("message", (d) => r(JSON.parse(String(d)).view)));
  const u = await op(`/api/session-shares/${share.id}/update`, { method: "POST" });
  assert.equal(u.status, 200);
  assert.equal((await pushed).items.length, 4);
  assert.equal((await view(anyone)).body.items.length, 4);
  // Revoke Ana: her page closes 4410 and her link answers the generic 410; the anyone row still opens.
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  const rid = share.recipients.find((x) => x.label === "Ana")!.id;
  const rv = await op(`/api/session-shares/${share.id}/recipients/${rid}/revoke`, { method: "POST" });
  assert.equal(rv.status, 200);
  assert.equal(await closed, 4410);
  const dead = await view(ana);
  assert.deepEqual([dead.status, dead.body.code, dead.body.why], [410, "gone", undefined]);
  assert.equal(JSON.stringify(dead.body).includes("Sharing"), false, "no title on a dead link");
  assert.equal((await view(anyone)).status, 200);
  assert.equal((await fetch(`${base}/api/s/${ana}/img/0`)).status, 410);
});

test("relink: a new token for the same recipient; the old one stops", async () => {
  const rid = share.recipients.find((x) => x.anyone)!.id;
  const r = await op(`/api/session-shares/${share.id}/recipients/${rid}/relink`, { method: "POST" });
  assert.equal(r.status, 200);
  const next = tokenOf((r.body as SessionShareMinted).links[0]!.link);
  assert.notEqual(next, anyone);
  assert.equal((await view(anyone)).status, 410);
  assert.equal((await view(next)).status, 200);
  anyone = next;
  const again = await op(`/api/session-shares/${share.id}/recipients`, { method: "POST", body: { anyone: true } });
  assert.equal(again.status, 409, "one live anyone row");
  const ben = await op(`/api/session-shares/${share.id}/recipients`, { method: "POST", body: { label: "Ben" } });
  assert.equal(ben.status, 201);
  assert.equal((await view(tokenOf((ben.body as SessionShareMinted).links[0]!.link))).status, 200);
});

test("Follow live: no cut; switching it off cuts at the current leaf", async () => {
  const on = await op(`/api/session-shares/${share.id}`, { method: "PATCH", body: { mode: "live" } });
  assert.equal(on.status, 200);
  assert.equal((on.body as SessionShare).cutAt, null);
  append("user", "Live one.");
  assert.equal((await view(anyone)).body.items.length, 5);
  const off = await op(`/api/session-shares/${share.id}`, { method: "PATCH", body: { mode: "snapshot" } });
  assert.equal((off.body as SessionShare).mode, "snapshot");
  append("assistant", "After the cut.");
  assert.equal((await view(anyone)).body.items.length, 5);
  assert.equal((await op(`/api/session-shares/${share.id}`, { method: "PATCH", body: { mode: "sometimes" } })).status, 400);
  assert.equal((await op(`/api/session-shares/${share.id}`, { method: "PATCH", body: { sessionPath: "/etc/passwd" } })).status, 400);
});

test("expiry: an expired link says so; Extend opens it again; the sweep closes an expired page", async () => {
  const store = JSON.parse(readFileSync(sharesFile(), "utf8"));
  for (const l of store.links) if (!l.revokedAt) l.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(sharesFile(), JSON.stringify(store), { mode: 0o600 });
  const gone = await view(anyone);
  assert.deepEqual([gone.status, gone.body.why], [410, "expired"]);
  assert.equal((await op(`/api/session-shares/${share.id}/extend`, { method: "POST", body: { days: 5 } })).status, 400);
  assert.equal((await op(`/api/session-shares/${share.id}/extend`, { method: "POST", body: { days: 7 } })).status, 200);
  assert.equal((await view(anyone)).status, 200);
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/s?token=${anyone}`);
  await new Promise((r) => ws.once("open", r));
  const s2 = JSON.parse(readFileSync(sharesFile(), "utf8"));
  for (const l of s2.links) if (!l.revokedAt) l.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(sharesFile(), JSON.stringify(s2), { mode: 0o600 });
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  assert.ok((await sweepSessionViewers()) >= 1);
  assert.equal(await closed, 4410);
  await op(`/api/session-shares/${share.id}/extend`, { method: "POST", body: { days: 30 } });
});

test("stop: every link answers 410 and the share reads stopped", async () => {
  const r = await op(`/api/session-shares/${share.id}/stop`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.ok((r.body as SessionShare).stoppedAt);
  assert.ok((r.body as SessionShare).recipients.every((x) => x.state === "off"));
  assert.equal((await view(anyone)).status, 410);
  assert.equal((await op(`/api/session-shares/${share.id}/recipients`, { method: "POST", body: { label: "Cy" } })).status, 409);
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/s?token=${anyone}`);
  const status = await new Promise<number>((r) => ws.once("unexpected-response", (_q, res) => r(res.statusCode ?? 0)));
  assert.equal(status, 410);
});

// ---- review findings (M1 B3, B4, B5): each test fails on the code before the fix -----------------

async function mint(mode: "snapshot" | "live", labels = ["Ana"]) {
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as SessionShareView & { cut: string };
  const r = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Review", mode, ...(mode === "snapshot" ? { cut: pv.cut } : {}), expiresInDays: 30, recipients: labels, anyone: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body as SessionShareMinted;
  return { share: m.share, tokens: m.links.map((l) => tokenOf(l.link)), preview: pv };
}
const openSocket = async (token: string) => {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/s?token=${token}`);
  const frames: string[] = [];
  ws.on("message", (d) => frames.push(String(d)));
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  await new Promise((r) => ws.once("open", r));
  await new Promise((r) => setTimeout(r, 30));
  return { ws, frames, closed };
};

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

test("B4 relink closes the old link's pages at once, even while the gateway's answer is held", async () => {
  const { share, tokens } = await mint("live");
  const old = await openSocket(tokens[0]!);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const off = onShareLinksChanged(() => held); // a gateway that hasn't answered yet
  try {
    const rid = share.recipients[0]!.id;
    const relink = op(`/api/session-shares/${share.id}/recipients/${rid}/relink`, { method: "POST" });
    const code = await Promise.race([old.closed, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]);
    assert.equal(code, 4410, "closed before the publication finished");
    release();
    assert.equal((await relink).status, 200);
  } finally {
    release();
    off();
  }
});

test("B4 a snapshot whose cut left the file: its socket is refused, and an open one closes on the sweep", async () => {
  const { tokens } = await mint("snapshot");
  const open = await openSocket(tokens[0]!);
  const text = readFileSync(FILE, "utf8");
  try {
    // The file is replaced by one without the cut (a rewrite, a migration).
    writeFileSync(FILE, text.split("\n")[0] + "\n");
    assert.equal((await view(tokens[0]!)).status, 410);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/s?token=${tokens[0]}`);
    const status = await new Promise<number>((r) => {
      ws.once("unexpected-response", (_q, res) => r(res.statusCode ?? 0));
      ws.once("open", () => r(101));
    });
    assert.equal(status, 410, "no socket for a share that doesn't read");
    await sweepSessionViewers();
    assert.equal(await Promise.race([open.closed, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]), 4410);
  } finally {
    writeFileSync(FILE, text);
  }
});

test("B3 a live build started before the share narrowed to a snapshot never reaches its pages", async () => {
  const { share, tokens } = await mint("live");
  const page = await openSocket(tokens[0]!);
  page.frames.length = 0;
  // An entry is written; a live build starts (it will read it) …
  const leaf = readFileSync(FILE, "utf8").trim().split("\n").at(-1)!;
  append("assistant", "POST-CUT-MARKER");
  const pending = pushShareView(share.id);
  // … and before it finishes, the share becomes a snapshot cut before that entry.
  store.patchShare(share.id, { mode: "snapshot", cut: { entryId: JSON.parse(leaf).id, at: null } });
  await pending;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!page.frames.some((f) => f.includes("POST-CUT-MARKER")), "the obsolete live view was not sent");
  assert.ok(!(await view(tokens[0]!)).body.items.some((i) => i.text.includes("POST-CUT-MARKER")));
  page.ws.close();
});

test("B3 two rebuilds finishing out of order: only the newest is sent", async () => {
  const { share, tokens } = await mint("live");
  const page = await openSocket(tokens[0]!);
  page.frames.length = 0;
  await Promise.all([pushShareView(share.id), pushShareView(share.id)]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(page.frames.length, 1, "one view, from the newest build");
  page.ws.close();
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
type Frame = { type: string; view?: SessionShareView; reset?: true };
const lastFrame = async (frames: string[]): Promise<Frame> => {
  for (let i = 0; i < 40 && !frames.length; i++) await new Promise((r) => setTimeout(r, 25));
  return JSON.parse(frames.at(-1)!) as Frame;
};
const texts = (v: SessionShareView) => v.items.map((i) => i.text);
const sl: Record<string, string> = {};
const storedShare = (id: string) => (JSON.parse(readFileSync(sharesFile(), "utf8")) as { shares: Record<string, unknown>[] }).shares.find((x) => x.id === id)!;
const storedFrom = (id: string) => storedShare(id).from as { entryId: string } | undefined;

test("slice: the outline names every shown message; preview and create take a start on the previewed branch", async () => {
  sl.s1 = append("user", "SLICE-ONE");
  sl.s2 = append("assistant", "SLICE-TWO", true);
  sl.s3 = append("user", "SLICE-THREE");
  const outline = (await op(`/api/session-shares/preview?session=${SID}&outline=1`)).body as SessionShareOutline;
  assert.equal(outline.cut, sl.s3);
  assert.deepEqual(outline.items.slice(-3).map((i) => [i.id, i.kind, i.excerpt, i.images]), [
    [sl.s1, "user", "SLICE-ONE", 0],
    [sl.s2, "reply", "SLICE-TWO", 1],
    [sl.s3, "user", "SLICE-THREE", 0],
  ]);
  const pv = (await op(`/api/session-shares/preview?session=${SID}&cut=${outline.cut}&from=${sl.s2}`)).body as SessionSharePreview;
  assert.deepEqual([texts(pv), pv.earlier, pv.from, pv.images], [["SLICE-TWO", "SLICE-THREE"], true, sl.s2, 1]);
  assert.equal((await op(`/api/session-shares/preview?session=${SID}&cut=${sl.s1}&from=${sl.s2}`)).status, 409, "a start after the cut");
  assert.equal((await op(`/api/session-shares/preview?session=${SID}&from=a%20b`)).status, 400);

  const body = { sessionId: SID, title: "A slice", mode: "snapshot", cut: outline.cut, expiresInDays: 30, recipients: ["Cy"], anyone: false };
  const off = await op("/api/session-shares", { method: "POST", body: { ...body, from: "not-on-it" } });
  assert.deepEqual([off.status, (off.body as { code: string }).code], [409, "stale-preview"]);
  assert.equal((await op("/api/session-shares", { method: "POST", body: { ...body, cut: sl.s1, from: sl.s2 } })).status, 409, "a start after the end");
  assert.equal((await op("/api/session-shares", { method: "POST", body: { ...body, from: 7 } })).status, 400);
  const r = await op("/api/session-shares", { method: "POST", body: { ...body, from: sl.s2 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body as SessionShareMinted;
  assert.equal(m.share.from, sl.s2);
  assert.equal(m.share.cut, sl.s3);
  const span = m.share.span!;
  assert.ok(span.first > 1 && span.last === span.first + 1 && span.total === span.last, JSON.stringify(span));
  assert.equal(storedFrom(m.share.id)?.entryId, sl.s2, "the store keeps the start");
  const v = await view(tokenOf(m.links[0]!.link));
  assert.deepEqual([texts(v.body), v.body.earlier, v.body.images], [["SLICE-TWO", "SLICE-THREE"], true, 1]);
  const listed = ((await op(`/api/session-shares?session=${SID}`)).body as SessionShare[]).find((x) => x.id === m.share.id)!;
  assert.deepEqual(listed.span, span);
  const whole = ((await op(`/api/session-shares?session=${SID}`)).body as SessionShare[]).find((x) => !x.from)!;
  assert.equal(whole.span, undefined, "a whole-session share has no span");
  sl.share = m.share.id;
  sl.token = tokenOf(m.links[0]!.link);
});

test("slice: PATCH moves the start (open pages get a reset view) or the end; a start after the end is refused", async () => {
  const held = (await view(sl.token!)).body.lineage;
  const page = await openSocket(sl.token!);
  page.frames.length = 0;
  let r = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { from: sl.s3 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let f = await lastFrame(page.frames);
  // The first push knows no earlier one; the lineage alone tells the page to replace its view.
  assert.deepEqual(texts(f.view!), ["SLICE-THREE"]);
  assert.notEqual(f.view!.lineage, held);
  page.frames.length = 0;
  r = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { title: "Renamed" } });
  f = await lastFrame(page.frames);
  assert.equal(f.reset, undefined, "a title change merges as before");
  page.frames.length = 0;
  r = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { from: null } });
  assert.equal((r.body as SessionShare).from, undefined);
  assert.equal((r.body as SessionShare).span, undefined);
  f = await lastFrame(page.frames);
  assert.equal(f.reset, true);
  assert.equal(f.view!.earlier, undefined);
  assert.ok(!("from" in storedShare(sl.share!)), "from null leaves the store");
  r = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { from: sl.s2, cut: sl.s2 } });
  assert.equal(r.status, 200, "Save Slice: one message");
  assert.deepEqual(texts((await view(sl.token!)).body), ["SLICE-TWO"]);
  const bad = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { from: sl.s3 } });
  assert.deepEqual([bad.status, (bad.body as { code: string }).code], [409, "stale-preview"], "a start after the end");
  assert.deepEqual(texts((await view(sl.token!)).body), ["SLICE-TWO"], "nothing changed");
  page.ws.close();
});

test("slice: Follow live may have a start; Update to now keeps the start; a rewind above it refuses the update and kills the live link", async () => {
  const live = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Live slice", mode: "live", from: sl.s2, expiresInDays: 30, recipients: ["Di"], anyone: false } });
  assert.equal(live.status, 201, JSON.stringify(live.body));
  assert.equal((live.body as SessionShareMinted).share.span!.last, null);
  assert.equal((await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "L", mode: "live", from: "nope", expiresInDays: 30, recipients: ["Di"], anyone: false } })).status, 409);
  const liveToken = tokenOf((live.body as SessionShareMinted).links[0]!.link);
  sl.s4 = append("assistant", "SLICE-FOUR");
  assert.deepEqual(texts((await view(liveToken)).body), ["SLICE-TWO", "SLICE-THREE", "SLICE-FOUR"]);
  // The snapshot slice (from s2, cut s2): Update to now moves the end and keeps the start.
  const u = await op(`/api/session-shares/${sl.share}/update`, { method: "POST" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual([(u.body as SessionShare).from, (u.body as SessionShare).cut], [sl.s2, sl.s4]);
  assert.deepEqual(texts((await view(sl.token!)).body), ["SLICE-TWO", "SLICE-THREE", "SLICE-FOUR"]);
  // A rewind above the start: a new leaf on s1.
  parent = sl.s1!;
  append("assistant", "REWOUND");
  const refused = await op(`/api/session-shares/${sl.share}/update`, { method: "POST" });
  assert.deepEqual([refused.status, (refused.body as { error: string }).error], [409, "The start of this share is no longer in the session."]);
  assert.equal(((await op(`/api/session-shares?session=${SID}`)).body as SessionShare[]).find((x) => x.id === sl.share)!.cut, sl.s4, "nothing changed");
  assert.equal((await view(liveToken)).status, 410, "the live slice's start left the branch");
  const toLive = await op(`/api/session-shares/${sl.share}`, { method: "PATCH", body: { mode: "live" } });
  assert.equal(toLive.status, 409, "Follow live on a slice whose start left the current branch");
});

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

test("B1 Follow live with an end is refused, on create and on PATCH, and nothing changes", async () => {
  const before = store.listShares().shares.length;
  const pv = (await op(`/api/session-shares/preview?session=${SID}`)).body as SessionSharePreview;
  const create = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "L", mode: "live", from: sl.s1, cut: pv.cut, expiresInDays: 30, recipients: ["Ed"], anyone: false } });
  assert.deepEqual([create.status, (create.body as { code: string }).code], [400, "live-end"]);
  assert.equal(store.listShares().shares.length, before, "nothing minted");
  assert.throws(() => store.createShare({ sessionId: SID, sessionPath: FILE, title: "L", mode: "live", cut: { entryId: pv.cut, at: null }, days: 30, labels: ["Ed"], anyone: false }), /no end/);

  const { share } = await mint("live");
  for (const body of [{ cut: pv.cut }, { cut: "bad cut!" }, { mode: "live", cut: pv.cut }]) {
    const r = await op(`/api/session-shares/${share.id}`, { method: "PATCH", body });
    assert.deepEqual([r.status, (r.body as { code: string }).code], [400, "live-end"], JSON.stringify(body));
    assert.deepEqual(storedBounds(share.id), { mode: "live", cut: null });
  }
  const snap = await mint("snapshot");
  const r = await op(`/api/session-shares/${snap.share.id}`, { method: "PATCH", body: { mode: "live", cut: pv.cut } });
  assert.equal(r.status, 400, "a switch to live that names an end");
  assert.equal(storedBounds(snap.share.id).mode, "snapshot");
  assert.throws(() => store.patchShare(share.id, { cut: { entryId: pv.cut, at: null } }), /no end/, "the store refuses it too");
});

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

test("B2 a long slice: a moved start's reset survives a build that overtakes it; an append merges; a stale page read shows another lineage", async () => {
  sl.long0 = append("user", "LONG-0");
  for (let i = 1; i < 260; i++) append(i % 2 ? "assistant" : "user", `LONG-${i}`);
  const created = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Long", mode: "live", from: sl.long0, expiresInDays: 30, recipients: ["Flo"], anyone: false } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const m = created.body as SessionShareMinted;
  const token = tokenOf(m.links[0]!.link);
  const first = (await view(token)).body;
  assert.equal(first.items.length, 200);
  assert.ok(first.lineage && first.before, "a lineage, and an earlier page");
  const earlierPage = (await (await fetch(`${base}/api/s/${token}?before=${first.before}`)).json()) as SessionShareView;
  assert.equal(earlierPage.lineage, first.lineage, "pages of one view share its lineage");
  const page = await openSocket(token);

  // Control: an append extends the slice, so it merges (no reset, same lineage).
  page.frames.length = 0;
  append("assistant", "LONG-APPENDED");
  await pushShareView(m.share.id);
  let f = await lastFrame(page.frames);
  assert.deepEqual([f.reset, f.view!.lineage], [undefined, first.lineage]);

  // The start moves on; its push is overtaken by a same-source rebuild (a title change, a watch).
  page.frames.length = 0;
  const newStart = append("user", "LONG-NEW-START");
  append("assistant", "LONG-AFTER-NEW-START");
  store.patchShare(m.share.id, { from: { entryId: newStart, at: null } });
  await Promise.all([pushShareView(m.share.id), pushShareView(m.share.id)]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(page.frames.length, 1, "one view, from the newest build");
  f = JSON.parse(page.frames[0]!) as Frame;
  assert.equal(f.reset, true, "the reset was carried by the build that was sent");
  assert.notEqual(f.view!.lineage, first.lineage);
  assert.deepEqual(texts(f.view!), ["LONG-NEW-START", "LONG-AFTER-NEW-START"]);
  // A page read begun before the move and answered after it: its lineage tells the page to drop it.
  const late = (await (await fetch(`${base}/api/s/${token}?before=1`)).json()) as SessionShareView;
  assert.notEqual(late.lineage, first.lineage);
  page.ws.close();
});

test("B2 an end on another branch or moved back resets; Update to now along the same path merges", async () => {
  const a = append("user", "BRANCH-A");
  const b = append("assistant", "BRANCH-B");
  const created = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Ends", mode: "snapshot", cut: b, expiresInDays: 30, recipients: ["Gus"], anyone: false } });
  const m = created.body as SessionShareMinted;
  const token = tokenOf(m.links[0]!.link);
  const lineages = [(await view(token)).body.lineage];
  const page = await openSocket(token);
  const step = async (act: () => Promise<{ status: number }>) => {
    page.frames.length = 0;
    assert.equal((await act()).status, 200);
    const f = await lastFrame(page.frames);
    lineages.push(f.view!.lineage);
    return f;
  };
  const update = () => op(`/api/session-shares/${m.share.id}/update`, { method: "POST" });
  // Update to now along the same path: an extension, so it merges.
  append("user", "BRANCH-C");
  let f = await step(update);
  assert.deepEqual([f.reset, lineages[1]], [undefined, lineages[0]]);
  // A rewind above the end (to A), then Update to now: another branch.
  parent = a;
  append("assistant", "BRANCH-D");
  f = await step(update);
  assert.deepEqual([f.reset, texts(f.view!).slice(-2)], [true, ["BRANCH-A", "BRANCH-D"]]);
  assert.notEqual(lineages[2], lineages[1]);
  // Save Slice with an earlier end: a page may still hold the longer view, so it resets.
  f = await step(() => op(`/api/session-shares/${m.share.id}`, { method: "PATCH", body: { cut: a } }));
  assert.equal(f.reset, true);
  assert.equal(new Set(lineages).size, 3);
  page.ws.close();
});

test("B2 a view read in flight when the start moves answers the narrowed view", async () => {
  const s1 = append("user", "FLIGHT-OLD");
  const s2 = append("assistant", "FLIGHT-NEW");
  const created = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Flight", mode: "live", from: s1, expiresInDays: 30, recipients: ["Hal"], anyone: false } });
  const m = created.body as SessionShareMinted;
  append("user", "flight ".repeat(4 * 1024 * 1024));
  const reading = view(tokenOf(m.links[0]!.link));
  await new Promise((r) => setTimeout(r, 5));
  store.patchShare(m.share.id, { from: { entryId: s2, at: null } });
  const r = await reading;
  assert.equal(r.status, 200);
  assert.ok(!texts(r.body).includes("FLIGHT-OLD"), "nothing from before the new start");
  assert.equal(r.body.items[0]!.text, "FLIGHT-NEW");
});

test("a live slice whose start left the branch: its open page closes on the sweep", async () => {
  const s1 = append("user", "SWEEP-ONE");
  const s2 = append("assistant", "SWEEP-TWO");
  const created = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "Sweep", mode: "live", from: s2, expiresInDays: 30, recipients: ["Ivy"], anyone: false } });
  const page = await openSocket(tokenOf((created.body as SessionShareMinted).links[0]!.link));
  parent = s1;
  append("assistant", "SWEEP-REWOUND");
  await sweepSessionViewers();
  assert.equal(await Promise.race([page.closed, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]), 4410);
});

test("a broken store serves nothing and is never overwritten", async () => {
  writeFileSync(sharesFile(), '{"version":1,"shares":[],"links":[],"extra":1}', { mode: 0o600 });
  assert.equal((await view(anyone)).status, 404);
  const r = await op("/api/session-shares", { method: "POST", body: { sessionId: SID, title: "T", mode: "snapshot", cut: "e1", expiresInDays: 30, recipients: ["Ana"], anyone: false } });
  assert.equal(r.status, 503);
  assert.equal(readFileSync(sharesFile(), "utf8"), '{"version":1,"shares":[],"links":[],"extra":1}');
});
