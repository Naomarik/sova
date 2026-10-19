import type { StateView, ToolBlock, ToolCtx, ToolResult, ToolSpec } from "../../shared/harness";
import {
  isTourId, isTourFile, isTourHandle, normalizeTourAttachment, normalizeTourCardDetails, normalizeTourJob,
  normalizeTourCredentials, normalizeTourManifest, normalizeTourScriptRequest, normalizeTourVerification, tourCredentialsProblem,
  tourCredentialsShapeProblem, tourScriptProblem, RECORD_TOUR_TOOL, SHOW_TOUR_TOOL, TOUR_CREDENTIALS_IN_SCRIPT,
  type TourAttachment, type TourCardDetails, type TourCredentials, type TourJob, type TourManifest, type TourScriptRequest, type TourVerification,
} from "../../shared/tour";
import { WORKER_SESSION } from "../harness/state-kinds";
import { tourLookProblem, tourLookScript, type TourLookAnswer, type TourLookRequest } from "./look";

/** Supplied by the server's served-tool binding, never by the script or tool parameters. */
export interface TourToolCaller { sessionId: string; sessionFile: string; cwd: string; state: StateView }
/** `look`: a look's answer (§app.tours/look): its lists once finished, else what to do meanwhile. */
export interface TourToolJob { job: TourJob; steps: number; manifest?: TourManifest; look?: TourLookAnswer | { tourId: string; next: string } }
/** The recorder resolves policy/source again at each stage; a stale call snapshot is not permission. */
export interface TourToolRuntime {
  /** `credentials`: a supplied login for the tour's per-tour memory store only; never persisted or returned. */
  dryRun(caller: TourToolCaller, script: TourScriptRequest, tourId?: string, credentials?: TourCredentials): Promise<TourToolJob>;
  /** `credentials` are checked against the dry run's stored script by the runtime. */
  record(caller: TourToolCaller, dryRunId: string, credentials?: TourCredentials): Promise<TourToolJob>;
  /** A look before the first dry run (§app.tours/look): a queued no-image job; `credentials` as for a dry run. */
  look?(caller: TourToolCaller, request: TourLookRequest, tourId?: string, credentials?: TourCredentials): Promise<TourToolJob>;
  /** Waits until the job rests or needs the user, five minutes at most; `signal` (Stop) ends the wait at once. */
  status(caller: TourToolCaller, jobId: string, signal?: AbortSignal): Promise<TourToolJob>;
  cancel(caller: TourToolCaller, jobId: string): Promise<TourToolJob>;
  inspect(caller: TourToolCaller, jobId: string, capture?: string): Promise<{ result: TourToolJob; content: ToolBlock[] }>;
  check(caller: TourToolCaller, jobId: string, verification: TourVerification): Promise<TourToolJob>;
  show(caller: TourToolCaller, tourId: string, editionId?: string): Promise<TourManifest>;
}
let runtime: TourToolRuntime | undefined;
/** Bound once by the server's tour bootstrap. Chats only receive served declarations. */
export function setTourToolRuntime(value: TourToolRuntime | undefined): void { runtime = value; }
const getRuntime = () => { if (!runtime) throw new Error("Tour recording is not ready on this server. Try again after its tour service starts."); return runtime; };
const str = { type: "string", minLength: 1, maxLength: 100 };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
export const RECORD_TOUR_OPS = ["look", "dry-run", "record", "status", "cancel", "inspect", "check"] as const;
type RecordTourOp = (typeof RECORD_TOUR_OPS)[number];
/** What each operation takes besides `op`; `required` are refused by name when missing. */
const OP_FIELDS: Record<RecordTourOp, { allowed: string[]; required: string[] }> = {
  look: { allowed: ["source", "sites", "signIn", "signInRoute", "pages", "tourId", "credentials"], required: ["source", "pages"] },
  "dry-run": { allowed: ["script", "tourId", "credentials"], required: ["script"] },
  record: { allowed: ["dryRunId", "credentials"], required: ["dryRunId"] },
  status: { allowed: ["jobId"], required: ["jobId"] },
  cancel: { allowed: ["jobId"], required: ["jobId"] },
  inspect: { allowed: ["jobId", "capture"], required: ["jobId"] },
  check: { allowed: ["jobId", "verification"], required: ["jobId", "verification"] },
};
/** One plain object at the root: several providers reject a root oneOf/anyOf/allOf and then send no
    arguments at all. Each operation's own fields are checked by name in execute. */
