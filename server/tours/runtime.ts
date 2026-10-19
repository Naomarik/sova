import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isTourId, isTourOrigin, normalizeTourManifest, normalizeTourScript, normalizeTourScriptRequest, tourCredentialsProblem, tourScriptProblem, tourSignInOrigins, TOUR_CREDENTIAL_LIMITS, TOUR_CREDENTIALS_IN_SCRIPT, TOUR_VIEWPORTS, type TourCredentials, type TourFailure, type TourScriptRequest, type TourEdition, type TourJob, type TourManifest, type TourScript, type TourSignInRequirement, type TourVerification } from "../../shared/tour";
import { stateRoot } from "../state-root";
import { resolveTourTarget, TourTargetRefused, TourTargetUnverifiable } from "../project-services/tour-target";
import { TourApprovalStore } from "./approvals";
import { TourAccountStore, type TourAccountInput } from "./accounts";
import { assertTourCoverage, checkTourManifest, tourAsset, tourScriptDigest } from "./checks";
import { resolveTourContext, resolveTourSource, type TourContextDeps } from "./context";
import { TourPrivateStore, type TourPrivateAttempt } from "./private";
import { isTourSessionDeleted, markTourSessionDeleted } from "./deleted";
import { TourJobBlocked, TourJobFailure, TourJobQueue, type TourJobPatch } from "./queue";
import { freshCheck, runTourAttempt, TOUR_SOVA_SIGN_IN_REFUSAL, type TourSignInAnswer, type TourSignInNeed } from "./runner";
import { TOUR_SIGN_IN_STALE, TOUR_SIGN_IN_WRONG } from "./runner-protocol";
import { TourSignInStore } from "./signin-store";
import { tourJobTerminal } from "./job";
import { TourCaptureFailure } from "./targets";
import { TourStore } from "./store";
import { tourLookAnswer, tourLookPending, tourLookProblem, tourLookScript, tourLookWithout, type TourLookRequest } from "./look";
import { TOUR_SOVA_REFUSAL } from "./runner-header";
import { setTourToolRuntime, type TourToolCaller, type TourToolJob, type TourToolRuntime } from "./tools";

/** A site a tour uses, and what this installation holds for it now. */
export interface TourSiteState { origin: string; approved: boolean; account: boolean }
/** What the chat is told when a recording waits for a sign-in: no value, ever. */
export interface TourNeedsYou { sessionId: string; tourId: string; jobId: string; origin: string; fields: TourSignInRequirement["fields"]; title?: string; since?: string }
export interface TourWaitingSignIn extends TourNeedsYou { since: string }
let needsYouHook: ((event: TourNeedsYou) => void) | undefined;
/** The user answered a recording's sign-in or site approval and the job continued (§app.tours/sites); `at` names that answer. Never a login value. */
export interface TourResumed { sessionId: string; tourId: string; jobId: string; title?: string; answered: "sign-in" | "site-approval"; origin?: string; at: string }
let resumedHook: ((event: TourResumed) => void) | undefined;
/** The server's wiring for the chat's "the recording continued" notice (set once, at startup). */
export function setTourResumed(fn: ((event: TourResumed) => void) | undefined): void { resumedHook = fn; }
/** The server's wiring for the chat's "needs you" mark and notice (set once, at startup). */
export function setTourNeedsYou(fn: ((event: TourNeedsYou) => void) | undefined): void { needsYouHook = fn; }
/** Refused, written nowhere: a supplied login value appears in what would be stored or returned. */
export { TOUR_CREDENTIALS_IN_SCRIPT };
export const TOUR_SIGN_IN_EXPIRED = "The sign-in expired after an hour. Record again.";
/** Every printed form a value could take in stored JSON: raw, JSON-escaped and URL-encoded. Values under 4 characters are exempt. */
function leaks(text: string, values: Iterable<string>): boolean {
  for (const v of values) if (v.length >= 4 && [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)].some(form => text.includes(form))) return true;
  return false;
}
export interface TourRuntimeOptions {
  root: string;
  queue?: TourJobQueue; store?: TourStore; artifacts?: TourPrivateStore;
  approvals?: TourApprovalStore; accounts?: TourAccountStore;
  context?: TourContextDeps;
  run?: typeof runTourAttempt;
  target?: typeof resolveTourTarget;
  /** The per-tour sign-in memory; defaults to a fresh one (memory only). */
  signIns?: TourSignInStore;
  /** A recording entered needs-sign-in (never a silent sign-in). */
  onNeedsYou?: (event: TourNeedsYou) => void;
  /** The user answered a sign-in or site approval and the job continued. */
  onResumed?: (event: TourResumed) => void;
  /** How long a status call waits for a change at most (default five minutes). */
  statusWaitMs?: number;
}
export const TOUR_STATUS_WAIT_MS = 300_000;
/** What a status call compares (§app.tours/recording). Progress (the completed count) is not part of it. */
const jobSignature = (job: TourJob): string => JSON.stringify([job.phase, job.failure ?? null, job.requirements ?? null]);
/** Phases only the agent can move on from: waiting there would only cost time. */
const RESTING: ReadonlySet<string> = new Set(["checking", "ready", "failed", "cancelled", "interrupted"]);
/** Phases waiting on the user. */
const NEEDS: ReadonlySet<string> = new Set(["needs-sign-in", "needs-site-approval", "needs-test-account"]);
/**
 * Whether the job as it is now wakes a chat that last saw `last` (a jobSignature): it came to rest, it started
 * waiting on the user, or, still waiting on the user, what it asks for or its failure changed. Moving between
 * working phases (queued, dry-run, recording) and progress never wake.
 */
