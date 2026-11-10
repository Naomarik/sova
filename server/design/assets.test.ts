// A chat's images: the names, what may be kept, what a page may show. Each refusal is tried against a state where it
// could have passed. No browser here: the drawn versions are stand-in bytes of the right type.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "design-assets-"));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));

const { DESIGN_ASSET_LIMITS } = await import("../../shared/design-assets");
const { assetNamesIn, assetNamesProblem, assetPath, keepAsset, readAssets, showAssets, changeAssets } = await import("./assets");
const { mountDesignAssetRoutes } = await import("./asset-routes");
const { keepCapture, captureDesignPage } = await import("./capture");
const { removeDesignFiles } = await import("./store");
const { addOwnImages } = await import("./own-images");

const PNG = (seed: number, size = 64) => { const b = Buffer.alloc(size, seed); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); return new Uint8Array(b); };
const WEBP = (seed: number, size = 64) => { const b = Buffer.alloc(size, seed); b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); return new Uint8Array(b); };
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));

let chats = 0;
const chat = () => `assets-${++chats}`;
const image = (seed: number, over: object = {}) => ({ source: "page" as const, original: PNG(seed), full: { bytes: WEBP(seed), w: 1600, h: 900 }, small: { bytes: WEBP(seed + 1), w: 560, h: 315 }, describe: { bytes: PNG(seed + 2), w: 1024, h: 576 }, width: 2000, height: 1125, context: {}, ...over });
const named = (r: ReturnType<typeof keepAsset>) => ("asset" in r ? r.asset.name : `refused: ${r.refused}`);

test("names count up, the same bytes keep their name and what was said about them", () => {
  const sid = chat();
  assert.equal(named(keepAsset(sid, image(1))), "a1");
  assert.equal(named(keepAsset(sid, image(2))), "a2");
  changeAssets(sid, (c) => void (c.assets[0]!.description = { kind: "hero", description: "d", placement: "p", usage: "u", at: "t" }));
  const again = keepAsset(sid, image(1));
  assert.ok("asset" in again && !again.isNew);
  assert.equal(again.asset.name, "a1");
  assert.equal(again.asset.description?.kind, "hero");
  assert.equal(readAssets(sid).assets.length, 2);
});

test("a name is never given twice, even once an image has gone", () => {
  const sid = chat();
  keepAsset(sid, image(1));
  changeAssets(sid, (c) => void c.assets.splice(0));
  assert.equal(named(keepAsset(sid, image(5))), "a2");
});

test("what can't be kept is refused with its reason, on what the bytes are", () => {
  const sid = chat();
  assert.match(named(keepAsset(sid, image(1, { original: new Uint8Array(Buffer.from("<html>not an image at all</html>")) }))), /isn't an image/);
  assert.match(named(keepAsset(sid, image(1, { original: PNG(1, DESIGN_ASSET_LIMITS.eachBytes + 1) }))), /8 MB/);
  // A drawn version that isn't a raster would be served as a picture: an SVG can't pass as one.
  assert.match(named(keepAsset(sid, image(1, { full: { bytes: SVG, w: 1, h: 1 } }))), /couldn't be drawn/);
  assert.equal(readAssets(sid).assets.length, 0);
});

test("a chat stops at its 200 MB, the image that doesn't fit is refused and earlier ones stay", () => {
  const sid = chat();
  const big = DESIGN_ASSET_LIMITS.eachBytes;
  let kept = 0;
  for (let i = 0; i < 40; i++) if ("asset" in keepAsset(sid, image(i, { original: PNG(i, big) }))) kept++;
  assert.ok(kept >= 20 && kept <= 25, `${kept} kept`);
  assert.match(named(keepAsset(sid, image(99, { original: PNG(99, big) }))), /200 MB/);
  assert.equal(readAssets(sid).assets.length, kept);
});

test("deleting the chat removes its images, and a late write doesn't bring them back", () => {
  const sid = chat();
  const r = keepAsset(sid, image(1));
  assert.ok("asset" in r);
  const file = assetPath(sid, r.asset, "original");
  assert.ok(existsSync(file));
  removeDesignFiles(sid);
  assert.equal(existsSync(file), false);
  assert.match(named(keepAsset(sid, image(2))), /deleted/);
  assert.equal(existsSync(file), false);
});

test("an asset's path can't leave its folder", () => {
  for (const a of [{ sha256: "../../etc/passwd", ext: "png" }, { sha256: "a".repeat(64), ext: "../x" }]) assert.throws(() => assetPath("s", a, "original"));
});

test("a page's names are read whole: a longer name or a half-written one isn't a shorter name", () => {
  assert.deepEqual(assetNamesIn(`<img src="sova-asset:a1"><img src="sova-asset:a12"><div style="background:url(sova-asset:a3)">sova-asset:a0 sova-asset:a2x sova-asset:a4-b`), ["a1", "a12", "a3"]);
});

test("a page naming an image the chat doesn't have is refused, naming the ones it may use", () => {
  const sid = chat();
  keepAsset(sid, image(1));
  assert.equal(assetNamesProblem(sid, `<img src="sova-asset:a1">`), null);
  const p = assetNamesProblem(sid, `<img src="sova-asset:a1"><img src="sova-asset:a9">`);
  assert.match(p!, /sova-asset:a9/);
  assert.match(p!, /a1/);
  assert.equal(assetNamesProblem(sid, "<p>no names</p>"), null);
});

test("showing a page puts in drawn pictures only, in the size asked for", () => {
  const sid = chat();
  keepAsset(sid, image(1));
  const page = `<img src="sova-asset:a1">`;
  const data = (shown: "small" | "full") => /src="data:([^;]+);base64,([^"]+)"/.exec(showAssets(sid, page, shown))!;
  const full = data("full"), small = data("small");
  assert.equal(full[1], "image/webp");
  assert.deepEqual(new Uint8Array(Buffer.from(full[2]!, "base64")), WEBP(1));
  assert.deepEqual(new Uint8Array(Buffer.from(small[2]!, "base64")), WEBP(2));
});

