import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MERGE_ANSWERS, type MergeAnswer, type MergeQueueView, type MergeReport } from "../../shared/merge-queue";
import { type AnyVerb, isMergeVerb, type MergeVerb, MERGE_READ_VERBS, ordered, type VerbResult } from "../../shared/project-contract";
import type { Caller } from "../project-services/engine";
import type { RunMerge, WakeThread } from "./contract";
import { MergeFailure, type MergeQueues, type ProjectQueue } from "./queue";
import { NOT_SERVED } from "./served";

/**
 * The merge verbs (POST /api/project-services/merge.<x>, through the engine's `merger` hook; the merge thread's tool
 * calls the same): who may call which, and what each answers (`VerbResult.merge`).
 *
 * Callers:
 * - the operator (the screens' buttons, the CLI): every verb; `merge.answer` and `merge.add` are the user's alone;
 * - the project's merge thread (its recorded chat): status, logs, note, extend, resolve, retry;
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
  /** The recorded merge thread of `root` is `sessionId`. */
  isThreadChat?: (root: string, sessionId: string) => boolean;
  /** The reviewer chat run `run` waits on. */
  reviewerOf?: (run: string) => string | null;
  /** Hand a reviewer's verdict to the review step (review-step.ts deliverReview); false: none waits. */
  deliverReview?: (run: string, v: { verdict: "ok" | "notes" | "blocking"; text?: string }) => boolean;
  now?: () => number;
}

const THREAD_VERBS: readonly MergeVerb[] = ["merge.status", "merge.logs", "merge.note", "merge.extend", "merge.resolve", "merge.retry"];
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
  command?: string;
  commands?: string[];
  none?: boolean;
  takesMin?: number;
  requires?: string[];
  dryRun?: boolean;
}

const KEYS: Record<keyof Req, "string" | "boolean" | "number" | "strings"> = {
  project: "string",
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
        return result(verb, root, true, false, { view: await deps.served.bareView(root) }, undefined, now());
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

/** The verbs a project on the Projects list may call before its merge setup is done. */
const SETUP_VERBS: readonly MergeVerb[] = ["merge.status", "merge.setup"];

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
  if (verb === "merge.add" || verb === "merge.answer" || verb === "merge.cancel" || verb === "merge.pause" || verb === "merge.resume" || verb === "merge.setup")
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
