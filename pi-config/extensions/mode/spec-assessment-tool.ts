/** SDK adapter: task boundaries are persisted user entry ids, not agent_start guesses. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { resolve, relative } from "node:path";
import { ASSESSMENT_TASK_ENTRY, assessmentAttribution, assessmentPrepareArgs, callAssessment, decodeAssessmentTask, observeAssessment, startAssessmentTask, type AssessmentTask } from "./spec-assessment.ts";

export const ASSESSMENT_TOOL = "spec_assess";
export interface AssessmentHost { core(): string; enabled(): boolean; worker: boolean | (() => boolean); roots?(ctx: ExtensionContext): readonly string[] }
export function currentAssessmentTaskId(branch: readonly unknown[]): string | null {
 for (let i = branch.length - 1; i >= 0; i--) {
  const e = branch[i] as { type?: string; id?: string; message?: { role?: string } };
  if (e.type === "message" && e.message?.role === "user") return typeof e.id === "string" ? e.id : null;
 }
 return null;
}

export function registerAssessmentTool(pi: ExtensionAPI, host: AssessmentHost): void {
 let attempt: string | null = null;
 let pending = Promise.resolve();
 const tasks = new Map<string, AssessmentTask>();
 const snapshots = new Map<string, string | null>();
 const queue = <T>(fn: () => Promise<T>): Promise<T> => { const result = pending.then(fn, fn); pending = result.then(() => undefined, () => undefined); return result; };
 const persist = (root: string, task: AssessmentTask) => { pi.appendEntry(ASSESSMENT_TASK_ENTRY, { v: 1, root, task: structuredClone(task), attemptId: attempt }); snapshots.set(JSON.stringify([task.sessionId, task.taskId, root]), attempt); };
 async function taskFor(ctx: ExtensionContext, root: string): Promise<AssessmentTask> {
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch();
  const taskId = currentAssessmentTaskId(branch);
  const key = JSON.stringify([sessionId, taskId, root]);
  const cached = tasks.get(key);
  if (cached) { if (snapshots.get(key) !== attempt) persist(root, cached); return cached; }
  let task: AssessmentTask | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
   const e = branch[i] as { type?: string; customType?: string; data?: { root?: string; task?: unknown } };
   if (e.type !== "custom" || e.customType !== ASSESSMENT_TASK_ENTRY || e.data?.root !== root) continue;
   const raw = e.data.task as { sessionId?: unknown; taskId?: unknown } | undefined;
   const saved = decodeAssessmentTask(e.data.task);
   if (raw?.sessionId === sessionId && raw.taskId === taskId && !saved) throw new Error("persisted assessment task baseline corrupt");
   if (saved?.sessionId === sessionId && saved.taskId === taskId) { task = saved; break; }
  }
  task ??= await startAssessmentTask(host.core(), root, sessionId, taskId, callAssessment, ctx.signal);
  tasks.set(key, task);
  persist(root, task);
  return task;
 }
 const isWorker = () => typeof host.worker === "function" ? host.worker() : host.worker;
 const rootsOf = (ctx: ExtensionContext) => [...new Set((host.roots?.(ctx) ?? [ctx.cwd]).map(p => resolve(ctx.cwd, p)))];
 const failure = (message: string, ctx: ExtensionContext, root?: string) => { try { pi.appendEntry("spec-assessment-error", { v: 1, message, sessionId: ctx.sessionManager.getSessionId(), taskId: currentAssessmentTaskId(ctx.sessionManager.getBranch()), attemptId: attempt, ...(root ? { root } : {}) }); } catch { /* teardown */ } };
 async function observe(ctx: ExtensionContext): Promise<void> {
  for (const root of rootsOf(ctx)) {
   const task = await taskFor(ctx, root);
   const result = await observeAssessment(host.core(), root, task, assessmentAttribution(ctx.sessionManager.getSessionId(), task.taskId, attempt, isWorker()), callAssessment, ctx.signal);
   if (result.failure) failure(result.failure, ctx, root);
   if (result.receipt) persist(root, task);
  }
 }
 pi.on("session_start", () => { tasks.clear(); snapshots.clear(); attempt = null; });
 pi.on("agent_start", () => { if (host.enabled()) attempt = randomUUID(); });
 pi.on("tool_call", async (event, ctx) => {
  if (!host.enabled()) return;
  await queue(async () => { try {
   for (const root of rootsOf(ctx)) {
    const task = await taskFor(ctx, root);
    const path = (event.input as { path?: unknown } | undefined)?.path;
    if (!task.base && (event.toolName === "write" || event.toolName === "edit") && typeof path === "string") {
     const rel = relative(root, resolve(ctx.cwd, path));
     if (rel && !rel.startsWith("../") && !task.paths.includes(rel)) { task.paths.push(rel); persist(root, task); }
    }
   }
  } catch { failure("task baseline capture or persistence unavailable", ctx); } });
 });
 pi.on("tool_result", async (event, ctx) => {
  if (event.toolName === ASSESSMENT_TOOL) {
   const details = event.details as { exit?: unknown; written?: unknown } | undefined;
   const action = event.input.action;
   if (details?.exit === 2 || (action === "prepare" || action === "record") && details?.written !== true) return { isError: true };
   return;
  }
  if (!host.enabled() || ["read", "grep", "find", "ls"].includes(event.toolName)) return;
  await queue(async () => { try { await observe(ctx); } catch { failure("automatic assessment observation unavailable", ctx); } });
 });
 pi.on("agent_before_settle", async (_event, ctx) => {
  if (!host.enabled() || !tasks.size) return;
  await queue(async () => { try { await observe(ctx); } catch { failure("settle assessment observation unavailable", ctx); } });
 });
 pi.registerTool({
  name: ASSESSMENT_TOOL, label: "Spec assessment",
  description: "Prepare or query observation-only input-bound spec assessments, or record explicit changed/preserved/not-applicable/unresolved decisions and verification bases. Neither a disposition nor current inputs proves correctness. Automatic unresolved observations are retained. Native workers can use the companion CLI. Record requires by and decisions; omission never clears a candidate.",
  parameters: Type.Object({ action: Type.Union([Type.Literal("prepare"), Type.Literal("record"), Type.Literal("status")]), name: Type.Optional(Type.String()), by: Type.Optional(Type.String()), decisions: Type.Optional(Type.Unknown()), paths: Type.Optional(Type.Array(Type.String())), draft: Type.Optional(Type.String()), self: Type.Optional(Type.Boolean()) }),
  async execute(_id, params, _signal, _update, ctx) {
   if (!host.enabled()) throw new Error("Spec assessments require spec mode here");
   return queue(async () => {
    const root = resolve(ctx.cwd);
    const task = await taskFor(ctx, root);
    const attribution = assessmentAttribution(ctx.sessionManager.getSessionId(), task.taskId, attempt, isWorker());
    const name = params.name ?? task.receipt;
    let args: string[];
    if (params.action === "prepare") {
     args = assessmentPrepareArgs(task, params.name ?? `task-${randomUUID()}`, attribution, params.paths ?? []);
     if (params.draft) args.push("--draft", params.draft);
     const preview = await callAssessment(host.core(), root, args, ctx.signal);
     if (task.unknowns.includes("initial input capture unavailable") || task.base === null && (preview.query as { base?: unknown } | undefined)?.base !== null) throw new Error("The task's fixed initial baseline is unavailable; a later HEAD cannot replace it");
     args.push("--write");
    } else if (params.action === "record") {
     if (!name || !params.by || !params.decisions) throw new Error("Record needs name (or an observed receipt), by, and decisions");
     args = ["record", name, "--by", params.by, "--decisions-json", JSON.stringify(params.decisions), "--attribution-json", JSON.stringify(attribution), ...(params.self ? ["--self"] : []), "--write"];
    } else args = name ? ["status", name] : ["status", "--owner-session", attribution.ownerSessionId ?? "unknown"];
    const details = await callAssessment(host.core(), root, args, ctx.signal);
    if (params.action === "prepare" && details.written === true && typeof details.name === "string") { task.receipt = details.name; task.fingerprint = typeof details.fingerprint === "string" ? details.fingerprint : undefined; persist(root, task); }
    const serialized = JSON.stringify(details);
    return { content: [{ type: "text" as const, text: serialized.length > 8000 ? `${serialized.slice(0, 8000)}\n[Assessment result truncated; query the receipt with the trusted CLI.]` : serialized }], details };
   });
  },
 });
}
