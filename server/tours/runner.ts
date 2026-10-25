import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { TOUR_LIMITS, isTourFile, isTourOrigin, normalizeTourScript, tourSignInOrigins, type TourFailure, type TourScript, type TourSignInRequirement, type TourStep } from "../../shared/tour";
import { hostProcTable } from "../project-services/proctable";
import { resolveTourTarget } from "../project-services/tour-target";
import { assertTourCoverage, tourAsset, tourScriptDigest } from "./checks";
import { isPublicRecordingAddress } from "./browser-addresses";
import { killTourChild, spawnTourCommand, type TourProxyOptions, type TourRecordingContext } from "./sandbox";
import { readBounded } from "./assets";
import { join } from "node:path";
import { TourCaptureFailure } from "./targets";
import { connectCandidates, startRunnerProxy, type RunnerProxy } from "./runner-proxy";
import { TourJobBlocked, TourJobFailure } from "./queue";
import { TourTargetRefused, TourTargetUnverifiable } from "../project-services/tour-target";
import type { TourAttemptProgress, TourChildMessage, TourParentMessage, TourStorageState } from "./runner-protocol";
import { normalizeTourLookResult, type TourLookResult } from "./look";

/** A managed Sova copy signs the recorder in by its cookie only (§app.tours/recording). */
export const TOUR_SOVA_SIGN_IN_REFUSAL = "A Sova test copy signs the recorder in by its own cookie; remove signIn.";
export const TOUR_ATTEMPT_LIMIT_MS = 5 * 60_000;
/** What the page asked for at its sign-in, and the answer: a login or a one-time code. Never logged. */
export interface TourSignInNeed { origin: string; fields: TourSignInRequirement["fields"]; reason?: string }
export interface TourSignInAnswer { account?: string; username?: string; password?: string; code?: string }

export interface TourAttemptOptions {
  context: TourRecordingContext;
  script: TourScript;
  tourId: string;
  editionId: string;
  dryRun: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: TourAttemptProgress) => void;
  /** Live exact-origin consent recheck. Project exemption applies only to the resolved own origin. */
  beforeContact: (origin: string) => Promise<void>;
  account?: { origin: string; username: string; password: string };
  /** The source's running-copy resolver (the runtime's own); defaults to the registry resolver. */
  target?: typeof resolveTourTarget;
  /** Test seam: the confined launch itself; defaults to spawnTourCommand. */
  spawn?: typeof spawnTourCommand;
  /** Test seam: a sandbox-off attempt's own proxy; defaults to startRunnerProxy. */
  startProxy?: typeof startRunnerProxy;
  /** The tour's stored signed-in session for its sign-in origins (form sign-in only). */
  signInStorage?: TourStorageState;
  /**
   * The page reached the script's sign-in: answered from the tour's memory, or after the user answers
   * (the job then waits in needs-sign-in). The attempt's time limit is paused while this waits.
   */
  onSignIn?: (need: TourSignInNeed) => Promise<TourSignInAnswer>;
  /** A sign-in succeeded: the sign-in origins' session, for this tour's later attempts. */
  onSignedIn?: (origin: string, storage: TourStorageState) => void;
  /** Test seam: the attempt's busy-time limit; defaults to 5 minutes. */
  limitMs?: number;
  /** A look (§app.tours/look): a dry run that lists each page's controls instead of checking marks. */
  look?: { signInRoute?: string };
}
export interface TourAttemptResult {
  steps: TourStep[];
  assets: Map<string, Uint8Array>;
  contactSheets: string[];
  suspicious: string[];
  provenance: { origin: string; recordedAt: string; generation?: number; publicOrigins?: string[] };
  /** Some answer came from a Sova; publication then requires a verified managed test copy. */
  sovaServer?: boolean;
  /** This attempt recorded a verified managed Sova test copy (its own record, not a header). */
  sovaCopy?: true;
  /** Writes the pages sent by themselves, stopped without reaching the site. */
  quietAborts?: number;
  /** The attempt ran signed in through the script's form sign-in (prompted, supplied or a stored session). */
  signedIn?: true;
  /** A look's lists (§app.tours/look). */
  look?: TourLookResult;
  scriptDigest: string;
  metrics?: { wallTimeMs: number; peakRssBytes: number; storedBytes: number };
}

