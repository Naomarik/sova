import { createSignal } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { getModelPolicy } from "./api";

/**
 * The model policy as the app sees it (Settings → Models, spec/12-settings-dialog.md §12).
 *
 * Two dimensions over the same names. GLOBAL says a provider or model may not be used at all —
 * not in a chat here, not in the TUI, not by a worker. SUBAGENT narrows what is still globally
 * allowed down to what subagents and team members may pick, so a model can be yours to drive by
 * hand and out of bounds for workers. Global therefore implies subagent, and the subagent entry is
 * kept rather than folded in: turning a model back on restores the worker preference it had.
 *
 * The shape mirrors the wire (GET/PUT /api/settings/models) and the file the server writes,
 * `~/.pi/agent/model-policy.json`, which the pi extensions read per spawn and per model change
 * (pi-config/extensions/model-policy/policy.ts). Providers are bare lowercase names; models are
 * "provider/modelId" refs. The server canonicalizes what it stores; everything here compares
 * lowercase so a hand-edited file still reads correctly.
 */
export interface ModelPolicy {
  /** Providers nothing may use. */
  disabledProviders: string[];
  /** "provider/modelId" refs nothing may use. */
  disabledModels: string[];
  /** Providers subagents may not use, on top of the global list. */
  subagentDisabledProviders: string[];
  /** Refs subagents may not use, on top of the global list. */
  subagentDisabledModels: string[];
}

export const EMPTY_POLICY: ModelPolicy = {
  disabledProviders: [],
  disabledModels: [],
  subagentDisabledProviders: [],
  subagentDisabledModels: [],
};

/** The Claude Code worker backend: one provider row, no model rows — its switch covers every
    Claude worker, its default model included. The id is the backend's, and the file's. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

const has = (list: string[], value: string) => list.some((entry) => entry.toLowerCase() === value.toLowerCase());

/** Is this provider allowed to be used at all? */
export const providerEnabled = (policy: ModelPolicy, provider: string) => !has(policy.disabledProviders, provider);

/** May subagents use this provider? A globally disabled provider never can. */
export const providerSubagentEnabled = (policy: ModelPolicy, provider: string) =>
  providerEnabled(policy, provider) && !has(policy.subagentDisabledProviders, provider);

/** The subagent switch as the user set it, ignoring whether the provider is globally on. Kept
    while the provider is off so turning it back on restores the preference (§12). */
export const providerSubagentPreference = (policy: ModelPolicy, provider: string) =>
  !has(policy.subagentDisabledProviders, provider);

/** Is this model allowed to be used at all? Its provider's switch covers it. */
export const modelEnabled = (policy: ModelPolicy, ref: string) =>
  providerEnabled(policy, providerOf(ref)) && !has(policy.disabledModels, ref);

/** May subagents use this model? */
export const modelSubagentEnabled = (policy: ModelPolicy, ref: string) =>
  modelEnabled(policy, ref) && providerSubagentEnabled(policy, providerOf(ref)) && !has(policy.subagentDisabledModels, ref);

/** The model's own subagent switch, ignoring what covers it. */
export const modelSubagentPreference = (policy: ModelPolicy, ref: string) => !has(policy.subagentDisabledModels, ref);

/** The provider half of a "provider/modelId" ref, lowercase; "" when there is no prefix. */
export const providerOf = (ref: string) => {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash).toLowerCase() : "";
};

const without = (list: string[], value: string) => list.filter((entry) => entry.toLowerCase() !== value.toLowerCase());
const with_ = (list: string[], value: string) => (has(list, value) ? list : [...list, value.toLowerCase()]);

/**
 * Turn a provider on or off globally. Off covers every model it serves, so their own global
 * entries leave the policy — the provider already says no, and turning it back on returns exactly
 * the list the screen showed. Subagent entries are untouched: they are a different question.
 */
export function setProviderEnabled(policy: ModelPolicy, provider: string, enabled: boolean): ModelPolicy {
  const prefix = `${provider.toLowerCase()}/`;
  return {
    ...policy,
    disabledProviders: enabled ? without(policy.disabledProviders, provider) : with_(policy.disabledProviders, provider),
    disabledModels: enabled
      ? policy.disabledModels
      : policy.disabledModels.filter((ref) => !ref.toLowerCase().startsWith(prefix)),
  };
}

/** Turn a provider on or off for subagents. Same rule, one dimension down. */
export function setProviderSubagents(policy: ModelPolicy, provider: string, enabled: boolean): ModelPolicy {
  const prefix = `${provider.toLowerCase()}/`;
  return {
    ...policy,
    subagentDisabledProviders: enabled
      ? without(policy.subagentDisabledProviders, provider)
      : with_(policy.subagentDisabledProviders, provider),
    subagentDisabledModels: enabled
      ? policy.subagentDisabledModels
      : policy.subagentDisabledModels.filter((ref) => !ref.toLowerCase().startsWith(prefix)),
  };
}

/** Turn one model on or off globally. */
export function setModelEnabled(policy: ModelPolicy, ref: string, enabled: boolean): ModelPolicy {
  return {
    ...policy,
    disabledModels: enabled ? without(policy.disabledModels, ref) : with_(policy.disabledModels, ref),
  };
}

/** Turn one model on or off for subagents. */
export function setModelSubagents(policy: ModelPolicy, ref: string, enabled: boolean): ModelPolicy {
  return {
    ...policy,
    subagentDisabledModels: enabled
      ? without(policy.subagentDisabledModels, ref)
      : with_(policy.subagentDisabledModels, ref),
  };
}

/** How many of these models may be used at all — the count a collapsed provider row carries. */
export const enabledCount = (policy: ModelPolicy, models: ModelInfo[]) =>
  models.filter((m) => modelEnabled(policy, m.ref)).length;

/**
 * The policy the app is working with, shared by the Settings dialog and the model picker: the
 * picker must not offer a model the server would refuse (spec/04c). Null before the first load.
 */
const [policy, setPolicy] = createSignal<ModelPolicy | null>(null);

export const modelPolicy = policy;

/** Replaces the cache (after a successful load or save). */
export const cacheModelPolicy = (next: ModelPolicy) => setPolicy(next);

/** Re-fetches and replaces the cache. Rejects like the request; the cache is left untouched. */
export async function loadModelPolicy(): Promise<ModelPolicy> {
  const next = await getModelPolicy();
  setPolicy(next);
  return next;
}

/** Fetches once; later calls resolve against the cache while nothing refreshes it. */
export async function ensureModelPolicy(): Promise<ModelPolicy> {
  return policy() ?? (await loadModelPolicy());
}

/**
 * The models a picker may offer. An unloaded policy hides nothing — the server refuses a disabled
 * model anyway, and a picker that empties itself because a fetch is in flight is worse than one
 * that briefly lists a model you can't pick.
 */
export const usableModels = (models: ModelInfo[]): ModelInfo[] => {
  const p = policy();
  return p ? models.filter((m) => modelEnabled(p, m.ref)) : models;
};
