/**
 * One review that blocked an entry, kept whole (§app.merge-queue/review-report), and where its card stands
 * (§chat.merge-queue/review-card). Pure: queue.ts keeps the records on the entry and feeds them events; the card, the
 * chat's request and the landed line read them, so they never disagree. A later review of the entry starts a record
 * of its own; events reach only the newest one, so an earlier review's card never changes.
 */
import { createHash } from "node:crypto";
import type { MergeEntry, MergeReviewRecord, ReviewCardState, ReviewFinding, ReviewVerdict } from "../../shared/merge-queue";

/** What happens to the entry, as the review's card reads it. */
export type ReviewEvent =
  /** The request carrying it (or a later note) went to the chat. */
  | { kind: "handed" }
  /** The chat's fix was checked, or the entry went back in line: the next run reviews it again. */
  | { kind: "checked" }
  /** A run of the entry started. */
  | { kind: "checking" }
  /** That run ended before a new review: a check failed, its drafts or a conflict sent it back. */
  | { kind: "stopped"; why: string }
  /** That run's review answered (blocking starts a new record; this one is then left as it was). */
  | { kind: "reviewed"; verdict: ReviewVerdict["verdict"] }
  /** A decision waits for the user. */
  | { kind: "waiting" }
  /** The user pressed Remove from Queue. */
  | { kind: "removed" }
  /** The entry landed. */
  | { kind: "landed" };

const FINAL: readonly ReviewCardState[] = ["passed", "removed"];

/**
 * The one state rule: a record's next state for an event (everything else on it unchanged). Final states (passed,
 * removed) take no event; a run that stops before its review leaves it Stopped, its findings as they were, until the
 * branch is next checked.
 */
export function nextReviewState(r: Pick<MergeReviewRecord, "state" | "stoppedFor">, ev: ReviewEvent): Pick<MergeReviewRecord, "state" | "stoppedFor"> {
  const at = (state: ReviewCardState, stoppedFor?: string) => ({ state, ...(stoppedFor ? { stoppedFor } : {}) });
  if (FINAL.includes(r.state)) return at(r.state, r.stoppedFor);
  switch (ev.kind) {
    case "removed":
      return at("removed");
    case "landed":
      return at("passed");
    case "waiting":
      return at("waiting");
    case "handed":
      // A Stopped card's own send-back (the check that failed) keeps it Stopped: it says what sent it back.
      return r.state === "stopped" ? at("stopped", r.stoppedFor) : r.state === "re-reviewing" ? at(r.state) : at("fixing");
    case "checked":
    case "checking":
      return at("re-reviewing");
    case "stopped":
      return r.state === "re-reviewing" ? at("stopped", ev.why) : at(r.state, r.stoppedFor);
    case "reviewed":
      return r.state === "re-reviewing" && ev.verdict !== "blocking" ? at("passed") : at(r.state, r.stoppedFor);
  }
}

/** The entry's newest review record with `ev` applied; false when there is none or nothing changed. */
export function applyReviewEvent(e: Pick<MergeEntry, "reviews">, ev: ReviewEvent, at: string): boolean {
  const r = e.reviews?.at(-1);
  if (!r) return false;
  const next = nextReviewState(r, ev);
  if (next.state === r.state && next.stoppedFor === r.stoppedFor) return false;
  r.state = next.state;
  if (next.stoppedFor) r.stoppedFor = next.stoppedFor;
  else delete r.stoppedFor;
  r.updatedAt = at;
  return true;
}

/** The newest review record while its card is still open (not passed, not removed). */
export function openReview(e: Pick<MergeEntry, "reviews">): MergeReviewRecord | undefined {
  const r = e.reviews?.at(-1);
  return r && !FINAL.includes(r.state) ? r : undefined;
}

/** A blocking verdict's record. Findings as merge.review parsed them; an older verdict with only text is read once. */
export function reviewRecord(o: { entry: string; run: string; commit: string; base: string; verdict: ReviewVerdict; at: string }): MergeReviewRecord {
  const parsed = o.verdict.findings ? { summary: o.verdict.summary ?? "", findings: o.verdict.findings } : fromText(o.verdict.text ?? "");
  return { id: `${o.entry}:${o.run}`, run: o.run, commit: o.commit, tip: o.verdict.commit, base: o.base, summary: parsed.summary, findings: structuredClone(parsed.findings), try: 0, of: 0, state: "with-thread", at: o.at, updatedAt: o.at };
}

/** A verdict that carries only its text (one recorded before findings were kept): its lines, as written. */
function fromText(text: string): { summary: string; findings: ReviewFinding[] } {
  const [summary = "", ...rest] = text.split("\n").filter((l) => l.trim());
  return { summary, findings: rest.map((l) => ({ kind: "other", text: l.replace(/^- /, "") })) };
}

/** One finding as the reviewer wrote it: `- [kind] file:line: text`. */
export function findingLine(f: ReviewFinding): string {
  return `- [${f.kind}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.text}`;
}

/** The report, whole, as the reviewer wrote it: its summary, then every finding. */
export function reportText(r: Pick<MergeReviewRecord, "summary" | "findings">): string {
  return [r.summary, ...r.findings.map(findingLine)].filter(Boolean).join("\n");
}

/** The same findings, whatever their order or wording's case and spacing: "the same failure twice" for a review. */
export function reviewPrint(findings: readonly ReviewFinding[]): string {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const lines = [...new Set(findings.map((f) => `${f.kind}|${f.file ?? ""}|${norm(f.text)}`))].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/** The merge thread's note after a request went: its own short request, counting no try. */
export function reviewNoteText(e: Pick<MergeEntry, "branch">, r: Pick<MergeReviewRecord, "commit">, note: string): string {
  return `The merge thread adds a note on the review of ${e.branch} at ${r.commit.slice(0, 7)}: ${note.trim()}`;
}

/** A notes-only review on the landed line: its findings whole, told quietly (§chat.merge-queue/chat-turns). */
export function reviewNotesLine(v: ReviewVerdict | undefined): string | null {
  if (!v || v.verdict !== "notes") return null;
  const body = v.findings ? reportText({ summary: v.summary ?? "", findings: v.findings }) : (v.text ?? "").trim();
  return body ? `Review notes: ${body}` : null;
}