test("an image whose original is an SVG is shown only as the raster drawn from it", () => {
  const sid = chat();
  keepAsset(sid, image(1, { original: SVG }));
  const shown = showAssets(sid, `<img src="sova-asset:a1">`, "full");
  assert.match(shown, /data:image\/webp/);
  assert.doesNotMatch(shown, /svg/);
});

test("a page no one drew pictures for is untouched, and a name the chat lacks shows nothing rather than a broken image", () => {
  const sid = chat();
  const plain = "<p>hello</p>";
  assert.equal(showAssets(sid, plain, "full"), plain);
  assert.doesNotMatch(showAssets(sid, `<img src="sova-asset:a7">`, "full"), /sova-asset/);
});

test("one image named over and over can't swell a page past its limit", () => {
  const sid = chat();
  keepAsset(sid, image(1, { full: { bytes: WEBP(1, 1024 * 1024), w: 1600, h: 900 }, small: { bytes: WEBP(2, 256 * 1024), w: 560, h: 315 } }));
  const page = `<img src="sova-asset:a1">`.repeat(400);
  const shown = showAssets(sid, page, "full");
  assert.ok(shown.length <= 25 * 1024 * 1024 + 400 * 100, `${shown.length}`);
  assert.equal([...shown.matchAll(/sova-asset/g)].length, 0);
});

test("the capture's record keeps ranked order, repeats once, and lists what the chat can't keep", () => {
  const sid = chat();
  const item = (seed: number, sourceUrl?: string) => ({ original: PNG(seed), full: { bytes: WEBP(seed), w: 9, h: 9 }, small: { bytes: WEBP(seed + 1), w: 9, h: 9 }, describe: { bytes: PNG(seed + 2), w: 9, h: 9 }, width: 9, height: 9, context: sourceUrl ? { sourceUrl } : {} });
  const notes = { colors: [], fonts: [] };
  const { capture, added } = keepCapture(sid, "https://x.test/", "t", { url: "https://x.test/", items: [item(1), item(2), item(1), { ...item(3, "https://x.test/bad"), original: new Uint8Array(32) }], skipped: [{ what: "https://x.test/huge", reason: "too big" }], moreSkipped: 0, notes, ms: 5 }, false);
  assert.deepEqual(capture.names, ["a1", "a2"]);
  assert.deepEqual(added, ["a1", "a2"]);
  assert.deepEqual(capture.skipped.map((s) => s.what), ["https://x.test/huge", "https://x.test/bad"]);
  assert.equal(readAssets(sid).captures.length, 1);
  // The same screen again: nothing new, names unchanged.
  const twice = keepCapture(sid, "https://x.test/", "t2", { url: "https://x.test/", items: [item(2), item(1)], skipped: [], moreSkipped: 0, notes, ms: 5 }, false);
  assert.deepEqual(twice.capture.names, ["a2", "a1"]);
  assert.deepEqual(twice.added, []);
});

const stores = (over: object = {}) => ({ approvals: { isApproved: () => false }, accounts: { forOrigin: () => null }, signIns: { login: () => undefined, takeCode: () => undefined, forget: () => {}, storage: () => undefined, setStorage: () => {} }, named: () => true, ...over }) as never;
const parent = (sid: string) => ({ sessionId: sid, path: "/f" });

