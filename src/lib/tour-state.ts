import type { TourJob, TourJobPhase, TourPresentation, TourProgress, TourSignInRequirement, TourSize } from "../../shared/tour";

export type TourPosition = Pick<TourProgress, "stepId" | "viewId" | "size">;
/** Stable identities survive viewport changes; a missing identity explicitly starts at step 1. */
export function tourPosition(manifest: TourPresentation, saved?: TourPosition): { step: number; view: number } {
  const step = saved ? manifest.steps.findIndex(s => s.id === saved.stepId) : -1;
  if (step < 0) return { step: 0, view: 0 };
  const view = manifest.steps[step]!.views.findIndex(v => v.id === saved!.viewId);
  return view < 0 ? { step: 0, view: 0 } : { step, view };
}
/** The player's one place: a step and one of that step's views. */
export type TourPlace = { step: number; view: number };
/** Every way a reader moves: Next/Back (and the arrow keys) by whole steps, the Steps list to a step, a chip to a view. */
export type TourMove = "next" | "back" | { step: number } | { view: number };
type TourShape = { steps: readonly { views: readonly unknown[] }[] };
const clampTo = (n: number, length: number) => Math.max(0, Math.min(length - 1, Number.isInteger(n) ? n : 0));
/** The nearest real place: never a step or a view that doesn't exist. */
export function tourPlace(manifest: TourShape, place: TourPlace): TourPlace {
  const step = clampTo(place.step, manifest.steps.length);
  return { step, view: clampTo(place.view, manifest.steps[step]?.views.length ?? 1) };
}
/** One move from one place to one valid place. A move to another step lands on its first view; a move
    that goes nowhere (Next on the last step, Back on the first, the step already shown) keeps the place. */
export function tourMove(manifest: TourShape, from: TourPlace, move: TourMove): TourPlace {
  const here = tourPlace(manifest, from);
  if (typeof move === "object" && "view" in move) return tourPlace(manifest, { step: here.step, view: move.view });
  const target = move === "next" ? here.step + 1 : move === "back" ? here.step - 1 : clampTo(move.step, manifest.steps.length);
  if (target < 0 || target >= manifest.steps.length || target === here.step) return here;
  return { step: target, view: 0 };
}
/** The footer at a place: Back only past the first step; beside Next, the next step's title, and Finish Tour only on the last step. */
export function tourFooter(manifest: Pick<TourPresentation, "steps">, place: TourPlace): { canBack: boolean; finish: boolean; nextLabel: string } {
  const { step } = tourPlace(manifest, place);
  const next = manifest.steps[step + 1];
  return { canBack: step > 0, finish: !next, nextLabel: next?.title ?? "You're at the last step" };
}
export function tourQuestion(manifest: TourPresentation, step: number, view: number): string {
  const s = manifest.steps[step]!, v = s.views[view]!;
  return `About “${manifest.title}”, step ${s.n}: “${s.title}” (${v.title})—can you explain this step and what I should do next?\nTour: ${manifest.id}; edition: ${manifest.editionId}; step: ${s.id}; view: ${v.id}.`;
}
export function tourCoverageQuestion(manifest: TourPresentation, step: number, view: number): string {
  const s = manifest.steps[step]!, v = s.views[view]!;
  return `I'd like more coverage around “${s.title}” (${v.title}) in “${manifest.title}”. A new recording can wait for someone with access to the source.\nTour: ${manifest.id}; edition: ${manifest.editionId}; step: ${s.id}; view: ${v.id}.`;
}
export function tourJobLabel(phase: TourJobPhase, size?: TourSize, queuePosition?: number, signIn?: TourSignInRequirement): string {
  switch (phase) {
    case "queued": return queuePosition ? `Waiting · ${queuePosition} in line` : "Waiting";
    case "needs-site-approval": return "Waiting for site approval";
    case "needs-test-account": return "Waiting for a test account";
    case "needs-sign-in": return signIn?.fields[0] === "code" ? "Waiting for a sign-in code" : "Waiting for you to sign in";
    case "dry-run": return "Rehearsing";
    case "recording": return size === "phone" ? "Recording phone" : size === "desktop" ? "Recording desktop" : "Recording";
    case "checking": return "Checking";
    case "ready": return "Ready";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Interrupted";
  }
}
export const tourJobActive = (phase: TourJobPhase) => !["ready", "failed", "cancelled", "interrupted"].includes(phase);
/** Re-record repeats a checked edition's source, so it is offered only when one exists; a first
    recording that ended without one is recorded again by asking the agent. Nothing while active. */
