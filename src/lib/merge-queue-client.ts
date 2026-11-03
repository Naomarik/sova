// The merge queue's client side: one call per user action, each a catalogue verb
// (`POST /api/project-services/merge.*`, the project verbs in shared/commands/projects.ts). Every
// action bumps `mergeChanged`, which the session view reads to reload the worktree rows and the tab
// reads to read the queue again, so the modal, the pane and the tab agree.
import { createSignal } from "solid-js";
import type { MergeAnswer, MergeCard, MergeReport } from "../../shared/merge-queue";
import type { VerbResult } from "../../shared/project-contract";
import { runMergeVerb } from "./api";
import type { MergeEntry, MergeQueueView } from "./merge-queue-types";

const [changed, setChanged] = createSignal(0);
/** Bumped after every action and on the feed's `merge_queue` frame: readers reload on it. */
export const mergeChanged = changed;
export const noteMergeChanged = () => setChanged((n) => n + 1);

const [feed, setFeed] = createSignal<{ project: string; view: MergeQueueView } | null>(null);
/** The latest view the session feed pushed (`merge_queue`), for the tab of that project. */
export const mergeFeed = feed;
/** Each project's entries and their states, as last pushed: a run's steps move often, the rows only when this does. */
const rowsSeen = new Map<string, string>();
const rowsKey = (v: MergeQueueView) =>
  [v.current?.entry ?? "", ...[...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].map((e) => `${e.id}:${e.state}:${e.position ?? ""}`), ...v.recent.map((l) => `${l.entry.id}:landed:${l.entry.notes.length}`)].join(",");
/** The session feed's `merge_queue` frame: the tab adopts the view; worktree rows reload only when an entry moved. */
export function noteMergeFeed(msg: { project: string; view: MergeQueueView }): void {
  setFeed({ project: msg.project, view: msg.view });
  const key = rowsKey(msg.view);
  if (rowsSeen.get(msg.project) === key) return;
  rowsSeen.set(msg.project, key);
  noteMergeChanged();
}

const [cardsFeed, setCardsFeed] = createSignal<{ session: string; cards: MergeCard[] } | null>(null);
/** The newest cards the session feed pushed for one chat (`merge_cards`). */
export const mergeCardsFeed = cardsFeed;
export const noteMergeCards = (msg: { session: string; cards: MergeCard[] }): void => void setCardsFeed({ session: msg.session, cards: msg.cards });

const report = (r: VerbResult): MergeReport | undefined => r.merge;

/** A refusal's words, or null when it went through. */
export const refusal = (r: { ok: boolean; error?: { message: string } }): string | null => (r.ok ? null : (r.error?.message ?? "The queue refused it."));

export async function readQueue(project: string): Promise<MergeQueueView> {
  const r = await runMergeVerb(project, "merge.status");
  const v = report(r)?.view;
  if (!v) throw new Error(refusal(r) ?? "The queue gave no answer.");
  return v;
}

export interface LandOptions {
  /** The commit the user was shown: the queue pins exactly it, never a newer head. */
  commit?: string;
  /** "Land Without Review": this merge skips the review step. */
  withoutReview?: boolean;
  /** "Land Without Its Specs…": its drafts stay drafts. */
  withoutSpecs?: boolean;
}

const opts = (o: LandOptions) => ({ ...(o.commit ? { commit: o.commit } : {}), ...(o.withoutReview ? { withoutReview: true } : {}), ...(o.withoutSpecs ? { withoutSpecs: true } : {}) });

/** Each action: the verb's answer, and readers told to reload. */
async function act(project: string | null, verb: `merge.${string}`, body: Record<string, unknown>): Promise<VerbResult> {
  const r = await runMergeVerb(project, verb, body);
  noteMergeChanged();
  return r;
}

/** Land: queue a worktree's branch at its head commit (the approval pins it and its drafts). */
export const land = (worktree: string, o: LandOptions = {}) =>
  act(null, "merge.add", { checkout: worktree, ...opts(o) });
/** Land on the queue's own rows, by branch. */
export const landBranch = (project: string, branch: string, o: LandOptions = {}) => act(project, "merge.add", { branch, ...opts(o) });
export const cancelEntry = (e: Pick<MergeEntry, "id">) => act(null, "merge.cancel", { entry: e.id });
/** The user's answer to an entry that waits for them: Accept, Send Back, Land Anyway. */
export const answerEntry = (e: Pick<MergeEntry, "id">, answer: MergeAnswer) => act(null, "merge.answer", { entry: e.id, answer });
export const pauseQueue = (project: string) => act(project, "merge.pause", {});
/** Start Fresh: the merge thread is retired (archived once its turn ends); the next event starts a new one. */
export const startFreshThread = (project: string) => act(project, "merge.fresh", {});
/** The History's Clear (a session id) and Clear All ("all"): those chats are deleted for good. */
export const clearQueueChats = (project: string, chat: string) => act(project, "merge.clear", { chat });
/** The user's answer to the merge thread's question, typed on the tab. */
export const answerThread = (project: string, ask: string, text: string) => act(project, "merge.reply", { ask, text });
export const resumeQueue = (project: string) => act(project, "merge.resume", {});

/** One run, its steps and their order (merge.logs answers the run with its lines). */
export async function readRun(run: string): Promise<import("./merge-queue-types").MergeRun> {
  const r = await runMergeVerb(null, "merge.logs", { run, lines: 1 });
  const got = report(r)?.run;
  if (!got) throw new Error(refusal(r) ?? "No such run.");
  return got;
}

/** A run's log: one step's, or every step's in order. */
export async function readLog(run: string, step?: string): Promise<string> {
  const r = await runMergeVerb(null, "merge.logs", { run, ...(step ? { step } : {}), lines: 5000 });
  if (!r.ok) throw new Error(refusal(r) ?? "No log.");
  return (report(r)?.lines ?? []).join("\n");
}

/** The onboarding's checks, as the project's `merge` section takes them. */
export type OnboardChecks =
  | { kind: "list"; checks: { label: string; command: string }[] }
  | { kind: "command"; command: string; takesMin?: number; requires?: string }
  | { kind: "none" };
/** merge.setup's params for an answer: one command (with how long and what starts first), a list, or none. */
export function setupBody(c: OnboardChecks): Record<string, unknown> {
  if (c.kind === "none") return { none: true };
  // The verb's params are flat (the CLI and the catalogue take them): each check as "Label: command".
  if (c.kind === "list") return { commands: c.checks.map((x) => `${x.label}: ${x.command}`) };
  return { command: c.command, ...(c.takesMin ? { takesMin: c.takesMin } : {}), ...(c.requires ? { requires: [c.requires] } : {}) };
}
/** Try It on Main: the copy, setup and the checks on the target alone, logged; nothing saved. */
export const tryOnMain = (project: string, c: OnboardChecks) => runMergeVerb(project, "merge.setup", { ...setupBody(c), dryRun: true });
/** Save Checks: writes the project's merge section. */
export const saveChecks = (project: string, c: OnboardChecks) => act(project, "merge.setup", setupBody(c));
