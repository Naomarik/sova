import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MERGE_ANSWERS, type MergeAnswer, type MergeEntry, type MergeQueueView, type MergeReport, type MergeThreadAsk } from "../../shared/merge-queue";
import { type AnyVerb, isMergeVerb, type MergeVerb, MERGE_READ_VERBS, ordered, type VerbResult } from "../../shared/project-contract";
import type { Caller } from "../project-services/engine";
import type { RunMerge, WakeThread } from "./contract";
import { MergeFailure, type MergeQueues, type ProjectQueue } from "./queue";
import { registerLiveMergeSettingsRoutes } from "./settings-routes";
import { registerLiveMergeLandingRoutes } from "./routes-landing";
import { registerLiveRunLogsRoutes } from "./run-logs-routes";
import { NOT_SERVED } from "./served";
import type { MergeNamesReport } from "../../shared/merge-queue";
import type { Proc } from "./copy";
import { liveOf, type RestartDeps, restartQueueOf as restartQueue, restartSelf } from "./restart";
import { CONTENTS_MAX_FILES, testInCopy } from "./resolve-content";
import { scratchCopyPath } from "./scratch";
import { envOf } from "./checks";
import { mergeSlotOf } from "./run";

import { checkReviewText, REVIEW_TEXT_LIMIT } from "./review-verdict";

/**
 * The merge verbs (POST /api/project-services/merge.<x>, through the engine's `merger` hook; the merge thread's tool
 * calls the same): who may call which, and what each answers (`VerbResult.merge`).
 *
 * Callers:
 * - the operator (the screens' buttons, the CLI): every verb; `merge.answer` and `merge.add` are the user's alone;
 * - the project's merge thread (its recorded chat): status, logs, note, extend, resolve, retry, ask, hold (its own
 *   hold while it restarts the project's server; merge.pause stays the user's);
 * - the chat a thread's question was asked in: reply to that question (the user's answer, relayed);
 * - the operator alone: fresh (Start Fresh) and clear (the History's Clear and Clear All);
 * - the run's reviewer chat: status, logs, review of that run;
 * - any other chat, overseer or assistant with the project in scope: status and logs.
 * Typed "land it" reaches `merge.add` through ingest.ts (the user's own word), never through a chat's verb call.
 */

export interface MergerDeps {
  queues: MergeQueues;
  /** The project root of a path (server/project-root.ts projectOf). */
  rootOf: (path: string) => Promise<string | null>;
  /** The served rule (served.ts): a root not on the Projects list gets no verb at all; one listed but not set up
   *  only merge.status (its bare view, served: false, made without a queue) and merge.setup (Initialize). */
  served: { isListed(root: string): boolean; served(root: string): Promise<boolean>; bareView(root: string): Promise<MergeQueueView> };
  /** A not-yet-served project's settings, made without a queue (settings.ts bareSettings): the bare view carries them. */
  bareSettings?: (root: string) => Promise<import("../../shared/merge-queue-settings").MergeQueueSettings | null>;
  /** The recorded merge thread of `root` is `sessionId`. */
  isThreadChat?: (root: string, sessionId: string) => boolean;
  /** `sessionId` is a run's reviewer chat (any run's, current or recent). */
  isReviewerChat?: (sessionId: string) => boolean;
  /** The reviewer chat run `run` waits on. */
  reviewerOf?: (run: string) => string | null;
  /** Hand a reviewer's verdict to the review step (review-step.ts deliverReview); false: none waits. */
  deliverReview?: (run: string, v: import("./review-step").ReviewAnswer) => boolean;
  /** The thread's question: asked in the owning chat of `entry`'s branch (else held on the tab, one notification). */
  threadAsk?: (root: string, q: { question: string; entry?: MergeEntry; choices?: string[]; decide?: import("./asks").AskDeps["decide"] }) => Promise<MergeThreadAsk>;
  /** A recorded question of `root`'s thread, by id. */
  askOf?: (root: string, id: string) => MergeThreadAsk | undefined;
  /** The user's answer to a question: closed, and handed to the thread. */
  threadAnswer?: (root: string, id: string, text: string, by: { kind: "chat" | "operator"; session?: string }) => Promise<MergeThreadAsk>;
  /** Start Fresh: the thread retired; true when there was one. */
  threadFresh?: (root: string) => Promise<boolean>;
  /** The History's clear: one queue chat by session id, or "all" the ended ones; how many were deleted. */
  clearChats?: (root: string, which: string) => Promise<number>;
  /** merge.live and merge.restart (restart.ts): the running server, its unit and its delayed restart. */
  restart?: RestartDeps;
  /** merge.names (names-verb.ts): the names step, Sova's own, on the project's names file. */
  names?: (q: ProjectQueue, action: "discover" | "add" | "show", text?: string) => Promise<MergeNamesReport>;
  /** merge.test: run a command in a scratch copy (tests stand one in). */
  runInCopy?: (argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number) => Promise<Proc>;
  now?: () => number;
}

