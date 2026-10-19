/** Made-up artifacts for contract consumers; never production seed data. */
import type { TourEdition, TourManifest, TourScript, TourSize } from "./tour";
const AT = "2026-01-02T03:04:05.000Z";
const PN = {
  desktop: { bytes: 756, sha256: "f6df7fb237796a09d5e71c5e28afa83d0c42d06e6f2a1819e46d102ccb593fd0", data: "iVBORw0KGgoAAAANSUhEUgAABaAAAAPAAQAAAADr/+MFAAACu0lEQVR42u3OAQ0AAAwCIPuX1hz/IAHpQZGW" + "lpaW".repeat(223) + "lv6THrPHhGH85W1gAAAAAElFTkSuQmCC" },
  phone: { bytes: 207, sha256: "132b7bc04d11dcee0bd5cad67f2e4aa37a75053d293f9461cf7e64a9a1de1f1a", data: "iVBORw0KGgoAAAANSUhEUgAAAYYAAANMAQAAAABwFzezAAAAlklEQVR42u3LoQEAAAwCIP9/Wm9YWINOehX" + "DMAz".repeat(40) + "DMJ7HAAQi89XO+TaCAAAAAElFTkSuQmCC" },
  sheet: { bytes: 67, sha256: "fa657a9138347d0291d41ef1b46f9b0742bcbfd37c5ddab50272ea858e7098a2", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR42mP4DwABAQEAHLCMmQAAAABJRU5ErkJggg==" },
};
/** White made-up PNGs with real viewport dimensions, never screenshots of user data. */
export function tourPngFixture(size: TourSize | "sheet" = "desktop"): Uint8Array { return Uint8Array.from(atob(PN[size].data), c => c.charCodeAt(0)); }
export function tourEditionAssetsFixture(): Map<string, Uint8Array> { return new Map([["desktop.png", tourPngFixture("desktop")], ["phone.png", tourPngFixture("phone")], ["contact-sheet.png", tourPngFixture("sheet")]]); }
export function tourScriptFixture(): TourScript {
  return { v: 1, title: "Find a saved draft", summary: "See where a draft waits before sending.", audience: "A new reviewer", outcome: "Know where to find a saved draft without sending it.", source: { kind: "site", origin: "https://example.test" }, chapters: [{ id: "drafts", title: "Drafts" }], steps: [{ id: "find-draft", chapter: "drafts", title: "Find the draft", summary: "The draft stays private until you choose to send it.", views: [{ id: "overview", title: "Overview", kind: "page", note: "Notice the saved label.", route: "/drafts", sizes: ["desktop", "phone"], actions: {}, marks: [{ target: { kind: "role", role: "heading", name: "Saved drafts" }, label: "Saved drafts appear here.", side: "right" }], masks: [] }] }] };
}
export function tourManifestFixture(): TourManifest {
  const script = tourScriptFixture();
  return { v: 2, id: "tour-demo", editionId: "edition-demo", title: script.title, summary: script.summary, scriptDigest: "a".repeat(64), recordedAt: AT, viewports: { desktop: { w: 1440, h: 960 }, phone: { w: 390, h: 844 } }, chapters: script.chapters, steps: [{ n: 1, id: "find-draft", chapter: "drafts", title: "Find the draft", summary: script.steps[0]!.summary, views: [{ id: "overview", title: "Overview", kind: "page", note: "Notice the saved label.", route: "/drafts", captures: { desktop: { image: "desktop.png", marks: [{ n: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1, side: "right", label: "Saved drafts appear here." }] }, phone: { image: "phone.png", marks: [] } } }] }], assets: ([{ file: "desktop.png", size: "desktop" }, { file: "phone.png", size: "phone" }, { file: "contact-sheet.png", size: "sheet" }] as const).map(({ file, size }) => ({ file, mime: "image/png", bytes: PN[size].bytes, sha256: PN[size].sha256 })), check: { status: "passed", checkedAt: AT, dryRun: true, captureCount: 2, contactSheets: ["contact-sheet.png"], overviewReviewed: true, suspiciousCapturesReviewed: [], notes: "Reviewed every overview cell; no suspicious captures." } };
}
export function tourReferenceFixture(): TourManifest {
  const m = tourManifestFixture();
  m.steps[0]!.views = [{ id: "overview", title: "Sending is not recorded", kind: "reference", note: "Reference text", reference: "Sending would submit the draft. This tour stops before that action.", route: null, captures: {} }];
  m.assets = []; m.check.captureCount = 0; m.check.contactSheets = [];
  return m;
}
export function tourEditionFixture(): TourEdition { return { v: 1, sessionId: "session-demo", source: { kind: "site", origin: "https://example.test" }, manifest: tourManifestFixture(), provenance: { origin: "https://example.test", recordedAt: AT } }; }
