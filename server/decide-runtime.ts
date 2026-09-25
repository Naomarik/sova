import type { DecisionKeyInfo, DecisionSettings, WorkerChoice } from "../shared/protocol";
import { getModelRuntime } from "./chat-manager";
import { DecisionError, estimateTokens, type DecisionProvider, type DecisionProviderId, type DecisionRequest, type DecisionResult } from "./decide";
import { createDecisionChain, type DecisionChain } from "./decide-chain";
import { createJevProvider } from "./decide-jev";
import { createLlmProvider, type LlmProviderDeps, type LlmRuntime } from "./decide-llm";
import { readJevKey, last4 } from "./decide-secret";
import { readDecisionSettings } from "./decide-settings";
import { modelDenial, readModelPolicy } from "./model-policy";
import { serverRedactor } from "./overseer-redact";

// The one wiring of the decision seam: the chain built from Settings → Decisions and the stored
// key, the key's status, and the gate every feature request passes (redaction + a size cap).
// Features import `decisions()` (a DecisionProvider) and never name a provider.

/** Hard cap on a request's state after redaction (JSON characters ≈ 8k tokens). */
export const MAX_STATE_CHARS = 32_000;

type KeyState = { fingerprint: string; status: DecisionKeyInfo["status"]; checkedAt?: number; message?: string };

export interface DecisionRuntimeDeps {
  settings?: () => DecisionSettings;
  key?: () => { key: string; source: "file" | "env" } | null;
  fetch?: typeof fetch;
  llm?: LlmProviderDeps;
  now?: () => number;
  log?: (line: string) => void;
}

export interface DecisionRuntime {
  /** The chain as a provider, with redaction and the size cap in front of it: the ONLY way a
      decision leaves the process (chain and jev below expose no `decide`, so no caller can reach
      a provider around the redactor). */
  provider: DecisionProvider;
  chain: Pick<DecisionChain, "status" | "resetBreakers">;
  jev: Pick<ReturnType<typeof createJevProvider>, "checkKey">;
  keyInfo(): DecisionKeyInfo;
  /** Record the outcome of an explicit key check (PUT key). */
  setKeyStatus(status: DecisionKeyInfo["status"], message?: string): void;
  settings(): DecisionSettings;
}

const choiceKey = (c: WorkerChoice | null) => (c ? `${c.backend}|${c.model}|${c.effort}` : "");
const fingerprint = (key: string) => `${key.length}:${key.slice(0, 2)}:${last4(key)}`;

export function createDecisionRuntime(deps: DecisionRuntimeDeps = {}): DecisionRuntime {
  const settings = deps.settings ?? (() => readDecisionSettings());
  const readKey = deps.key ?? (() => readJevKey());
  const now = deps.now ?? Date.now;
  let keyState: KeyState | undefined;

  const currentKeyState = (): KeyState | undefined => {
    const k = readKey();
    if (!k) return (keyState = undefined);
    const fp = fingerprint(k.key);
    if (keyState?.fingerprint !== fp) {
      keyState = { fingerprint: fp, status: "unverified" };
      chain?.resetBreakers("jev");
    }
    return keyState;
  };

  const jev = createJevProvider({ key: () => readKey()?.key ?? null, fetch: deps.fetch });
  const llmDeps: LlmProviderDeps = deps.llm ?? {
    runtime: () => getModelRuntime() as unknown as Promise<LlmRuntime>,
    denial: (c) => modelDenial(readModelPolicy(), c.backend === "pi" ? c.model : `claude-code/${c.model}`),
  };
  let llm: { key: string; provider: ReturnType<typeof createLlmProvider> } | undefined;

  const providers = () => {
    const s = settings();
    const list: (DecisionProvider & { id: DecisionProviderId })[] = [];
    if (s.jev.enabled && currentKeyState()) list.push(jev);
    const k = choiceKey(s.fallback);
    if (llm?.key !== k) {
      if (llm) chain?.resetBreakers(llm.provider.id);
      llm = s.fallback ? { key: k, provider: createLlmProvider(s.fallback, llmDeps) } : undefined;
    }
    if (llm) list.push(llm.provider);
    return list;
  };

  const unavailableReason = () => {
    const s = settings();
    if (!s.jev.enabled) return "Jev is off and no fallback model is set.";
    return "No Jev key is stored and no fallback model is set.";
  };

  let chain: DecisionChain | undefined;
  chain = createDecisionChain({
    providers,
    unavailableReason,
    now,
    log: deps.log ?? ((line) => console.warn(line)),
    onAttempt: (id, outcome) => {
      if (id !== "jev") return;
      const ks = currentKeyState();
      if (!ks) return;
      if (outcome.ok) Object.assign(ks, { status: "ok", checkedAt: now(), message: undefined });
      else if (outcome.error.failure === "auth") Object.assign(ks, { status: "rejected", checkedAt: now(), message: outcome.error.message });
      else if (outcome.error.failure !== "unavailable" && outcome.error.failure !== "bad-request" && outcome.error.failure !== "too-large")
        Object.assign(ks, { status: ks.status === "ok" ? "ok" : "error", checkedAt: now(), message: outcome.error.message });
    },
  });
  const theChain = chain;

  const provider: DecisionProvider = {
    id: "chain",
    label: theChain.label,
    decide(req: DecisionRequest): Promise<DecisionResult> {
      // Redact before anything leaves the process, whichever provider answers.
      const state = serverRedactor().redactDeep(req.state);
      const size = typeof state === "string" ? state.length : JSON.stringify(state).length;
      if (size > MAX_STATE_CHARS)
        return Promise.reject(new DecisionError("too-large", `state is ${size} characters (cap ${MAX_STATE_CHARS}, ≈${estimateTokens(state)} tokens)`));
      return theChain.decide({ ...req, state });
    },
  };

  return {
    provider,
    chain: { status: () => theChain.status(), resetBreakers: (p) => theChain.resetBreakers(p) },
    jev: { checkKey: (key) => jev.checkKey(key) },
    settings,
    keyInfo(): DecisionKeyInfo {
      const k = readKey();
      if (!k) return { present: false, status: "absent" };
      const ks = currentKeyState();
      return {
        present: true,
        last4: last4(k.key),
        source: k.source,
        status: ks?.status ?? "unverified",
        ...(ks?.checkedAt ? { checkedAt: ks.checkedAt } : {}),
        ...(ks?.message ? { message: ks.message } : {}),
      };
    },
    setKeyStatus(status, message) {
      const ks = currentKeyState();
      if (ks) Object.assign(ks, { status, checkedAt: now(), message });
      if (status === "ok") theChain.resetBreakers("jev");
    },
  };
}

let shared: DecisionRuntime | undefined;
/** The server's one runtime (lazy). */
export const decisionRuntime = (): DecisionRuntime => (shared ??= createDecisionRuntime());

/** What features call: a DecisionProvider (the chain, redacted and capped). */
export const decisions = (): DecisionProvider => decisionRuntime().provider;

/** Is there any provider right now? Features report "unavailable" and send nothing when not. */
export const decisionsReady = (): boolean => decisionRuntime().chain.status().ready;

/** Features' settings view (features on/off, exclusions, neverSendTui): see decide-settings.ts maySend. */
export const decisionSettings = (): DecisionSettings => decisionRuntime().settings();