const THREAD_VERBS: readonly MergeVerb[] = ["merge.status", "merge.logs", "merge.note", "merge.extend", "merge.resolve", "merge.retry", "merge.ask", "merge.hold", "merge.rule", "merge.restart", "merge.test", "merge.names"];
const REVIEWER_VERBS: readonly MergeVerb[] = ["merge.status", "merge.logs", "merge.review"];

interface Req {
  project?: string;
  branch?: string;
  checkout?: string;
  commit?: string;
  entry?: string;
  run?: string;
  step?: string;
  lines?: number;
  note?: string;
  withoutSpecs?: boolean;
  withoutReview?: boolean;
  via?: string;
  chat?: string;
  checks?: string[];
  select?: string[];
  why?: string;
  verdict?: string;
  files?: string[];
  ours?: string;
  theirs?: string;
  proposal?: string;
  answer?: string;
  text?: string;
  ask?: string;
  command?: string;
  commands?: string[];
  none?: boolean;
  takesMin?: number;
  requires?: string[];
  dryRun?: boolean;
  action?: string;
  ruling?: string;
  choices?: string[];
  request?: string;
  drafts?: boolean;
  contents?: Record<string, string>;
}

const KEYS: Record<keyof Req, "string" | "boolean" | "number" | "strings" | "map"> = {
  project: "string",
  ask: "string",
  branch: "string",
  checkout: "string",
  commit: "string",
  entry: "string",
  run: "string",
  step: "string",
  lines: "number",
  note: "string",
  withoutSpecs: "boolean",
  withoutReview: "boolean",
  via: "string",
  chat: "string",
  checks: "strings",
  select: "strings",
  why: "string",
  verdict: "string",
  files: "strings",
  ours: "string",
  theirs: "string",
  proposal: "string",
  answer: "string",
  text: "string",
  command: "string",
  commands: "strings",
  none: "boolean",
  takesMin: "number",
  requires: "strings",
  dryRun: "boolean",
  action: "string",
  ruling: "string",
  choices: "strings",
  request: "string",
  drafts: "boolean",
  contents: "map",
};

/** A string key's length limit. `text` carries a whole review (merge.review), whose own format bounds it below this
 *  (review-verdict.ts REVIEW_TEXT_LIMIT); every other text a verb takes is shorter. */
const STRING_MAX = 4000;
const stringMax = (k: string) => (k === "text" ? REVIEW_TEXT_LIMIT : STRING_MAX);

function parse(body: unknown): Req {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new MergeFailure("invalid-request", "the body is a JSON object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const want = KEYS[k as keyof Req];
    if (!want) continue; // the engine's own keys (confirm, …) and the CLI's extras ride along
    const ok =
      want === "map"
        ? typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length <= CONTENTS_MAX_FILES && Object.entries(v as object).every(([p, t]) => p.length > 0 && p.length <= 500 && typeof t === "string")
        : want === "strings"
        ? Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500)
        : want === "number"
          ? typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 5000
          : want === "string"
            ? typeof v === "string" && v.length <= stringMax(k)
            : typeof v === "boolean";
    if (!ok) throw new MergeFailure("invalid-request", `"${k}" must be ${want === "map" ? `an object of file texts by path (at most ${CONTENTS_MAX_FILES})` : want === "strings" ? "a list of names" : want === "number" ? "a whole number (1–5000)" : typeof v === "string" ? `at most ${stringMax(k)} characters` : `a ${want}`}`);
    out[k] = v;
  }
  return out as Req;
}

function sessionId(caller: Caller): string | null {
  return caller.kind === "session" ? caller.id : null;
}

/** The merger the engine forwards `merge.*` to. */
export function merger(deps: MergerDeps): (verb: string, body: unknown, caller: Caller) => Promise<VerbResult> {
  const now = deps.now ?? Date.now;
  return async (verb, body, caller) => {
    let root: string | null = null;
    let changed = false;
    let report: MergeReport | undefined;
    try {
      if (!isMergeVerb(verb)) throw new MergeFailure("invalid-request", `unknown verb "${verb}"`);
      const req = parse(body);
      const got = await queueFor(deps, verb, req, caller);
      if ("bare" in got) {
        // A listed project with no merge setup: its status is read from Git alone, no queue made (a4).
        root = got.bare;
        authorize(deps, verb, caller, root, req);
        const bare = await deps.served.bareView(root);
        const settings = (await deps.bareSettings?.(root)) ?? null;
        return result(verb, root, true, false, { view: settings ? { ...bare, settings } : bare }, undefined, now());
      }
      const q = got;
      root = q.root;
      authorize(deps, verb, caller, q.root, req);
      const r = await dispatch(deps, verb, req, q, caller);
      changed = r.changed;
      report = r.report;
      return result(verb, root, true, changed, report, undefined, now());
    } catch (err) {
      const f = err instanceof MergeFailure ? err : new MergeFailure("busy", err instanceof Error ? err.message : String(err));
      const code = f.code === "busy" && !(err instanceof MergeFailure) ? ("start-failed" as const) : f.code;
      return result((isMergeVerb(verb) ? verb : "merge.status") as AnyVerb, root, false, changed, report, { code, message: f.message }, now());
    }
  };
}

