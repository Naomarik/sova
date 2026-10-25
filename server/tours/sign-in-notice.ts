// A tour recording waiting for a sign-in tells its chat (§app.tours/sites): the chat is marked as
// needing you (an act item of the attention digest, server/attention.ts) and its agent gets one short
// tagged notice (shared/wake.ts parses it as a wake, never a user prompt) pointing the user at the
// tour card. Harness-neutral: the notice goes through Sova's own promptSession, which refuses a chat it
// can't write to (open in a terminal, a hand-off, an overseer); then only the mark shows, and the
// notice is not sent later. Neither ever carries a secret: only the tour, its job, the site and what is
// needed. The notice is never queued behind a running turn, where it would arrive after the wait may
// have ended: it waits until the chat is idle, and goes only if that job still waits for that sign-in.
import { isTourId, isTourOrigin } from "../../shared/tour";
import { TOUR_SIGN_IN_TAG } from "../../shared/wake";

/** `since`: when this wait began (one entry into needs-sign-in); `title`: the tour's title. */
export interface TourNeedsYouEvent { sessionId: string; tourId: string; jobId: string; origin: string; fields: readonly string[]; title?: string; since?: string }
export interface TourSignInWait { sessionId: string; origin: string; fields: readonly string[]; since: number }

/** The notice's text: the tag line, a Reason line (the wake row's line) and the instruction, naming the tour and its job. */
export function tourSignInNoticeText(n: number, e: Pick<TourNeedsYouEvent, "origin" | "fields"> & Partial<Pick<TourNeedsYouEvent, "tourId" | "jobId" | "title">>): string {
  const code = e.fields.length === 1 && e.fields[0] === "code";
  const title = (e.title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return [
    `${TOUR_SIGN_IN_TAG} t${n}] A tour recording is waiting for a sign-in.`,
    `Reason: ${code ? `Enter the sign-in code for ${e.origin} on the tour card.` : `Sign in to ${e.origin} on the tour card.`}`,
    `Tour ${title ? `"${title}" ` : ""}${e.tourId ? `(tourId ${e.tourId}), ` : ""}${e.jobId ? `job ${e.jobId}, ` : ""}was waiting for this sign-in when this was sent. Check it with record_tour status first, and act only if it still shows needs-sign-in: then point the user at the sign-in form on the tour card in this chat. If they would rather give you the login in chat, cancel the recording and record again with credentials. See vis_guide tour-signin.`,
  ].join("\n");
}

export interface TourSignInNoticeDeps {
  /** The session file of a session id, or null when it can't be found. */
  pathOf(sessionId: string): Promise<string | null>;
  /** Sova's harness-neutral prompt (server/session-prompt.ts promptSession): a follow-up, sent once per key. */
  prompt(path: string, text: string, key: string): Promise<{ ok: boolean; error?: string }>;
  /** The chat is mid-turn (or compacting), so a prompt now would be queued behind it. Default: never. */
  busy?(path: string): boolean;
  /** That job still waits for that same sign-in (the entry that began at `since`). Default: always. */
  stillWaiting?(jobId: string, since: string | undefined): boolean;
  /** How often a notice held for a busy chat looks again (default 1 s). */
  pollMs?: number;
  log?(line: string): void;
}

/** The onNeedsYou handler: one notice per entry into `needs-sign-in` (a job asking again, for a code say, notifies again). */
export function tourSignInNotifier(deps: TourSignInNoticeDeps): (e: TourNeedsYouEvent) => void {
  let n = 0;
  const asked = new Map<string, number>();
  return (e) => {
    if (!isTourId(e.jobId) || !isTourOrigin(e.origin)) return;
    const time = (asked.get(e.jobId) ?? 0) + 1;
    asked.set(e.jobId, time);
    if (asked.size > 1000) asked.delete(asked.keys().next().value!);
    const text = tourSignInNoticeText(++n, e);
    void (async () => {
      const path = await deps.pathOf(e.sessionId);
      if (!path) return deps.log?.("[tours] a sign-in notice found no chat; only the needs-you mark shows");
      const waiting = () => { try { return deps.stillWaiting?.(e.jobId, e.since) ?? true; } catch { return false; } };
      const busy = () => { try { return deps.busy?.(path) ?? false; } catch { return false; } };
      // Held while the chat is busy, never queued behind its turn; dropped once the wait has ended.
      while (waiting() && busy()) await new Promise(r => setTimeout(r, deps.pollMs ?? 1000));
      if (!waiting()) return deps.log?.("[tours] a sign-in notice wasn't sent: the recording no longer waits for that sign-in");
      const r = await deps.prompt(path, text, `tour-sign-in:${e.jobId}:${time}`);
      // A chat Sova can't prompt keeps only the mark; the reason is Sova's own words, never a secret.
      if (!r.ok) deps.log?.(`[tours] a sign-in notice wasn't delivered: ${r.error ?? "refused"}`);
    })().catch(() => deps.log?.("[tours] a sign-in notice failed"));
  };
}

/**
 * The user answered a recording's sign-in or site approval (card or route) and the job continued: `at` names that
 * answer. `origin`: the sign-in's site. Never a login value.
 */
export interface TourResumedEvent { sessionId: string; tourId: string; jobId: string; title?: string; answered: "sign-in" | "site-approval"; origin?: string; at: string }
/** The resumed notice: tagged like the sign-in notice (the same wake row), naming the tour and job, telling the agent to call status. */
export function tourResumedNoticeText(n: number, e: Pick<TourResumedEvent, "tourId" | "jobId" | "answered"> & Partial<Pick<TourResumedEvent, "title" | "origin">>): string {
  const title = (e.title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return [
    `${TOUR_SIGN_IN_TAG} t${n}] A tour recording continued after the user answered.`,
    `Reason: ${e.answered === "sign-in" && e.origin ? `The user signed in to ${e.origin} on the tour card.` : e.answered === "sign-in" ? "The user signed in on the tour card." : "The user approved the recording's sites on the tour card."}`,
    `Tour ${title ? `"${title}" ` : ""}(tourId ${e.tourId}), job ${e.jobId}, continued. Call record_tour status with jobId ${e.jobId}: it waits until the job finishes, fails or needs the user again, so don't sleep or poll.`,
  ].join("\n");
}
export interface TourResumedNoticeDeps extends Omit<TourSignInNoticeDeps, "stillWaiting"> {
  /** That job still continues from the answer made at `at`: not waiting on the user again, not cancelled or interrupted, no later answer. */
  stillContinuing?(jobId: string, at: string): boolean;
  /** The chat is busy now, by session id, read when the answer comes (before its file is looked up). Default: busy(path) once found. */
  busyOf?(sessionId: string): boolean;
}
/**
 * The resumed handler: one notice per answer, at once to an idle chat. Dropped, never queued or held, when the
 * chat is busy at the answer or started working before it went, or when the job no longer continues from that
 * answer (it came to rest, waits on the user again, or a later answer took its place).
 */
export function tourResumedNotifier(deps: TourResumedNoticeDeps): (e: TourResumedEvent) => void {
  let n = 0;
  const answers = new Map<string, number>();
  return (e) => {
    if (!isTourId(e.jobId) || !isTourId(e.tourId) || (e.origin !== undefined && !isTourOrigin(e.origin))) return;
    const time = (answers.get(e.jobId) ?? 0) + 1;
    answers.set(e.jobId, time);
    if (answers.size > 1000) answers.delete(answers.keys().next().value!);
    const text = tourResumedNoticeText(++n, e);
    let atAnswer: boolean | undefined;
    try { atAnswer = deps.busyOf?.(e.sessionId); } catch { atAnswer = undefined; }
    void (async () => {
      const path = await deps.pathOf(e.sessionId);
      if (!path) return;
      const continuing = () => { try { return deps.stillContinuing?.(e.jobId, e.at) ?? true; } catch { return false; } };
      const busy = () => { try { return deps.busy?.(path) ?? false; } catch { return false; } };
      // Idle when the answer came: any turn seen later is the chat working on its own, so it needs no notice.
      // Busy at the answer, or busy by the time the notice would go: the chat is working and will call status itself.
      if ((atAnswer ?? busy()) || busy()) return deps.log?.("[tours] a resumed-recording notice wasn't sent: the chat is already working");
      if (!continuing()) return deps.log?.("[tours] a resumed-recording notice wasn't sent: the job no longer continues from that answer");
      const r = await deps.prompt(path, text, `tour-resumed:${e.jobId}:${time}`);
      if (!r.ok) deps.log?.(`[tours] a resumed-recording notice wasn't delivered: ${r.error ?? "refused"}`);
    })().catch(() => deps.log?.("[tours] a resumed-recording notice failed"));
  };
}

let waits: () => readonly TourSignInWait[] = () => [];
/** Bound by the server to the tour runtime's in-memory list of recordings waiting for a sign-in. */
export function setTourSignInWaits(source: (() => readonly TourSignInWait[]) | undefined): void { waits = source ?? (() => []); }
/** Per session, its oldest waiting sign-in, for the attention digest's `tour-sign-in` item. */
export function tourSignInWaits(): Map<string, { origin: string; code: boolean; since: number }> {
  const out = new Map<string, { origin: string; code: boolean; since: number }>();
  let list: readonly TourSignInWait[] = [];
  try { list = waits(); } catch { list = []; }
  for (const w of list) {
    const had = out.get(w.sessionId);
    if (!had || w.since < had.since) out.set(w.sessionId, { origin: w.origin, code: w.fields.length === 1 && w.fields[0] === "code", since: w.since });
  }
  return out;
}