/**
 * One live check shared by every contact that arrives while it is waiting to start: each caller gets
 * the result of a check that began at or after its call, never an older one, while a burst of contacts
 * (a page's scripts and their proxy connections) costs two checks rather than one each. A project
 * source's identity check scans this host's processes synchronously, so per-contact checks blocked
 * the server, its in-process proxy included, long enough for a page load to time out.
 */
export function freshCheck(check: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const start = (): Promise<void> => { const p = (async () => check())().finally(() => { if (running === p) running = null; }); running = p; return p; };
  return () => {
    if (!running) return start();
    next ??= running.catch(() => {}).then(() => { next = null; return start(); });
    return next;
  };
}

/** Server orchestrator only. Browser work occurs in a fresh short-lived confined child. */
export async function runTourAttempt(options: TourAttemptOptions): Promise<TourAttemptResult> {
  const startedAt = performance.now();
  const script = normalizeTourScript(options.script);
  if (!script) throw new Error("Invalid tour script. Split oversized tours or correct its semantic targets.");
  if (options.signal?.aborted) throw new Error("Recording cancelled.");
  if (options.look && !options.dryRun) throw new Error("A look takes no pictures.");
  const target = await (options.target ?? resolveTourTarget)(script.source);
  if (script.signIn && target.sova) throw new TourCaptureFailure({ message: TOUR_SOVA_SIGN_IN_REFUSAL, guidance: "Record the copy as it is: its own sign-in cookie signs the recorder in." });
  const signInOrigins = script.signIn ? tourSignInOrigins(script.signIn, target.origin) : [];
  const current = freshCheck(() => target.assertCurrent());
  const checkContact = async (origin: string) => {
    await current();
    // Also prevents declaring another managed copy as an approved external subresource.
    if (!(script.source.kind === "project" && origin === target.origin)) {
      await resolveTourTarget({ kind: "site", origin });
    }
    await options.beforeContact(origin);
  };
  const checkpoint = async () => { await current(); await options.beforeContact(target.origin); };
  for (const origin of new Set([target.origin, ...(script.sites ?? []), ...signInOrigins])) await checkContact(origin);
  if (options.signal?.aborted) throw new Error("Recording cancelled.");
  if (options.account && options.account.origin !== target.origin) throw new Error("The test account belongs to another origin.");
  // Sandbox on: the attempt's own proxy resolves only allowlisted names and refuses every non-public
  // answer; a project source's one verified endpoint is admitted, its identity re-checked per contact.
  const proxied = options.context.sandbox.on;
  let proxy: TourProxyOptions | undefined;
  if (proxied) {
    // And, as with the sandbox off, only this tour's declared or requested origins, before any lookup.
    proxy = { forbid: address => !isPublicRecordingAddress(address), admit: (host, port) => admit(connectCandidates(host, port)).then(() => true) };
    const own = script.source.kind === "project" ? new URL(target.origin) : null;
    if (own && own.protocol === "http:" && own.hostname === "127.0.0.1" && own.port) {
      proxy.local = { host: "127.0.0.1", port: Number(own.port), admit: async () => { await current(); return true; } };
    }
  }
  // A verified managed Sova copy: its own install token, read here, only ever becomes its cookie.
  const sova = target.sova ? await sovaCopyCookie(target.origin, target.sova.agentDir) : undefined;
  // Sandbox off: the attempt's own proxy is the browser's only way out, loopback included, and admits
  // an origin only through this attempt's live consent and source-identity check. No proxy, no launch.
  // It admits only this tour's declared origins (source, listed sites, test-account origin) and the
  // origins its page requested through the checked route, each only while the per-contact check
  // passes. Anything else (a speculative load, a background call, an undeclared redirect hop) is
  // refused before contact and fails nothing; a declared or requested origin that the check now
  // refuses for consent or identity stops the attempt.
  const declared = new Set([target.origin, ...(script.sites ?? []), ...(options.account ? [options.account.origin] : []), ...signInOrigins]);
  const routed = new Set<string>();
  const admit = async (candidates: string[]): Promise<string> => {
    const known = candidates.filter(o => declared.has(o) || routed.has(o));
    if (!known.length) throw new Error("Not an origin of this tour.");
    let refusal: unknown;
    for (const origin of known) {
      try { await checkContact(origin); return origin; } catch (error) { refusal ??= error; }
    }
    // Consent, source identity, the chat's sandbox scope or the site budget changing stops the attempt.
    if (refusal instanceof TourJobBlocked || refusal instanceof TourJobFailure || refusal instanceof TourTargetRefused || refusal instanceof TourTargetUnverifiable || refusal instanceof TourCaptureFailure) {
      policyError ??= refusal;
      stopForPolicy?.();
    }
    throw refusal;
  };
  let stopForPolicy: (() => void) | undefined;
  let own: RunnerProxy | undefined;
  if (!proxied) {
    try { own = await (options.startProxy ?? startRunnerProxy)({ admit }); }
    catch { throw new TourCaptureFailure({ message: "Recording couldn't start its network guard, so nothing ran.", guidance: "Retry in a moment. Recording never runs with a direct connection." }); }
  }
  let child: Awaited<ReturnType<typeof spawnTourCommand>>;
  try { child = await (options.spawn ?? spawnTourCommand)(options.context, [process.execPath, fileURLToPath(new URL("./runner-child.ts", import.meta.url))], proxy, own?.url); }
  catch (error) { await own?.close(); throw error; }
  const proc = child.process;
  const assets = new Map<string, Uint8Array>();
  let assetBytes = 0;
  let failure: Error | undefined;
  let policyError: unknown;
  let result: Extract<TourChildMessage, { type: "result" }> | undefined;
  let stopping = false;
  let signedIn = false;
  const table = hostProcTable();
  const tree = new Map<number, string>();
  const leaderStart = proc.pid ? table.startOf(proc.pid) : null;
  let peakRssBytes = 0;
  let sampling = false;
  const observe = () => {
    const entries = table.list();
    const known = new Set<number>(proc.pid && leaderStart && table.startOf(proc.pid) === leaderStart ? [proc.pid] : []);
    for (const [pid, start] of tree) if (table.startOf(pid) === start) known.add(pid);
    for (let grew = true; grew;) { grew = false; for (const entry of entries) if (!known.has(entry.pid) && known.has(entry.ppid)) { known.add(entry.pid); grew = true; } }
    for (const pid of known) { const start = table.startOf(pid); if (start) tree.set(pid, start); }
    return known;
  };
  const killTree = (signal: NodeJS.Signals) => {
    observe();
    // Chromium may setsid; group signalling alone would leak that process.
    for (const [pid, start] of [...tree].reverse()) if (table.startOf(pid) === start) { try { process.kill(pid, signal); } catch { /* exited */ } }
    if (proc.exitCode === null && proc.signalCode === null) killTourChild(proc, signal);
  };
  const stop = (error: Error) => { failure ??= error; if (!stopping) { stopping = true; killTree("SIGTERM"); } };
  stopForPolicy = () => stop(new Error("This recording's site approval or source changed."));
  const abort = () => stop(new Error("Recording cancelled."));
  // The guard stopping mid-attempt stops the attempt with it.
  let finished = false;
  void own?.closed.then(() => { if (!finished) stop(new TourCaptureFailure({ message: "Recording's network guard stopped, so the attempt stopped with it.", guidance: "Retry. Nothing was published." })); });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  // The busy-time budget: paused, with the time left kept, while a sign-in waits for its answer.
  let left = options.limitMs ?? TOUR_ATTEMPT_LIMIT_MS, since = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const runClock = () => { since = performance.now(); timeout = setTimeout(() => stop(new Error("Recording exceeded its 5-minute limit. Split the tour and retry.")), Math.max(0, left)); };
  const pauseClock = () => { if (timeout === undefined) return; clearTimeout(timeout); timeout = undefined; left -= performance.now() - since; };
  runClock();
  let signingIn = false;
  const resource = setInterval(() => {
    if (sampling) return;
    const pids = observe();
    if (stopping) { killTree("SIGKILL"); return; }
    if (process.platform === "linux") {
      let rss = 0;
      for (const pid of pids) {
        try { const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); rss += Number(match?.[1] ?? 0) * 1024; } catch { /* exited */ }
      }
      peakRssBytes = Math.max(peakRssBytes, rss);
      if (rss > 1536 * 1024 * 1024) stop(new Error("Recording exceeded its 1.5 GiB process-memory budget. Split the tour and retry."));
    } else if (pids.size) {
      // macOS has no procfs. One bounded asynchronous batch, never one synchronous ps per PID.
      sampling = true;
      execFile("ps", ["-o", "rss=", "-p", [...pids].join(",")], { encoding: "utf8", timeout: 2000, maxBuffer: 1_048_576, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
        sampling = false;
        if (stopping || proc.exitCode !== null || proc.signalCode !== null) return;
        const values = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
        if (error || !values.length || values.some(v => !Number.isFinite(v) || v < 0)) { stop(new Error("Recording could not enforce its process-memory budget on this host.")); return; }
        const rss = values.reduce((total, value) => total + value * 1024, 0);
        peakRssBytes = Math.max(peakRssBytes, rss);
        if (rss > 1536 * 1024 * 1024) stop(new Error("Recording exceeded its 1.5 GiB process-memory budget. Split the tour and retry."));
      });
    }
  }, process.platform === "linux" ? 250 : 1000);
  const write = (message: TourParentMessage) => { if (!proc.stdin?.destroyed) proc.stdin?.write(`${JSON.stringify(message)}\n`); };
  const lines = createInterface({ input: proc.stdout! });
  let outputBytes = 0;
  let pending = 0;
  let stderrBytes = 0;
  proc.stderr?.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > 1_048_576) stop(new Error("Recording exceeded its diagnostic output limit.")); });
  // Cap before readline buffers a complete hostile/accidental line.
  proc.stdout?.on("data", (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > TOUR_LIMITS.totalBytes * 1.4 + 4_194_304) stop(new Error("Recording exceeded its IPC output limit.")); });
  lines.on("line", line => {
    if (failure) return;
    try {
      if (line.length > TOUR_LIMITS.assetBytes * 1.4 + 400_000) throw new Error("Recording exceeded its IPC message limit.");
      const message = JSON.parse(line) as TourChildMessage;
      if (message.type === "contact" || message.type === "checkpoint") {
        if (++pending > 256) throw new Error("Recording exceeded its pending policy-check limit.");
        // A passed contact makes its origin one this page requested, before the child may proceed.
        void (message.type === "contact" ? checkContact(message.origin).then(() => { routed.add(message.origin); }) : checkpoint()).then(() => write({ type: "answer", id: message.id }), error => {
          const safe = error instanceof TourCaptureFailure ? error.failure : { message: "Recording source ownership or site approval changed.", guidance: error instanceof Error ? error.message.slice(0, 1000) : "Review this copy and site consent, then retry." };
          write({ type: "answer", id: message.id, failure: safe });
          policyError ??= error;
        }).finally(() => { pending--; });
      } else if (message.type === "asset") {
        if (options.dryRun || !isTourFile(message.file) || assets.has(message.file) || assets.size >= TOUR_LIMITS.assets || typeof message.base64 !== "string" || message.base64.length > TOUR_LIMITS.assetBytes * 1.4) throw new Error("Invalid recording image output.");
        const bytes = Buffer.from(message.base64, "base64"); tourAsset(message.file, bytes); assetBytes += bytes.length;
        if (assetBytes > TOUR_LIMITS.totalBytes) throw new Error("Recording exceeded its total image budget.");
        assets.set(message.file, bytes);
      } else if (message.type === "sign-in-needed") {
        const fields = JSON.stringify(message.fields);
        if (signingIn || !signInOrigins.includes(message.origin) || !Number.isInteger(message.id) || (fields !== (script.signIn?.account ? '["account","username","password"]' : '["username","password"]') && fields !== '["code"]') || (message.reason !== undefined && (typeof message.reason !== "string" || message.reason.length > 300))) throw new Error("Invalid recording sign-in request.");
        if (!options.onSignIn) { write({ type: "answer", id: message.id, failure: { message: "This page asks to sign in, and this recording can't take a sign-in.", guidance: "Record it from the tour's chat." } }); return; }
        signingIn = true; pauseClock();
        options.onSignIn({ origin: message.origin, fields: message.fields, ...(message.reason ? { reason: message.reason } : {}) }).then(answer => {
          signingIn = false;
          if (stopping) return;
          runClock();
          write({ type: "sign-in", id: message.id, ...(answer.account !== undefined ? { account: answer.account } : {}), ...(answer.username !== undefined ? { username: answer.username } : {}), ...(answer.password !== undefined ? { password: answer.password } : {}), ...(answer.code !== undefined ? { code: answer.code } : {}) });
        }, (error: unknown) => {
          signingIn = false;
          // Too many waiting, a cancel, the hour running out: the attempt stops with that reason.
          policyError ??= error;
          stop(error instanceof Error ? error : new Error("Recording sign-in stopped."));
        });
      } else if (message.type === "signed-in") {
        if (!signInOrigins.includes(message.origin) || !message.storage || !Array.isArray(message.storage.cookies) || !Array.isArray(message.storage.origins)) throw new Error("Invalid recording sign-in state.");
        signedIn = true;
        options.onSignedIn?.(message.origin, message.storage);
      } else if (message.type === "progress") options.onProgress?.(message.progress);
      else if (message.type === "failure") { failure = new TourCaptureFailure(message.failure as TourFailure); }
      else if (message.type === "result") { if (result) throw new Error("Duplicate recording result."); result = message; }
      else throw new Error("Unexpected recording output.");
    } catch (error) { stop(error instanceof Error ? error : new Error("Invalid recording output.")); }
  });
  try {
    const exited = new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
    write({ type: "start", input: { script, origin: target.origin, dryRun: options.dryRun, proxied, declared: [...declared], ...(options.account ? { account: options.account } : {}), ...(sova ? { sova } : {}), ...(script.signIn ? { signIn: { origins: signInOrigins, ...(options.signInStorage ? { storage: options.signInStorage } : {}) } } : {}), ...(options.look ? { look: { ...(options.look.signInRoute ? { signInRoute: options.look.signInRoute } : {}) } } : {}) } });
    const code = await exited;
    if (policyError) throw policyError;
    if (failure) throw failure;
    if (code !== 0 || !result) throw new Error("The installed recording browser stopped before completing this attempt. Check its installation and sandbox; no partial edition was published.");
    await target.assertCurrent();
    if (typeof result.sovaServer !== "boolean" || (result.quietAborts !== undefined && !(Number.isInteger(result.quietAborts) && result.quietAborts >= 0 && result.quietAborts <= 1_000_000)) || (result.signedIn !== undefined && typeof result.signedIn !== "boolean") || (result.signedIn && !script.signIn)) throw new Error("Invalid recording result.");
    const look = options.look ? normalizeTourLookResult(result.look) : undefined;
    if (options.look ? !look : result.look !== undefined) throw new Error("Invalid look result.");
    if (!Array.isArray(result.publicOrigins) || result.publicOrigins.length > 64 || !result.publicOrigins.every(isTourOrigin) || new Set(result.publicOrigins).size !== result.publicOrigins.length) throw new Error("Invalid recording address attestation.");
    if (!options.dryRun) {
      assertTourCoverage(script, result.steps);
      const listed = new Set([...result.steps.flatMap(s => s.views.flatMap(v => Object.values(v.captures).map(c => c.image))), ...result.contactSheets]);
      if (listed.size !== assets.size || [...listed].some(file => !assets.has(file)) || !result.suspicious.every(file => assets.has(file))) throw new Error("The recording image inventory is incomplete.");
    }
    return { ...(look ? { look } : {}), ...(sova ? { sovaCopy: true as const } : {}), ...(result.quietAborts ? { quietAborts: result.quietAborts } : {}), ...(script.signIn && (result.signedIn || signedIn) ? { signedIn: true as const } : {}), steps: result.steps, assets, contactSheets: result.contactSheets, suspicious: result.suspicious, provenance: { origin: target.origin, recordedAt: new Date().toISOString(), publicOrigins: proxied ? [] : result.publicOrigins, ...(target.generation !== undefined ? { generation: target.generation } : {}) }, sovaServer: result.sovaServer, scriptDigest: tourScriptDigest(script), metrics: { wallTimeMs: Math.round(performance.now() - startedAt), peakRssBytes, storedBytes: assetBytes } };
  } finally {
    clearTimeout(timeout); clearInterval(resource); options.signal?.removeEventListener("abort", abort); lines.close();
    finished = true;
    killTree("SIGKILL");
    await child.dispose();
    await own?.close();
  }
}

/** The copy's install token as its sign-in cookie: read with no link followed, size-bounded, never echoed. */
async function sovaCopyCookie(origin: string, agentDir: string): Promise<{ origin: string; name: string; value: string; marker: string }> {
  const bytes = readBounded(agentDir, join(agentDir, "sova", "auth-token"), 512);
  const value = bytes?.toString("utf8").trim() ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new TourCaptureFailure({ message: "This test copy's sign-in could not be read safely.", guidance: "Start the test copy so it creates its own sign-in, then retry. Its state directory must hold no links." });
  const { authCookieName, tourRecorderCookieName } = await import("../auth");
  return { origin, name: authCookieName(agentDir), value, marker: tourRecorderCookieName(agentDir) };
}
