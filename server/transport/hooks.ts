// Where the Transport agent and Safe Transport plug into a transport (§app.transport/agent,
// §app.transport/safe-transport). Each has a default that works alone, so a transport runs with
// neither: the destination is ready at once, and at a Move's switch working helpers are interrupted.
// And the lab's knobs: SOVA_TRANSPORT_KILL_AT=<step> ends this server at that step, and
// SOVA_TRANSPORT_PAUSE_AT=<step> waits there until the transport is retried.
import type { Step } from "./store";

export interface ProjectRef {
  /** The repository's remotes, without credentials. */
  remotes: string[];
  /** Its first commit. */
  firstCommit?: string;
  /** The folder the chat's tree goes to there. */
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
  worktrees: { name: string; branch: string | null }[];
  model?: string;
  /** The source chat's own model ("provider/model"): the agent's last fallback for its default. */
  chatModel?: string;
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
}

export interface PreviewExtras {
  busyHelpers: { id: string; name: string; role?: string }[];
}

type PrepareFn = (req: PrepareRequest, o: { signal: AbortSignal }) => Promise<Prepared>;
type RestFn = (chatId: string, mode: "safe" | "interrupt", onProgress: (waiting: number) => void, o: { signal: AbortSignal }) => Promise<RestResult>;
type AfterFn = (req: PrepareRequest & { privateFiles: string[]; sourceValues: string[] }) => void | Promise<void>;
type NeedsFn = (project: ProjectRef, opts?: { chatModel?: string }) => Promise<NeedsAnswer>;
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
export const needsAnswer = (project: ProjectRef, opts: { chatModel?: string } = {}): Promise<NeedsAnswer> =>
  hooks.needs ? hooks.needs(project, opts) : Promise.resolve({ needs: [], models: [], modelDefault: null, preparedAt: null });
export const previewExtras = async (chatId: string): Promise<PreviewExtras> => (hooks.extras ? hooks.extras(chatId) : { busyHelpers: [] });
export const interruptWaiting = (chatId: string): boolean => hooks.interrupt?.(chatId) ?? false;
export const isTransportAgent = (sessionId: string): boolean => hooks.isAgent?.(sessionId) ?? false;
export const hasRestHook = (): boolean => hooks.rest !== null;
export function bringHelpersToRest(...a: Parameters<RestFn>): Promise<RestResult> | null {
  return hooks.rest ? hooks.rest(...a) : null;
}
export function afterArrival(req: Parameters<AfterFn>[0]): void {
  if (!hooks.after) return;
  void Promise.resolve()
    .then(() => hooks.after!(req))
    .catch((err) => console.error(`[transport] ${req.tid}: after arrival: ${err instanceof Error ? err.message : String(err)}`));
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
