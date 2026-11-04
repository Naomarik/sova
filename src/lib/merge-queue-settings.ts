// The words of Settings → Merge Queue and of the Merge Queue tab's summary line: what the queue's
// settings say, where each lives, and what an edit changes. Pure (no DOM, no Solid).
import type { EffectiveModel, MergeQueueSettings, MergeSettingsChange, MergeSettingsSaveResult, SettingSource } from "../../shared/merge-queue-settings";
import { settingsWaitingWords } from "../../shared/merge-queue-settings";
import { pickLabel } from "./model-pick";
import { modelLabel } from "./format";

/** Each row's tag: where the value lives. */
export const SOURCE_TAG: Record<SettingSource, string> = { project: "Project file", computer: "This computer", sova: "Set by Sova" };

/** "11 checks", "1 check", "No checks", "The test command". */
export function checksWords(c: MergeQueueSettings["checks"]): string {
  if (c.mode === "test-command") return "The test command";
  if (c.mode === "none" || c.mode === "unset" || c.list.length === 0) return "No checks";
  return `${c.list.length} check${c.list.length === 1 ? "" : "s"}`;
}

/** Whether the queue pushes after each landing: the file's switch, or, absent, whether there's an origin. */
export const pushes = (s: Pick<MergeQueueSettings, "landing">, hasOrigin: boolean): boolean => s.landing.push ?? hasOrigin;

/** "review on, Opus 5.5" / "review off". */
export function reviewWords(s: Pick<MergeQueueSettings, "review">): string {
  return s.review.on ? `review on, ${modelLabel(s.review.model.effective.model) ?? s.review.model.effective.model}` : "review off";
}

/** The Merge Queue tab's summary line: "11 checks · review on, Opus 5.5 · pushes to origin". */
export function summaryLine(s: MergeQueueSettings, hasOrigin: boolean): string {
  const push = !hasOrigin ? "no remote" : pushes(s, hasOrigin) ? "pushes to origin" : "doesn't push";
  return [checksWords(s.checks), reviewWords(s), push].join(" · ");
}

/** The Checks group's caption: "9 always, 2 when the merge thread picks them". */
export function checksCaption(c: MergeQueueSettings["checks"]): string | null {
  if (c.mode !== "declared" || c.list.length === 0) return null;
  const picked = c.list.filter((x) => x.optional).length;
  const always = c.list.length - picked;
  if (!picked) return `${always === 1 ? "Runs" : "All run"} every time`;
  return `${always} always, ${picked} when the merge thread picks ${picked === 1 ? "it" : "them"}`;
}

/** "10 min", "1 min 30 s", "45 s". */
/** The Merge thread's "Fresh chat" row (thread.ts replaceReason): one endless chat with memory, replaced only when it
    must be. The half-context rule still applies to every thread, as a safety net. */
export function freshChatWords(f: Pick<MergeQueueSettings["fixed"], "threadMaxContext">): string {
  const share = f.threadMaxContext === 0.5 ? "half" : `${Math.round(f.threadMaxContext * 100)}%`;
  return `One endless thread with memory (UniiChat). A new one only when it's gone, open in a terminal, keeps refusing messages or past ${share} of its context, or when you press Start Fresh.`;
}

