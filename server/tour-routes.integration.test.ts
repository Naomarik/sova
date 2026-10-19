import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dns from "node:dns/promises";
import type { TourPresentation } from "../shared/tour";
import type { TourStore as Store } from "./tours/store";
import type { TourShares as Shares } from "./tours/shares";
import { createTourRouteFixture } from "./tours/route-fixture.integration.fixture";

const f = await createTourRouteFixture();
after(() => f.close());
const base = `/api/tours/${f.sid}/${f.sourceEdition.manifest.id}/editions/${f.sourceEdition.manifest.editionId}`;

test("actual main app/auth gate and actual share listener wire checked owner and standalone tour families", async t => {
  const { TourStore, publishEdition } = await import("./tours/store");
  const { TourShares } = await import("./tours/shares");
  const { tourEditionAssetsFixture } = await import("../shared/tour-fixtures");
  const { TourApprovalStore } = await import("./tours/approvals");
  const { markTourSessionDeleted } = await import("./tours/deleted");
  let snapshotReads = 0, editionReads = 0, assetReads = 0;
  const snapshot = TourShares.prototype.manifest, edition = TourStore.prototype.readEdition, asset = TourStore.prototype.readAsset;
  t.mock.method(TourShares.prototype, "manifest", function(this: Shares, row: Parameters<Shares["manifest"]>[0]) { snapshotReads++; return snapshot.call(this, row); });
  t.mock.method(TourStore.prototype, "readEdition", function(this: Store, s: string, id: string, e: string) { editionReads++; return edition.call(this, s, id, e); });
  t.mock.method(TourStore.prototype, "readAsset", function(this: Store, s: string, id: string, e: string, file: string) { assetReads++; return asset.call(this, s, id, e, file); });
  const counts = () => ({ snapshotReads, editionReads, assetReads });
  const reset = () => { snapshotReads = editionReads = assetReads = 0; };
  const post = (path: string, body?: unknown) => f.requestMain(path, { method: "POST", body });
  type Preview = { previewId: string; manifest: TourPresentation; expiresAt: string };
  type Link = { id: string; url: string; expiresAt: string; editionId: string };
  let link!: Link, token = "", reader = "";

  await t.test("all owner methods pass the actual install auth gate, exact session/edition scope and capture allowlist", async () => {
    for (const path of [base, `${base}/assets/desktop.png`, `${base}/progress`, `/api/tours/${f.sid}/jobs/missing`]) assert.equal((await f.requestMain(path, { auth: false })).status, 401, path);
    assert.equal((await f.requestMain(`${base}/shares`, { auth: false, method: "POST", body: "{bad" })).status, 401);
    assert.equal((await f.requestMain(base, { headers: { Origin: "https://foreign.invalid" } })).status, 403);
    assert.equal((await f.requestMain(base, { headers: { Cookie: "not-the-install-cookie=wrong" } })).status, 401);
    const owned = await f.requestMain(base); assert.equal(owned.status, 200); assert.equal(owned.headers["x-sova-server"], "sova");
    const m = owned.json<TourPresentation>(); assert.equal(m.editionId, f.sourceEdition.manifest.editionId); assert.equal(m.assets.length, 2); assert.ok(m.steps.every(s => s.views.every(v => v.route === null)));
    const picture = await f.requestMain(`${base}/assets/desktop.png`); assert.equal(picture.status, 200); assert.deepEqual(picture.bytes, Buffer.from(tourEditionAssetsFixture().get("desktop.png")!));
    for (const path of [`${base}/assets/contact-sheet.png`, `${base}/assets/guessed.png`, base.replace(f.sid, "other-chat"), base.replace("edition-demo", "other-edition")]) assert.equal((await f.requestMain(path)).status, 404, path);
    const position = { stepId: m.steps[0]!.id, viewId: m.steps[0]!.views[0]!.id, size: "phone" };
    assert.equal((await f.requestMain(`${base}/progress`, { method: "PUT", body: position })).status, 200); assert.equal((await f.requestMain(`${base}/progress`)).json<{ size: string }>().size, "phone");
    assert.equal((await f.requestMain(`${base}/progress`, { method: "PUT", body: { ...position, viewId: "guessed" } })).status, 400);
  });

  await t.test("owner Open reads only private record-time attestations and never performs DNS or fetch", async () => {
    const named = structuredClone(f.sourceEdition); named.manifest.id = "named-open"; named.source = { kind: "site", origin: "https://public.example.com" }; named.provenance.origin = named.source.origin; delete named.provenance.publicOrigins;
    publishEdition(named, tourEditionAssetsFixture());
    const attested = structuredClone(named); attested.manifest.editionId = "attested"; attested.provenance.publicOrigins = [named.source.origin]; publishEdition(attested, tourEditionAssetsFixture());
    new TourApprovalStore(join(f.stateRoot, "tour-approvals")).approve(named.source.origin);
    const oldLookup = dns.lookup, oldFetch = globalThis.fetch; let network = 0;
    dns.lookup = (() => { network++; throw new Error("A view attempted DNS."); }) as typeof dns.lookup;
    globalThis.fetch = (() => { network++; throw new Error("A view attempted HTTP."); }) as typeof fetch;
    try {
      const prefix = `/api/tours/${f.sid}/named-open/editions/`;
      const hidden = await f.requestMain(`${prefix}${named.manifest.editionId}/destinations`); assert.equal(hidden.status, 200); assert.deepEqual(hidden.json(), {});
      const allowed = await f.requestMain(`${prefix}attested/destinations`); assert.equal(allowed.status, 200);
      assert.equal(allowed.json<Record<string, Record<string, { phone: string }>>>()[named.manifest.steps[0]!.id]?.[named.manifest.steps[0]!.views[0]!.id]?.phone, "https://public.example.com/drafts");
      assert.equal(network, 0, "actual app HTTP view request invokes neither server DNS nor fetch");
    } finally { dns.lookup = oldLookup; globalThis.fetch = oldFetch; }
  });

  await t.test("unsupported gateways refuse before mint and do not consume the exact reviewed preview", async () => {
    const p = await post(`${base}/share-preview`); assert.equal(p.status, 200); const preview = p.json<Preview>();
    const { setGatewayDeps, refreshGateway, resetGatewayClient } = await import("./share/gateway-client");
    const file = join(f.stateRoot, "tour-shares.json"), before = existsSync(file) ? readFileSync(file, "utf8") : null;
    const undo = setGatewayDeps({ readSetting: () => ({ version: 1, route: { via: { nodeId: "fixture-gateway" } } }), peers: () => [{ id: "gateway", nodeId: "fixture-gateway", label: "Gateway", dnsName: "gateway.invalid" }], addressMode: () => false, endpoint: async () => "http://gateway.invalid:4801", call: async url => url.endsWith("/api/peer/hello") ? { status: 200, body: { mesh: 1, shareGateway: { publicUrl: "https://share.example.com" } } } : { status: 200, body: { publicUrl: "https://share.example.com", accepting: true, seq: null, kinds: ["h", "i", "s", "p"] } }, recordUrl: () => {} });
    resetGatewayClient();
    try {
      await refreshGateway(); const refused = await post(`${base}/shares`, { previewId: preview.previewId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(refused.status, 409); assert.equal(refused.json<{ code: string }>().code, "gateway-old"); assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before, "no authority was minted");
    } finally { undo(); resetGatewayClient(); }
    const minted = await post(`${base}/shares`, { previewId: preview.previewId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(minted.status, 201, minted.text); link = minted.json<Link>(); token = new URL(link.url, f.shareURL).pathname.split("/").pop()!;
    assert.equal((await post(`${base}/shares`, { previewId: preview.previewId, expiresAt: link.expiresAt })).status, 409, "review is one-use through the actual mounted route");
  });

  await t.test("actual public listener serves only pinned safe presentation and members, with isolated resume positions", async () => {
    const publicBase = `/api/t/${token}`;
    assert.equal((await f.requestShare(`/t/${token}`)).status, 200);
    const response = await f.requestShare(publicBase); assert.equal(response.status, 200); const m = response.json<TourPresentation>();
    assert.notEqual(m.id, f.sourceEdition.manifest.id); assert.notEqual(m.editionId, f.sourceEdition.manifest.editionId);
    for (const key of ["source", "provenance", "scriptDigest", "check", "sessionId"]) assert.equal(response.text.includes(`\"${key}\"`), false, key);
    assert.equal(response.text.includes(f.sid), false); assert.equal(response.text.includes(f.sourceEdition.provenance.origin), false); assert.ok(m.steps.every(s => s.views.every(v => v.route === null)));
    const image = await f.requestShare(`${publicBase}/assets/desktop.png`); assert.equal(image.status, 200); assert.deepEqual(image.bytes, Buffer.from(tourEditionAssetsFixture().get("desktop.png")!));
    for (const [name, value] of Object.entries({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" })) assert.equal(image.headers[name], value, name);
    reset(); for (const file of ["contact-sheet.png", "guessed.png", "other-edition.png"]) assert.equal((await f.requestShare(`${publicBase}/assets/${file}`)).status, 404);
    assert.deepEqual(counts(), { snapshotReads: 0, editionReads: 0, assetReads: 0 }, "actual invalid members do no tour snapshot or image I/O");
    assert.equal((await f.requestShare(`${base}/assets/desktop.png`)).status, 404, "operator route is absent on actual public edge");
    assert.equal((await f.requestMain(publicBase)).status, 404, "public API is not mounted on the operator listener");
    const first = await f.requestShare(`${publicBase}/readers`, { method: "POST" }), second = await f.requestShare(`${publicBase}/readers`, { method: "POST" }); assert.equal(first.status, 201); assert.equal(second.status, 201);
    reader = first.json<{ reader: string }>().reader; const other = second.json<{ reader: string }>().reader;
    const position = { stepId: m.steps[0]!.id, viewId: m.steps[0]!.views[0]!.id, size: "phone" };
    assert.equal((await f.requestShare(`${publicBase}/progress?reader=${reader}`, { method: "PUT", body: position })).status, 200);
    assert.equal((await f.requestShare(`${publicBase}/progress?reader=${reader}`)).json<{ size: string }>().size, "phone"); assert.equal((await f.requestShare(`${publicBase}/progress?reader=${other}`)).json(), null);
    assert.equal((await f.requestShare(`${publicBase}/progress?reader=${"z".repeat(43)}`)).status, 404);
    const next = structuredClone(f.sourceEdition); next.manifest.editionId = "next-edition"; next.manifest.title = "New checked edition"; publishEdition(next, tourEditionAssetsFixture());
    assert.equal((await f.requestShare(publicBase)).json<TourPresentation>().title, f.sourceEdition.manifest.title, "existing token never follows latest");
    assert.equal(existsSync(join(f.stateRoot, "visitor-identity.jsonl")), false, "default-off reads create no visitor identity file");
    assert.equal((await f.requestMain(`${base}/shares/${link.id}`, { method: "DELETE" })).status, 200);
    reset(); assert.equal((await f.requestShare(publicBase)).status, 404); assert.equal((await f.requestShare(`${publicBase}/assets/desktop.png`)).status, 404); assert.deepEqual(counts(), { snapshotReads: 0, editionReads: 0, assetReads: 0 });
  });

  await t.test("/t follows opt-in Log visitors: off writes nothing, on writes one identity line per visit and never joins resume progress", async () => {
    const { writeVisitorLogging } = await import("./visitor-logging");
    const { digest } = await import("./tours/assets");
    const identity = join(f.stateRoot, "visitor-identity.jsonl"), visits = join(f.stateRoot, "session-share-visits.jsonl");
    const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    const preview = (await post(`${base}/share-preview`)).json<Preview>();
    const made = await post(`${base}/shares`, { previewId: preview.previewId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }); assert.equal(made.status, 201, made.text);
    const visited = made.json<Link>(), bearer = new URL(visited.url, f.shareURL).pathname.split("/").pop()!;
    const ua = "Mozilla/5.0 (X11; Linux x86_64) FixtureBrowser/1.0", tab = "A".repeat(22), slack = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
    const open = () => f.requestShare(`/api/t/${bearer}?v=${tab}`, { headers: { "User-Agent": ua, "Accept-Language": "en-GB", "X-Forwarded-For": "203.0.113.9" } });
    const m = (await open()).json<TourPresentation>(), position = { stepId: m.steps[0]!.id, viewId: m.steps[0]!.views[0]!.id, size: "desktop" };
    const readerOf = async () => { const r = await f.requestShare(`/api/t/${bearer}/readers`, { method: "POST" }); assert.equal(r.status, 201); return r.json<{ reader: string }>().reader; };
    const resume = async (reader: string) => {
      assert.equal((await f.requestShare(`/api/t/${bearer}/progress?reader=${reader}`, { method: "PUT", body: position, headers: { "User-Agent": ua } })).status, 200);
      assert.equal((await f.requestShare(`/api/t/${bearer}/progress?reader=${reader}`, { headers: { "User-Agent": ua } })).status, 200);
    };
    writeVisitorLogging({ logVisitors: false, forwardIp: false });
    try {
      assert.equal((await open()).status, 200);
      assert.equal((await f.requestShare(`/t/${bearer}`, { headers: { "User-Agent": slack } })).status, 200);
      const offReader = await readerOf(); await resume(offReader);
      assert.deepEqual([lines(identity), lines(visits)], [[], []], "off: opening, previewing and resuming write no identity and no visit line");
      writeVisitorLogging({ logVisitors: true, forwardIp: false });
      assert.equal((await f.requestShare(`/api/t/${"z".repeat(43)}?v=${tab}`, { headers: { "User-Agent": ua } })).status, 404);
      assert.equal((await f.requestShare(`/t/${"z".repeat(43)}`, { headers: { "User-Agent": slack } })).status, 200);
      assert.deepEqual([lines(identity), lines(visits)], [[], []], "on: a guessed link writes nothing");
      assert.equal((await open()).status, 200); assert.equal((await open()).status, 200);
      const onReader = await readerOf(); await resume(onReader); await resume(offReader);
      const who = lines(identity); assert.equal(who.length, 1, "one identity line per visit (address and user agent), not per request");
      const line = JSON.parse(who[0]!) as { id: string; ip: string; ua: string; lang?: string };
      const opened = lines(visits).map(l => JSON.parse(l) as { kind: string; id: string; shareId?: string; recipientId?: string }).filter(l => l.kind === "visit");
      assert.equal(opened.length, 1, "progress reads and writes never record or continue a visit"); assert.equal(line.id, opened[0]!.id);
      assert.equal(opened[0]!.shareId, visited.id); assert.equal(opened[0]!.recipientId, "tour");
      assert.equal(line.ua, ua); assert.equal(line.lang, "en-GB"); assert.equal(line.ip, "203.0.113.9", "the address is the share edge's own client (the loopback front's last X-Forwarded-For hop), as for /s/");
      assert.equal(statSync(identity).mode & 0o777, 0o600);
      const kept = readFileSync(identity, "utf8") + readFileSync(visits, "utf8");
      for (const secret of [bearer, digest(bearer), onReader, offReader, f.sid, f.sourceEdition.manifest.id, f.sourceEdition.manifest.editionId, position.stepId]) assert.equal(kept.includes(secret), false, "no token, hash, resume reader, source id or tour content is kept");
      assert.equal((await f.requestShare(`/t/${bearer}`, { headers: { "User-Agent": slack } })).status, 200);
      assert.equal(lines(visits).map(l => JSON.parse(l) as { kind: string }).filter(l => l.kind === "preview").length, 1, "on: a link previewer's shell fetch is a preview line");
      assert.equal(lines(identity).length, 1, "a preview adds no identity line");
    } finally {
      writeVisitorLogging({ logVisitors: false, forwardIp: false });
      await f.requestMain(`${base}/shares/${visited.id}`, { method: "DELETE" });
    }
  });

  await t.test("a source deleted while a write body is still arriving answers the indistinguishable 404, never 400", async () => {
    const { request } = await import("node:http");
    const { digest } = await import("./tours/assets");
    const marker = join(f.stateRoot, "tour-deleted", `${digest(f.sid)}.json`);
    const url = new URL(f.mainURL);
    // The headers arrive first, so the owner gate has already admitted the request when the body (malformed) follows.
    const streamed = (path: string, method: string, during: () => void) => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(url.port), path, method, agent: false, headers: { Cookie: f.ownerCookie, Origin: f.mainURL, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "Content-Length": "4" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 500)); });
      req.on("error", reject); req.flushHeaders();
      setTimeout(() => { try { during(); } catch (error) { reject(error); } req.end("{bad"); }, 300);
    });
    for (const [path, method] of [[`${base}/progress`, "PUT"], [`${base}/shares`, "POST"]] as const) {
      assert.equal(await streamed(path, method, () => {}), 400, `positive control: a live owner's malformed ${method} is a 400`);
      try {
        assert.equal(await streamed(path, method, () => markTourSessionDeleted(f.stateRoot, f.sid)), 404, `${method} deleted during body admission`);
      } finally { unlinkSync(marker); }
    }
    // Deterministic variant: deletion lands inside the progress handler itself, after its edition read.
    let armed = true;
    t.mock.method(TourStore.prototype, "readEdition", function(this: Store, s: string, id: string, e: string) { const out = edition.call(this, s, id, e); if (armed && s === f.sid) { armed = false; markTourSessionDeleted(f.stateRoot, f.sid); } return out; });
    try { assert.equal((await f.requestMain(`${base}/progress`, { method: "PUT", body: "{bad" })).status, 404); assert.equal(armed, false, "the in-handler deletion actually ran"); }
    finally { unlinkSync(marker); t.mock.method(TourStore.prototype, "readEdition", function(this: Store, s: string, id: string, e: string) { editionReads++; return edition.call(this, s, id, e); }); }
  });

  await t.test("missing, identity-reused and durably deleted owners deny all source APIs despite leftover editions", async () => {
    const preview = (await post(`${base}/share-preview`)).json<Preview>();
    const made = await post(`${base}/shares`, { previewId: preview.previewId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }); assert.equal(made.status, 201); const bearer = new URL(made.json<Link>().url, f.shareURL).pathname.split("/").pop()!;
    const saved = readFileSync(f.sessionFile), lines = saved.toString("utf8").split("\n"), header = JSON.parse(lines[0]!); header.id = "other-chat"; lines[0] = JSON.stringify(header);
    const denied = async () => {
      reset();
      for (const [path, method, body] of [[base, "GET"], [`${base}/assets/desktop.png`, "GET"], [`${base}/progress`, "GET"], [`${base}/progress`, "PUT", "{bad"], [`${base}/destinations`, "GET"], [`${base}/share-preview`, "POST"], [`${base}/shares`, "POST", "{bad"], [`${base}/bindings`, "POST", "{bad"], [`/api/tours/${f.sid}/jobs/missing/account`, "POST", "{bad"]] as const) assert.equal((await f.requestMain(path, { method, body })).status, 404, path);
      for (const [path, method] of [[`/api/t/${bearer}`, "GET"], [`/api/t/${bearer}/assets/desktop.png`, "GET"], [`/api/t/${bearer}/readers`, "POST"], [`/api/t/${bearer}/progress?reader=${reader}`, "GET"]] as const) assert.equal((await f.requestShare(path, { method })).status, 404, path);
      assert.deepEqual(counts(), { snapshotReads: 0, editionReads: 0, assetReads: 0 }, "actual ownership denial precedes all tour I/O");
    };
    try { writeFileSync(f.sessionFile, lines.join("\n")); await denied(); } finally { writeFileSync(f.sessionFile, saved); }
    unlinkSync(f.sessionFile); await denied();
    writeFileSync(f.sessionFile, saved); markTourSessionDeleted(f.stateRoot, f.sid); await denied();
    assert.ok(existsSync(join(f.stateRoot, "tours", f.sid)), "physical editions really remain for this cleanup-failure scenario");
  });
});
