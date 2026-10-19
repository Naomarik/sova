import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { tourEditionFixture, tourManifestFixture, tourPngFixture, tourReferenceFixture, tourScriptFixture } from "./tour-fixtures";
import { isTourFile, isTourOrigin, isTourRoute, normalizeTourAttachment, normalizeTourCardDetails, normalizeTourDetachment, normalizeTourEdition, normalizeTourJob, normalizeTourManifest, normalizeTourPresentation, normalizeTourProgress, normalizeTourScript, projectTourPublic, TOUR_LIMITS, tourCardArgs, tourProgressFits, tourScriptProblem } from "./tour";

test("safe fixtures pass strict normalizers and assets authenticate their actual bytes", () => {
  assert.deepEqual(normalizeTourScript(tourScriptFixture()), tourScriptFixture());
  assert.deepEqual(normalizeTourManifest(tourManifestFixture()), tourManifestFixture());
  assert.deepEqual(normalizeTourManifest(tourReferenceFixture()), tourReferenceFixture());
  assert.deepEqual(normalizeTourEdition(tourEditionFixture()), tourEditionFixture());
  const bytes = tourPngFixture();
  assert.equal(bytes.length, tourManifestFixture().assets[0]!.bytes);
  for (const size of ["desktop", "phone"] as const) {
    const png = tourPngFixture(size);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(view.getUint32(16), tourManifestFixture().viewports[size].w);
    assert.equal(view.getUint32(20), tourManifestFixture().viewports[size].h);
    const asset = tourManifestFixture().assets.find(a => a.file === `${size}.png`)!;
    assert.equal(png.byteLength, asset.bytes);
    assert.equal(createHash("sha256").update(png).digest("hex"), asset.sha256);
  }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), tourManifestFixture().assets[0]!.sha256);
  const normalized = normalizeTourManifest(tourManifestFixture())!;
  normalized.steps[0]!.title = "Different";
  assert.notEqual(tourManifestFixture().steps[0]!.title, "Different", "normalization does not retain caller-owned objects");
});

test("script refuses executable, secret-bearing, unknown, duplicate and dangling fields at every level", () => {
  const mutations: ((s: any) => void)[] = [
    s => s.password = "secret", s => s.source.url = "http://other.test", s => s.source.origin = "https://user:pass@example.test",
    s => s.steps.push(s.steps[0]), s => s.chapters.push(s.chapters[0]), s => s.steps[0].chapter = "missing",
    s => s.steps[0].views.push(s.steps[0].views[0]), s => s.steps[0].views[0].route = "https://example.test/",
    s => s.steps[0].views[0].actions.desktop = [{ op: "eval", script: "alert(1)" }],
    s => s.steps[0].views[0].actions.desktop = [{ op: "open", target: { kind: "css", selector: "button" } }],
    s => s.steps[0].views[0].actions.desktop = [{ op: "press", key: "Enter" }],
    s => s.steps[0].views[0].actions.desktop = [{ op: "fill", target: { kind: "text", text: "x" }, value: "x", password: "x" }],
    s => s.steps[0].views[0].masks = [{ kind: "text", text: "private", css: "*" }],
    s => s.steps[0].views[0].marks[0].side = "auto", s => s.steps[0].views[0].sizes = ["desktop", "desktop"],
    s => s.steps[0].views[0].sizes = ["desktop"], s => s.steps[0].views[0].actions.watch = [],
    s => s.steps[0].views[0].comparison = { group: "x", phase: "maybe" }, s => s.sites = ["https://example.test", "https://example.test"],
    s => s.steps[0].views[0] = { id: "ref", title: "Reference", note: "", kind: "reference", reference: "Not recorded", captures: {} },
  ];
  for (const mutate of mutations) { const s = tourScriptFixture(); mutate(s); assert.equal(normalizeTourScript(s), undefined, mutate.toString()); }
  const s = tourScriptFixture(); const view = s.steps[0]!.views[0]!;
  assert.equal(view.kind, "page");
  if (view.kind === "page") { view.sizes = ["phone"]; view.unavailableReason = "This view is available on phone only."; }
  assert.ok(normalizeTourScript(s), "explicit availability is supported");
});

test("closed actions support only safe declarative shapes; byte/count limits require splitting", () => {
  const s = tourScriptFixture() as any;
  s.steps[0].views[0].actions.desktop = [
    { op: "open", target: { kind: "role", role: "button", name: "Details" } },
    { op: "fill", target: { kind: "role", role: "searchbox", name: "Search drafts" }, value: "Example" },
    { op: "scroll", x: 0, y: 300 }, { op: "wait", target: { kind: "text", text: "Saved" } },
  ];
  assert.ok(normalizeTourScript(s));
  s.steps[0].views[0].actions.desktop = Array(TOUR_LIMITS.actions + 1).fill({ op: "scroll", x: 0, y: 1 });
  assert.equal(normalizeTourScript(s), undefined);
  s.steps[0].views[0].actions.desktop = [];
  s.steps = Array.from({ length: TOUR_LIMITS.steps + 1 }, (_, i) => ({ ...s.steps[0], id: `step-${i}` }));
  assert.equal(normalizeTourScript(s), undefined);
});

