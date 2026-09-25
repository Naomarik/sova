import type { DecisionChainStatus, DecisionProviderStatus } from "../shared/protocol";
import {
  DecisionError,
  failureMessage,
  FALLS_THROUGH,
  validateQuestions,
  type DecisionFailure,
  type DecisionProvider,
  type DecisionProviderId,
  type DecisionRequest,
  type DecisionResult,
} from "./decide";

// The chain: a DecisionProvider that tries its providers in order (the settings build the order:
// Jev when it is enabled and has a key, then the configured fallback model). A failure in
// FALLS_THROUGH moves to the next provider; "bad-request" never does. Per-provider circuit breaker,
// one in-flight request per (purpose, dedupeKey), and a global concurrency cap, so a backfill and a
// live turn never fan out into many parallel calls. In memory only.

export const AUTH_SKIP_MS = 15 * 60_000;
export const RATE_LIMIT_SKIP_MS = 30_000;
/** Consecutive overloaded/server/network/timeout failures: 1st, 2nd, 3rd+. */
export const ESCALATING_SKIP_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
export const DEFAULT_CONCURRENCY = 2;

type ChainProvider = DecisionProvider & { readonly id: DecisionProviderId };

export interface DecisionChainOptions {
  /** The providers in order, read at every call (settings changes apply at once). */
  providers: () => ChainProvider[];
  /** One sentence when `providers()` is empty ("Jev is off and no fallback model is set"). */
  unavailableReason?: () => string;
  concurrency?: number;
  now?: () => number;
  /** Called after every provider attempt (the runtime tracks the key's status from Jev's). */
  onAttempt?: (provider: DecisionProviderId, outcome: { ok: true } | { ok: false; error: DecisionError }) => void;
  log?: (line: string) => void;
}

export interface DecisionChain extends DecisionProvider {
  readonly id: "chain";
  status(): DecisionChainStatus;
  /** Forget breaker state (all, or one provider's): the key or the model setting changed. */
  resetBreakers(provider?: DecisionProviderId): void;
}

interface Breaker {
  until: number;
  strikes: number;
  lastFailure?: DecisionProviderStatus["lastFailure"];
  lastOkAt?: number;
}

const asDecisionError = (err: unknown, provider: DecisionProviderId): DecisionError => {
  if (err instanceof DecisionError) return err.provider ? err : new DecisionError(err.failure, err.message, { provider, status: err.status, retryAfterMs: err.retryAfterMs, requestId: err.requestId });
  const aborted = err instanceof Error && err.name === "AbortError";
  return new DecisionError(aborted ? "timeout" : "server", failureMessage(err), { provider, cause: err });
};

/** How long a failure keeps the provider out, or 0. Pure; exported for tests. */
export function skipFor(failure: DecisionFailure, strikes: number, retryAfterMs?: number): number {
  switch (failure) {
    case "auth":
    case "quota":
      return AUTH_SKIP_MS;
    case "rate-limit":
      return retryAfterMs && retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_SKIP_MS;
    case "overloaded":
    case "server":
    case "network":
    case "timeout":
      return ESCALATING_SKIP_MS[Math.min(strikes, ESCALATING_SKIP_MS.length) - 1] ?? 0;
    default:
      return 0; // unavailable, too-large, malformed-answer, bad-request: about this request, not the provider
  }
}

