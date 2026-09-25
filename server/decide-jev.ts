import {
  DecisionError,
  estimateTokens,
  failureMessage,
  normalizeDistribution,
  peakConfidence,
  validateQuestions,
  type Answer,
  type DecisionFailure,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type Question,
} from "./decide";

// Jev (TypeSafe, https://api.typesafe.ai): POST /v1/systemone {state, model, questions}. Plain
// fetch, no SDK. boolean → noul, choice → choice (criteria = options), score → score (criteria =
// levels). The key is read per call and never appears in an error, a log line or the wire.

export const JEV_API = "https://api.typesafe.ai";
export const JEV_TIMEOUT_MS = 8_000;
/** Jev's limit is 32k tokens for state + the longest question; keep a margin (chars/4 is rough). */
export const JEV_MAX_TOKENS = 30_000;

export interface JevProviderOptions {
  key: () => string | null;
  fetch?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, string | null> }
  | { type: "score"; instructions: unknown; criteria: string[] };

export function toJevQuestion(q: Question): JevQuestion {
  if (q.type === "boolean") return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  if (q.type === "choice") return { type: "choice", instructions: q.instructions, criteria: q.options };
  return { type: "score", instructions: q.instructions, criteria: [...q.levels] };
}

const malformed = (msg: string, requestId?: string) => new DecisionError("malformed-answer", msg, { provider: "jev", requestId });

/** One Jev answer → our Answer (confidence is recomputed from the probabilities when absent). */
export function fromJevAnswer(id: string, q: Question, raw: unknown, requestId?: string): Answer {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") throw malformed(`no answer for ${id}`, requestId);
  if (q.type === "boolean") {
    const p = a.noul;
    if (typeof p !== "number" || !Number.isFinite(p)) throw malformed(`${id}: no noul probability`, requestId);
    return { type: "boolean", p: Math.min(1, Math.max(0, p)) };
  }
  const probs = a.probabilities;
  if (!probs || typeof probs !== "object") throw malformed(`${id}: no probabilities`, requestId);
  if (q.type === "choice") {
    const keys = Object.keys(q.options);
    const values = normalizeDistribution(keys.map((k) => Number((probs as Record<string, unknown>)[k] ?? 0)));
    const probabilities: Record<string, number> = Object.fromEntries(keys.map((k, i) => [k, values[i] ?? 0]));
    const choice = typeof a.choice === "string" && keys.includes(a.choice) ? a.choice : (keys[values.indexOf(Math.max(...values))] ?? "");
    const confidence = typeof a.confidence === "number" ? Math.min(1, Math.max(0, a.confidence)) : peakConfidence(values);
    return { type: "choice", choice, probabilities, confidence };
  }
  const n = q.levels.length;
  const list = Array.isArray(probs) ? probs.map(Number) : Array.from({ length: n }, (_, i) => Number((probs as Record<string, unknown>)[String(i)] ?? 0));
  if (list.length !== n) throw malformed(`${id}: expected ${n} level probabilities`, requestId);
  const probabilities = normalizeDistribution(list);
  const score = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : probabilities.reduce((acc, p, i) => acc + p * i, 0);
  const confidence = typeof a.confidence === "number" ? Math.min(1, Math.max(0, a.confidence)) : peakConfidence(probabilities);
  return { type: "score", score: Math.min(n - 1, Math.max(0, score)), probabilities, confidence };
}

/** The error body's type and message, from both observed shapes ({detail:{error_type,message}} and {detail:"…"}). */
function errorDetail(body: unknown): { type: string; message: string } {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return { type: "", message: detail };
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: unknown; loc?: unknown } | undefined;
    return { type: "validation", message: `${String(first?.msg ?? "invalid request")}${Array.isArray(first?.loc) ? ` at ${first.loc.join(".")}` : ""}` };
  }
  if (detail && typeof detail === "object") {
    const d = detail as { error_type?: unknown; message?: unknown };
    return { type: String(d.error_type ?? ""), message: String(d.message ?? d.error_type ?? "") };
  }
  return { type: "", message: "" };
}

