import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MERGE_ANSWERS, type MergeAnswer, type MergeEntry, type MergeQueueView, type MergeReport, type MergeThreadAsk } from "../../shared/merge-queue";
import { type AnyVerb, isMergeVerb, type MergeVerb, MERGE_READ_VERBS, ordered, type VerbResult } from "../../shared/project-contract";
import type { Caller } from "../project-services/engine";
import type { RunMerge, WakeThread } from "./contract";
import { MergeFailure, type MergeQueues, type ProjectQueue } from "./queue";
import { registerLiveMergeSettingsRoutes } from "./settings-routes";
import { registerLiveMergeLandingRoutes } from "./routes-landing";
import { NOT_SERVED } from "./served";

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
  deliverReview?: (run: string, v: { verdict: "ok" | "notes" | "blocking"; text?: string }) => boolean;
  /** The thread's question: asked in the owning chat of `entry`'s branch (else held on the tab, one notification). */
  threadAsk?: (root: string, q: { question: string; entry?: MergeEntry }) => Promise<MergeThreadAsk>;
  /** A recorded question of `root`'s thread, by id. */
  askOf?: (root: string, id: string) => MergeThreadAsk | undefined;
  /** The user's answer to a question: closed, and handed to the thread. */
  threadAnswer?: (root: string, id: string, text: string, by: { kind: "chat" | "operator"; session?: string }) => Promise<MergeThreadAsk>;
  /** Start Fresh: the thread retired; true when there was one. */
  threadFresh?: (root: string) => Promise<boolean>;
  /** The History's clear: one queue chat by session id, or "all" the ended ones; how many were deleted. */
  clearChats?: (root: string, which: string) => Promise<number>;
  now?: () => number;
}

const THREAD_VERBS: readonly MergeVerb[] = ["merge.status", "merge.logs", "merge.note", "merge.extend", "merge.resolve", "merge.retry", "merge.ask", "merge.hold"];
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
}

const KEYS: Record<keyof Req, "string" | "boolean" | "number" | "strings"> = {
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
};

function parse(body: unknown): Req {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new MergeFailure("invalid-request", "the body is a JSON object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const want = KEYS[k as keyof Req];
    if (!want) continue; // the engine's own keys (confirm, …) and the CLI's extras ride along
    const ok =
      want === "strings"
        ? Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500)
        : want === "number"
          ? typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 5000
          : want === "string"
            ? typeof v === "string" && v.length <= 4000
            : typeof v === "boolean";
    if (!ok) throw new MergeFailure("invalid-request", `"${k}" must be ${want === "strings" ? "a list of names" : want === "number" ? "a whole number (1–5000)" : `a ${want}`}`);
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
export const CLICK_IS_THE_USERS =
  "a chat's own scripts never act as the user: landing, answering, removing from the queue, cancelling, pausing and the queue's other acts come only from the user's own click in Sova's page or their own word in the branch's chat. Nothing was done; ask the user";

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
  // Any other act from a chat's script on the operator's route: refused (the merge thread and a run's reviewer use their
  // own tool, a session caller, below). It still reads, and still runs a trial, as any chat on its project may.
  // One exception: the chat the merge thread asked in relays its user's answer (merge.reply), named by its own key.
  if (caller.kind === "operator" && caller.fromChat && verb === "merge.reply") {
    const ask = req.ask ? deps.askOf?.(root, req.ask) : undefined;
    if (caller.chat && ask?.askedIn?.session === caller.chat) return;
    throw new MergeFailure("forbidden", "only the chat the merge thread asked in relays the user's answer");
  }
  if (caller.kind === "operator" && caller.fromChat && !MERGE_READ_VERBS.includes(verb) && verb !== "merge.try") throw new MergeFailure("forbidden", CLICK_IS_THE_USERS);
  // A command a card ran (its view's code or its button's): a chat's or an extension's code, never the user's act here.
  if (caller.kind === "operator" && caller.fromCard && !MERGE_READ_VERBS.includes(verb)) throw new MergeFailure("forbidden", CARD_IS_NOT_THE_USERS);
  if (caller.kind === "operator") return;
  const reads = MERGE_READ_VERBS.includes(verb);
  const sid = sessionId(caller);
  // The run's reviewer works in the merge copy, whatever project its folder reads as: its run decides.
  if (sid && req.run && REVIEWER_VERBS.includes(verb) && deps.reviewerOf?.(req.run) === sid) return;
  if (caller.kind === "session" || caller.kind === "project-overseer" || caller.kind === "assistant") {
    if (caller.root !== root) throw new MergeFailure("forbidden", `this caller acts only on its own project${caller.root ? ` (${caller.root})` : ""}`);
  }
  if (sid && deps.isThreadChat?.(root, sid) && THREAD_VERBS.includes(verb)) return;
  if (reads && caller.kind !== "conform") return;
  // A trial saves and merges nothing: any chat on its own project may run one (the setup chat does); never merge.setup.
  // Never the merge thread or a run's reviewer: neither sets anything up.
  if (verb === "merge.try") {
    if (sid && deps.isThreadChat?.(root, sid)) throw new MergeFailure("forbidden", "the merge thread never sets anything up: it runs no trial");
    if (sid && deps.isReviewerChat?.(sid)) throw new MergeFailure("forbidden", "a run's reviewer runs no trial");
    if (caller.kind === "session") return;
    throw new MergeFailure("forbidden", "only the user or a chat on this project runs a trial");
  }
  // The chat a question was asked in relays the user's answer; nobody else does (the operator may, from the tab).
  if (verb === "merge.reply") {
    const ask = req.ask ? deps.askOf?.(root, req.ask) : undefined;
    if (sid && ask?.askedIn?.session === sid) return;
    throw new MergeFailure("forbidden", "only the chat the merge thread asked in relays the user's answer");
  }
  if (verb === "merge.setup") throw new MergeFailure("forbidden", SETUP_IS_THE_USERS);
  if (verb === "merge.add" || verb === "merge.answer" || verb === "merge.cancel" || verb === "merge.pause" || verb === "merge.resume" || verb === "merge.fresh" || verb === "merge.clear")
    throw new MergeFailure("forbidden", "only the user lands, cancels, pauses, answers or sets up the checks: their Land button or their own word in the branch's chat");
  if (verb === "merge.review") throw new MergeFailure("forbidden", "only the run's reviewer posts its review");
  throw new MergeFailure("forbidden", `only the project's merge thread calls ${verb}`);
}