export function minutes(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** A model row: "Opus 5.5 · high", or "Same as new chats" with what that is today. */
export function modelWords(m: EffectiveModel): { value: string; today?: string; why?: string } {
  if (m.picked) return { value: pickLabel(m.picked as never) ?? m.picked.model, ...(m.fallbackWhy ? { why: m.fallbackWhy } : {}) };
  return { value: "Same as new chats", today: pickLabel(m.effective as never) ?? m.effective.model, ...(m.fallbackWhy ? { why: m.fallbackWhy } : {}) };
}

/** The draft of the project-file edits: what the form shows, against what master has. */
export interface ProjectDraft {
  push: boolean;
  review: boolean;
  checks: Record<string, { timeoutSec: number; rerun: boolean; optional: boolean }>;
}

export function toProjectDraft(s: MergeQueueSettings, hasOrigin: boolean): ProjectDraft {
  const checks: ProjectDraft["checks"] = {};
  for (const c of s.checks.list) checks[c.id] = { timeoutSec: c.timeoutSec, rerun: c.rerun, optional: c.optional };
  return { push: pushes(s, hasOrigin), review: s.review.on, checks };
}

/** Only what the user changed: an untouched field is never written (absent push stays absent). Pure. */
export function changesOf(d: ProjectDraft, s: MergeQueueSettings, hasOrigin: boolean): MergeSettingsChange | null {
  const base = toProjectDraft(s, hasOrigin);
  const out: MergeSettingsChange = {};
  if (d.push !== base.push) out.push = d.push;
  if (d.review !== base.review) out.review = d.review;
  const checks: NonNullable<MergeSettingsChange["checks"]> = {};
  for (const [id, c] of Object.entries(d.checks)) {
    const b = base.checks[id];
    if (!b) continue;
    const one: { timeoutSec?: number; rerun?: boolean; optional?: boolean } = {};
    if (c.timeoutSec !== b.timeoutSec) one.timeoutSec = c.timeoutSec;
    if (c.rerun !== b.rerun) one.rerun = c.rerun;
    if (c.optional !== b.optional) one.optional = c.optional;
    if (Object.keys(one).length) checks[id] = one;
  }
  if (Object.keys(checks).length) out.checks = checks;
  return Object.keys(out).length ? out : null;
}

/** The confirm's list: one line per change, in the form's order. Pure. */
export function changeLines(ch: MergeSettingsChange, s: MergeQueueSettings): string[] {
  const lines: string[] = [];
  if (ch.push !== undefined) lines.push(ch.push ? "Push after each landing: on" : "Push after each landing: off");
  if (ch.review !== undefined) lines.push(ch.review ? "Review each landing: on" : "Review each landing: off");
  for (const c of s.checks.list) {
    const x = ch.checks?.[c.id];
    if (!x) continue;
    const parts: string[] = [];
    if (x.timeoutSec !== undefined) parts.push(`time limit ${minutes(x.timeoutSec)}`);
    if (x.rerun !== undefined) parts.push(x.rerun ? "reruns failed files" : "no reruns");
    if (x.optional !== undefined) parts.push(x.optional ? "only when picked" : "runs every time");
    lines.push(`${c.label}: ${parts.join(", ")}`);
  }
  return lines;
}

/** The time-limit field: whole minutes, 1 to the cap. Null when it isn't one. Pure. */
export function parseMinutes(text: string, capMin: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= capMin ? n : null;
}

/** "Saved to master as 1a2b3c4; pushed with the next landing." */
export function savedWords(target: string, commit: string, pushesAfter: boolean): string {
  return `Saved to ${target} as ${commit.slice(0, 7)}${pushesAfter ? "; pushed with the next landing" : ""}.`;
}

/** The user's edits of `base`, on top of `fresh` (a newer read of master): each field they left alone follows master. Pure. */
export function rebaseDraft(d: ProjectDraft, base: ProjectDraft, fresh: ProjectDraft): ProjectDraft {
  const pick = <T>(mine: T, was: T, now: T): T => (mine !== was ? mine : now);
  const checks: ProjectDraft["checks"] = {};
  for (const [id, now] of Object.entries(fresh.checks)) {
    const mine = d.checks[id];
    const was = base.checks[id];
    checks[id] = mine && was ? { timeoutSec: pick(mine.timeoutSec, was.timeoutSec, now.timeoutSec), rerun: pick(mine.rerun, was.rerun, now.rerun), optional: pick(mine.optional, was.optional, now.optional) } : { ...now };
  }
  return { push: pick(d.push, base.push, fresh.push), review: pick(d.review, base.review, fresh.review), checks };
}

/** A refused call's words: the server's `{error: {code, message}}` envelope, a plain `{error}`, or the error's own message. Pure. */
export function refusalWords(err: unknown): string {
  const body = (err as { body?: unknown } | null)?.body as { error?: unknown } | undefined;
  const e = body?.error;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  if (typeof e === "string") return e;
  return err instanceof Error ? err.message : String(err);
}

/** The merge thread's Instructions caption when it reads a project-folder copy that differs from the target, else null. Pure. */
export function threadFolderCaption(s: Pick<MergeQueueSettings, "thread" | "landing">): string | null {
  return s.thread.playbooks.some((p) => p.differsFromFolder) ? `The merge thread reads the project folder's copy, which differs from ${s.landing.target}.` : null;
}

/** The waiting save's banner title: why it waits (the branch checking now, or the release holding the queue), or that it failed. Pure. */
export const pendingSaveTitle = (p: { release?: string }, failed: boolean): string => (failed ? "The waiting save couldn't be applied." : `${settingsWaitingWords(p.release)}.`);

/** What a save says, by how it went: onto the target, waiting for the current branch or the open release, a PR/MR opened, or a branch pushed. Pure. */
export function saveResultWords(r: MergeSettingsSaveResult, o: { target: string; pushes: boolean; gitlab: boolean }): { text: string; link?: { href: string; label: string } } {
  switch (r.state) {
    case "saved":
      return { text: savedWords(o.target, r.commit, o.pushes) };
    case "waiting":
      return { text: `${settingsWaitingWords(r.release)}.` };
    case "requested": {
      const kind = o.gitlab ? `MR !${r.number}` : `PR #${r.number}`;
      return { text: `Opened ${kind} for the settings change. It applies once it's merged into ${o.target}.`, link: { href: r.url, label: o.gitlab ? "Open MR" : "Open PR" } };
    }
    case "pushed":
      return { text: `Pushed the settings change as ${r.branch}. It applies once it's merged into ${o.target}.` };
  }
}
