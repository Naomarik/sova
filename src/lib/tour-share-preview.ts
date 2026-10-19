import type { TourPresentation } from "../../shared/tour";
import { absoluteTime } from "./spend";
import { tourPreviewItems } from "./tour-state";

/** One picture-or-reference cell of the share review (§app.tours/sharing). */
export type TourPreviewItem = ReturnType<typeof tourPreviewItems>[number];

/** Everything a reader sees beside one cell, exactly as the review dialog shows it. */
export interface TourPreviewText {
  chapter: string | null;
  step: string;
  summary: string;
  /** The view's label as the reader's view chips say it ("Before: …" for a comparison), and the size. */
  view: string;
  note: string;
  callouts: string[];
  /** A reference view's text, or why this size has no picture. */
  reference: string | null;
}

const viewLabel = (item: TourPreviewItem): string =>
  `${item.view.comparison ? `${item.view.comparison.phase === "before" ? "Before" : "After"}: ` : ""}${item.view.title}${item.size ? ` · ${item.size}` : ""}`;

export function tourPreviewText(manifest: TourPresentation, item: TourPreviewItem): TourPreviewText {
  return {
    chapter: manifest.chapters.find((c) => c.id === item.step.chapter)?.title ?? null,
    step: `${item.step.n}. ${item.step.title}`,
    summary: item.step.summary,
    view: viewLabel(item),
    note: item.view.note,
    callouts: item.capture?.marks.map((m) => m.label) ?? [],
    reference: item.capture ? null : ((item.view.kind === "reference" ? item.view.reference : item.view.unavailableReason) ?? null),
  };
}

/** Every text the review dialog shows: the tour's title and summary, its chapter list, and each cell's text. */
export function tourPreviewStrings(manifest: TourPresentation): string[] {
  const cells = tourPreviewItems(manifest).flatMap((item) => {
    const t = tourPreviewText(manifest, item);
    return [t.chapter ?? "", t.step, t.summary, t.view, t.note, ...t.callouts, t.reference ?? ""];
  });
  return [manifest.title, manifest.summary, ...manifest.chapters.map((c) => c.title), ...cells].filter(Boolean);
}

/** Every text a reader of this edition can be shown (the viewer's titles, chapters, notes, callouts
    and references): the review must include each one. */
export function tourReaderStrings(manifest: TourPresentation): string[] {
  return [
    manifest.title,
    manifest.summary,
    ...manifest.chapters.map((c) => c.title),
    ...manifest.steps.flatMap((s) => [
      s.title,
      s.summary,
      ...s.views.flatMap((v) => [v.title, v.note, v.reference ?? "", v.unavailableReason ?? "", ...Object.values(v.captures).flatMap((c) => c?.marks.map((m) => m.label) ?? [])]),
    ]),
  ].filter(Boolean);
}

/** The review's line above the pictures: when the edition was recorded and its size, never its internal id. */
export function tourPreviewSummary(manifest: TourPresentation, pictures: number, now = Date.now()): string {
  const steps = manifest.steps.length;
  return `Recorded ${absoluteTime(manifest.recordedAt, now)} · ${steps} ${steps === 1 ? "step" : "steps"} · ${pictures} ${pictures === 1 ? "picture" : "pictures"}`;
}