test("URL and file predicates refuse authority changes, traversal and executable URLs", () => {
  for (const s of ["https://example.test", "http://127.0.0.1:4923", "http://[::1]:4923"]) assert.ok(isTourOrigin(s), s);
  for (const s of ["https://example.test/", "https://example.test/path", "https://u:p@example.test", "javascript:alert(1)", "file:///tmp/x", "https://example.test?x"]) assert.equal(isTourOrigin(s), false, s);
  assert.ok(isTourRoute("/drafts?filter=saved#current"));
  for (const s of ["//other.test", "/\\other.test", "/%2fother.test", "/a/../x", "/a/%2e%2e/x", "/a/%5cx", "/%00", "javascript:x"]) assert.equal(isTourRoute(s), false, s);
  for (const s of ["../x.png", "x/../x.png", "x.svg", "x.png?secret", "x.PNG", "manifest.json", "%2e.png"]) assert.equal(isTourFile(s), false, s);
});

test("manifest requires complete checked captures and exact bounded inventory", () => {
  const mutations: ((m: any) => void)[] = [
    m => m.source = { kind: "site", origin: "https://private.test" }, m => m.accountId = "test-login",
    m => m.editionId = "../other", m => m.scriptDigest = "bad", m => m.recordedAt = "yesterday",
    m => delete m.steps[0].views[0].captures.phone, m => m.steps[0].n = 3,
    m => m.steps[0].views[0].captures.desktop.marks[0].x = 1,
    m => m.steps[0].views[0].captures.desktop.marks[0].w = 0,
    m => m.steps[0].views[0].captures.desktop.marks[0].n = 2,
    m => m.steps[0].views[0].captures.desktop.image = "missing.png",
    m => m.assets.push(m.assets[0]), m => m.assets.push({ ...m.assets[0], file: "unused.png" }),
    m => m.assets[0].bytes = TOUR_LIMITS.assetBytes + 1, m => m.assets[0].sha256 = "x".repeat(64),
    m => m.steps[0].views[0].captures.desktop.storageState = {},
    m => m.check.status = "failed", m => m.check.dryRun = false, m => m.check.overviewReviewed = false,
    m => m.check.captureCount = 1, m => m.check.contactSheets = ["missing.png"],
    m => m.check.suspiciousCapturesReviewed = ["missing.png"],
    m => m.steps[0].views[0].kind = "reference",
  ];
  for (const mutate of mutations) { const m = tourManifestFixture(); mutate(m); assert.equal(normalizeTourManifest(m), undefined, mutate.toString()); }
  const one = tourManifestFixture(); delete one.steps[0]!.views[0]!.captures.phone; one.steps[0]!.views[0]!.unavailableReason = "Desktop only"; one.assets = one.assets.filter(a => a.file !== "phone.png"); one.check.captureCount = 1;
  assert.ok(normalizeTourManifest(one));
});

test("source identity is internal and project addresses cannot be substituted for registry identity", () => {
  const e = tourEditionFixture();
  e.source = { kind: "project", projectId: "p-demo", instanceId: "instance-demo", checkout: "/projects/demo", serviceId: "web", endpoint: "http" };
  e.provenance.generation = 2;
  assert.ok(normalizeTourEdition(e));
  assert.equal(normalizeTourEdition({ ...e, source: { ...e.source, origin: "http://127.0.0.1:4923" } }), undefined);
  assert.equal(normalizeTourEdition({ ...e, source: { ...e.source, checkout: "/projects/../other" } }), undefined);
  const p = projectTourPublic(e.manifest, { id: "public-demo", editionId: "public-edition" });
  assert.ok(normalizeTourPresentation(p));
  assert.ok(!p.assets.some(a => a.file === "contact-sheet.png"), "review sheets are not public assets");
  assert.equal(p.steps[0]!.views[0]!.route, null);
  const json = JSON.stringify(p);
  for (const secret of ["source", "provenance", "scriptDigest", "overviewReviewed", "session-demo", "tour-demo", "/drafts"]) assert.ok(!json.includes(secret), secret);
});

