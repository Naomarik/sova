import { tourManifestFixture } from "../../shared/tour-fixtures";
import type { TourManifest, TourView } from "../../shared/tour";

/** A made-up tour whose steps hold 3, 2 and 1 views: step 1 has a pictured view, a written-only
    (reference) view and a desktop-only view; step 2 a pictured view and a phone-only view. The shape
    that froze the player: on step 2's second view, Next went to a step with only one view. */
export function tourNavFixture(): TourManifest {
  const m = tourManifestFixture();
  const base = m.steps[0]!.views[0]!;
  const page = (id: string, title: string): TourView => ({ ...structuredClone(base), id, title });
  const only = (id: string, title: string, keep: "desktop" | "phone"): TourView => {
    const v = page(id, title);
    delete v.captures[keep === "desktop" ? "phone" : "desktop"];
    v.unavailableReason = `Only recorded on ${keep}.`;
    return v;
  };
  const words: TourView = { id: "in-words", title: "In words", kind: "reference", note: "", reference: "Sending isn't recorded.\n\nIt submits the draft.", route: null, captures: {} };
  const step = m.steps[0]!;
  m.steps = [
    { ...step, n: 1, id: "s1", title: "First step", views: [page("s1-a", "Overview"), words, only("s1-c", "Desktop panel", "desktop")] },
    { ...step, n: 2, id: "s2", title: "Second step", views: [page("s2-a", "List"), only("s2-b", "Phone sheet", "phone")] },
    { ...step, n: 3, id: "s3", title: "Third step", views: [page("s3-a", "Done")] },
  ];
  return m;
}
