import type { DecisionKeyInfo, DecisionProbeResult, DecisionSaveResult, DecisionSettingsInfo, DelegateOptions } from "../shared/protocol";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, PI_EFFORTS, sameChoice } from "../pi-config/extensions/mode/delegate.ts";
import { DecisionError, failureMessage, type Question } from "./decide";
import { decisionRuntime, type DecisionRuntime } from "./decide-runtime";
import { cleanKey, deleteJevKey, readJevKey, writeJevKey } from "./decide-secret";
import { decisionDefaults, decisionsFile, DECISION_SUGGESTIONS, parseDecisionSettings, readDecisionSettings, writeDecisionSettings } from "./decide-settings";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";

// Route handlers for Settings → Decisions (shared/protocol.ts DECISIONS block). Framework-free:
// each returns { status, body } so server/index.ts wires them in a line each.

export type RouteResult<T> = { status: 200; body: T } | { status: 400 | 409 | 422; body: { error: string } | T };

const BACKEND_LABELS = { pi: "pi", "claude-code": "Claude Code" } as const;

export function decisionsInfo(rt: DecisionRuntime = decisionRuntime()): DecisionSettingsInfo {
  return {
    settings: readDecisionSettings(),
    defaults: decisionDefaults(),
    key: rt.keyInfo(),
    chain: rt.chain.status(),
    suggestions: DECISION_SUGGESTIONS,
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    file: decisionsFile(),
  };
}

/** GET /api/settings/decisions/options: Delegate's discovery. */
export const decisionsOptions = (sources: DelegateSources): Promise<DelegateOptions> => delegateOptions(sources);

/** PUT /api/settings/decisions. A CHANGED fallback its backend can't run is refused (400); unverifiable or policy-denied saves with a warning. */
export async function saveDecisions(body: unknown, sources: DelegateSources, rt: DecisionRuntime = decisionRuntime()): Promise<RouteResult<DecisionSaveResult>> {
  const parsed = parseDecisionSettings(body);
  if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
  const stored = readDecisionSettings();
  let warnings: string[] = [];
  if (parsed.fallback && !sameChoice(parsed.fallback, stored.fallback)) {
    const verdict = verifySlots([{ label: "Fallback model", choice: parsed.fallback, stored: stored.fallback }], await delegateOptions(sources), "Decisions");
    if ("error" in verdict) return { status: 400, body: { error: verdict.error } };
    warnings = verdict.warnings;
  }
  writeDecisionSettings(parsed);
  const info = decisionsInfo(rt);
  if ((parsed.features.attention || parsed.features.tags) && !info.chain.ready)
    warnings.push(`${info.chain.reason ?? "No decision provider is available."} The features stay unavailable and send nothing until one is.`);
  return { status: 200, body: { ...info, warnings } };
}

/** PUT /api/settings/decisions/key {key}: checked against Jev first; a rejected key is not stored. */
export async function putJevKey(body: unknown, rt: DecisionRuntime = decisionRuntime()): Promise<RouteResult<DecisionKeyInfo>> {
  const raw = (body as { key?: unknown } | null)?.key;
  const key = cleanKey(raw);
  if (!key) return { status: 400, body: { error: "Paste the whole key: 20 to 512 characters, no spaces." } };
  if (readJevKey()?.source === "env") return { status: 409, body: { error: "SOVA_JEV_KEY is set in the server's environment; it overrides a stored key." } };
  const check = await rt.jev.checkKey(key);
  if (!check.ok && check.failure === "auth") return { status: 422, body: { present: rt.keyInfo().present, status: "rejected", message: check.message ?? "Jev rejected the key." } as DecisionKeyInfo };
  writeJevKey(key);
  rt.setKeyStatus(check.ok ? "ok" : "error", check.ok ? undefined : (check.message ?? check.failure));
  return { status: 200, body: rt.keyInfo() };
}

/** DELETE /api/settings/decisions/key. */
export function deleteKey(rt: DecisionRuntime = decisionRuntime()): RouteResult<DecisionKeyInfo> {
  if (readJevKey()?.source === "env") return { status: 409, body: { error: "SOVA_JEV_KEY is set in the server's environment; unset it there." } };
  deleteJevKey();
  rt.chain.resetBreakers("jev");
  return { status: 200, body: rt.keyInfo() };
}

/** The canned probe: tiny, no user data. */
export const PROBE_STATE = { message: "The deploy finished. Should I also update the changelog, or leave it for you?" };
export const PROBE_QUESTIONS: Record<string, Question> = {
  asks_user: { type: "boolean", instructions: "Does `message` ask the reader a question or for a decision?" },
  outcome: { type: "choice", instructions: "What does `message` report about the task?", options: { done: "finished", failed: "it failed", blocked: "waiting on someone" } },
};

/** POST /api/settings/decisions/probe: one canned decision through the chain. Never 5xx for a provider failure. */
export async function probeDecisions(rt: DecisionRuntime = decisionRuntime()): Promise<DecisionProbeResult> {
  try {
    const r = await rt.provider.decide({ purpose: "probe", state: PROBE_STATE, questions: PROBE_QUESTIONS });
    return {
      ok: true,
      provider: r.provider,
      model: r.model,
      latencyMs: r.latencyMs,
      ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}),
      chain: rt.chain.status(),
    };
  } catch (err) {
    const e = err instanceof DecisionError ? err : new DecisionError("server", failureMessage(err));
    return { ok: false, failure: e.failure, message: e.message, chain: rt.chain.status() };
  }
}
