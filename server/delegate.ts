import { join } from "node:path";
import { agentRoot } from "./state-root";
import {
  CLAUDE_EFFORTS,
  DELEGATE_BACKENDS,
  DELEGATE_FILE_NAME,
  DELEGATE_PROFILE_INFO,
  DELEGATE_PROFILES,
  delegateDefaults,
  effectiveEfforts,
  loadDelegate,
  modelShapeError,
  parseDelegate,
  PI_EFFORTS,
  saveDelegate,
  sameChoice,
  type DelegateBackend,
  type DelegateSettings,
  type WorkerChoice,
} from "../pi-config/extensions/mode/delegate.ts";
import type {
  DelegateBackendOptions,
  DelegateModelOption,
  DelegateOptions,
  DelegateSaveResult,
  DelegateSettingsInfo,
  ModelInfo,
  ModelPolicy,
} from "../shared/protocol";
import { claudeDrift, claudeOffer } from "../pi-config/extensions/claude-code/catalog.ts";
import { discoverClaudeModels, type ClaudeModel } from "./claude-models";
import { CLAUDE_CODE_PROVIDER } from "./models";

// Delegate routing (legacy file; Settings → Subagents now edits it per profile): which worker each
// kind of Delegate work goes to. The file (~/.pi/agent/mode-delegate.json) and its rules are the mode
// extension's (pi-config/extensions/mode/delegate.ts, imported as one of the server's pure mode
// modules); this module adds what only the server can: the models each backend actually
// offers, the policy's view of them, and a save that refuses what discovery says cannot run.
// Every Delegate session — TUI or web — re-reads the file at its next turn boundary.

export const delegateFile = () => join(agentRoot(), DELEGATE_FILE_NAME);

const BACKEND_LABELS: Record<DelegateBackend, string> = { pi: "pi", "claude-code": "Claude Code" };

// Compile-time: the extension's shape is the wire shape.
const _wire: DelegateSettingsInfo["settings"] = delegateDefaults();
void _wire;

export function delegateInfo(file = delegateFile()): DelegateSettingsInfo {
  return {
    settings: loadDelegate(file),
    defaults: delegateDefaults(),
    profiles: DELEGATE_PROFILES.map((id) => ({ id, label: DELEGATE_PROFILE_INFO[id].label, description: DELEGATE_PROFILE_INFO[id].description })),
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    file,
  };
}

// ── Policy (the subagent view of model-policy.json) ─────────────────────────────────────────────

const has = (list: string[], value: string) => list.some((e) => e.toLowerCase() === value.toLowerCase());

/**
 * Why subagents may not run this worker, or null. The same rule the subagents extension applies at
 * spawn (subagents/policy.ts policyDenial): a pi ref's provider is its prefix, a backend's is the
 * backend id, and a backend model matches its bare id or "backend/id". Shown, never enforced here —
 * spawn enforces it, and Delegate routes a denied primary to its fallback, disclosed.
 */
export function workerDenial(policy: ModelPolicy, backend: DelegateBackend, model: string): string | null {
  const provider = backend === "pi" ? model.slice(0, Math.max(0, model.indexOf("/"))).toLowerCase() : backend;
  const refs = backend === "pi" ? [model] : [model, `${backend}/${model}`];
  if (provider && has(policy.disabledProviders, provider)) return `${provider} is turned off in Settings → Models`;
  if (provider && has(policy.subagentDisabledProviders, provider)) return `${provider} is off for subagents in Settings → Models`;
  if (refs.some((r) => has(policy.disabledModels, r))) return `${model} is turned off in Settings → Models`;
  if (refs.some((r) => has(policy.subagentDisabledModels, r))) return `${model} is off for subagents in Settings → Models`;
  return null;
}

// ── Discovery ──────────────────────────────────────────────────────────────────────────────────

export interface DelegateSources {
  /** pi's models with credentials, unfiltered by the picker's switches (models.ts listRegistryModels). */
  piModels(): Promise<Pick<ModelInfo, "ref" | "id" | "provider" | "thinkingLevels">[]>;
  claudeModels(): Promise<ClaudeModel[]>;
  policy(): ModelPolicy;
}

