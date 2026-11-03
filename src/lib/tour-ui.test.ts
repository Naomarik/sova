// Run: node scripts/run-tests.mjs src/lib/tour-ui.test.ts. The tour viewer's written-out ("reference")
// step and the tour card's "In this tour" list, rendered (SSR) and through the helpers they draw from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tourManifestFixture, tourReferenceFixture } from "../../shared/tour-fixtures";
import type { TourPresentation } from "../../shared/tour";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const state: Record<string, any> = await import("./tour-state");
const { TourViewer } = await importSsr(new URL("../components/TourViewer.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const card = await importSsr(new URL("../components/TourReadCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const draw = (component: unknown, props: unknown): string => renderToString(() => solid.createComponent(component as never, props as never));
const viewer = (manifest: TourPresentation) => draw(TourViewer, { manifest, assetUrl: (f: string) => `/a/${f}`, onClose() {} });

test("viewer: a reference view shows no Desktop/Phone switch and says it is explained in words", () => {
  const html = viewer(tourReferenceFixture());
  assert.ok(!html.includes("tour-size-picker"), "no size switch on a reference view");
  assert.ok(html.includes("Explained in words · not pictured"));
  assert.ok(!html.includes("not a recording"));
});

test("viewer: a page view keeps the Desktop/Phone switch, also when it lacks one size", () => {
  assert.ok(viewer(tourManifestFixture()).includes("tour-size-picker"));
  const m = tourManifestFixture(); const v = m.steps[0]!.views[0]!; delete v.captures.desktop; v.unavailableReason = "Desktop has no such panel.";
  const html = viewer(m);
  assert.ok(html.includes("tour-size-picker"));
  assert.ok(html.includes("Desktop view unavailable"));
});

test("viewer: reference text becomes one paragraph per blank-line-separated part, as written", () => {
  const m = tourReferenceFixture();
  m.steps[0]!.views[0]!.reference = "First part, as written.\nSame paragraph.\n\nSecond part.\n\n\nThird part.";
  const html = viewer(m);
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(x => x[1]!.replace(/<!--[^>]*-->/g, ""));
  const ref = html.slice(html.indexOf("tour-reference-text"));
  assert.equal([...ref.slice(0, ref.indexOf("</div>")).matchAll(/<p/g)].length, 3);
  assert.ok(paras.includes("First part, as written.\nSame paragraph."));
  assert.ok(paras.includes("Second part.") && paras.includes("Third part."));
  assert.deepEqual(state.tourParagraphs("A\n\nB\n \nC"), ["A", "B", "C"]);
  assert.deepEqual(state.tourParagraphs("only one"), ["only one"]);
});

test("viewer: reopened at any saved place, it draws that step and view, with Finish Tour only on the last step", async () => {
  const { tourNavFixture } = await import("./tour-nav-fixture");
  const m = tourNavFixture();
  const text = (html: string) => html.replace(/<!--[^>]*-->/g, "");
  m.steps.forEach((s, step) => s.views.forEach((v, view) => {
    const html = text(draw(TourViewer, { manifest: m, assetUrl: (f: string) => `/a/${f}`, onClose() {}, initialProgress: { stepId: s.id, viewId: v.id, size: "desktop" } }));
    const where = `step ${step + 1} view ${view + 1}`;
    assert.ok(html.includes(`Step ${step + 1} of 3`), where);
    assert.ok(html.includes(`${view + 1}/${s.views.length} views`), where);
    assert.equal([...html.matchAll(/class="button tour-view-chip" aria-pressed="true"/g)].length, 1, where);
    const last = step === m.steps.length - 1;
    assert.ok(html.includes(last ? "Finish Tour" : m.steps[step + 1]!.title), where);
    assert.equal(html.includes("Finish Tour"), last, where);
    if (v.kind === "reference") assert.ok(html.includes("Explained in words · not pictured"), where);
    else if (!v.captures.desktop) assert.ok(html.includes("Desktop view unavailable"), where);
  }));
});

const chaptered = (): TourPresentation => {
  const m: TourPresentation = tourManifestFixture();
  const base = m.steps[0]!;
  const chapters = ["Start", "Drafts", "Review", "Share", "Archive", "Settings"];
  m.chapters = chapters.map((title, i) => ({ id: `c${i + 1}`, title }));
  const owners = ["c1", "c1", "c2", "c3", "c4", "c5", "c6", "c6", "c6"];
  m.steps = owners.map((chapter, i) => ({ ...structuredClone(base), n: i + 1, id: `s${i + 1}`, chapter, title: `Step ${i + 1}` }));
  return m;
};

test("card: chapter rows say which steps each covers and open its first step", () => {
  const rows = state.tourChapterRows(chaptered());
  assert.deepEqual(rows.map((r: any) => [r.n, r.title, r.label, r.firstStepId]), [
    [1, "Start", "Steps 1–2", "s1"], [2, "Drafts", "Step 3", "s3"], [3, "Review", "Step 4", "s4"],
    [4, "Share", "Step 5", "s5"], [5, "Archive", "Step 6", "s6"], [6, "Settings", "Steps 7–9", "s7"],
  ]);
  // The card opens the viewer with the row's first step as its starting place (initialProgress).
  const m = chaptered();
  assert.deepEqual(rows.map((r: any) => state.tourPosition(m, { stepId: r.firstStepId, viewId: r.firstViewId, size: "desktop" }).step), [0, 2, 3, 4, 5, 6]);
  const opened: string[] = [];
  const html = draw(card.TourChapterList, { manifest: chaptered(), onOpen: (row: any) => opened.push(row.firstStepId) });
  assert.ok(html.includes("In this tour"));
  assert.match(html, /<ol[^>]*class="tour-chapter-list[^"]*"/);
  assert.equal([...html.matchAll(/<li[^>]*><button type="button" class="tour-chapter-row"/g)].length, 6, "each line is a list item holding a button");
  assert.ok(html.includes("Steps 7–9"));
});

test("card: more than 4 chapters fold behind Show all N; more than 5 go two columns when wide", () => {
  const html = draw(card.TourChapterList, { manifest: chaptered(), onOpen() {} });
  assert.equal([...html.matchAll(/tour-chapter-folded/g)].length, 2);
  assert.ok(html.includes("Show all <!--$-->6<!--/-->") || html.includes("Show all 6"));
  assert.ok(html.includes("tour-chapter-list-wide"));
  const few = chaptered(); few.chapters = few.chapters.slice(0, 4); few.steps = few.steps.filter(s => ["c1", "c2", "c3", "c4"].includes(s.chapter));
  const small = draw(card.TourChapterList, { manifest: few, onOpen() {} });
  assert.ok(!small.includes("Show all") && !small.includes("tour-chapter-folded") && !small.includes("tour-chapter-list-wide"));
});