function result(verb: AnyVerb, root: string | null, ok: boolean, changed: boolean, merge: MergeReport | undefined, error: VerbResult["error"] | undefined, at: number): VerbResult {
  return ordered({
    v: 1,
    verb,
    project: root,
    instance: null,
    slot: null,
    generation: null,
    checkout: null,
    branch: null,
    ok,
    changed,
    state: "absent",
    steps: [],
    services: [],
    data: [],
    links: [],
    ...(merge ? { merge } : {}),
    ...(error ? { error } : {}),
    defHash: null,
    at: new Date(at).toISOString(),
  });
}

/** merge.setup's refusal to every caller but the user's own page: a chat proposes its setup on a branch instead. */
export const SETUP_IS_THE_USERS = "only the user saves the checks, from their own page: a chat proposes the setup on its branch and runs a trial with merge.try";

/** The operator's route called by a process a chat runs (its `x-sova-caller` key): never the user's act, whatever it
    asks (§app.access/your-click). Land, the answers, Remove from Queue and Cancel come only from the user's own click in
    Sova's page or their own word in the branch's chat (typed "land it", read by the worktree tool, not this route). */
/** merge.respond's refusal to anyone but a branch's chat (the queue then checks it is the chat the request went to). */
export const RESPOND_IS_THE_CHATS = "only the branch's chat a merge queue request was sent to answers it, with its own tool";

export const CLICK_IS_THE_USERS =
  "a chat's own scripts never act as the user: landing, answering, removing from the queue, cancelling, pausing and the queue's other acts come only from the user's own click in Sova's page or their own word in the branch's chat. Nothing was done; ask the user";

/** merge.reply from any chat: the user's own next message is the answer, never a chat's relay. */
export const REPLY_IS_THE_USERS =
  "no chat answers the merge thread's question, not even by relaying: your user's own next message in this chat is the answer, and Sova sends it with the question. Ask them in your reply and wait; never answer it yourself";

/** The merge queue's acts only the user's own page takes (§app.access/your-click): every verb but the reads and a trial.
    Routes ask the page check (notPageNorProven) for these, as for `apply`. */
export const pageOnlyMergeVerb = (verb: string): boolean => isMergeVerb(verb) && !MERGE_READ_VERBS.includes(verb) && verb !== "merge.try";

/** An act on the merge queue from the user's route that isn't their own page: a token in a header (any script, a chat's
    shell that left its key out), an in-process dispatch. */
export const PAGE_IS_THE_USERS =
  "only the user's own click in Sova's page lands, answers, removes from the queue, cancels or pauses: a request that shows the token in a header (a script, a terminal, a chat's shell) never acts as the user here. Nothing was done; ask the user";

/** A card's command (server/transcript-cards.ts) on the merge queue: refused for every act. */
export const CARD_IS_NOT_THE_USERS =
  "a card's commands never act as the user on the merge queue: landing, answering, removing from the queue and the queue's other acts come only from Sova's own controls in the page or the user's own word in the branch's chat. Nothing was done";

/** The verbs a project on the Projects list may call before its merge setup is done. */
const SETUP_VERBS: readonly MergeVerb[] = ["merge.status", "merge.setup", "merge.try"];

type Gated = ProjectQueue | { bare: string };

/** The queue of `root`, when the served rule lets `verb` reach it; never creates a queue for a root it refuses. A
 *  listed project with no setup: merge.status is answered bare (no queue) unless a setup press already loaded one. */
async function gated(deps: MergerDeps, verb: MergeVerb, root: string): Promise<Gated> {
  if (!deps.served.isListed(root)) throw new MergeFailure("unsupported", NOT_SERVED);
  if (await deps.served.served(root)) return deps.queues.get(root);
  if (!SETUP_VERBS.includes(verb)) throw new MergeFailure("unsupported", NOT_SERVED);
  if (verb === "merge.status") return (await deps.queues.peek(root)) ?? { bare: root };
  return deps.queues.get(root);
}