test("a signed-in capture waits for your say-so, the browser doesn't start, and asks only once", async () => {
  const sid = chat();
  let ran = 0;
  const run = (async () => { ran++; throw new Error("ran"); }) as never;
  const req = { url: "https://app.test/x", signIn: { route: "/in", username: { kind: "role", role: "textbox", name: "U" }, password: { kind: "role", role: "textbox", name: "P" }, submit: { kind: "role", role: "button", name: "Go" }, signedIn: { kind: "text", text: "Hi" } } };
  const out = await captureDesignPage(parent(sid), req, { stores: stores(), run });
  assert.deepEqual(out, { kind: "needs-signed-in-consent", origin: "https://app.test" });
  assert.equal(ran, 0);
  const { noteSignedInConsent } = await import("./assets");
  noteSignedInConsent(sid, "https://app.test");
  const after = await captureDesignPage(parent(sid), req, { stores: stores(), run, context: async () => ({ sessionId: sid, sessionFile: "/f", cwd: "/c", agentDir: "/a", sandbox: { on: false } }), registry: () => ({ instances: [] }) as never });
  assert.notEqual(after.kind, "needs-signed-in-consent");
});

test("a stored test account makes a page signed-in too, and consent is per exact origin", async () => {
  const sid = chat();
  const { noteSignedInConsent } = await import("./assets");
  noteSignedInConsent(sid, "https://other.test");
  const s = stores({ accounts: { forOrigin: () => ({ credentials: () => ({ origin: "https://app.test", username: "u", password: "p" }) }) } });
  assert.equal((await captureDesignPage(parent(sid), { url: "https://app.test/x" }, { stores: s, run: (async () => { throw new Error("ran"); }) as never })).kind, "needs-signed-in-consent");
});

test("a pasted image joins the same set, as yours, and one bad image costs only itself", async () => {
  const sid = chat();
  const draw = async (_c: unknown, images: readonly Uint8Array[]) => images.map((b) => ({ width: 800, height: 600, full: { bytes: WEBP(b[10]!), w: 800, h: 600 }, small: { bytes: WEBP(b[10]! + 1), w: 560, h: 420 }, describe: { bytes: PNG(b[10]! + 2), w: 800, h: 600 } }));
  const context = (async () => ({ sessionId: sid, sessionFile: "/f", cwd: "/c", agentDir: "/a", sandbox: { on: false } })) as never;
  const out = await addOwnImages(parent(sid), [PNG(7), new Uint8Array(Buffer.from("not a picture, only text padding")), PNG(9, DESIGN_ASSET_LIMITS.eachBytes + 1)], { draw: draw as never, context });
  assert.deepEqual(out.added.map((a) => [a.name, a.source]), [["a1", "yours"]]);
  assert.deepEqual(out.refused.map((r) => r.reason), ["It isn't an image.", "It's over the 8 MB limit."]);
});

test("the same picture from a page and from you is one asset under one name", async () => {
  const sid = chat();
  keepAsset(sid, image(7));
  const draw = async (_c: unknown, images: readonly Uint8Array[]) => images.map(() => ({ width: 8, height: 8, full: { bytes: WEBP(1), w: 8, h: 8 }, small: { bytes: WEBP(2), w: 8, h: 8 }, describe: { bytes: PNG(3), w: 8, h: 8 } }));
  const out = await addOwnImages(parent(sid), [PNG(7)], { draw: draw as never, context: (async () => ({})) as never });
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.known.map((a) => a.name), ["a1"]);
});

const routes = () => {
  const app = new Hono();
  const sid = chat();
  mountDesignAssetRoutes(app, (c) => (c.req.query("path") ? { sessionId: sid, path: "/f" } : null));
  return { app, sid };
};

test("a picture served is a drawn raster with nosniff; an original is only ever a download", async () => {
  const { app, sid } = routes();
  keepAsset(sid, image(1, { original: SVG }));
  const small = await app.request("/api/design/assets/a1/small?path=x");
  assert.equal(small.status, 200);
  assert.equal(small.headers.get("content-type"), "image/webp");
  assert.equal(small.headers.get("x-content-type-options"), "nosniff");
  const orig = await app.request("/api/design/assets/a1/original?path=x");
  assert.equal(orig.headers.get("content-type"), "application/octet-stream");
  assert.match(orig.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(orig.headers.get("x-content-type-options"), "nosniff");
  for (const bad of ["a1/describe", "a1/../x", "../a1/small", "b1/small", "a99/small"]) assert.notEqual((await app.request(`/api/design/assets/${bad}?path=x`)).status, 200, bad);
});

test("bringing images in and agreeing to a signed-in capture are the person's own click", async () => {
  const { app, sid } = routes();
  // A script, marked as such by its token header, is refused before anything is read.
  const headers = { "content-type": "application/json", "x-sova-token": "t" };
  for (const [url, body] of [["/api/design/assets/signed-in-consent?path=x", { origin: "https://app.test" }], ["/api/design/assets/own?path=x", { paths: ["/tmp/a.png"] }]] as const) {
    assert.equal((await app.request(url, { method: "POST", headers, body: JSON.stringify(body) })).status, 403, url);
  }
  assert.deepEqual(readAssets(sid).signedInConsent, []);
});