async function dispatch(deps: MergerDeps, verb: MergeVerb, req: Req, q: ProjectQueue, caller: Caller): Promise<{ changed: boolean; report: MergeReport }> {
  const by = caller.kind === "operator" ? ("operator" as const) : ("thread" as const);
  const viewOf = async () => q.view();
  switch (verb) {
    case "merge.status":
      return { changed: false, report: { view: await viewOf() } };
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
        ...(req.note !== undefined ? { note: req.note } : {}),
      });
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.answer": {
      const a = need(req.answer, "answer");
      if (!(MERGE_ANSWERS as readonly string[]).includes(a)) throw new MergeFailure("invalid-request", 'answer is "accept", "send-back" or "land-anyway"');
      const e = await q.answer(need(req.entry, "entry"), a as MergeAnswer, req.why);
      return { changed: true, report: { entry: e, view: await viewOf() } };
    }
    case "merge.review": {
      const runId = need(req.run, "run");
      const v = need(req.verdict, "verdict");
      if (!["ok", "notes", "blocking"].includes(v)) throw new MergeFailure("invalid-request", 'verdict is "ok", "notes" or "blocking"');
      if ((v === "notes" || v === "blocking") && !req.text?.trim()) throw new MergeFailure("invalid-request", "say what the review found (text)");
      const verdict = { verdict: v as "ok" | "notes" | "blocking", ...(req.text?.trim() ? { text: req.text.trim() } : {}) };
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
      const ask = await deps.threadAsk(q.root, { question, ...(e ? { entry: e } : {}) });
      return { changed: true, report: { ask } };
    }
    case "merge.reply": {
      const id = need(req.ask, "question (ask)");
      const text = need(req.text?.trim(), "answer (text)");
      if (!deps.threadAnswer) throw new MergeFailure("unsupported", "no merge thread here to answer");
      // A chat's script relaying (authorize checked it is the chat asked in) answers as that chat, never as the tab.
      const relay = caller.kind === "operator" && caller.fromChat && caller.chat ? caller.chat : null;
      const ask = await deps.threadAnswer(q.root, id, text, relay ? { kind: "chat", session: relay } : caller.kind === "operator" ? { kind: "operator" } : { kind: "chat", ...(sessionId(caller) ? { session: sessionId(caller)! } : {}) });
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
    const { mergeCardsOf } = await import("./wire");
    return c.json({ cards: mergeCardsOf(id) });
  });
}

/** merge.add's `via`: a typed "open a PR" / "open an MR". */
function viaOf(v: string): "github-pr" | "gitlab-mr" {
  if (v !== "github-pr" && v !== "gitlab-mr") throw new MergeFailure("invalid-request", '"via" is "github-pr" or "gitlab-mr"');
  return v;
}