const CLAUDE_TTL_MS = 60_000;
/** How long the options wait for the CLI's list before answering without its drift. */
const CLAUDE_DRIFT_WAIT_MS = 3_000;
let claudeCache: { at: number; models: ClaudeModel[] } | undefined;
let claudeInFlight: Promise<ClaudeModel[]> | undefined;

/**
 * The CLI's initialize list, cached 60 s; failures are not cached, concurrent asks share one CLI
 * run. Read only for drift (§app.claude-code-provider/catalog-drift): what Settings offers is Sova's
 * Claude catalog, never this list.
 */
export function cachedClaudeModels(discover: () => Promise<ClaudeModel[]> = () => discoverClaudeModels()): Promise<ClaudeModel[]> {
  if (claudeCache && Date.now() - claudeCache.at < CLAUDE_TTL_MS) return Promise.resolve(claudeCache.models);
  claudeInFlight ??= discover()
    .then((models) => {
      claudeCache = { at: Date.now(), models };
      return models;
    })
    .finally(() => {
      claudeInFlight = undefined;
    });
  return claudeInFlight;
}

/** Test seam: forget the cached Claude list. */
export const resetClaudeCache = () => {
  claudeCache = undefined;
  claudeInFlight = undefined;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");

/**
 * Every backend's offer, as the screen needs it: ids, names, the efforts each model supports, and
 * the policy's denial. A backend whose discovery fails comes back with `models: null` and the
 * reason — never an empty list, which would claim nothing is offered.
 */
export async function delegateOptions(sources: DelegateSources): Promise<DelegateOptions> {
  const policy = sources.policy();
  const withDenial = (backend: DelegateBackend, option: Omit<DelegateModelOption, "denied">): DelegateModelOption => {
    const denied = workerDenial(policy, backend, option.id);
    return denied ? { ...option, denied } : option;
  };
  const pi = async (): Promise<DelegateBackendOptions> => {
    try {
      const models = await sources.piModels();
      return {
        id: "pi",
        label: BACKEND_LABELS.pi,
        sessionScopedProviders: [CLAUDE_CODE_PROVIDER],
        models: models
          .map((m) => withDenial("pi", { id: m.ref, name: m.ref, efforts: effectiveEfforts("pi", m.thinkingLevels) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    } catch (err) {
      return { id: "pi", label: BACKEND_LABELS.pi, models: null, error: message(err) };
    }
  };
  // Sova's Claude catalog, at once and offline (§app.claude-code-provider/catalog); the CLI's own list,
  // when it answers within CLAUDE_DRIFT_WAIT_MS, only says what differs.
  const claude = async (): Promise<DelegateBackendOptions> => {
    let drift: DelegateBackendOptions["drift"];
    try {
      const listed = await Promise.race([sources.claudeModels(), new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), CLAUDE_DRIFT_WAIT_MS).unref?.())]);
      const d = claudeDrift(listed);
      if (d.unknown.length || d.moved.length) drift = d;
    } catch {
      /* drift unknown: nothing changes */
    }
    return {
      id: "claude-code",
      label: BACKEND_LABELS["claude-code"],
      models: claudeOffer().map((m) =>
        withDenial("claude-code", {
          id: m.id,
          name: m.name,
          // The same rule routing applies (delegate.ts effectiveEfforts): a model taking no effort
          // control is unconstrained.
          efforts: effectiveEfforts("claude-code", [...m.efforts]),
        }),
      ),
      ...(drift ? { drift } : {}),
    };
  };
  return { backends: await Promise.all([pi(), claude()]) };
}

// ── Save ─────────────────────────────────────────────────────────────────────────────────────────

/** A pi ref of a provider this server can't speak for (DelegateBackendOptions.sessionScopedProviders). */
const sessionScoped = (backend: DelegateBackendOptions, model: string): boolean => {
  const slash = model.indexOf("/");
  return slash > 0 && !!backend.sessionScopedProviders?.includes(model.slice(0, slash));
};

/**
 * What discovery says about one tuple: an error when the backend answered and cannot run it, a
 * warning when it cannot be checked or the policy refuses it. Pure; exported for tests.
 *
 * Claude Code is judged by Sova's catalog: a shape-valid Claude id it doesn't know is a warning,
 * never an error, and still used — the same reading the mode extension routes by (routing.ts
 * assess). pi's registry is local and reliable: there absence stands.
 */
export function checkChoice(choice: WorkerChoice, options: DelegateOptions, owner = "Delegate", otherwise = "asks"): { error?: string; warning?: string } {
  const backend = options.backends.find((b) => b.id === choice.backend);
  if (!backend || backend.models === null)
    return { warning: `not verified — ${BACKEND_LABELS[choice.backend]} couldn't list its models${backend?.error ? ` (${backend.error})` : ""}` };
  const model = backend.models.find((m) => m.id === choice.model);
  if (!model && sessionScoped(backend, choice.model))
    return { warning: `not verified — ${choice.model.slice(0, choice.model.indexOf("/"))} models exist only in sessions started with that provider on` };
  if (!model && choice.backend === "claude-code" && modelShapeError("claude-code", choice.model) === null)
    return { warning: `not verified — ${choice.model} is not in Sova's Claude catalog; it will still be used` };
  if (!model) return { error: `${choice.model} isn't offered by ${BACKEND_LABELS[choice.backend]}` };
  if (!model.efforts.includes(choice.effort))
    return { error: `${choice.model} doesn't take effort "${choice.effort}" (it takes ${model.efforts.join(", ") || "none"})` };
  if (model.denied) return { warning: `${model.denied}; ${owner} uses the fallback or ${otherwise}` };
  return {};
}

/**
 * Replace the whole routing (PUT). Shape first (the extension's strict parse), then discovery:
 * a CHANGED tuple the backend authoritatively cannot run is refused; one that can't be checked,
 * or that the policy refuses, is saved with a warning. A tuple left as it was stored is never
 * refused — the save must not be blocked by a slot the user didn't touch — and warns instead.
 */
export async function saveDelegateSettings(
  body: unknown,
  sources: DelegateSources,
  file = delegateFile(),
): Promise<DelegateSaveResult | { error: string }> {
  const parsed = parseDelegate(body);
  if ("error" in parsed) return parsed;
  const stored = loadDelegate(file);
  const options = await delegateOptions(sources);
  const slots = DELEGATE_PROFILES.flatMap((id) =>
    (["primary", "fallback"] as const).map((slot) => ({
      label: `${DELEGATE_PROFILE_INFO[id].label} ${slot}`,
      choice: parsed.profiles[id][slot],
      stored: stored.profiles[id][slot],
    })),
  );
  const verdict = verifySlots(slots, options);
  if ("error" in verdict) return verdict;
  saveDelegate(file, parsed);
  return { ...delegateInfo(file), warnings: verdict.warnings };
}

/**
 * The save check both worker settings share (Delegate's profiles, the spec writer): a CHANGED tuple
 * its backend authoritatively cannot run is an error; one that can't be checked, or that the policy
 * refuses, is a warning; a tuple left as it was stored never blocks the save. Slots on a backend
 * that couldn't list its models get one sentence per backend, not one per slot.
 */
export function verifySlots(
  slots: { label: string; choice: WorkerChoice | null; stored: WorkerChoice | null | undefined }[],
  options: DelegateOptions,
  owner = "Delegate",
  /** What happens when the fallback can't run either: Delegate asks; a team isn't created. */
  otherwise = "asks",
): { warnings: string[] } | { error: string } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unlisted = new Map<DelegateBackend, string[]>();
  for (const { label, choice, stored } of slots) {
    if (!choice) continue;
    if (options.backends.find((b) => b.id === choice.backend)?.models === null) {
      unlisted.set(choice.backend, [...(unlisted.get(choice.backend) ?? []), label]);
      continue;
    }
    const verdict = checkChoice(choice, options, owner, otherwise);
    const unchanged = sameChoice(choice, stored);
    if (verdict.error && !unchanged) errors.push(`${label}: ${verdict.error}`);
    else if (verdict.error || verdict.warning) warnings.push(`${label}: ${verdict.error ?? verdict.warning}`);
  }
  if (errors.length > 0) return { error: `${errors.join(". ")}.` };
  for (const [backend, labels] of unlisted) {
    const why = options.backends.find((b) => b.id === backend)?.error;
    warnings.unshift(`Not verified, because ${BACKEND_LABELS[backend]} couldn't list its models${why ? ` (${why})` : ""}: ${labels.join(", ")}`);
  }
  return { warnings };
}

export type { DelegateSettings };
