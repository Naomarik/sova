/**
 * How the review step's reviewer chat starts and ends on the server: a fresh chat per attempt, in
 * the merge copy (or its own folder), on the shipped `merge-reviewer` profile (no edit tools, no workers, web, timers or
 * worktrees; `merge-reviewer-shell` or `merge-reviewer-fix` when the kit or the project asks, review-kit.ts) and the
 * project's review model (models.ts; unset: the kit's declared model when it can be used, else the new-chat default),
 * with the review step's own message (review-step.ts `reviewerText`); archived when the
 * step is done with it: its turn is waited for (at most 2 min), else stopped, then archived with retries
 * (retire.ts). When Sova starts, every reviewer chat no review is waiting on is tidied away the same way
 * (sweepReviewers). The review step awaits the verdict, times out and retries; this file only starts and
 * stops chats.
 *
 * The kit is opened only through that message: it is never a skill and never loaded into another chat.
 *
 * Harness-neutral: the chat starts through Sova's own POST /api/sessions and ends through its archive.
 */
import type { SessionSummary } from "../../shared/protocol";
import type { ReviewerStart, StartReviewer } from "./review-step";
import { retireChat, type RetireDeps, type RetireOutcome } from "./retire";
import { createChat, type AppRequest, type Result } from "./thread";
import { reviewerTitle as sharedReviewerTitle } from "../../shared/fixed-names";
import { REVIEWER_PROFILE } from "./review-kit";

export { REVIEWER_PROFILE };

export interface ReviewerDeps {
  /** `root`: the project's main checkout (whose review model it starts on). Resolves the model it started on too. */
  create(cwd: string, text: string, title: string, root: string, o: { profile: string; kitModel?: { model?: string; thinking?: string } }): Promise<Result<{ id: string; path: string; model?: string; thinking?: string }>>;
  archive(path: string): Promise<Result>;
  /** A reviewer that can run or write (a shell, the fixer) runs only confined: its own sandbox turned on, its tools
   *  enforced. Resolves the sandbox's status line, or why it can't be; absent: it can't (the read-only one starts). */
  confine?(path: string): Promise<{ ok: true; status: string } | { ok: false; why: string }>;
  /** Send the chat its first message (a confined reviewer starts with none, so nothing runs before its sandbox is on). */
  prompt?(path: string, text: string): Promise<Result>;
  /** The chat is mid-turn; absent: never (the archive alone decides). */
  busy?(path: string): boolean;
  /** Stop its turn. */
  abort?(path: string): Promise<void>;
  /** retire.ts's clock, waits and log, for tests. */
  retire?: Pick<RetireDeps, "now" | "sleep" | "log" | "waitMs" | "pollMs" | "retryMs">;
}

/** retire.ts's deps over a reviewer's. */
const retireDeps = (deps: ReviewerDeps): RetireDeps => ({
  busy: (p) => deps.busy?.(p) ?? false,
  abort: (p) => deps.abort?.(p) ?? Promise.resolve(),
  archive: (p) => deps.archive(p),
  log: (l) => console.warn(`[merge-reviewer] ${l}`),
  ...deps.retire,
});

/** The title a reviewer chat gets: what it reviews, and which attempt (shared/fixed-names.ts, also used to rebuild it). */
export const reviewerTitle = (o: Pick<ReviewerStart, "branch" | "commit" | "attempt">): string => sharedReviewerTitle(o);

/** The review step's starter over `deps`. A refused start throws (the step counts it as the reviewer's failure). */
export function reviewerStarter(deps: ReviewerDeps): StartReviewer {
  return async (o) => {
    const profile = o.profile ?? REVIEWER_PROFILE;
    const model = o.kitModel ? { kitModel: o.kitModel } : {};
    let limited: string | undefined;
    let r: Result<{ id: string; path: string; model?: string; thinking?: string }>;
    if (profile === REVIEWER_PROFILE) r = await deps.create(o.copy, o.text, reviewerTitle(o), o.root, { profile, ...model });
    else {
      // Started with no message, so nothing runs before its sandbox is on; never with a shell it can't confine.
      const c = await deps.create(o.copy, "", reviewerTitle(o), o.root, { profile, ...model });
      if (!c.ok) throw new Error(`couldn't start the reviewer: ${c.error}`);
      const sealed = deps.confine ? await deps.confine(c.path).catch((err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) })) : { ok: false as const, why: "nothing here can turn its sandbox on" };
      if (sealed.ok) {
        const sent = deps.prompt ? await deps.prompt(c.path, o.text) : { ok: false as const, error: "nothing here can send it its message" };
        if (!sent.ok) {
          void retireChat(c.path, retireDeps(deps));
          throw new Error(`couldn't start the reviewer: ${sent.error}`);
        }
        r = c;
      } else {
        void retireChat(c.path, retireDeps(deps));
        limited = `it runs read-only: its sandbox couldn't be turned on (${sealed.why}), and a reviewer never has a shell it can't confine`;
        r = await deps.create(o.copy, o.readOnlyText ?? o.text, reviewerTitle(o), o.root, { profile: REVIEWER_PROFILE, ...model });
      }
    }
    if (!r.ok) throw new Error(`couldn't start the reviewer: ${r.error}`);
    let retiring: Promise<RetireOutcome> | null = null;
    return {
      sessionId: r.id,
      path: r.path,
      ...(limited ? { limited } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.thinking ? { thinking: r.thinking } : {}),
      /** Once: wait for its turn (else stop it), then archive. A second call answers the first's outcome. */
      stop() {
        retiring ??= retireChat(r.path, retireDeps(deps));
        return retiring.then(() => undefined);
      },
    };
  };
}

