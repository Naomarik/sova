import type { DecisionFailure, DecisionProviderId } from "../shared/protocol";

// The decision seam (Settings → Decisions): features ask typed questions about a text state and
// get typed answers with probabilities back. Jev (decide-jev.ts) and any pi / Claude Code model
// (decide-llm.ts) implement it; the chain (decide-chain.ts) is a third implementation that picks
// between them. Nothing above this seam names a provider. Pure: no I/O here.

export type { DecisionFailure, DecisionProviderId };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Text-only state: a string, or JSON built from strings/numbers/booleans (no images). */
export type DecisionState = string | JsonObject | JsonValue[];

/** Instructions may be structured (Jev takes object instructions; the LLM prompt renders them). */
export type Instructions = string | JsonObject;

export type Question =
  | { type: "boolean"; instructions: Instructions; criteria?: { true?: string; false?: string } }
  /** 2..255 options; the value is a one-line rubric, or null. */
  | { type: "choice"; instructions: Instructions; options: Record<string, string | null> }
  /** 2..10 ordered levels, lowest first. */
  | { type: "score"; instructions: Instructions; levels: readonly string[] };

export type Answer =
  /** P(yes), 0..1. */
  | { type: "boolean"; p: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /** score = the expectation over levels, in [0, levels-1]. */
  | { type: "score"; score: number; probabilities: number[]; confidence: number };

export type DecisionPurpose = "attention" | "worker" | "tags" | "probe";

export interface DecisionRequest {
  /** Which feature asks: logs, and the LLM system prompt. */
  purpose: DecisionPurpose;
  state: DecisionState;
  questions: Record<string, Question>;
  /** Callers pass their cache key: the chain runs one request per (purpose, dedupeKey) at a time. */
  dedupeKey?: string;
  signal?: AbortSignal;
}

export interface DecisionResult {
  /** One per question id, validated. */
  answers: Record<string, Answer>;
  provider: DecisionProviderId;
  /** "jev-1.13.0", "ollama-cloud/…", "haiku". */
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** Set by the chain when the first provider failed and a later one answered. */
  fellBackFrom?: { provider: DecisionProviderId; failure: DecisionFailure; message: string };
}

export interface DecisionProvider {
  readonly id: DecisionProviderId | "chain";
  readonly label: string;
  /** Throws DecisionError; never returns a partial answer set. */
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

export interface DecisionErrorOptions {
  status?: number;
  retryAfterMs?: number;
  requestId?: string;
  /** Which provider failed (set by providers; the chain reads it). */
  provider?: DecisionProviderId;
  cause?: unknown;
}

export class DecisionError extends Error {
  readonly failure: DecisionFailure;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly provider?: DecisionProviderId;
  constructor(failure: DecisionFailure, message: string, opts: DecisionErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "DecisionError";
    this.failure = failure;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.requestId = opts.requestId;
    this.provider = opts.provider;
  }
}

/**
 * Which failures the chain moves past to the next provider. NOT in the set: "bad-request". A
 * malformed question is the caller's defect; a second provider would either accept it silently
 * (an LLM) and hide the bug, or reject it too. It surfaces as an error.
 */
export const FALLS_THROUGH: ReadonlySet<DecisionFailure> = new Set<DecisionFailure>([
  "unavailable",
  "auth",
  "quota",
  "rate-limit",
  "overloaded",
  "timeout",
  "network",
  "too-large",
  "malformed-answer",
  "server",
]);

export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

const blank = (i: Instructions): boolean => (typeof i === "string" ? !i.trim() : Object.keys(i).length === 0);

/** Throws `bad-request` for a question set no provider should see. Runs before any network. */
export function validateQuestions(questions: Record<string, Question>): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new DecisionError("bad-request", "no questions");
  for (const id of ids) {
    const q = questions[id];
    if (!id.trim()) throw new DecisionError("bad-request", "empty question id");
    if (!q || typeof q !== "object") throw new DecisionError("bad-request", `question ${id}: not an object`);
    if (blank(q.instructions)) throw new DecisionError("bad-request", `question ${id}: empty instructions`);
    if (q.type === "choice") {
      const n = Object.keys(q.options ?? {}).length;
      if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new DecisionError("bad-request", `question ${id}: ${n} options (2..${MAX_CHOICE_OPTIONS})`);
      if (Object.keys(q.options).some((k) => !k.trim())) throw new DecisionError("bad-request", `question ${id}: empty option name`);
    } else if (q.type === "score") {
      const n = q.levels?.length ?? 0;
      if (n < 2 || n > MAX_SCORE_LEVELS) throw new DecisionError("bad-request", `question ${id}: ${n} levels (2..${MAX_SCORE_LEVELS})`);
      if (q.levels.some((l) => typeof l !== "string" || !l.trim())) throw new DecisionError("bad-request", `question ${id}: empty level`);
    } else if (q.type !== "boolean") {
      throw new DecisionError("bad-request", `question ${id}: unknown type`);
    }
  }
}

/** Rough token count: characters / 4, over the JSON text. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 4);
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** The formula Jev's docs use: (n·peak − 1)/(n − 1), clamped to 0..1. Uniform → 0, one-hot → 1. */
export function peakConfidence(probs: readonly number[]): number {
  const n = probs.length;
  if (n < 2) return 1;
  const peak = Math.max(...probs);
  return clamp01((n * peak - 1) / (n - 1));
}
export const choiceConfidence = (probs: Record<string, number>): number => peakConfidence(Object.values(probs));
export const scoreConfidence = (probs: readonly number[]): number => peakConfidence(probs);

/** Clamp to 0..1 and renormalize to sum 1; an all-zero list becomes uniform. */
export function normalizeDistribution(values: readonly number[]): number[] {
  const clamped = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0));
  const sum = clamped.reduce((a, b) => a + b, 0);
  if (sum <= 0) return clamped.map(() => 1 / clamped.length);
  return clamped.map((v) => v / sum);
}

