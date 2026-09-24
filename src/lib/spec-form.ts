import type { SpecSettings } from "../../shared/protocol";
import { sameChoice, type DraftChoice } from "./delegate-form";

/**
 * Settings → Modes → Spec's form rules: the spec writer, one worker row plus an optional fallback,
 * or none (the session writes the spec itself). The row itself is Delegate's (delegate-form.ts,
 * WorkerSlotRow), with its rule: nothing here ever picks a model the user didn't.
 */

export type SpecDraft = { version: 1; writer: { primary: DraftChoice; fallback: DraftChoice | null } | null };

export const cloneSpec = (s: SpecSettings | SpecDraft): SpecDraft => JSON.parse(JSON.stringify(s));

export function sameSpec(a: SpecSettings | SpecDraft, b: SpecSettings | SpecDraft): boolean {
  if (!a.writer || !b.writer) return !a.writer && !b.writer;
  return sameChoice(a.writer.primary, b.writer.primary) && sameChoice(a.writer.fallback, b.writer.fallback);
}

/** "A worker" starts with nothing chosen but the backend; "None" is null. */
export const writerFor = (on: boolean): SpecDraft["writer"] => (on ? { primary: { backend: "claude-code", model: "", effort: "" }, fallback: null } : null);

/** None, or every row has a model and an effort. What the Save button waits for. */
export function specDraftComplete(draft: SpecDraft): boolean {
  const w = draft.writer;
  return !w || (!!w.primary.model && !!w.primary.effort && (w.fallback === null || (!!w.fallback.model && !!w.fallback.effort)));
}

/** A fallback that is its own primary: the server refuses it whatever discovery says. */
export function specDraftConflict(draft: SpecDraft): boolean {
  const w = draft.writer;
  return !!w && w.fallback !== null && !!w.fallback.model && sameChoice(w.primary, w.fallback);
}