/** HTTP status + body → failure. Pure; exported for tests. */
export function jevFailure(status: number, body: unknown): { failure: DecisionFailure; message: string } {
  const { type, message } = errorDetail(body);
  const text = `${type} ${message}`.toLowerCase();
  const msg = (fallback: string) => (message ? `${fallback}: ${message}` : fallback).slice(0, 240);
  if (status === 402 || /quota|credit|billing|payment|insufficient/.test(text)) return { failure: "quota", message: msg("Jev credits or quota exhausted") };
  if (status === 401 || status === 403) return { failure: "auth", message: msg("Jev rejected the key") };
  if (status === 429) return { failure: "rate-limit", message: msg("Jev rate limit") };
  if (status === 529 || status === 503) return { failure: "overloaded", message: msg("Jev is overloaded") };
  if (status === 400 && type === "max_tokens_exceeded") return { failure: "too-large", message: "the state is too large for Jev" };
  if (status === 400 || status === 422) return { failure: "bad-request", message: msg(`Jev refused the request (${status})`) };
  return { failure: "server", message: msg(`Jev answered ${status}`) };
}

const retryAfter = (h: string | null): number | undefined => {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

/** Run `fn` with an AbortSignal that fires at the deadline or when `outer` aborts. */
async function withDeadline<T>(timeoutMs: number, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export function createJevProvider(opts: JevProviderOptions): DecisionProvider & { readonly id: "jev"; checkKey(key?: string): Promise<{ ok: boolean; failure?: DecisionFailure; message?: string }> } {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? "jev-latest";
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const base = opts.baseUrl ?? JEV_API;

  /** Scrub the key out of anything we are about to report (belt and braces: we never include it). */
  const scrub = (text: string, key: string) => (key ? text.split(key).join("[redacted]") : text);

  return {
    id: "jev",
    label: "Jev",
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      validateQuestions(req.questions);
      const key = opts.key();
      if (!key) throw new DecisionError("unavailable", "no Jev key is stored", { provider: "jev" });
      const questions = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, toJevQuestion(q)]));
      const longest = Math.max(...Object.values(questions).map((q) => estimateTokens(q)));
      if (estimateTokens(req.state) + longest > JEV_MAX_TOKENS) throw new DecisionError("too-large", "the state is too large for Jev", { provider: "jev" });
      const started = Date.now();
      let res: Response;
      try {
        res = await withDeadline(timeoutMs, req.signal, (signal) =>
          doFetch(`${base}/v1/systemone`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ state: req.state, model, questions }),
            signal,
          }),
        );
      } catch (err) {
        const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        throw new DecisionError(aborted ? "timeout" : "network", aborted ? `Jev did not answer within ${timeoutMs} ms` : scrub(`Jev unreachable: ${failureMessage(err)}`, key), { provider: "jev" });
      }
      const requestId = res.headers.get("x-typesafe-request-id") ?? undefined;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const { failure, message } = jevFailure(res.status, body);
        throw new DecisionError(failure, scrub(message, key), { provider: "jev", status: res.status, requestId, retryAfterMs: res.status === 429 ? (retryAfter(res.headers.get("retry-after")) ?? undefined) : undefined });
      }
      const b = body as { answers?: Record<string, unknown>; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
      if (!b || !b.answers || typeof b.answers !== "object") throw malformed("Jev's reply has no answers", requestId);
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, fromJevAnswer(id, q, b.answers?.[id], requestId)]));
      const usage =
        b.usage && typeof b.usage.input_tokens === "number" ? { inputTokens: b.usage.input_tokens, outputTokens: typeof b.usage.output_tokens === "number" ? b.usage.output_tokens : 0 } : undefined;
      return { answers, provider: "jev", model: typeof b.model === "string" ? b.model : model, latencyMs: Date.now() - started, ...(usage ? { usage } : {}) };
    },
    /** GET /v1/models with this key (default: the stored one): does Jev accept it? Free. */
    async checkKey(candidate?: string) {
      const key = candidate ?? opts.key();
      if (!key) return { ok: false, failure: "unavailable" as const, message: "no Jev key is stored" };
      try {
        const res = await withDeadline(timeoutMs, undefined, (signal) => doFetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal }));
        if (res.ok) return { ok: true };
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* no body */
        }
        const { failure, message } = jevFailure(res.status, body);
        return { ok: false, failure, message: scrub(message, key) };
      } catch (err) {
        const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        return { ok: false, failure: aborted ? ("timeout" as const) : ("network" as const), message: scrub(aborted ? "Jev did not answer in time" : `Jev unreachable: ${failureMessage(err)}`, key) };
      }
    },
  };
}