/** The queue a request is about: its project, or the one holding its entry or run. */
async function queueFor(deps: MergerDeps, verb: MergeVerb, req: Req, caller: Caller): Promise<Gated> {
  if (req.project) {
    if (!isAbsolute(req.project)) throw new MergeFailure("invalid-request", "the project is an absolute path inside it");
    const root = await deps.rootOf(req.project);
    if (!root) throw new MergeFailure("not-found", `no project at ${req.project}`);
    return gated(deps, verb, root);
  }
  if (req.entry) {
    const q = await deps.queues.findEntry(req.entry);
    if (!q) throw new MergeFailure("not-found", `no queue entry ${req.entry}`);
    return gated(deps, verb, q.root);
  }
  // A request of a branch's chat names its queue (merge.respond, merge.rule); one Sova made before any Land has none,
  // and the caller's own project answers for it below.
  if (req.request) {
    const q = await deps.queues.findRequest(req.request);
    if (q) return gated(deps, verb, q.root);
  }
  if (req.run) {
    const q = await deps.queues.findRun(req.run);
    if (!q) throw new MergeFailure("not-found", `no merge run ${req.run}`);
    return gated(deps, verb, q.root);
  }
  if (req.checkout && isAbsolute(req.checkout)) {
    const root = await deps.rootOf(req.checkout);
    if (root) return gated(deps, verb, root);
  }
  if (caller.kind === "session" && caller.root) return gated(deps, verb, caller.root);
  if ((caller.kind === "project-overseer" || caller.kind === "assistant") && caller.root) return gated(deps, verb, caller.root);
  throw new MergeFailure("invalid-request", `${verb}: name the project (an absolute path inside it)${verb === "merge.status" || verb === "merge.add" ? "" : ", the entry or the run"}`);
}

function authorize(deps: MergerDeps, verb: MergeVerb, caller: Caller, root: string, req: Req): void {
  // merge.setup saves to the target: the user's own page only, never a chat's script on the operator's route (any dryRun).
  if (caller.kind === "operator" && caller.fromChat && verb === "merge.setup") throw new MergeFailure("forbidden", SETUP_IS_THE_USERS);
  // A chat's script on the operator's route never restarts Sova, runs a branch's tests or writes the names file: the
  // merge thread's own tool or the user's page does.
  if (caller.kind === "operator" && caller.fromChat && (verb === "merge.restart" || verb === "merge.test" || verb === "merge.names")) throw new MergeFailure("forbidden", `${verb} is the merge thread's (its own tool) or the user's page, never a chat's script`);
  // Any other act from a chat's script on the operator's route: refused (the merge thread and a run's reviewer use their
  // own tool, a session caller, below). It still reads, and still runs a trial, as any chat on its project may.
  if (caller.kind === "operator" && caller.fromChat && !MERGE_READ_VERBS.includes(verb) && verb !== "merge.try") throw new MergeFailure("forbidden", CLICK_IS_THE_USERS);
  // A command a card ran (its view's code or its button's): a chat's or an extension's code, never the user's act here.
  if (caller.kind === "operator" && caller.fromCard && !MERGE_READ_VERBS.includes(verb)) throw new MergeFailure("forbidden", CARD_IS_NOT_THE_USERS);
  // Not the user's own page (nor a proven click from another of their computers): never the user's act, whatever it
  // says of itself. A chat whose shell leaves its key out is caught here, by what it can't show (the page's cookie).
  if (caller.kind === "operator" && caller.notPage && pageOnlyMergeVerb(verb)) throw new MergeFailure("forbidden", PAGE_IS_THE_USERS);
  // merge.respond is the branch's chat's own answer to a request: never the user's page, never a script.
  if (caller.kind === "operator" && verb === "merge.respond") throw new MergeFailure("forbidden", RESPOND_IS_THE_CHATS);
  if (caller.kind === "operator") return;
  const reads = MERGE_READ_VERBS.includes(verb);
  const sid = sessionId(caller);
  // The run's reviewer works in the merge copy, whatever project its folder reads as: its run decides.
  if (sid && req.run && REVIEWER_VERBS.includes(verb) && deps.reviewerOf?.(req.run) === sid) return;
  if (caller.kind === "session" || caller.kind === "project-overseer" || caller.kind === "assistant") {
    if (caller.root !== root) throw new MergeFailure("forbidden", `this caller acts only on its own project${caller.root ? ` (${caller.root})` : ""}`);
  }
  if (sid && deps.isThreadChat?.(root, sid) && THREAD_VERBS.includes(verb)) {
    // The thread acting at all proves it runs: fixes that waited for it are handed to it again (q14).
    void deps.queues.peek(root)?.then((q) => q.threadActed()).catch(() => {});
    return;
  }
  if (reads && caller.kind !== "conform") return;
  // A trial saves and merges nothing: any chat on its own project may run one (the setup chat does); never merge.setup.
  // Never the merge thread or a run's reviewer: neither sets anything up.
  if (verb === "merge.try") {
    if (sid && deps.isThreadChat?.(root, sid)) throw new MergeFailure("forbidden", "the merge thread never sets anything up: it runs no trial");
    if (sid && deps.isReviewerChat?.(sid)) throw new MergeFailure("forbidden", "a run's reviewer runs no trial");
    if (caller.kind === "session") return;
    throw new MergeFailure("forbidden", "only the user or a chat on this project runs a trial");
  }
  // No chat relays the user's answer to a thread question, not even the chat it was asked in: Sova takes the user's own
  // next message there as the answer (server/merge-queue/channel.ts takeHeldNote), so no model can answer for them.
  if (verb === "merge.reply") throw new MergeFailure("forbidden", REPLY_IS_THE_USERS);
  if (verb === "merge.setup") throw new MergeFailure("forbidden", SETUP_IS_THE_USERS);
  // A branch's chat answers the requests sent to it (the queue checks it is the one); never the merge thread or a reviewer.
  if (verb === "merge.respond") {
    if (sid && caller.kind === "session" && !deps.isThreadChat?.(root, sid) && !deps.isReviewerChat?.(sid)) return;
    throw new MergeFailure("forbidden", RESPOND_IS_THE_CHATS);
  }
  if (verb === "merge.add" || verb === "merge.answer" || verb === "merge.cancel" || verb === "merge.pause" || verb === "merge.resume" || verb === "merge.fresh" || verb === "merge.clear")
    throw new MergeFailure("forbidden", "only the user lands, cancels, pauses, answers or sets up the checks: their Land button or their own word in the branch's chat");
  if (verb === "merge.review") throw new MergeFailure("forbidden", "only the run's reviewer posts its review");
  throw new MergeFailure("forbidden", `only the project's merge thread calls ${verb}`);
}