function wakes(last: string, job: TourJob): boolean {
  if (last === jobSignature(job) || !(RESTING.has(job.phase) || NEEDS.has(job.phase))) return false;
  const [phase] = JSON.parse(last) as [string];
  return phase !== job.phase || NEEDS.has(job.phase);
}
type Waiter = TourWaitingSignIn & { phase: "dry-run" | "recording"; resolve: (answer: TourSignInAnswer) => void; reject: (error: Error) => void };
/** The only adapter between served tools, durable jobs, contained capture and checked editions. */
export class TourRuntime implements TourToolRuntime {
  readonly queue: TourJobQueue;
  readonly store: TourStore;
  readonly artifacts: TourPrivateStore;
  readonly approvals: TourApprovalStore;
  readonly accounts: TourAccountStore;
  readonly signIns: TourSignInStore;
  private readonly waiters = new Map<string, Waiter>();
  /** Running executions, so the hour running out can stop the ones of its tour. */
  private readonly live = new Map<string, { sessionId: string; tourId: string; expire: () => void }>();
  private readonly unsubscribe: () => void;
  private readonly unexpire: () => void;
  private readonly deletedSessions = new Set<string>();
  private readonly removals = new Map<string, Promise<void>>();
  /** Per chat and job, the job as that chat last saw it (memory only: a restart forgets, so the next status answers at once). */
  private readonly seen = new Map<string, string>();
  private readonly statusWaits = new Set<() => void>();
  /** Per job, its latest user answer that let it continue (memory only). */
  private readonly answers = new Map<string, { at: string; sessionId: string }>();
  private answerSeq = 0;
  constructor(private readonly options: TourRuntimeOptions) {
    this.queue = options.queue ?? new TourJobQueue({ root: join(options.root, "tour-jobs") });
    this.store = options.store ?? new TourStore(join(options.root, "tours"));
    this.artifacts = options.artifacts ?? new TourPrivateStore(join(options.root, "tour-private"));
    this.approvals = options.approvals ?? new TourApprovalStore(join(options.root, "tour-approvals"));
    this.accounts = options.accounts ?? new TourAccountStore(join(options.root, "tour-accounts"));
    this.signIns = options.signIns ?? new TourSignInStore();
    this.unsubscribe = this.queue.subscribe(job => {
      const a = this.isDeleted(job.sessionId) ? null : this.artifacts.read(job.sessionId, job.id);
      // The tour's sign-in goes when its recording ends, or when any of its jobs is cancelled.
      if (tourJobTerminal(job) && (job.phase === "cancelled" || a?.mode === "record")) this.signIns.clear(job.sessionId, job.tourId);
      if (a) this.artifacts.save({ ...a, report: job });
    });
    this.unexpire = this.signIns.onExpire((sessionId, tourId) => {
      for (const run of this.live.values()) if (run.sessionId === sessionId && run.tourId === tourId) run.expire();
    });
  }
  async dryRun(caller: TourToolCaller, input: TourScriptRequest, tourId: string = randomUUID(), credentials?: TourCredentials): Promise<TourToolJob> {
    this.assertActive(caller.sessionId);
    if (!isTourId(tourId)) throw new Error("Invalid tour id.");
    const context = await resolveTourContext(caller, this.options.context);
    const request = normalizeTourScriptRequest(input);
    if (!request) throw new Error(tourScriptProblem(input) ?? "Invalid tour script. Read vis_guide with tour before recording.");
    // The stored script always holds the full source Sova derived, pinned for every later attempt.
    const script = normalizeTourScript({ ...request, source: await resolveTourSource(context, request.source, this.options.context) });
    if (!script) throw new Error("Invalid tour script. Read vis_guide with tour before recording.");
    this.assertActive(caller.sessionId);
    // A declared source cannot retarget an existing tour on re-record.
    const previous = this.store.latestEdition(caller.sessionId, tourId);
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(script.source)) throw new Error("Re-record must keep this tour's original source identity. Create a new tour for another source.");
    await this.checkSignIn(caller, script, credentials);
    return this.saw(caller.sessionId, this.submitWith(caller, script, tourId, "dry-run", undefined, credentials));
  }
  /** A look (§app.tours/look): a no-image dry run of the pages asked for, holding its sign-in under `tourId` for the dry run. */
  async look(caller: TourToolCaller, input: TourLookRequest, tourId: string = randomUUID(), credentials?: TourCredentials): Promise<TourToolJob> {
    this.assertActive(caller.sessionId);
    if (!isTourId(tourId)) throw new Error("Invalid tour id.");
    const problem = tourLookProblem(input);
    if (problem) throw new Error(problem);
    const context = await resolveTourContext(caller, this.options.context);
    const request = normalizeTourScriptRequest(tourLookScript(input));
    if (!request) throw new Error("Invalid look request.");
    const script = normalizeTourScript({ ...request, source: await resolveTourSource(context, request.source, this.options.context) });
    if (!script) throw new Error("Invalid look request.");
    this.assertActive(caller.sessionId);
    const previous = this.store.latestEdition(caller.sessionId, tourId);
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(script.source)) throw new Error("A look must keep this tour's original source identity. Use a new tour for another source.");
    await this.checkSignIn(caller, script, credentials);
    return this.saw(caller.sessionId, this.submitWith(caller, script, tourId, "look", undefined, credentials, input.signInRoute));
  }
  async record(caller: TourToolCaller, dryRunId: string, credentials?: TourCredentials): Promise<TourToolJob> {
    this.assertActive(caller.sessionId);
    await resolveTourContext(caller, this.options.context);
    const { job, attempt } = this.owned(caller.sessionId, dryRunId);
    if (job.phase !== "checking" || attempt.mode !== "dry-run" || !attempt.dryRunPassed) throw new Error("Record needs a successful no-image dry run from this chat. Run dry-run first.");
    await this.checkSignIn(caller, attempt.script, credentials);
    return this.saw(caller.sessionId, this.submitWith(caller, attempt.script, job.tourId, "record", job.id, credentials));
  }
  /** A waiting recording's sign-in, from the card: a login goes to the tour's memory, a code straight to the page. Never echoed. */
  async signIn(caller: TourToolCaller, jobId: string, input: { origin: string; account?: string; username: string; password: string } | { origin: string; code: string }): Promise<TourJob> {
    const { job } = this.owned(caller.sessionId, jobId);
    const waiter = this.waiters.get(jobId);
    const asked = job.requirements?.signIn;
    if (job.phase !== "needs-sign-in" || !asked || !waiter || asked.origin !== input.origin) throw new Error("This recording isn't waiting for that sign-in.");
    const typable = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
    if (asked.fields[0] === "code") {
      if (!("code" in input) || "username" in input || !typable(input.code, TOUR_CREDENTIAL_LIMITS.code)) throw new Error("This recording asks for a one-time code.");
      this.answer(waiter, { code: input.code });
      this.resumed(job, "sign-in", input.origin);
    } else {
      const wantsAccount = asked.fields[0] === "account";
      const refusal = wantsAccount ? "This recording asks for an account, a username and a password." : "This recording asks for a username and password.";
      if (!("username" in input) || "code" in input || wantsAccount !== ("account" in input && input.account !== undefined)) throw new Error(refusal);
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const account = wantsAccount && typeof input.account === "string" ? input.account.trim() : undefined;
      if (!typable(username, TOUR_CREDENTIAL_LIMITS.username) || !typable(input.password, TOUR_CREDENTIAL_LIMITS.password) || (wantsAccount && !typable(account, TOUR_CREDENTIAL_LIMITS.account))) throw new Error(refusal);
      const login = { ...(account !== undefined ? { account } : {}), username, password: input.password };
      this.signIns.setLogin(caller.sessionId, job.tourId, input.origin, login);
      this.answer(waiter, login);
      this.resumed(job, "sign-in", input.origin);
    }
    return this.result(caller.sessionId, jobId).job;
  }
  /** Approve All: exactly the origins the card showed, equal to the job's request as a set. */
  async approveAll(caller: TourToolCaller, jobId: string, origins: string[]): Promise<TourJob> {
    const { job } = this.owned(caller.sessionId, jobId);
    const wanted = job.requirements?.origins ?? [];
    if (job.phase !== "needs-site-approval" || !wanted.length || origins.length !== wanted.length || new Set(origins).size !== origins.length || !origins.every(o => isTourOrigin(o) && wanted.includes(o))) throw new Error("Approve exactly the sites this recording asks for.");
    for (const origin of origins) this.approvals.approve(origin);
    if (this.queue.resume(caller.sessionId, jobId)) this.resumed(job, "site-approval");
    return this.result(caller.sessionId, jobId).job;
  }
  /** Recordings waiting for a sign-in now: the chat's "needs you" mark. Memory only; a restart has none. */
  waitingSignIns(): TourWaitingSignIn[] {
    return [...this.waiters.values()].map(({ sessionId, tourId, jobId, origin, fields, since }) => ({ sessionId, tourId, jobId, origin, fields: [...fields] as TourWaitingSignIn["fields"], since }));
  }
  /**
   * That job still continues from the user's answer made at `at`: it is the job's latest answer, and the job
   * neither waits on the user again nor has come to rest.
   */
  stillContinuing(jobId: string, at: string): boolean {
    const answer = this.answers.get(jobId);
    if (answer?.at !== at) return false;
    const job = this.queue.get(answer.sessionId, jobId);
    // Still working: neither waiting on the user again nor come to rest (checking, ready, failed, cancelled, interrupted).
    return !!job && !NEEDS.has(job.phase) && !RESTING.has(job.phase);
  }
  /** The user's answer let the job continue: note it, and tell the chat (never a login value). */
  private resumed(job: TourJob, answered: TourResumed["answered"], origin?: string): void {
    const at = `${new Date().toISOString()}#${++this.answerSeq}`;
    this.answers.delete(job.id); this.answers.set(job.id, { at, sessionId: job.sessionId });
    if (this.answers.size > 2000) this.answers.delete(this.answers.keys().next().value!);
    const event: TourResumed = { sessionId: job.sessionId, tourId: job.tourId, jobId: job.id, ...(job.title ? { title: job.title } : {}), answered, ...(origin ? { origin } : {}), at };
    for (const fn of [this.options.onResumed, resumedHook]) { try { fn?.(event); } catch { /* telling the chat can't fail the answer */ } }
  }
  /** That job still waits for the sign-in that began at `since` (any of its sign-ins when `since` is unknown). */
  stillWaitingSignIn(jobId: string, since?: string): boolean {
    const waiter = this.waiters.get(jobId);
    return !!waiter && (since === undefined || waiter.since === since);
  }
  /**
   * Waits until the job, since this chat last saw it, came to rest, started waiting on the user, or changed what
   * it asks the user for (see `wakes`), or five minutes pass, or the signal aborts; a job resting where only the
   * agent can move it, or never seen (a first call, or after a restart), answers at once.
   */
  async status(caller: TourToolCaller, jobId: string, signal?: AbortSignal): Promise<TourToolJob> {
    const first = this.result(caller.sessionId, jobId);
    const last = this.seen.get(this.seenKey(caller.sessionId, jobId));
    if (last === undefined || wakes(last, first.job) || RESTING.has(first.job.phase) || signal?.aborted) return this.saw(caller.sessionId, first);
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", done); this.statusWaits.delete(done); resolve(); };
      const timer = setTimeout(done, this.options.statusWaitMs ?? TOUR_STATUS_WAIT_MS);
      const unsubscribe = this.queue.subscribe(job => { if (job.id === jobId && wakes(last, job)) done(); });
      signal?.addEventListener("abort", done, { once: true });
      this.statusWaits.add(done);
    });
    return this.saw(caller.sessionId, this.result(caller.sessionId, jobId));
  }
  async cancel(caller: TourToolCaller, jobId: string): Promise<TourToolJob> {
    this.owned(caller.sessionId, jobId);
    this.queue.cancel(caller.sessionId, jobId);
    return this.result(caller.sessionId, jobId);
  }
  async inspect(caller: TourToolCaller, jobId: string, capture?: string): ReturnType<TourToolRuntime["inspect"]> {
    const { job, attempt } = this.owned(caller.sessionId, jobId);
    const files = attempt.manifest?.check.contactSheets ?? [];
    const requested = capture ? [capture] : files;
    if (capture && !attempt.manifest?.assets.some(a => a.file === capture)) throw new Error("Choose an exact picture from this recording's report.");
    const images: Buffer[] = [];
    for (const file of requested) {
      const bytes = this.artifacts.readImage(caller.sessionId, jobId, file);
      if (!bytes) throw new Error("That private recording picture is unavailable. Re-record this tour.");
      images.push(bytes);
    }
    // A copy of each picture in the chat's own folder, for a model that can't see pictures (§app.tours/recording).
    const copies = await this.copyForChat(caller, jobId, requested, images);
    const content: Awaited<ReturnType<TourToolRuntime["inspect"]>>["content"] = [{ type: "text", text: JSON.stringify({ job, mode: attempt.mode, dryRunPassed: !!attempt.dryRunPassed, contactSheets: files, captures: attempt.manifest?.steps.flatMap(s => s.views.flatMap(v => Object.values(v.captures).map(c => c.image))) ?? [], suspicious: attempt.suspicious, ...(copies ? { copies, copiesNote: "Copies of the pictures above in your working folder: a picture helper can read them. They are the only recording files to read." } : {}) }) }];
    for (const bytes of images) content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    // Receipt is produced by returning an actual artifact, not by accepting an agent boolean.
    this.artifacts.save({ ...attempt, receipts: [...new Set([...attempt.receipts, ...requested])] });
    return { result: this.saw(caller.sessionId, this.result(caller.sessionId, jobId)), content };
  }
  async check(caller: TourToolCaller, jobId: string, verification: TourVerification): Promise<TourToolJob> {
    this.assertActive(caller.sessionId);
    const context = await resolveTourContext(caller, this.options.context);
    const { job, attempt } = this.owned(caller.sessionId, jobId);
    if (job.phase === "ready") return this.result(caller.sessionId, jobId);
    if (job.phase !== "checking" || attempt.mode !== "record" || !attempt.dryRunPassed || !attempt.manifest || !attempt.origin) throw new Error("This job has no complete captured edition to check. The previous edition is unchanged.");
    const source = await resolveTourSource(context, attempt.script.source, this.options.context);
    const target = await (this.options.target ?? resolveTourTarget)(source);
    await target.assertCurrent();
    this.assertActive(caller.sessionId);
    if (target.origin !== attempt.origin || target.generation !== attempt.generation) throw new Error("This tour's running copy changed before checking. Re-record against the same source.");
    // A recording that saw a Sova (or kept no answer, as before this check) publishes only from a
    // verified managed copy: by the attempt's own record and by resolving that copy again now.
    if (attempt.sovaServer !== false && !(attempt.sovaCopy && target.sova)) throw new Error(TOUR_SOVA_REFUSAL);
    const missing = this.approvals.missing([target.origin, ...(attempt.script.sites ?? []), ...(attempt.contactedOrigins ?? [])], source.kind === "project" ? target.origin : undefined);
    if (missing.length) throw new Error("Site consent changed before checking. Approve the exact origins and re-record.");
    const assets = this.artifacts.images(attempt);
    assertTourCoverage(attempt.script, attempt.manifest.steps);
    const manifest = checkTourManifest(attempt.manifest, assets, new Set(attempt.receipts), attempt.suspicious, verification);
    if (manifest.scriptDigest !== tourScriptDigest(attempt.script)) throw new Error("The authoring script changed. Run a fresh dry run and recording.");
    const edition: TourEdition = { v: 1, sessionId: caller.sessionId, source, manifest, provenance: { origin: attempt.origin, recordedAt: manifest.recordedAt, ...(attempt.signedIn ? { signedIn: true as const } : {}), ...(attempt.generation !== undefined ? { generation: attempt.generation } : {}), ...(attempt.publicOrigins !== undefined ? { publicOrigins: [...attempt.publicOrigins] } : {}) } };
    // Cancellation can arrive while the live source checks await their result.
    if (this.owned(caller.sessionId, jobId).job.phase !== "checking") throw new Error("This recording is no longer awaiting publication.");
    // All validation and receipts precede the store's atomic publish. Previous editions are immutable.
    this.store.publishEdition(edition, assets);
    this.artifacts.save({ ...attempt, manifest });
    this.queue.update(jobId, { phase: "ready", editionId: manifest.editionId });
    return this.result(caller.sessionId, jobId);
  }
  async show(caller: TourToolCaller, tourId: string, editionId?: string): Promise<TourManifest> {
    this.assertActive(caller.sessionId);
    const edition = editionId ? this.store.readEdition(caller.sessionId, tourId, editionId) : this.store.latestEdition(caller.sessionId, tourId);
    if (!edition) throw new Error("This chat has no complete checked edition of that tour.");
    return edition.manifest;
  }
  async approve(caller: TourToolCaller, jobId: string, origin: string): Promise<TourJob> {
    const { job } = this.owned(caller.sessionId, jobId);
    if (!isTourOrigin(origin) || !job.requirements?.origins?.includes(origin)) throw new Error("Approve only an exact site requested by this recording.");
    this.approvals.approve(origin);
    if (job.requirements.origins.every(o => this.approvals.isApproved(o)) && this.queue.resume(caller.sessionId, jobId)) this.resumed(job, "site-approval");
    return this.result(caller.sessionId, jobId).job;
  }
  async saveAccount(caller: TourToolCaller, jobId: string, input: TourAccountInput): Promise<TourJob> {
    const { job, attempt } = this.owned(caller.sessionId, jobId);
    if (job.phase !== "needs-test-account" || job.requirements?.testAccount?.origin !== input.origin) throw new Error("This recording did not request that test account origin.");
    const account = this.accounts.save(input);
    // This is a new authoring input; the resumed task repeats its no-image sequence.
    this.artifacts.save({ ...attempt, script: { ...attempt.script, accountId: account.id }, dryRunPassed: undefined });
    this.queue.resume(caller.sessionId, jobId);
    return this.result(caller.sessionId, jobId).job;
  }
  async reRecord(caller: TourToolCaller, tourId: string): Promise<TourJob> {
    this.assertActive(caller.sessionId);
    await resolveTourContext(caller, this.options.context);
    const edition = this.store.latestEdition(caller.sessionId, tourId);
    if (!edition) throw new Error("This chat has no checked tour to re-record.");
    const previous = this.queue.list(caller.sessionId).filter(j => j.tourId === tourId && j.editionId === edition.manifest.editionId).map(j => this.artifacts.read(caller.sessionId, j.id)).find(a => a?.mode === "record");
    if (!previous) throw new Error("The private authoring script is unavailable. Ask the agent to author a fresh dry run against this same source.");
    const context = await resolveTourContext(caller, this.options.context);
    const source = await resolveTourSource(context, previous.script.source, this.options.context);
    // Refuse port reuse/stopped originals before queuing, then independently recheck at launch.
    await (this.options.target ?? resolveTourTarget)(source);
    return this.submit(caller, previous.script, tourId, "record").job;
  }
  latest(sessionId: string, tourId: string): { editionId?: string; signedIn?: true; job?: TourJob; sites: TourSiteState[] } {
    this.assertActive(sessionId);
    if (!isTourId(tourId)) throw new Error("Invalid tour id.");
    const latest = this.store.latestEdition(sessionId, tourId);
    const editionId = latest?.manifest.editionId;
    const job = this.queue.list(sessionId).filter(j => j.tourId === tourId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { ...(editionId ? { editionId } : {}), ...(latest?.provenance.signedIn ? { signedIn: true as const } : {}), ...(job ? { job } : {}), sites: this.sites(sessionId, tourId) };
  }
  /**
   * The exact origins this chat's tour uses (its site source, declared, requested and contacted
   * origins, and its editions' recorded origin), each with whether this installation holds a site
   * approval or a test account for it now.
   */
  sites(sessionId: string, tourId: string): TourSiteState[] {
    this.assertActive(sessionId);
    const origins = new Set<string>();
    for (const job of this.queue.list(sessionId).filter(j => j.tourId === tourId)) {
      for (const o of job.requirements?.origins ?? []) origins.add(o);
      if (job.requirements?.testAccount) origins.add(job.requirements.testAccount.origin);
      const attempt = this.artifacts.read(sessionId, job.id);
      if (!attempt) continue;
      if (attempt.script.source.kind === "site") origins.add(attempt.script.source.origin);
      for (const o of [attempt.origin, ...(attempt.script.sites ?? []), ...(attempt.contactedOrigins ?? [])]) if (o) origins.add(o);
    }
    const edition = this.store.latestEdition(sessionId, tourId);
    if (edition) origins.add(edition.provenance.origin);
    const approved = new Set(this.approvals.list());
    const accounts = new Set(this.accounts.list().map(a => a.origin));
    return [...origins].filter(isTourOrigin).sort().map(origin => ({ origin, approved: approved.has(origin), account: accounts.has(origin) }));
  }
  /** Forget an origin's approval for the whole installation; only an origin this chat's tour uses. */
  revokeSite(caller: TourToolCaller, tourId: string, origin: string): TourSiteState[] {
    if (!isTourId(tourId) || !this.sites(caller.sessionId, tourId).some(s => s.origin === origin)) throw new Error("This tour doesn't use that site.");
    this.approvals.revoke(origin);
    return this.sites(caller.sessionId, tourId);
  }
  /** Delete the stored test account for an origin; only an origin this chat's tour uses. */
  removeAccount(caller: TourToolCaller, tourId: string, origin: string): TourSiteState[] {
    if (!isTourId(tourId) || !this.sites(caller.sessionId, tourId).some(s => s.origin === origin)) throw new Error("This tour doesn't use that site.");
    for (const account of this.accounts.list().filter(a => a.origin === origin)) this.accounts.remove(account.id);
    return this.sites(caller.sessionId, tourId);
  }
  /** Refuse work synchronously, then wait for actual child cleanup before removing artifacts. */
  removeSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    this.signIns.clearSession(sessionId);
    const existing = this.removals.get(sessionId);
    if (existing) return existing;
    const failures: unknown[] = [];
    try { markTourSessionDeleted(this.options.root, sessionId); } catch (error) { failures.push(error); }
    const pending = (async () => {
      try { await this.queue.removeSession(sessionId); } catch (error) { failures.push(error); }
      // Even a failed job-file removal must not release the lifecycle before child settlement.
      await this.queue.waitForSessionIdle(sessionId);
      try { this.artifacts.removeSession(sessionId); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Tour recording cleanup failed after child settlement.");
    })();
    this.removals.set(sessionId, pending);
    // A failed cleanup remains tombstoned, but the lifecycle sweep may retry the deletion.
    void pending.catch(() => { if (this.removals.get(sessionId) === pending) this.removals.delete(sessionId); });
    return pending;
  }
  close(): void {
    for (const done of [...this.statusWaits]) done();
    this.unsubscribe(); this.unexpire(); this.queue.close();
    for (const waiter of this.waiters.values()) waiter.reject(new Error("Recording queue is shutting down."));
    this.waiters.clear(); this.signIns.clearAll();
  }
  private isDeleted(sessionId: string): boolean {
    return this.deletedSessions.has(sessionId) || isTourSessionDeleted(this.options.root, sessionId);
  }
  private assertActive(sessionId: string): void {
    if (this.isDeleted(sessionId)) throw new Error("That recording is unavailable in this chat. The chat was deleted.");
  }
  private owned(sessionId: string, jobId: string): { job: TourJob; attempt: TourPrivateAttempt } {
    this.assertActive(sessionId);
    const job = this.queue.get(sessionId, jobId), attempt = this.artifacts.read(sessionId, jobId);
    if (!job || !attempt || attempt.tourId !== job.tourId) throw new Error("That recording is unavailable in this chat.");
    return { job, attempt };
  }
  /**
   * Writes `files` to `<chat cwd>/.sova-tour/<jobId>/` (a folder git ignores) and returns their paths; undefined,
   * writing nothing, when the chat's folder can't be established, lies inside Sova's state, or holds a link or
   * a non-folder where a folder goes. Never follows a link.
   */
  private async copyForChat(caller: TourToolCaller, jobId: string, files: string[], images: Buffer[]): Promise<string[] | undefined> {
    if (!files.length) return undefined;
    try {
      const cwd = (await resolveTourContext(caller, this.options.context)).cwd;
      const root = resolve(this.options.root);
      if (cwd === root || cwd.startsWith(`${root}${sep}`)) return undefined;
      const top = join(cwd, ".sova-tour"), dir = join(top, jobId);
      for (const d of [top, dir]) {
        try { mkdirSync(d, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const st = lstatSync(d);
        if (!st.isDirectory() || st.isSymbolicLink()) return undefined;
      }
      const ignore = join(top, ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n", { flag: "wx" });
      return files.map((file, i) => {
        const path = join(dir, file), temp = join(dir, `.${randomUUID()}.tmp`);
        try { writeFileSync(temp, images[i]!, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
        finally { rmSync(temp, { force: true }); }
        return path;
      });
    } catch { return undefined; }
  }
  private seenKey(sessionId: string, jobId: string): string { return `${sessionId}\u0000${jobId}`; }
  /** Notes the job as this chat now sees it, for its next status call. Bounded: the oldest are forgotten first. */
  private saw(sessionId: string, result: TourToolJob): TourToolJob {
    const key = this.seenKey(sessionId, result.job.id);
    this.seen.delete(key); this.seen.set(key, jobSignature(result.job));
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value!);
    return result;
  }
  private result(sessionId: string, jobId: string): TourToolJob {
    const { job, attempt } = this.owned(sessionId, jobId);
    const manifest = job.phase === "ready" && job.editionId ? this.store.readEdition(sessionId, job.tourId, job.editionId)?.manifest : undefined;
    const look = attempt.mode !== "look" ? undefined : attempt.look ? tourLookAnswer(job.tourId, attempt.look) : !tourJobTerminal(job) && job.phase !== "checking" ? tourLookPending(job.tourId) : undefined;
    return { job, steps: attempt.script.steps.length, ...(manifest ? { manifest } : {}), ...(look ? { look } : {}) };
  }
  /** A sign-in's checks before anything is written: not on a Sova copy, credentials for its own origins, no value in the script. */
  private async checkSignIn(caller: TourToolCaller, script: TourScript, credentials: TourCredentials | undefined): Promise<void> {
    if (!script.signIn) {
      if (credentials !== undefined) throw new Error(tourCredentialsProblem(credentials, undefined) ?? "credentials need a signIn in the script.");
      return;
    }
    const target = await (this.options.target ?? resolveTourTarget)(script.source);
    if (target.sova) throw new Error(TOUR_SOVA_SIGN_IN_REFUSAL);
    this.assertActive(caller.sessionId);
    if (credentials === undefined) return;
    const problem = tourCredentialsProblem(credentials, script.signIn, tourSignInOrigins(script.signIn, target.origin));
    if (problem) throw new Error(problem);
    if (leaks(JSON.stringify(script), Object.values(credentials).flatMap(c => [c.username, c.password, ...(c.account !== undefined ? [c.account] : []), ...(c.code !== undefined ? [c.code] : [])]))) throw new Error(TOUR_CREDENTIALS_IN_SCRIPT);
  }
  /** Supplied credentials go to the tour's memory before its job can start, so it signs in silently. */
  private submitWith(caller: TourToolCaller, script: TourScript, tourId: string, mode: "dry-run" | "record" | "look", dryRunId: string | undefined, credentials: TourCredentials | undefined, lookRoute?: string): TourToolJob {
    const had = this.signIns.has(caller.sessionId, tourId);
    if (credentials) this.signIns.setCredentials(caller.sessionId, tourId, credentials);
    try { return this.submit(caller, script, tourId, mode, dryRunId, lookRoute); }
    catch (error) { if (credentials && !had) this.signIns.clear(caller.sessionId, tourId); throw error; }
  }
  private answer(waiter: Waiter, answer: TourSignInAnswer): void {
    this.waiters.delete(waiter.jobId);
    this.queue.unpark(waiter.jobId, waiter.phase);
    waiter.resolve(answer);
  }
  private submit(caller: TourToolCaller, script: TourScript, tourId: string, mode: "dry-run" | "record" | "look", dryRunId?: string, lookRoute?: string): TourToolJob {
    this.assertActive(caller.sessionId);
    const total = script.steps.reduce((n, s) => n + s.views.reduce((v, w) => v + (w.kind === "page" ? w.sizes.length : 1), 0), 0);
    const job = this.queue.enqueue({ sessionId: caller.sessionId, tourId, title: script.title, total }, (job, signal, progress) => this.execute(caller, job.id, signal, progress));
    this.artifacts.save({ v: 1, sessionId: caller.sessionId, jobId: job.id, tourId, script, mode, ...(dryRunId ? { dryRunId } : {}), ...(lookRoute ? { lookRoute } : {}), suspicious: [], receipts: [], report: job });
    return this.result(caller.sessionId, job.id);
  }
  private async execute(caller: TourToolCaller, jobId: string, signal: AbortSignal, progress: (p: TourJobPatch) => void): Promise<{ phase: "checking" }> {
    let accountOrigin: string | undefined;
    // The hour running out stops this execution (and its signed-in browser) as a failure, not a cancel.
    const local = new AbortController();
    const forward = () => local.abort();
    signal.addEventListener("abort", forward, { once: true }); if (signal.aborted) local.abort();
    let expired = false;
    /** Login values this execution handed to its child: kept out of anything it writes. */
    const seen = new Set<string>();
    const tourId = this.queue.get(caller.sessionId, jobId)?.tourId;
    let quietAborts = 0;
    try {
      let { attempt } = this.owned(caller.sessionId, jobId);
      this.live.set(jobId, { sessionId: caller.sessionId, tourId: attempt.tourId, expire: () => {
        expired = true; local.abort();
        const waiter = this.waiters.get(jobId);
        if (waiter) { this.waiters.delete(jobId); waiter.reject(new TourJobFailure({ message: TOUR_SIGN_IN_EXPIRED, guidance: "The signed-in browser was closed. Nothing was published." })); }
      } });
      const context = await resolveTourContext(caller, this.options.context);
      const source = await resolveTourSource(context, attempt.script.source, this.options.context);
      const script = { ...attempt.script, source };
      const target = await (this.options.target ?? resolveTourTarget)(source);
      accountOrigin = target.origin;
      const projectOrigin = source.kind === "project" ? target.origin : undefined;
      const contactedOrigins = new Set<string>();
      const missing = this.approvals.missing([target.origin, ...(script.sites ?? [])], projectOrigin);
      if (missing.length) throw new TourJobBlocked({ origins: missing });
      // An explicit reference must resolve for this exact origin; without one, the origin's stored account serves.
      const account = script.accountId ? this.accounts.resolve(script.accountId, target.origin) : this.accounts.forOrigin(target.origin);
      if (script.accountId && !account) throw new TourJobBlocked({ testAccount: { origin: target.origin, kind: "http-basic", reason: "Select a stored test account for this exact site." } });
      const editionId = randomUUID();
      const guard = freshCheck(async () => {
        this.assertActive(caller.sessionId);
        const current = await resolveTourContext(caller, this.options.context);
        if (JSON.stringify(current) !== JSON.stringify(context)) throw new TourJobFailure({ message: "The chat's sandbox scope changed during recording.", guidance: "Retry under the chat's current restrictions. The previous checked edition is unchanged." });
        await resolveTourSource(current, script.source, this.options.context);
        await target.assertCurrent();
        this.assertActive(caller.sessionId);
      });
      const signInOrigins = script.signIn ? tourSignInOrigins(script.signIn, target.origin) : [];
      const run = async (dryRun: boolean) => {
        await guard(); // Re-establish trusted scope before each child launch, including capture after dry-run.
        // The tour's stored session: the record job reuses its dry run's sign-in (one prompt per tour).
        const storage = script.signIn ? this.signIns.storage(caller.sessionId, attempt.tourId) : undefined;
        for (const origin of signInOrigins) { const login = this.signIns.login(caller.sessionId, attempt.tourId, origin); if (login) { seen.add(login.username); seen.add(login.password); if (login.account) seen.add(login.account); } }
        const attemptResult = await (this.options.run ?? runTourAttempt)({ context, script, tourId: attempt.tourId, editionId, dryRun, signal: local.signal, ...(this.options.target ? { target: this.options.target } : {}),
          ...(storage ? { signInStorage: storage } : {}),
          ...(script.signIn ? {
            onSignIn: (need: TourSignInNeed) => this.waitForSignIn(caller.sessionId, attempt.tourId, jobId, need, dryRun, local.signal, seen),
            onSignedIn: (_origin: string, state: Parameters<TourSignInStore["setStorage"]>[3]) => { this.signIns.setStorage(caller.sessionId, attempt.tourId, signInOrigins, state); },
          } : {}),
          onProgress: p => progress({ ...p, phase: dryRun ? "dry-run" : "recording" }),
          ...(attempt.mode === "look" ? { look: { ...(attempt.lookRoute ? { signInRoute: attempt.lookRoute } : {}) } } : {}),
          beforeContact: async origin => {
            await guard();
            if (this.approvals.missing([origin], projectOrigin).length) throw new TourJobBlocked({ origins: [origin] });
            contactedOrigins.add(origin);
            if (contactedOrigins.size > 64) throw new TourJobFailure({ message: "This tour contacts too many different sites.", guidance: "Split the tour or use reference text for the additional destinations." });
          },
          ...(account ? { account: account.credentials() } : {}),
        });
        if (attemptResult.quietAborts) { quietAborts += attemptResult.quietAborts; progress({ quietAborts }); }
        return attemptResult;
      };
      // Always repeat the dry run at launch, not merely trust an earlier environment or consent.
      const dry = await run(true);
      if (signal.aborted) throw new Error("Recording cancelled.");
      if (dry.scriptDigest !== tourScriptDigest(script) || dry.assets.size !== 0 || dry.contactSheets.length) throw new Error("Invalid no-image dry-run receipt.");
      // A look keeps its lists, without any entry naming a login value, and is never recorded.
      if (attempt.mode === "look") {
        if (!dry.look) throw new Error("Invalid look result.");
        this.artifacts.save({ ...this.owned(caller.sessionId, jobId).attempt, script, look: tourLookWithout(dry.look, text => leaks(text, seen)) });
        return { phase: "checking" };
      }
      attempt = { ...this.owned(caller.sessionId, jobId).attempt, script, dryRunPassed: true };
      this.artifacts.save(attempt);
      if (attempt.mode === "dry-run") return { phase: "checking" };
      progress({ phase: "recording", completed: 0, total: this.owned(caller.sessionId, jobId).job.total });
      const recorded = await run(false);
      this.assertActive(caller.sessionId);
      if (signal.aborted) throw new Error("Recording cancelled.");
      assertTourCoverage(script, recorded.steps);
      const captureCount = recorded.steps.reduce((n, s) => n + s.views.reduce((v, w) => v + Object.keys(w.captures).length, 0), 0);
      const manifest = normalizeTourManifest({ v: 2, id: attempt.tourId, editionId, title: script.title, summary: script.summary, viewports: TOUR_VIEWPORTS, recordedAt: recorded.provenance.recordedAt, chapters: script.chapters, steps: recorded.steps, assets: [...recorded.assets].map(([f, b]) => tourAsset(f, b)), scriptDigest: recorded.scriptDigest,
        check: { status: "passed", dryRun: true, captureCount, contactSheets: recorded.contactSheets, overviewReviewed: true, suspiciousCapturesReviewed: [], notes: "Staged only; inspection receipts and explicit visual verification are required before publication.", checkedAt: recorded.provenance.recordedAt } });
      if (!manifest || manifest.scriptDigest !== tourScriptDigest(script)) throw new Error("The recording is incomplete. No edition was published.");
      for (const [file, bytes] of recorded.assets) this.artifacts.writeImage(caller.sessionId, jobId, file, bytes);
      this.artifacts.save({ ...this.owned(caller.sessionId, jobId).attempt, manifest, origin: recorded.provenance.origin, generation: recorded.provenance.generation, contactedOrigins: [...contactedOrigins], publicOrigins: recorded.provenance.publicOrigins !== undefined ? [...recorded.provenance.publicOrigins] : undefined, suspicious: recorded.suspicious, receipts: [], sovaServer: recorded.sovaServer === true || dry.sovaServer === true, ...(recorded.sovaCopy ? { sovaCopy: true as const } : {}), ...(recorded.signedIn ? { signedIn: true as const } : {}) });
      return { phase: "checking" };
    } catch (error) {
      if (expired) throw new TourJobFailure({ message: TOUR_SIGN_IN_EXPIRED, guidance: "The signed-in browser was closed. Nothing was published." });
      if (error instanceof TourCaptureFailure) {
        if (error.failure.message === TOUR_SIGN_IN_WRONG && error.failure.blockedOrigin && tourId) this.signIns.forget(caller.sessionId, tourId, error.failure.blockedOrigin);
        if (error.failure.message === TOUR_SIGN_IN_STALE && tourId) this.signIns.forgetStorage(caller.sessionId, tourId);
        if (error.failure.message === "This page requires a test account." && error.failure.blockedOrigin === accountOrigin && isTourOrigin(accountOrigin)) throw new TourJobBlocked({ testAccount: { origin: accountOrigin, kind: "http-basic", reason: "Use an operator-approved test account, never a personal account." } });
        throw new TourJobFailure(scrubFailure(error.failure, seen));
      }
      // A refused copy (stopped, swapped, taken over) says why; one whose state couldn't be read says that
      // instead. Neither is a pass or an approval wait.
      if (error instanceof TourTargetRefused || error instanceof TourTargetUnverifiable) throw new TourJobFailure({ message: error.message, guidance: error.guidance });
      if (error instanceof TourJobFailure) throw new TourJobFailure(scrubFailure(error.failure, seen));
      // Anything else ends as "could not finish", its message only in the server log: never one carrying a login value.
      if (error instanceof Error && leaks(error.message, seen)) throw new Error("(a message that mentions a sign-in detail, not shown)");
      throw error;
    } finally {
      this.live.delete(jobId); signal.removeEventListener("abort", forward);
      const waiter = this.waiters.get(jobId); if (waiter) { this.waiters.delete(jobId); waiter.reject(new Error("Recording stopped.")); }
    }
  }
  /** The page asks to sign in: answered from the tour's memory, else the job waits in needs-sign-in for the user. */
  private async waitForSignIn(sessionId: string, tourId: string, jobId: string, need: TourSignInNeed, dryRun: boolean, signal: AbortSignal, seen: Set<string>): Promise<TourSignInAnswer> {
    if (signal.aborted) throw new Error("Recording cancelled.");
    const note = (a: TourSignInAnswer) => { for (const v of [a.account, a.username, a.password, a.code]) if (v) seen.add(v); return a; };
    if (need.fields[0] === "code") { const code = this.signIns.takeCode(sessionId, tourId, need.origin); if (code) return note({ code }); }
    // A stored login answers only the boxes asked for: an account exactly when the page has an account box.
    else { const login = this.signIns.login(sessionId, tourId, need.origin); if (login && (need.fields[0] === "account") === (login.account !== undefined)) return note(login); }
    const fields = [...need.fields] as TourSignInRequirement["fields"];
    // Past the parked cap this throws, and the attempt fails naming the recordings already waiting.
    this.queue.park(jobId, { origin: need.origin, kind: "form", fields, ...(need.reason ? { reason: need.reason } : {}) });
    return new Promise<TourSignInAnswer>((resolve, reject) => {
      const waiter: Waiter = { sessionId, tourId, jobId, origin: need.origin, fields, since: new Date().toISOString(), phase: dryRun ? "dry-run" : "recording", resolve: a => resolve(note(a)), reject };
      this.waiters.set(jobId, waiter);
      signal.addEventListener("abort", () => { if (this.waiters.get(jobId) === waiter) this.waiters.delete(jobId); reject(new Error("Recording cancelled.")); }, { once: true });
      const title = this.queue.get(sessionId, jobId)?.title;
      const event: TourNeedsYou = { sessionId, tourId, jobId, origin: need.origin, fields: [...fields] as TourNeedsYou["fields"], ...(title ? { title } : {}), since: waiter.since };
      for (const fn of [this.options.onNeedsYou, needsYouHook]) { try { fn?.(event); } catch { /* telling the chat can't fail the recording */ } }
    });
  }
}
/** A failure that would carry a login value (a page showing the username, say) is replaced, keeping only where it happened. */
function scrubFailure(failure: TourFailure, seen: Set<string>): TourFailure {
  if (!leaks(JSON.stringify(failure), seen)) return failure;
  return { message: "Recording stopped on a page that shows a sign-in detail.", guidance: "Nothing was published. Review this view's targets, then record again.", ...(failure.stepId ? { stepId: failure.stepId } : {}), ...(failure.viewId ? { viewId: failure.viewId } : {}), ...(failure.size ? { size: failure.size } : {}) };
}
export const createTourToolRuntime = (options: TourRuntimeOptions): TourRuntime => new TourRuntime(options);
let service: TourRuntime | undefined;
export function ensureTourToolRuntime(): TourRuntime {
  if (!service) { service = createTourToolRuntime({ root: stateRoot() }); setTourToolRuntime(service); }
  return service;
}
export const tourRuntime = ensureTourToolRuntime;
