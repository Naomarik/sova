// Settings → Summaries: the pure half of the form — what each model select lists, and what a row
// says about its pick. Runs under tsx --test.
//
// The model lists are Delegate's (GET /api/settings/delegate/options: pi's credentialed models, the
// Claude Code CLI's own list), but its `denied` is not used here. That field is the SUBAGENT
// dimension of the model policy, and a summarizer is not a subagent: the topic-outline extension
// checks only whether a model may be used at all (summarizers/policy-gate.ts → globallyEnabled),
// so a model that is merely off for subagents still summarizes. Reading `denied` would warn about
// a skip that never happens.

import type { DelegateOptions, SummarizerBackend, SummarizerChoice } from "../../shared/protocol";
import type { ModelPolicy } from "./model-policy";

/** A choice while it's being made: the model is "" between a backend change and a pick. */
export type SummarizerDraft = SummarizerChoice;

export const BACKEND_LABELS: Record<SummarizerBackend, string> = { "claude-code": "Claude Code", pi: "pi" };

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Why the model policy keeps this summarizer from running, or null. Mirrors `globallyEnabled` in
 * pi-config/extensions/model-policy/policy.ts: the provider is a pi ref's prefix or, for Claude
 * Code, the backend itself; a Claude Code model is off under its bare id or "claude-code/<id>".
 */
export function summarizerDenial(policy: ModelPolicy | null, choice: SummarizerChoice): string | null {
  if (!policy || !choice.model) return null;
  const ref = lower(choice.model);
  const provider = choice.backend === "pi" ? ref.slice(0, Math.max(0, ref.indexOf("/"))) : choice.backend;
  if (provider && policy.disabledProviders.some((p) => lower(p) === provider)) return `${provider} is turned off in Settings → Models`;
  const refs = choice.backend === "pi" ? [ref] : [ref, `${choice.backend}/${ref}`];
  if (policy.disabledModels.some((m) => refs.includes(lower(m)))) return `${choice.model} is turned off in Settings → Models`;
  return null;
}

export interface SelectOption {
  value: string;
  label: string;
}

/** The backend's list, or null when it couldn't list (or the options aren't in yet). */
const listed = (options: DelegateOptions | undefined, backend: SummarizerBackend) =>
  options?.backends.find((b) => b.id === backend)?.models ?? null;

/**
 * Is a pick the backend didn't list merely unverified, rather than gone? When the backend couldn't
 * answer; for Claude Code always (its list is remote and varies, and the CLI takes an alias it
 * omits — the reading Delegate uses too); for a pi provider whose models exist per session.
 */
function unverified(options: DelegateOptions | undefined, choice: SummarizerChoice): boolean {
  const backend = options?.backends.find((b) => b.id === choice.backend);
  if (!backend || backend.models === null || choice.backend === "claude-code") return true;
  const slash = choice.model.indexOf("/");
  return slash > 0 && !!backend.sessionScopedProviders?.includes(choice.model.slice(0, slash));
}

/** The model select: what the backend offers, a policy-off model marked, and the stored pick always shown. */
export function summarizerModelOptions(
  options: DelegateOptions | undefined,
  policy: ModelPolicy | null,
  choice: SummarizerChoice,
): SelectOption[] {
  const out: SelectOption[] = (listed(options, choice.backend) ?? []).map((m) => ({
    value: m.id,
    label: `${m.id}${summarizerDenial(policy, { backend: choice.backend, model: m.id }) ? " — turned off" : ""}`,
  }));
  if (choice.model && !out.some((o) => o.value === choice.model))
    out.unshift({ value: choice.model, label: `${choice.model} — ${unverified(options, choice) ? "not verified" : "not offered"}` });
  return out;
}

export type IssueTone = "error" | "warn" | "muted";

/** What a row says about its pick, or null when there's nothing to say. */
export function summarizerIssue(
  options: DelegateOptions | undefined,
  policy: ModelPolicy | null,
  choice: SummarizerChoice,
  primary: SummarizerChoice | null,
): { tone: IssueTone; text: string } | null {
  if (!choice.model) return { tone: "muted", text: "Choose a model." };
  if (primary && primary.backend === choice.backend && primary.model === choice.model)
    return { tone: "error", text: "Same as the primary. Choose another model, or no fallback." };
  const denied = summarizerDenial(policy, choice);
  if (denied) return { tone: "warn", text: `${denied}, so summaries skip it.` };
  if (!options) return null; // still asking
  const models = listed(options, choice.backend);
  if (models?.some((m) => m.id === choice.model)) return null;
  if (models === null) return { tone: "muted", text: `Not verified: ${BACKEND_LABELS[choice.backend]} couldn't list its models.` };
  if (unverified(options, choice))
    return {
      tone: "muted",
      text:
        choice.backend === "claude-code"
          ? `Not verified: the Claude Code CLI's model list doesn't include ${choice.model} right now (the list varies).`
          : `Not verified: ${choice.model.slice(0, choice.model.indexOf("/"))} models exist only in sessions started with that provider on.`,
    };
  return { tone: "error", text: `${choice.model} isn't offered by ${BACKEND_LABELS[choice.backend]}, so it's skipped.` };
}