async function dispatch(deps: MergerDeps, verb: MergeVerb, req: Req, q: ProjectQueue, caller: Caller): Promise<{ changed: boolean; report: MergeReport }> {
  const by = caller.kind === "operator" ? ("operator" as const) : ("thread" as const);
  const viewOf = async () => q.view();
  switch (verb) {
    case "merge.status": {
      const view = await viewOf();
      if (!req.entry) return { changed: false, report: { view } };
      // One entry: the rest of the view stays (counts, hold, settings), its lists narrowed to that entry.
      const one = (xs: MergeEntry[]): MergeEntry[] => xs.filter((x) => x.id === req.entry);
      const narrowed: MergeQueueView = {
        ...view,
        checking: one(view.checking),
        waiting: one(view.waiting),
        needsYou: one(view.needsYou),
        needsFix: one(view.needsFix),
        ...(view.waitingOnHost ? { waitingOnHost: one(view.waitingOnHost) } : {}),
        recent: view.recent.filter((x) => x.entry.id === req.entry),
      };
      return { changed: false, report: { view: narrowed } };
    }
    case "merge.logs": {
      const runId = req.run ?? (req.entry ? q.entry(req.entry)?.run : undefined);
      if (!runId) throw new MergeFailure("invalid-request", "name the run (or an entry that had one)");
      const run = q.currentRun()?.id === runId ? q.currentRun()! : q.store.readRun(runId);
      if (!run) throw new MergeFailure("not-found", `no merge run ${runId}`);
      const n = req.lines ?? 100;
      const steps = req.step ? run.steps.filter((s) => s.id === req.step) : run.steps;
      if (req.step && !steps.length) throw new MergeFailure("not-found", `no step ${req.step} in ${runId}`);
      const lines: string[] = [];
      for (const s of steps) {
        const l = q.store.readLog(runId, s.log, n) ?? [];
        if (!req.step) lines.push(`── ${s.label} (${s.result}) ──`);
        lines.push(...l);
      }
      return { changed: false, report: { run: structuredClone(run), lines: req.step ? lines : lines.slice(-Math.max(n, 1) * Math.max(1, steps.length)) } };
    }
    case "merge.add": {
      const r = await q.add({
        ...(req.branch ? { branch: req.branch } : {}),
        ...(req.checkout ? { checkout: req.checkout } : {}),
        ...(req.commit ? { commit: req.commit } : {}),
        ...(req.withoutSpecs ? { withoutSpecs: true } : {}),
        ...(req.withoutReview ? { withoutReview: true } : {}),
        ...(req.via ? { via: viaOf(req.via) } : {}),
        ...(req.chat ? { chat: req.chat, session: req.chat } : {}),
        by: "land-button",
      });
      return { changed: r.changed, report: { entry: r.entry, view: await viewOf() } };
    }
    case "merge.cancel": {
      const e = await q.cancel(need(req.entry, "entry"), req.note);
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.pause":
      if (q.isPaused()) return { changed: false, report: { view: await viewOf() } };
      await q.pause(req.why);
      return { changed: true, report: { view: await viewOf() } };
    case "merge.resume":
      if (!q.isPaused()) return { changed: false, report: { view: await viewOf() } };
      await q.resume();
      return { changed: true, report: { view: await viewOf() } };
    case "merge.note": {
      if (req.note === undefined) throw new MergeFailure("invalid-request", "say the note (empty clears it)");
      const e = await q.note(need(req.entry, "entry"), req.note, by);
      return { changed: true, report: { entry: e } };
    }
    case "merge.extend": {
      const e = await q.extend(need(req.entry, "entry"), req.checks ?? [], req.why ?? "", req.select, req.note);
      return { changed: true, report: { entry: e } };
    }
    case "merge.resolve": {
      const e = await q.resolve(need(req.entry, "entry"), {
        verdict: need(req.verdict, "verdict"),
        ...(req.files ? { files: req.files } : {}),
        ours: req.ours ?? "",
        theirs: req.theirs ?? "",
        proposal: req.proposal ?? "",
        ...(req.commit ? { commit: req.commit } : {}),
        ...(req.contents ? { contents: req.contents } : {}),
        ...(req.note !== undefined ? { note: req.note } : {}),
        ...(req.text !== undefined ? { text: req.text } : {}),
        ...(req.choices ? { choices: req.choices } : {}),
      });
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.respond": {
      const sid = sessionId(caller);
      const id = need(req.request, "request (rq_…)");
      // A request Sova made before any Land (drafts that don't fit, what blocks a finished branch): no entry holds it.
      if (!q.requestOf(id)) {
        const { answerLoose, isLooseRequest } = await import("./answers");
        if (isLooseRequest(id)) return { changed: true, report: { request: answerLoose(id, sid, { answer: need(req.answer, 'answer ("fixed", "needs-you" or "cant")'), ...(req.text !== undefined ? { text: req.text } : {}) }) } };
      }
      const r = await q.respond(id, sid, {
        answer: need(req.answer, 'answer ("fixed", "needs-you" or "cant")'),
        ...(req.text !== undefined ? { text: req.text } : {}),
        ...(req.commit ? { commit: req.commit } : {}),
        ...(req.drafts ? { drafts: true } : {}),
        ...(req.choices ? { options: req.choices } : {}),
      });
      return { changed: true, report: { entry: r.entry, request: r.request } };
    }
    case "merge.rule": {
      const request = (req as { request?: string }).request;
      const e = await q.rule(need(req.entry, "entry"), {
        ruling: need(req.ruling, "ruling"),
        ...(req.text !== undefined ? { text: req.text } : {}),
        ...(req.choices ? { choices: req.choices } : {}),
        ...(request ? { request } : {}),
        ...(req.note !== undefined ? { note: req.note } : {}),
      });
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.answer": {
      const a = need(req.answer, "answer");
      if (!(MERGE_ANSWERS as readonly string[]).includes(a)) throw new MergeFailure("invalid-request", 'answer is "accept", "land-anyway", "try-again" or "land"');
      const e = await q.answer(need(req.entry, "entry"), a as MergeAnswer, req.why);
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.review": {
      const runId = need(req.run, "run");
      const v = need(req.verdict, "verdict");
      if (!["ok", "notes", "blocking"].includes(v)) throw new MergeFailure("invalid-request", 'verdict is "ok", "notes" or "blocking"');
      if ((v === "notes" || v === "blocking") && !req.text?.trim()) throw new MergeFailure("invalid-request", "say what the review found (text)");
      // The verdict's shape is checked here (the reviewer has no shell to run a kit script): a malformed one is refused.
      const checked = checkReviewText(v as "ok" | "notes" | "blocking", req.text);
      if ("why" in checked) throw new MergeFailure("invalid-request", `review refused: ${checked.why}; fix it and answer again`);
      const verdict = { verdict: v as "ok" | "notes" | "blocking", ...(checked.text ? { text: checked.text, summary: checked.summary, findings: checked.findings } : {}) };
      if (deps.deliverReview?.(runId, verdict)) return { changed: true, report: {} };
      const run = await q.review(runId, verdict);
      return { changed: true, report: { run } };
    }
    case "merge.retry":
      await q.retry(req.entry, req.note);
      return { changed: true, report: { view: await viewOf() } };
    case "merge.ask": {
      const question = need(req.text?.trim(), "question (text)");
      if (question.length > 2000) throw new MergeFailure("invalid-request", "keep the question under 2000 characters");
      if (!deps.threadAsk) throw new MergeFailure("unsupported", "nothing here can ask the user for the merge thread");
      const e = req.entry ? q.entry(req.entry) : undefined;
      if (req.entry && !e) throw new MergeFailure("not-found", `no queue entry ${req.entry}`);
      // A question about an entry whose branch chat can take it waits as a decision on that entry's card (al_3 v7).
      const decide: import("./asks").AskDeps["decide"] = (a) => q.askDecision(e!.id, a);
      const ask = await deps.threadAsk(q.root, { question, ...(e ? { entry: e, decide } : {}), ...(req.choices ? { choices: req.choices } : {}) });
      return { changed: true, report: { ask } };
    }
    case "merge.reply": {
      const id = need(req.ask, "question (ask)");
      const text = need(req.text?.trim(), "answer (text)");
      if (!deps.threadAnswer) throw new MergeFailure("unsupported", "no merge thread here to answer");
      const ask = await deps.threadAnswer(q.root, id, text, caller.kind === "operator" ? { kind: "operator" } : { kind: "chat", ...(sessionId(caller) ? { session: sessionId(caller)! } : {}) });
      return { changed: true, report: { ask } };
    }
    case "merge.fresh": {
      if (!deps.threadFresh) throw new MergeFailure("unsupported", "no merge thread here");
      const fresh = await deps.threadFresh(q.root);
      return { changed: fresh, report: { fresh, view: await viewOf() } };
    }
    case "merge.clear": {
      if (!deps.clearChats) throw new MergeFailure("unsupported", "nothing here can clear the queue's chats");
      const cleared = await deps.clearChats(q.root, need(req.chat, 'chat (a session id, or "all")'));
      return { changed: cleared > 0, report: { cleared, view: await viewOf() } };
    }
    case "merge.hold": {
      const action = need(req.action, 'action ("set" or "clear")');
      if (action !== "set" && action !== "clear") throw new MergeFailure("invalid-request", '"action" is "set" or "clear"');
      const r = await q.hold(action);
      return { changed: r.changed, report: { hold: r.hold, view: await viewOf() } };
    }
    case "merge.try": {
      const r = await q.trial({
        ...(req.branch ? { branch: req.branch } : {}),
        ...(req.commit ? { commit: req.commit } : {}),
        ...(req.checkout ? { checkout: req.checkout } : {}),
        ...(req.checks ? { checks: req.checks } : {}),
        by: caller.kind === "operator" && !caller.fromChat ? { kind: "operator" } : { kind: "chat", ...(sessionId(caller) ? { session: sessionId(caller)! } : {}) },
      });
      return { changed: true, report: { trial: r.trial, run: r.run } };
    }
    case "merge.live": {
      if (!deps.restart) throw new MergeFailure("unsupported", "this server can't say what it runs");
      return { changed: false, report: { live: await liveOf(restartQueue(q), deps.restart) } };
    }
    case "merge.restart": {
      if (!deps.restart) throw new MergeFailure("unsupported", "this server can't restart itself");
      const r = await restartSelf(restartQueue(q), deps.restart);
      return { changed: r.outcome !== "nothing", report: { restart: r } };
    }
    case "merge.test": {
      const e = q.entry(need(req.entry, "entry"));
      if (!e) throw new MergeFailure("not-found", `no queue entry ${req.entry}`);
      if (e.state !== "conflict" && e.state !== "behaviour-differs") throw new MergeFailure("invalid-request", `${e.branch} has no conflict and so no scratch copy (it is ${e.state})`);
      const d = await q.declared();
      const test = d.def?.test?.run;
      if (!test?.length) throw new MergeFailure("unsupported", "the project declares no test command");
      const install = d.def?.merge?.install?.run ?? null;
      const copy = scratchCopyPath(q.root, e.id);
      // The queue's checks' environment, at the merge copy's slot, with data of the test's own.
      const data = join(q.store.dir, "scratch-tests", e.id);
      const env = envOf(d.def!, { project: q.root, projectId: q.id, copy, slot: mergeSlotOf(d.def!), data, target: q.target, base: (await q.targetHead()) ?? "", tip: e.commit });
      const r = await testInCopy({ copy, entry: e.id, install, test, env, ...(req.select ? { select: req.select } : {}), timeoutMs: (d.def?.test?.timeout ?? 1200) * 1000, ...(deps.runInCopy ? { run: deps.runInCopy } : {}) }).catch((err: unknown) => {
        throw new MergeFailure("invalid-request", err instanceof Error ? err.message : String(err));
      });
      return { changed: false, report: { test: r } };
    }
    case "merge.names": {
      const action = need(req.action, 'action ("discover", "add" or "show")');
      if (action !== "discover" && action !== "add" && action !== "show") throw new MergeFailure("invalid-request", '"action" is "discover", "add" or "show"');
      if (action === "add" && !req.text?.trim()) throw new MergeFailure("invalid-request", "say the names to add (text: one `<kind>: <value>` per line)");
      if (!deps.names) throw new MergeFailure("unsupported", "this server runs no names step");
      return { changed: action !== "show", report: { names: await deps.names(q, action, req.text) } };
    }
    case "merge.setup": {
      const r = await q.setup({
        ...(req.command ? { command: req.command } : {}),
        ...(req.commands ? { commands: req.commands } : {}),
        ...(req.none ? { none: true } : {}),
        ...(req.takesMin ? { takesMin: req.takesMin } : {}),
        ...(req.requires ? { requires: req.requires } : {}),
        ...(req.dryRun ? { dryRun: true } : {}),
      });
      return { changed: !req.dryRun, report: { ...(r.run ? { run: r.run } : {}), view: await viewOf() } };
    }
  }
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === "") throw new MergeFailure("invalid-request", `name the ${what}`);
  return v;
}

