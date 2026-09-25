import {
  DecisionError,
  normalizeAnswers,
  validateQuestions,
  type DecisionFailure,
  type DecisionProvider,
  type DecisionProviderId,
  type DecisionRequest,
  type DecisionResult,
} from "./decide";

// A scripted DecisionProvider for tests (the feature modules' and the chain's): no network, no
// model. Features take a `() => DecisionProvider` and never know which provider exists.

/** Raw answers in the LLM contract (see normalizeAnswers), or a failure to throw. */
export type FakeReply = Record<string, unknown> | { fail: DecisionFailure; message?: string; retryAfterMs?: number };

export interface FakeProvider extends DecisionProvider {
  readonly id: DecisionProviderId;
  /** Every request seen, in order. */
  readonly calls: DecisionRequest[];
  /** Calls running right now, and the most ever at once. */
  readonly inFlight: number;
  readonly maxInFlight: number;
}

export interface FakeProviderOptions {
  id?: DecisionProviderId;
  model?: string;
  /** Per-call reply: a fixed value, or computed from the request (and the 0-based call index). */
  reply: FakeReply | ((req: DecisionRequest, call: number) => FakeReply | Promise<FakeReply>);
  /** Resolve after this many ms (or when the returned promise settles). */
  delayMs?: number;
}

const isFailure = (r: FakeReply): r is { fail: DecisionFailure; message?: string; retryAfterMs?: number } =>
  typeof (r as { fail?: unknown }).fail === "string";

export function createFakeProvider(opts: FakeProviderOptions): FakeProvider {
  const id = opts.id ?? "jev";
  const calls: DecisionRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    id,
    label: `fake ${id}`,
    calls,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      const call = calls.length;
      calls.push(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const started = Date.now();
      try {
        validateQuestions(req.questions);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const reply = typeof opts.reply === "function" ? await opts.reply(req, call) : opts.reply;
        if (isFailure(reply)) throw new DecisionError(reply.fail, reply.message ?? `fake ${reply.fail}`, { provider: id, retryAfterMs: reply.retryAfterMs });
        return { answers: normalizeAnswers(req.questions, reply), provider: id, model: opts.model ?? `fake-${id}`, latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof DecisionError && !err.provider) throw new DecisionError(err.failure, err.message, { provider: id });
        throw err;
      } finally {
        inFlight--;
      }
    },
  };
}