export function createDecisionChain(opts: DecisionChainOptions): DecisionChain {
  const now = opts.now ?? Date.now;
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const breakers = new Map<DecisionProviderId, Breaker>();
  const inFlight = new Map<string, Promise<DecisionResult>>();
  const waiters: (() => void)[] = [];
  let running = 0;

  const breaker = (id: DecisionProviderId): Breaker => {
    let b = breakers.get(id);
    if (!b) breakers.set(id, (b = { until: 0, strikes: 0 }));
    return b;
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (running < limit) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        running++;
        resolve();
      };
      const onAbort = () => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new DecisionError("timeout", "aborted while queued"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(go);
    });
  };
  const release = () => {
    running--;
    waiters.shift()?.();
  };

  const record = (id: DecisionProviderId, outcome: { ok: true } | { ok: false; error: DecisionError }) => {
    const b = breaker(id);
    if (outcome.ok) {
      b.strikes = 0;
      b.until = 0;
      b.lastOkAt = now();
    } else {
      const e = outcome.error;
      if (e.failure !== "unavailable" || e.message !== SKIPPED) {
        const escalates = ["overloaded", "server", "network", "timeout"].includes(e.failure);
        b.strikes = escalates ? b.strikes + 1 : b.strikes;
        const ms = skipFor(e.failure, b.strikes, e.retryAfterMs);
        if (ms > 0) b.until = now() + ms;
        b.lastFailure = { failure: e.failure, message: e.message, at: now(), ...(e.requestId ? { requestId: e.requestId } : {}) };
      }
    }
    try {
      opts.onAttempt?.(id, outcome);
    } catch {
      /* an observer never breaks a decision */
    }
  };

  const run = async (req: DecisionRequest): Promise<DecisionResult> => {
    validateQuestions(req.questions); // bad-request before any provider or queue slot
    const providers = opts.providers();
    if (providers.length === 0) throw new DecisionError("unavailable", opts.unavailableReason?.() ?? "no decision provider is configured");
    await acquire(req.signal);
    try {
      const failures: DecisionError[] = [];
      for (const p of providers) {
        const b = breaker(p.id);
        if (b.until > now()) {
          failures.push(new DecisionError("unavailable", SKIPPED, { provider: p.id }));
          continue;
        }
        try {
          const result = await p.decide(req);
          record(p.id, { ok: true });
          const first = failures[0];
          return first ? { ...result, fellBackFrom: { provider: first.provider ?? p.id, failure: first.failure, message: describe(first) } } : result;
        } catch (err) {
          const e = asDecisionError(err, p.id);
          record(p.id, { ok: false, error: e });
          opts.log?.(`[decide] ${req.purpose}: ${p.id} failed (${e.failure}): ${e.message}`);
          if (!FALLS_THROUGH.has(e.failure)) throw e;
          failures.push(e);
          if (req.signal?.aborted) break;
        }
      }
      const last = failures[failures.length - 1] ?? new DecisionError("unavailable", "no provider answered");
      const summary = failures.map((f) => `${f.provider}: ${f.failure} (${describe(f)})`).join("; ");
      throw new DecisionError(last.failure, summary, { provider: last.provider, retryAfterMs: last.retryAfterMs, requestId: last.requestId, cause: failures });
    } finally {
      release();
    }
  };

  return {
    id: "chain",
    label: "Decision chain",
    decide(req: DecisionRequest): Promise<DecisionResult> {
      if (!req.dedupeKey) return run(req);
      const key = `${req.purpose}\0${req.dedupeKey}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const p = run(req).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
    status(): DecisionChainStatus {
      const providers = opts.providers();
      const t = now();
      const list: DecisionProviderStatus[] = providers.map((p) => {
        const b = breakers.get(p.id);
        const skipped = !!b && b.until > t;
        return {
          id: p.id,
          label: p.label,
          state: skipped ? "skipped" : "ok",
          ...(skipped ? { until: b.until } : {}),
          ...(b?.lastFailure ? { lastFailure: b.lastFailure } : {}),
          ...(b?.lastOkAt ? { lastOkAt: b.lastOkAt } : {}),
        };
      });
      return list.length ? { ready: true, providers: list } : { ready: false, providers: [], reason: opts.unavailableReason?.() ?? "no decision provider is configured" };
    },
    resetBreakers(provider?: DecisionProviderId) {
      if (provider) breakers.delete(provider);
      else breakers.clear();
    },
  };
}

/** The message a breaker-skipped provider carries (its own failure is not repeated as new). */
const SKIPPED = "skipped: failing recently";

const describe = (e: DecisionError) => e.message.slice(0, 160);