const recordParams = obj({
  op: { type: "string", enum: [...RECORD_TOUR_OPS], description: "look(source, pages, signIn?|signInRoute?, sites?, tourId?, credentials?) → dry-run(script, tourId?, credentials?) → record(dryRunId, credentials?) → inspect(jobId, capture?) → check(jobId, verification); status/cancel(jobId). status waits until the job finishes, fails, rests for you or needs the user (up to five minutes)." },
  script: { type: "object", description: "dry-run only: the whole declarative tour script from vis_guide with tour." },
  tourId: { ...str, description: "look and dry-run, optional: the tour to use; reuse the look's tourId for the dry run so it starts signed in." },
  source: { type: "object", description: "look only: the source the script will name." },
  sites: { type: "array", items: { type: "string" }, description: "look only, optional: the script's sites." },
  signIn: { type: "object", description: "look only, optional: the script's signIn, when known." },
  signInRoute: { type: "string", description: "look only, optional, before signIn is known: the sign-in page's route; the look lists that page signed out." },
  pages: { type: "array", maxItems: 10, items: { type: "object" }, description: "look only: up to 10 {route, actions?} (actions: a list for both sizes, or {desktop?, phone?}); [] with signInRoute lists only the sign-in page." },
  credentials: { type: "object", description: "look, dry-run and record, optional: a login you were given for the script's signIn, keyed by sign-in origin: {\"https://app.example\": {account?, username, password, code?}} (account exactly when signIn declares an account box). Kept in memory for this tour only; never stored, echoed or put in the script." },
  dryRunId: { ...str, description: "record only: the job id of a successful dry run." },
  jobId: { ...str, description: "status, cancel, inspect and check: the job id." },
  capture: { type: "string", maxLength: 124, description: "inspect only, optional: an exact capture filename from the report." },
  verification: obj({
    overviewReviewed: { type: "boolean", description: "true only after actually looking at every overview cell." },
    suspiciousCapturesReviewed: { type: "array", maxItems: 672, items: { type: "string", maxLength: 124 }, description: "Every capture you opened closely, including each reported suspicious one." },
    notes: { type: "string", minLength: 1, maxLength: 2000, description: "What you checked and resolved." },
  }, ["overviewReviewed", "suspiciousCapturesReviewed", "notes"]),
}, ["op"]);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Login values of 4+ characters, to keep out of anything written or returned (shorter ones would match by chance). */
const secretsOf = (c: TourCredentials | undefined): string[] => c ? Object.values(c).flatMap(e => [...(e.account !== undefined ? [e.account] : []), e.username, e.password, ...(e.code !== undefined ? [e.code] : [])]).filter(x => x.length >= 4) : [];
const leaks = (secrets: string[], value: unknown): boolean => { if (!secrets.length) return false; const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; return secrets.some(x => text.includes(x)); };
const SECRET_IN_TOUR = TOUR_CREDENTIALS_IN_SCRIPT;
/** Supplied credentials, refused by name (never by value) when malformed. */
function credentialsFor(p: Record<string, unknown>, script?: TourScriptRequest): TourCredentials | undefined {
  if (p.credentials === undefined) return undefined;
  if (script) {
    const allowed = script.signIn?.origins ?? (script.source.kind === "site" ? [script.source.origin] : undefined);
    const problem = tourCredentialsProblem(p.credentials, script.signIn, allowed);
    if (problem) throw new Error(problem);
    return normalizeTourCredentials(p.credentials, allowed);
  }
  const problem = tourCredentialsShapeProblem(p.credentials);
  if (problem) throw new Error(problem);
  return normalizeTourCredentials(p.credentials);
}
/** Runs a service call holding supplied credentials: nothing it returns or throws may carry one of their values. */
async function guarded(secrets: string[], run: () => Promise<ToolResult<TourCardDetails>>): Promise<ToolResult<TourCardDetails>> {
  let result: ToolResult<TourCardDetails>;
  try { result = await run(); } catch (error) {
    if (leaks(secrets, error instanceof Error ? error.message : String(error))) throw new Error("The recording request failed. Its reason mentioned a sign-in detail, so it isn't shown.");
    throw error;
  }
  if (leaks(secrets, result)) throw new Error("The recording's answer mentioned a sign-in detail, so it isn't shown. Check the tour with status.");
  return result;
}
const exact = (p: Record<string, unknown>, allowed: string[]) => { if (Object.keys(p).some(k => !allowed.includes(k))) throw new Error("Unknown tour parameter. Read vis_guide with tour for the exact workflow."); };
function callerFor(sessionId: string, sessionFile: string, ctx: ToolCtx | undefined, recording = false): TourToolCaller {
  if (!ctx || ctx.sessionId !== sessionId) throw new Error("The tour request has no trusted owning chat context.");
  const state = ctx.state();
  if (recording && state.has(WORKER_SESSION)) throw new Error("Worker recording is unavailable until its parent sandbox scope can be verified. Ask the owning chat to record this tour.");
  return { sessionId, sessionFile, cwd: ctx.cwd, state };
}
export function tourJobCard(result: TourToolJob): TourCardDetails {
  const { job, manifest } = result;
  if (!normalizeTourJob(job) || (job.phase === "ready" && (!manifest || !normalizeTourManifest(manifest) || manifest.id !== job.tourId || manifest.editionId !== job.editionId))) throw new Error("The recorder returned no matching checked edition. No finished tour was shown.");
  const card = normalizeTourCardDetails({ v: 1, tourId: job.tourId, title: job.title, steps: result.steps, status: job.phase, jobId: job.id, ...(job.editionId ? { editionId: job.editionId } : {}), ...(job.phase === "ready" && manifest?.steps.flatMap(s => s.views).find(v => v.kind === "page")?.captures.desktop?.image ? { cover: manifest.steps.flatMap(s => s.views).find(v => v.kind === "page")!.captures.desktop!.image } : {}) });
  if (!card) throw new Error("The recorder returned an invalid tour card. No finished tour was shown.");
  return card;
}
function answer(result: TourToolJob, caller: TourToolCaller, content?: ToolBlock[]): ToolResult<TourCardDetails> {
  const job = result.job;
  if (job.sessionId !== caller.sessionId) throw new Error("That recording belongs to another chat.");
  return { details: tourJobCard(result), content: content ?? [{ type: "text", text: JSON.stringify({ job, steps: result.steps, ...(result.look ? { look: result.look } : {}) }) }] };
}
/** Ordinary chats use both tools only while the vis tools are active. */
export function tourTools(sessionId: string, sessionFile: string): ToolSpec[] {
  return [{
    name: RECORD_TOUR_TOOL, label: "record tour",
    description: "Prepare and record a real UI tour. Read vis_guide with tour first. look(source,pages,signIn?|signInRoute?) lists each page's real controls first → dry-run(script,tourId?,credentials?) → record(dryRunId,credentials?) → inspect(jobId,capture?) → check(jobId,verification); status/cancel use jobId. Submits nothing but a declared signIn. Only an explicit checked edition can be shown.\nRules: each picture is one screen (desktop 1440×960, phone 390×844), so every target a view names must be fully on it (use {op:\"reveal\", target}); every target must match exactly one visible control; take targets from the look, role and name first; tourId goes beside the script, never inside it; status waits for the job to rest or need the user (up to five minutes), so never sleep or poll in a loop.",
    parameters: recordParams,
    async execute(_id, params: unknown, signal, _onUpdate, ctx) {
      if (!record(params)) throw new Error("Tour parameters must be an object.");
      const p = params; const op = p.op;
      if (!RECORD_TOUR_OPS.includes(op as RecordTourOp)) throw new Error(`record_tour needs "op": one of ${RECORD_TOUR_OPS.join(", ")}. Read vis_guide with tour for the workflow.`);
      const fields = OP_FIELDS[op as RecordTourOp];
      const extra = Object.keys(p).filter(k => k !== "op" && !fields.allowed.includes(k));
      if (extra.length) throw new Error(`Unknown tour parameter for ${op}: ${extra.join(", ")}. ${op} takes ${fields.allowed.join(", ")}.`);
      const missing = fields.required.filter(k => p[k] === undefined);
      if (missing.length) throw new Error(`${op} needs ${missing.join(" and ")}. Read vis_guide with tour for the exact workflow.`);
      const caller = callerFor(sessionId, sessionFile, ctx, ["look", "dry-run", "record", "check"].includes(String(op)));
      const service = getRuntime();
      if (op === "look") {
        const { op: _op, tourId, credentials: _c, ...request } = p;
        const problem = tourLookProblem(request);
        if (problem) throw new Error(problem);
        if (tourId !== undefined && !isTourId(tourId)) throw new Error("Invalid tour id.");
        if (!service.look) throw new Error("This server can't look at pages yet. Run the dry run instead.");
        const look = request as unknown as TourLookRequest;
        const credentials = credentialsFor(p, tourLookScript(look));
        const secrets = secretsOf(credentials);
        if (leaks(secrets, request)) throw new Error(SECRET_IN_TOUR);
        const run = service.look.bind(service);
        return guarded(secrets, async () => answer(await run(caller, look, tourId as string | undefined, credentials), caller));
      }
      if (op === "dry-run") {
        exact(p, ["op", "script", "tourId", "credentials"]);
        // A project source names its running copy alone; the server derives and checks the rest.
        const script = normalizeTourScriptRequest(p.script);
        if (!script) throw new Error(tourScriptProblem(p.script) ?? "The tour script is invalid or too large. Use the exact declarative schema from vis_guide with tour; split a tour over its limits.");
        if (p.tourId !== undefined && !isTourId(p.tourId)) throw new Error("Invalid tour id.");
        const credentials = credentialsFor(p, script);
        const secrets = secretsOf(credentials);
        // Nothing is written yet: a login value inside the script would be persisted with it.
        if (leaks(secrets, script)) throw new Error(SECRET_IN_TOUR);
        const tourId = p.tourId;
        return guarded(secrets, async () => answer(await service.dryRun(caller, script, tourId, credentials), caller));
      }
      if (op === "record") {
        exact(p, ["op", "dryRunId", "credentials"]);
        if (!isTourId(p.dryRunId)) throw new Error("record needs the successful dryRunId.");
        const credentials = credentialsFor(p);
        const dryRunId = p.dryRunId;
        return guarded(secretsOf(credentials), async () => answer(await service.record(caller, dryRunId, credentials), caller));
      }
      if (!isTourId(p.jobId)) throw new Error("This operation needs its owning jobId.");
      if (op === "status") { exact(p, ["op", "jobId"]); return answer(await service.status(caller, p.jobId, signal), caller); }
      if (op === "cancel") { exact(p, ["op", "jobId"]); return answer(await service.cancel(caller, p.jobId), caller); }
      if (op === "inspect") {
        exact(p, ["op", "jobId", "capture"]);
        if (p.capture !== undefined && !isTourFile(p.capture)) throw new Error("Inspect only an exact capture filename listed in the job report.");
        const inspected = await service.inspect(caller, p.jobId, p.capture);
        return answer(inspected.result, caller, inspected.content);
      }
      if (op === "check") {
        exact(p, ["op", "jobId", "verification"]);
        const verification = normalizeTourVerification(p.verification);
        if (!verification) throw new Error("Checking needs actual overview review, inspected capture filenames and a concrete verification note.");
        return answer(await service.check(caller, p.jobId, verification), caller);
      }
      throw new Error("Unknown tour operation. Use look, dry-run, record, status, cancel, inspect or check.");
    },
  }, {
    name: SHOW_TOUR_TOOL, label: "show tour",
    description: "Present one complete checked tour edition from this chat. Record and visually check it first; never records on display. Read vis_guide with tour for the workflow.",
    parameters: obj({ tourId: str, editionId: str }, ["tourId"]),
    async execute(_id, params: unknown, _signal, _onUpdate, ctx) {
      if (!record(params)) throw new Error("Tour parameters must be an object.");
      exact(params, ["tourId", "editionId"]);
      if (!isTourId(params.tourId) || (params.editionId !== undefined && !isTourId(params.editionId))) throw new Error("Invalid tour or edition id.");
      const m = normalizeTourManifest(await getRuntime().show(callerFor(sessionId, sessionFile, ctx), params.tourId, params.editionId));
      if (!m || m.id !== params.tourId || (params.editionId && m.editionId !== params.editionId)) throw new Error("This tour has no matching complete checked edition. Nothing was shown.");
      const cover = m.steps.flatMap(s => s.views).find(v => v.kind === "page");
      const details = normalizeTourCardDetails({ v: 1, tourId: m.id, editionId: m.editionId, title: m.title, steps: m.steps.length, status: "ready", ...(cover?.captures.desktop?.image || cover?.captures.phone?.image ? { cover: cover.captures.desktop?.image ?? cover.captures.phone!.image } : {}) })!;
      return { content: [{ type: "text", text: `Tour ready: ${m.title} · ${m.steps.length} steps.` }], details };
    },
  }];
}
/** Hand-offs can name only a reviewed handle already bound to their authorized conversation. */
export function showBatonTourTool(resolve: (handle: string) => Promise<TourAttachment>): ToolSpec {
  return {
    name: SHOW_TOUR_TOOL, label: "show tour",
    description: "Show a reviewed tour already attached to this conversation, using only its opaque handle. Never records or widens access. A request for more coverage waits for an authorized builder.",
    parameters: obj({ handle: { type: "string", pattern: "^tr_[A-Za-z0-9_-]{16}$" } }, ["handle"]),
    async execute(_id, params: unknown) {
      if (!record(params)) throw new Error("Tour parameters must be an object.");
      exact(params, ["handle"]);
      if (!isTourHandle(params.handle)) throw new Error("Choose an attached tour handle from this conversation.");
      const attachment = normalizeTourAttachment(await resolve(params.handle));
      if (!attachment || attachment.handle !== params.handle) throw new Error("That tour is not available in this conversation.");
      return { content: [{ type: "text", text: `${attachment.title}: ${attachment.summary}` }], details: { v: 1, handle: attachment.handle, title: attachment.title, summary: attachment.summary, steps: attachment.steps } };
    },
  };
}