/**
 * Tidy away reviewer chats left open: every reviewer chat (SessionSummary.queueChat) not archived whose run no
 * review is waiting on now (`active`), each retired in turn. Resolves the paths it retired.
 */
export async function sweepReviewers(sessions: readonly Pick<SessionSummary, "id" | "path" | "archived" | "queueChat">[], active: ReadonlySet<string>, retire: (path: string) => Promise<RetireOutcome>): Promise<string[]> {
  const left = sessions.filter((s) => s.queueChat?.role === "reviewer" && !s.archived && !active.has(s.id));
  const done: string[] = [];
  for (const s of left) if ((await retire(s.path).catch(() => "not-archived" as const)) !== "not-archived") done.push(s.path);
  return done;
}

/** Wire the review step's starter on the server: Sova's own session start and archive; then the startup sweep. */
export async function startMergeReviewer(request: AppRequest): Promise<void> {
  const [{ setReviewerStarter, activeReviewers }, { listSessions }, { liveRetireDeps }] = await Promise.all([import("./review-step"), import("../sessions-index"), import("./retire")]);
  const live = await liveRetireDeps();
  setReviewerStarter(
    reviewerStarter({
      create: async (cwd, text, title, root, o) => {
        const choice = await reviewerModel(root, o.kitModel);
        const r = await createChat(request, cwd, o.profile, text, title, choice.opening);
        return r.ok ? { ...r, ...(choice.ran.model ? { model: choice.ran.model } : {}), ...(choice.ran.thinking ? { thinking: choice.ran.thinking } : {}) } : r;
      },
      confine: confineLive,
      prompt: async (path, text) => {
        const sent = await (await import("../session-prompt")).promptSession(path, text);
        return sent.ok ? { ok: true } : { ok: false, error: sent.error ?? "it couldn't be sent" };
      },
      archive: live.archive,
      busy: live.busy,
      abort: live.abort,
    }),
  );
  // Not awaited, and not in the start's first moments: a listing then is reused by the requests right after it
  // (sessions-index's reuse window), so files written meanwhile would be missed. The sweep has no hurry.
  const t = setTimeout(() => {
    void listSessions()
      .then((all) => sweepReviewers(all, activeReviewers(), (p) => retireChat(p, { ...live, log: (l) => console.warn(`[merge-reviewer] ${l}`) })))
      .then((done) => {
        if (done.length) console.log(`[merge-reviewer] archived ${done.length} reviewer chat${done.length === 1 ? "" : "s"} left open`);
      })
      .catch((err) => console.warn(`[merge-reviewer] sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }, SWEEP_DELAY_MS);
  (t as { unref?: () => void }).unref?.();
}

/** What a reviewer chat's sandbox state means for a shell or a fix: only full enforcement confines it (an unattended
 *  chat never runs on a partial one, as the sandbox's own unattended paths refuse it); null while it is still coming on. */
export function confinedBy(info: { on: boolean; enforcement: string; status: string; starting?: true } | null): { ok: true; status: string } | { ok: false; why: string } | null {
  if (info?.on && info.enforcement === "full") return { ok: true, status: info.status };
  if (!info || info.starting) return null;
  if (info.on === false) return { ok: false, why: info.status || "it stayed off" };
  if (info.enforcement === "partial") return { ok: false, why: `its enforcement is only partial${info.status ? ` (${info.status})` : ""}` };
  if (info.enforcement === "unavailable") return { ok: false, why: info.status || "nothing enforces it here" };
  return null;
}

/** Turn a reviewer chat's own sandbox on (raising it needs no click) and wait for it to be enforced in full; anything
 *  else is why not. */
async function confineLive(path: string): Promise<{ ok: true; status: string } | { ok: false; why: string }> {
  const { acquireChatHandle } = await import("../chat-handle");
  const chat = await acquireChatHandle(path);
  const applied = await chat.applySandbox("on");
  if (applied.outcome === "unsupported") return { ok: false, why: "this runtime has no sandbox" };
  for (let i = 0; i < 40; i++) {
    const v = confinedBy(await chat.sandboxInfo());
    if (v) return v;
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: false, why: "it didn't come on within 10 s" };
}

/**
 * The model a reviewer starts on, and what it runs on: this computer's review pick for the project (Settings → Merge
 * Queue), else the kit's declared model when it can be used here, else the new-chat default (nothing sent).
 */
export async function reviewerModel(
  root: string,
  kitModel: { model?: string; thinking?: string } | undefined,
  o: { picked?: (root: string) => Promise<{ model: string; thinking?: string | null } | null>; check?: import("./models").ModelCheck } = {},
): Promise<{ opening: { model: string; thinking?: string | null } | null; ran: { model?: string; thinking?: string } }> {
  const models = await import("./models");
  const check = o.check ?? models.liveModelCheck();
  const picked = await (o.picked ?? ((r) => models.startingModel(r, "review", { check })))(root);
  const d = check.defaults();
  // A kit that names only its effort: the new-chat default's model at that effort.
  const kit = picked || !kitModel ? null : kitModel.model ? await models.openingOf({ model: kitModel.model, ...(kitModel.thinking ? { thinking: kitModel.thinking } : {}) }, check) : kitModel.thinking && d.model ? { model: d.model, thinking: kitModel.thinking } : null;
  const opening = picked ?? kit;
  if (opening) return { opening, ran: { model: opening.model, ...(opening.thinking ? { thinking: opening.thinking } : {}) } };
  return { opening: null, ran: { ...(d.model ? { model: d.model } : {}), ...(d.thinking ? { thinking: d.thinking } : {}) } };
}

/** How long after the server's start the reviewer sweep runs. */
export const SWEEP_DELAY_MS = 30_000;