const malformed = (msg: string) => new DecisionError("malformed-answer", msg);

/**
 * Raw per-question answers (the LLM contract: `{p}` for boolean, `{probabilities: {option: p}}` for
 * choice, `{probabilities: [p0..]}` or `{probabilities: {"0": p0, …}}` for score) → validated
 * Answers. Clamps, renormalizes, picks argmax, computes the score expectation. A missing id, an
 * unknown option or a wrong shape → `malformed-answer`.
 */
export function normalizeAnswers(questions: Record<string, Question>, raw: unknown): Record<string, Answer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw malformed("answer is not an object");
  const obj = raw as Record<string, unknown>;
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = obj[id];
    if (a === undefined) throw malformed(`no answer for ${id}`);
    if (q.type === "boolean") {
      const p = typeof a === "number" ? a : (a as { p?: unknown } | null)?.p;
      if (typeof p !== "number" || !Number.isFinite(p)) throw malformed(`${id}: expected a probability p`);
      out[id] = { type: "boolean", p: clamp01(p) };
    } else if (q.type === "choice") {
      const probs = (a as { probabilities?: unknown } | null)?.probabilities;
      if (!probs || typeof probs !== "object" || Array.isArray(probs)) throw malformed(`${id}: expected probabilities over options`);
      const keys = Object.keys(q.options);
      for (const k of Object.keys(probs)) if (!keys.includes(k)) throw malformed(`${id}: unknown option ${JSON.stringify(k).slice(0, 60)}`);
      const values = normalizeDistribution(keys.map((k) => Number((probs as Record<string, unknown>)[k] ?? 0)));
      const probabilities: Record<string, number> = Object.fromEntries(keys.map((k, i) => [k, values[i] ?? 0]));
      let best = 0;
      values.forEach((v, i) => (v > (values[best] ?? 0) ? (best = i) : undefined));
      out[id] = { type: "choice", choice: keys[best] ?? "", probabilities, confidence: choiceConfidence(probabilities) };
    } else {
      const probs = (a as { probabilities?: unknown } | null)?.probabilities;
      const n = q.levels.length;
      let list: number[];
      if (Array.isArray(probs)) {
        if (probs.length !== n) throw malformed(`${id}: expected ${n} level probabilities`);
        list = probs.map(Number);
      } else if (probs && typeof probs === "object") {
        for (const k of Object.keys(probs)) if (!/^\d+$/.test(k) || Number(k) >= n) throw malformed(`${id}: unknown level ${k}`);
        list = Array.from({ length: n }, (_, i) => Number((probs as Record<string, unknown>)[String(i)] ?? 0));
      } else {
        throw malformed(`${id}: expected probabilities over levels`);
      }
      const probabilities = normalizeDistribution(list);
      const score = probabilities.reduce((acc, p, i) => acc + p * i, 0);
      out[id] = { type: "score", score, probabilities, confidence: scoreConfidence(probabilities) };
    }
  }
  return out;
}

/**
 * The first balanced `{…}` in a model's text (fences and prose around it tolerated), parsed.
 * Throws `malformed-answer` when there is none or it doesn't parse.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw malformed("no JSON object in the reply");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        throw malformed("the reply's JSON object does not parse");
      }
    }
  }
  throw malformed("unterminated JSON object in the reply");
}

/** A short, secret-free message for logs and the settings screen. */
export const failureMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
