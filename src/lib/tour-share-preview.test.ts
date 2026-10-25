import assert from "node:assert/strict";
import { test } from "node:test";
import { projectTourPublic, type TourPresentation } from "../../shared/tour";
import { tourManifestFixture } from "../../shared/tour-fixtures";
import { tourPreviewItems } from "./tour-state";
import { tourPreviewStrings, tourPreviewSummary, tourPreviewText, tourReaderStrings } from "./tour-share-preview";

function manifest(): TourPresentation {
  const m = projectTourPublic(tourManifestFixture(), { id: "tour-opaque", editionId: "edition-opaque" });
  m.chapters = [{ id: "drafts", title: "Drafts" }, { id: "billing", title: "Billing internals" }];
  const step = structuredClone(m.steps[0]!);
  step.n = 2; step.id = "billing-step"; step.chapter = "billing"; step.title = "Open the invoice list"; step.summary = "Invoices wait here before anyone sends them.";
  step.views = [
    { ...structuredClone(m.steps[0]!.views[0]!), id: "before", title: "Invoice list", note: "The total updates after saving.", comparison: { group: "totals", phase: "before" }, captures: { desktop: { image: "desktop.png", marks: [{ n: 1, x: 0.2, y: 0.2, w: 0.2, h: 0.1, side: "left", label: "Totals column" }] } }, unavailableReason: "The phone layout hides this table." },
    { id: "policy", title: "Refund policy", kind: "reference", note: "Read before approving refunds.", route: null, reference: "Refunds over the limit need a second approver.", captures: {} },
  ];
  m.steps.push(step);
  return m;
}

test("each review cell carries its chapter title, so a chapter is reviewed before Create Link or Send Tour enables", () => {
  const m = manifest(), items = tourPreviewItems(m);
  const billing = items.filter((i) => i.step.chapter === "billing").map((i) => tourPreviewText(m, i));
  assert.equal(billing.length, 3, "desktop picture, phone-unavailable cell and reference cell");
  assert.ok(billing.every((t) => t.chapter === "Billing internals"));
  const [picture, missing, reference] = billing;
  assert.equal(picture!.view, "Before: Invoice list · desktop", "the comparison label as the reader's view chip says it");
  assert.deepEqual(picture!.callouts, ["Totals column"]);
  assert.equal(missing!.reference, "The phone layout hides this table.");
  assert.equal(reference!.reference, "Refunds over the limit need a second approver."); assert.equal(reference!.note, "Read before approving refunds.");
});

test("the review shows every text a reader can be shown, and a missing one is caught", () => {
  const m = manifest(), shown = tourPreviewStrings(m).join("\n");
  for (const text of tourReaderStrings(m)) assert.ok(shown.includes(text), `the review shows "${text}"`);
  // Negative control: the same check fails for a review without chapter titles.
  const withoutChapters = tourPreviewItems(m).flatMap((i) => { const t = tourPreviewText(m, i); return [t.step, t.summary, t.view, t.note, ...t.callouts, t.reference ?? ""]; }).join("\n");
  assert.equal(tourReaderStrings(m).every((text) => withoutChapters.includes(text) || [m.title, m.summary].includes(text)), false);
});

test("the review's summary line says when the edition was recorded and its size, never the internal edition id", () => {
  const m = manifest(), now = Date.parse(m.recordedAt) + 3_600_000;
  const line = tourPreviewSummary(m, 3, now);
  assert.match(line, /^Recorded .+ · 2 steps · 3 pictures$/);
  assert.equal(line.includes(m.editionId), false); assert.equal(line.includes("Edition"), false);
  const one = { ...m, steps: m.steps.slice(0, 1) };
  assert.match(tourPreviewSummary(one, 1, now), /^Recorded .+ · 1 step · 1 picture$/);
  assert.equal(tourPreviewSummary(m, 0, now).endsWith("· 0 pictures"), true);
});
