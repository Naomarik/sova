// Where the Transport agent and Safe Transport plug into a transport (§app.transport/agent,
// §app.transport/safe-transport). Each has a default that works alone, so a transport runs with
// neither: the destination is ready at once, and at a Move's switch working helpers are interrupted.
// And the lab's knobs: SOVA_TRANSPORT_KILL_AT=<step> ends this server at that step, and
// SOVA_TRANSPORT_PAUSE_AT=<step> waits there until the transport is retried.
import type { SetupDef } from "./setup-def";
import type { Step } from "./store";

export interface ProjectRef {
  /** The repository's remotes, without credentials. */
  remotes: string[];
  /** Its first commit. */
  firstCommit?: string;
  /** The project's folder there: the repository when the chat's tree is a linked worktree, else the folder it goes to. */
  path: string;
}

export interface PrepareRequest {
  tid: string;
  /** The source, as this host's peers.json names it. */
  sourcePeer: string;
  sourceLabel?: string;
  sourceChatId: string;
  title: string;
  project: ProjectRef;
  /** The chat's own tree first. `head`: its commit when offered. */
  worktrees: { name: string; branch: string | null; head?: string }[];
  model?: string;
  /** The source chat's own model ("provider/model"): the agent's last fallback for its default. */
  chatModel?: string;
  /** The project comes in the package (§app.transport/package): nothing is cloned, and the setup checks run once it arrived. */
  fromSource?: boolean;
  /** The chat's worktrees' folders here (absolute): the agent's tools may write them once they are there. */
  trees?: string[];
}

export type Prepared = { ready: true } | { needsYou: string };

export interface RestResult {
  /** Helpers' chat session ids. */
  interrupted: string[];
  wrapped: string[];
  stillWorking: string[];
}

export interface NeedsAnswer {
  needs: string[];
  models: string[];
  modelDefault: string | null;
  preparedAt: number | null;
  /** This device lacks the repository and can't clone it: the project comes from the source. */
  fromSource?: boolean;
  /** With the project from the source: what its setup definition says this device still lacks, set up after arrival. */
  afterArrival?: string[];
}

export interface PreviewExtras {
  busyHelpers: { id: string; name: string; role?: string }[];
}

type PrepareFn = (req: PrepareRequest, o: { signal: AbortSignal }) => Promise<Prepared>;
type RestFn = (chatId: string, mode: "safe" | "interrupt", onProgress: (waiting: number) => void, o: { signal: AbortSignal }) => Promise<RestResult>;
/** Resolves with what the agent sets up there by short names once it has it ([]: nothing to set up). */
type AfterFn = (req: PrepareRequest & { privateFiles: string[]; sourceValues: string[] }) => void | string[] | Promise<void | string[]>;
type NeedsFn = (project: ProjectRef, opts?: { chatModel?: string; setup?: SetupDef | null }) => Promise<NeedsAnswer>;
type ExtrasFn = (chatId: string) => Promise<PreviewExtras> | PreviewExtras;
type InterruptFn = (chatId: string) => boolean;
type IsAgentFn = (sessionId: string) => boolean;

const hooks: {
  prepare: PrepareFn | null;
  rest: RestFn | null;
  after: AfterFn | null;
  needs: NeedsFn | null;
  extras: ExtrasFn | null;
  interrupt: InterruptFn | null;
  isAgent: IsAgentFn | null;
} = { prepare: null, rest: null, after: null, needs: null, extras: null, interrupt: null, isAgent: null };

export const setPrepareDestination = (fn: PrepareFn | null): void => void (hooks.prepare = fn);
export const setBringHelpersToRest = (fn: RestFn | null): void => void (hooks.rest = fn);
export const setAfterArrival = (fn: AfterFn | null): void => void (hooks.after = fn);
export const setNeedsAnswer = (fn: NeedsFn | null): void => void (hooks.needs = fn);
export const setPreviewExtras = (fn: ExtrasFn | null): void => void (hooks.extras = fn);
export const setInterruptWaiting = (fn: InterruptFn | null): void => void (hooks.interrupt = fn);
export const setIsTransportAgent = (fn: IsAgentFn | null): void => void (hooks.isAgent = fn);

export const prepareDestination = (req: PrepareRequest, o: { signal: AbortSignal }): Promise<Prepared> => (hooks.prepare ? hooks.prepare(req, o) : Promise.resolve({ ready: true }));
export const needsAnswer = (project: ProjectRef, opts: { chatModel?: string; setup?: SetupDef | null } = {}): Promise<NeedsAnswer> =>
  hooks.needs ? hooks.needs(project, opts) : Promise.resolve({ needs: [], models: [], modelDefault: null, preparedAt: null });
export const previewExtras = async (chatId: string): Promise<PreviewExtras> => (hooks.extras ? hooks.extras(chatId) : { busyHelpers: [] });
export const interruptWaiting = (chatId: string): boolean => hooks.interrupt?.(chatId) ?? false;
export const isTransportAgent = (sessionId: string): boolean => hooks.isAgent?.(sessionId) ?? false;
export const hasRestHook = (): boolean => hooks.rest !== null;
export function bringHelpersToRest(...a: Parameters<RestFn>): Promise<RestResult> | null {
  return hooks.rest ? hooks.rest(...a) : null;
}
/** How long the arrival waits to hear what is being set up there before it answers without it. */
export const SETTING_UP_WAIT_MS = 20_000;

/** After arrival: hand the Transport agent what is left. Resolves with what it sets up there (short names) once it
    has it, [] when nothing is, or [] after `waitMs` while it goes on by itself. Never throws. */
export function afterArrival(req: Parameters<AfterFn>[0], waitMs = SETTING_UP_WAIT_MS): Promise<string[]> {
  if (!hooks.after) return Promise.resolve([]);
  const run = Promise.resolve()
    .then(() => hooks.after!(req))
    .then((x) => (Array.isArray(x) ? x : []))
    .catch((err: unknown) => {
      console.error(`[transport] ${req.tid}: after arrival: ${err instanceof Error ? err.message : String(err)}`);
      return [] as string[];
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string[]>((ok) => {
    timer = setTimeout(() => ok([]), waitMs);
    timer.unref?.();
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

// ---- the lab's knobs ----------------------------------------------------------------------------

const paused = new Map<string, () => void>();

/** At `step` of transport `tid`: end the server (kill knob), or wait until it is retried (pause knob). */
export async function knob(tid: string, step: Step): Promise<void> {
  if (process.env.SOVA_TRANSPORT_KILL_AT === step) {
    console.log(`[transport] ${tid}: SOVA_TRANSPORT_KILL_AT=${step}: exiting`);
    process.kill(process.pid, "SIGKILL");
  }
  if (process.env.SOVA_TRANSPORT_PAUSE_AT === step) {
    console.log(`[transport] ${tid}: SOVA_TRANSPORT_PAUSE_AT=${step}: waiting for a retry`);
    await new Promise<void>((ok) => paused.set(tid, ok));
  }
}

/** A retry releases a paused step. True when one was waiting. */
export function releasePause(tid: string): boolean {
  const go = paused.get(tid);
  paused.delete(tid);
  go?.();
  return !!go;
}