export function tourRecordAgain(phase: TourJobPhase, hasEdition: boolean): "button" | "ask" | null {
  if (tourJobActive(phase)) return null;
  return hasEdition ? "button" : "ask";
}
export const TOUR_ASK_TO_RECORD = "To record this tour again, ask the agent in this chat.";
export function tourJobLocation(job: TourJob): string {
  return [job.stepId && `Step ${job.stepId}`, job.viewId && `view ${job.viewId}`, job.size, job.total > 0 && `${job.completed} of ${job.total} completed`].filter(Boolean).join(" · ");
}
/** Review includes references and both sizes, never just the cover picture. */
export function tourPreviewItems(manifest: TourPresentation) {
  return manifest.steps.flatMap(step => step.views.flatMap(view => view.kind === "reference"
    ? [{ key: `${step.id}/${view.id}/reference`, step, view, size: undefined, capture: undefined }]
    : (["desktop", "phone"] as const).map(size => ({ key: `${step.id}/${view.id}/${size}`, step, view, size: size as TourSize | undefined, capture: view.captures[size] }))));
}

/** What the sign-in form holds. Only the fields the requirement names are ever sent. */
export interface TourSignInFields { account: string; username: string; password: string; code: string }
export const TOUR_SIGNIN_EMPTY: TourSignInFields = Object.freeze({ account: "", username: "", password: "", code: "" });
export type TourSignInBody = { origin: string; account?: string; username: string; password: string } | { origin: string; code: string };
/** A three-box sign-in (an account such as a site's pre-filled code box, then username and password). */
export const tourSignInWantsAccount = (requirement: TourSignInRequirement): boolean => (requirement.fields as readonly string[]).includes("account");
/** The exact body for the requirement, or null while it isn't complete (the submit button stays disabled). */
export function tourSignInPayload(requirement: TourSignInRequirement, fields: TourSignInFields): TourSignInBody | null {
  if (requirement.fields[0] === "code") return fields.code.trim() ? { origin: requirement.origin, code: fields.code.trim() } : null;
  const username = fields.username.trim(), account = fields.account.trim();
  if (!username || !fields.password) return null;
  if (!tourSignInWantsAccount(requirement)) return { origin: requirement.origin, username, password: fields.password };
  return account ? { origin: requirement.origin, account, username, password: fields.password } : null;
}
/** Submit: take the body, and every field empties at once, before the request is sent or fails. */
export function takeTourSignIn(requirement: TourSignInRequirement, fields: TourSignInFields): { body: TourSignInBody | null; fields: TourSignInFields } {
  return { body: tourSignInPayload(requirement, fields), fields: { ...TOUR_SIGNIN_EMPTY } };
}
/** Share and Send to a Hand-off show only once the server has said this edition wasn't recorded signed in. */
export const tourShareAllowed = (status: { loaded: boolean; signedIn: boolean }): boolean => status.loaded && !status.signedIn;
export const TOUR_SIGNED_IN_CAPTION = "Recorded signed in. This tour stays in this chat.";
export const TOUR_SIGNIN_PRIVACY = "What you type here stays in memory for this tour only, not in the chat or on disk. It's cleared when the recording ends, or after 1 hour.";

/** A reference view is words, not a picture: there is nothing for the Desktop/Phone switch to resize. */
export function tourShowsSizeSwitch(view: Pick<TourPresentation["steps"][number]["views"][number], "kind">): boolean {
  return view.kind !== "reference";
}
/** Reference text exactly as written, split into paragraphs on blank lines; never reordered or rewrapped. */
export function tourParagraphs(text: string | undefined): string[] {
  return (text ?? "").split(/\r?\n[ \t]*\r?\n/).map(p => p.replace(/^\r?\n+|\r?\n+$/g, "")).filter(p => p.trim() !== "");
}
export interface TourChapterRow { id: string; n: number; title: string; steps: number[]; label: string; firstStepId: string; firstViewId: string }
/** The card's "In this tour" list: each chapter with the step numbers it covers, in chapter order. */
export function tourChapterRows(manifest: Pick<TourPresentation, "chapters" | "steps">): TourChapterRow[] {
  return manifest.chapters.flatMap((c, i) => {
    const steps = manifest.steps.filter(s => s.chapter === c.id);
    const first = steps[0];
    if (!first) return [];
    const ns = steps.map(s => s.n);
    const contiguous = ns.every((n, k) => k === 0 || n === ns[k - 1]! + 1);
    const label = ns.length === 1 ? `Step ${ns[0]}` : contiguous ? `Steps ${ns[0]}–${ns[ns.length - 1]}` : `Steps ${ns.join(", ")}`;
    return [{ id: c.id, n: i + 1, title: c.title, steps: ns, label, firstStepId: first.id, firstViewId: first.views[0]?.id ?? "" }];
  });
}