test("record-time public-origin attestations stay private, exact, unique and bounded", () => {
  const e = tourEditionFixture();
  assert.ok(normalizeTourEdition(e), "legacy editions may omit attestations");
  e.provenance.publicOrigins = ["https://example.test", "https://assets.example.test"];
  assert.deepEqual(normalizeTourEdition(e)?.provenance.publicOrigins, e.provenance.publicOrigins);
  for (const invalid of [["https://example.test/"], ["https://example.test/path"], ["https://user:secret@example.test"], ["https://example.test", "https://example.test"], Array.from({ length: 65 }, (_, i) => `https://site-${i}.example.test`), "https://example.test", [null]]) {
    assert.equal(normalizeTourEdition({ ...e, provenance: { ...e.provenance, publicOrigins: invalid } }), undefined);
  }
  const presentation = projectTourPublic(e.manifest, { id: "public-demo", editionId: "public-edition" });
  assert.ok(!JSON.stringify(presentation).includes("publicOrigins"));
  assert.equal(normalizeTourPresentation({ ...presentation, publicOrigins: e.provenance.publicOrigins }), undefined);
  assert.equal(normalizeTourScript({ ...tourScriptFixture(), publicOrigins: e.provenance.publicOrigins }), undefined, "authoring input cannot mint an attestation");
});

test("cards and eager arguments cannot carry scripts, reports, secrets or fake finished state", () => {
  const card = { v: 1, tourId: "tour-demo", title: "Drafts", steps: 1, status: "ready", editionId: "edition-demo", cover: "desktop.png" };
  assert.deepEqual(normalizeTourCardDetails(card), card);
  for (const extra of [{ script: tourScriptFixture() }, { accountId: "secret" }, { report: "x" }, { source: {} }]) assert.equal(normalizeTourCardDetails({ ...card, ...extra }), undefined);
  assert.equal(normalizeTourCardDetails({ ...card, editionId: undefined }), undefined);
  assert.equal(normalizeTourCardDetails({ ...card, status: "failed" }), undefined);
  assert.deepEqual(tourCardArgs({ op: "dry-run", script: tourScriptFixture(), tourId: "tour-demo", password: "secret" }), { op: "dry-run", tourId: "tour-demo" });
});

test("tour detachment names exactly one opaque binding and copies no extra authority", () => {
  const detachment = { v: 1, handle: "tr_abcdefghijklmnop" };
  const normalized = normalizeTourDetachment(detachment);
  assert.deepEqual(normalized, detachment);
  assert.notEqual(normalized, detachment, "normalization returns isolated data");
  for (const invalid of [null, [], "tr_abcdefghijklmnop", {}, { ...detachment, v: 2 }, { ...detachment, handle: "../invalid" }, { ...detachment, handle: "tr_abcdefghijklmno" }, { ...detachment, handle: "tr_abcdefghijklmnopq" }, { ...detachment, edition: "snapshot-demo" }, { ...detachment, files: [] }, { ...detachment, handle: undefined }]) {
    assert.equal(normalizeTourDetachment(invalid), undefined);
  }
});

test("durable job progress and reader position have strict identities", () => {
  const at = "2026-01-02T03:04:05.000Z";
  const j = { v: 1, id: "job-demo", tourId: "tour-demo", sessionId: "session-demo", title: "Drafts", phase: "queued", completed: 0, total: 2, queuePosition: 1, createdAt: at, updatedAt: at };
  assert.ok(normalizeTourJob(j));
  assert.equal(normalizeTourJob({ ...j, phase: "recording" }), undefined, "queue place is only for queued jobs");
  assert.equal(normalizeTourJob({ ...j, completed: 3 }), undefined);
  assert.equal(normalizeTourJob({ ...j, failure: { message: "No target", guidance: "Choose its unique name", nearest: Array(9).fill("Near") } }), undefined);
  const p = { v: 1, tourId: "tour-demo", editionId: "edition-demo", stepId: "find-draft", viewId: "overview", size: "phone", updatedAt: at } as const;
  assert.ok(normalizeTourProgress(p)); assert.ok(tourProgressFits(p, tourManifestFixture()));
  assert.equal(tourProgressFits({ ...p, editionId: "edition-new" }, tourManifestFixture()), false);
  assert.equal(tourProgressFits({ ...p, viewId: "missing" }, tourManifestFixture()), false);
  const attachment = { v: 1, handle: "tr_abcdefghijklmnop", title: "Drafts", summary: "A saved draft", steps: 1, edition: "snapshot-demo", files: ["desktop.png"] };
  assert.ok(normalizeTourAttachment(attachment));
  assert.equal(normalizeTourAttachment({ ...attachment, files: ["../secret.png"] }), undefined);
});

test("a page view may leave out masks: it means none, stored as []", () => {
  const script = tourScriptFixture();
  const page = script.steps[0]!.views.find(v => v.kind === "page")! as unknown as Record<string, unknown>;
  delete page.masks;
  assert.equal(tourScriptProblem(script), null);
  const stored = normalizeTourScript(script);
  assert.ok(stored, "accepted without masks");
  assert.deepEqual((stored!.steps[0]!.views.find(v => v.kind === "page") as { masks: unknown }).masks, []);
  assert.ok(script.steps[0]!.views.every(v => v.kind !== "page" || !("masks" in v) || Array.isArray(v.masks)), "the input itself is not changed");
});
