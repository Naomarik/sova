// Initialize pressed in Settings → Merge Queue on a project with no merge setup: its Merge Queue tab
// opens straight on the setup (the onboarding), not on a second Initialize. One request, taken once.
import type { MergeQueueView } from "./merge-queue";

/** The queue doesn't serve this listed project: it has no merge setup (an invalid one is still a setup, said as such). Pure. */
export const notSetUp = (v: Pick<MergeQueueView, "served" | "checks" | "invalid">): boolean => !v.invalid && (v.served === false || v.checks === "unset");

let asked: string | null = null;

/** Settings' Initialize: the next Merge Queue tab of `projectId` to draw opens on the setup. */
export function requestInitialize(projectId: string): void {
  asked = projectId;
}

/** Whether `projectId`'s tab should open on the setup; true once per request. */
export function takeInitialize(projectId: string): boolean {
  if (asked !== projectId) return false;
  asked = null;
  return true;
}