// ---- the server's queues ------------------------------------------------------------------------

/** The roots of every project the queue has records for (to load and recover them at start). */
export function recordedRoots(base: string): string[] {
  const out: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(base);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const f = join(base, d, "queue.json");
    if (!existsSync(f)) continue;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { root?: unknown };
      if (typeof raw.root === "string" && existsSync(raw.root)) out.push(raw.root);
    } catch {}
  }
  return out;
}

/** The fallback runner until copy-checks' run is wired: every run is a machine failure (never blamed). */
export const unwiredRun: RunMerge = async () => ({ verdict: "machine", why: "the merge run isn't wired in this server", notes: [], checks: [] });

/** A thread wake that asks nobody. */
export const noThread: WakeThread = () => false;

/**
 * GET /api/merge-queue/cards?path=<session file> (or ?session=<path or id>): a chat's merge queue cards (server/merge-queue/cards.ts), as the
 * page draws them; {cards: []} while the queue isn't started or the chat has none.
 */
export function registerMergeCardRoutes(app: import("hono").Hono): void {
  // The queue's settings: read, the review and thread models, saves (settings-routes.ts).
  registerLiveMergeSettingsRoutes(app);
  // How a branch lands (al_3): Update Local Main, a request's Publish, How it lands (routes-landing.ts).
  registerLiveMergeLandingRoutes(app);
  // The merge thread's Run Logs chip: the run folders' size and Clean Logs (run-logs-routes.ts).
  registerLiveRunLogsRoutes(app);
  // Try Again on a branch summary that failed (branch-summaries.ts): {branch, commit}; refused for one that worked.
  app.post("/api/merge-queue/projects/:project/branch-summary", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { branch?: unknown; commit?: unknown } | null;
    const bad = (message: string) => c.json({ error: { code: "invalid-request", message } }, 400);
    if (!b || typeof b !== "object" || Array.isArray(b)) return bad("Expected JSON body { branch, commit }");
    if (typeof b.branch !== "string") return bad("branch must be a string");
    if (typeof b.commit !== "string") return bad("commit must be a string");
    const branch = b.branch.trim();
    const commit = b.commit.trim().toLowerCase();
    if (!branch || branch.length > 255) return bad("name the branch");
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return bad("commit is the full commit id the row shows");
    const { retryBranchSummary } = await import("./wire");
    const r = await retryBranchSummary(c.req.param("project"), branch, commit);
    if (r.ok) return c.json({ ok: true, state: "writing" });
    const status = r.code === "not-found" ? 404 : r.code === "busy" ? 409 : r.code === "unsupported" ? 501 : 400;
    return c.json({ error: { code: r.code, message: r.message } }, status);
  });
  // The landing bar's starting picture: every project's queue and releases in one quick read (wire.ts landingSummary).
  app.get("/api/merge-queue/landing-summary", async (c) => {
    const { landingSummary } = await import("./wire");
    return c.json(await landingSummary());
  });
  app.get("/api/merge-queue/cards", async (c) => {
    const raw = (c.req.query("path") ?? c.req.query("session"))?.trim();
    if (!raw) return c.json({ error: "name the session (its file path or id)" }, 400);
    const { getSessionSummary, listSessions } = await import("../sessions-index");
    const s = isAbsolute(raw) ? await getSessionSummary(raw).catch(() => null) : raw.length <= 200 ? ((await listSessions().catch(() => [])).find((x) => x.id === raw) ?? null) : null;
    if (!s) return c.json({ error: "No such session (name it by its file path or id)" }, 404);
    const id = s.id;
    const { mergeCardsOf, mergeReviewCardsOf } = await import("./wire");
    return c.json({ cards: mergeCardsOf(id), reviews: await mergeReviewCardsOf(id) });
  });
}

/** merge.add's `via`: a typed "open a PR" / "open an MR". */
function viaOf(v: string): "github-pr" | "gitlab-mr" {
  if (v !== "github-pr" && v !== "gitlab-mr") throw new MergeFailure("invalid-request", '"via" is "github-pr" or "gitlab-mr"');
  return v;
}
