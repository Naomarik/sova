import type {
  DelegateBackendId,
  DelegateModelOption,
  DelegateOptions,
  DelegateProfileId,
  DelegateSettings,
  DelegateSettingsInfo,
  WorkerChoice,
} from "../../shared/protocol";

/**
 * Settings → Modes → Delegate's form rules. Pure, so the
 * component only draws: what each select offers, what a change does to the rest of its row, and
 * what the row says about the pick.
 *
 * Two rules carry the design. Nothing here ever picks a model the user didn't: changing the backend
 * clears the model and the effort, and changing the model keeps the effort only if the new model
 * takes it. And a backend that couldn't list its models (`models: null`) is not a backend that
 * offers nothing: the saved value stays selectable and reads "not verified", never "not offered".
 */

export type Slot = "primary" | "fallback";

/** What a worker row needs of a settings screen's info: the backends and every effort each accepts. */
export type BackendsInfo = Pick<DelegateSettingsInfo, "backends">;

/** A row being edited. Blank model/effort = not chosen yet; the form can't be saved like that. */
export interface DraftChoice {
  backend: DelegateBackendId;
  model: string;
  effort: string;
}

export type DraftSettings = {
  version: 1;
  profiles: Record<DelegateProfileId, { primary: DraftChoice; fallback: DraftChoice | null }>;
};

export const cloneSettings = (s: DelegateSettings | DraftSettings): DraftSettings => JSON.parse(JSON.stringify(s));

export const sameChoice = (a: DraftChoice | null, b: DraftChoice | null) =>
  !a || !b ? !a && !b : a.backend === b.backend && a.model === b.model && a.effort === b.effort;

export function sameSettings(a: DraftSettings | DelegateSettings, b: DraftSettings | DelegateSettings): boolean {
  return (Object.keys(a.profiles) as DelegateProfileId[]).every(
    (id) => sameChoice(a.profiles[id].primary, b.profiles[id]?.primary ?? null) && sameChoice(a.profiles[id].fallback, b.profiles[id]?.fallback ?? null),
  );
}

/** A new backend: model and effort go blank — the user picks them, we don't. */
export const withBackend = (choice: DraftChoice, backend: DelegateBackendId): DraftChoice =>
  backend === choice.backend ? choice : { backend, model: "", effort: "" };

/** A new model: the effort stays when the model takes it (or can't be checked), else goes blank. */
export function withModel(choice: DraftChoice, model: string, options: DelegateOptions | undefined): DraftChoice {
  const efforts = modelEfforts(options, choice.backend, model);
  return { ...choice, model, effort: efforts === null || efforts.includes(choice.effort) ? choice.effort : "" };
}

/** The backend's discovered models, or null when it couldn't say (or hasn't answered yet). */
export function backendModels(options: DelegateOptions | undefined, backend: DelegateBackendId): DelegateModelOption[] | null {
  return options?.backends.find((b) => b.id === backend)?.models ?? null;
}

/** A pi ref whose provider only exists per session, so its absence from the list proves nothing. */
export function sessionScoped(options: DelegateOptions | undefined, choice: DraftChoice): boolean {
  const slash = choice.model.indexOf("/");
  const scoped = options?.backends.find((b) => b.id === choice.backend)?.sessionScopedProviders;
  return slash > 0 && !!scoped?.includes(choice.model.slice(0, slash));
}

/**
 * A Claude Code alias the CLI would accept at runtime, missing from a list it did answer. The
 * CLI's model list is remote and account-gated and alternates within minutes between a shape
 * with the `[1m]` aliases and one without, so absence from it is weak evidence: the pick reads
 * "not verified", never "not offered". Same shape rule as the mode extension's modelShapeError
 * for claude-code (an alias: no "/", no leading "-", no whitespace); pi's registry is local and
 * reliable, so a pi model missing from its list stays an error.
 */
export function unlistedClaudeAlias(choice: DraftChoice): boolean {
  const model = choice.model;
  return choice.backend === "claude-code" && model !== "" && model.trim() === model && !/[\s\0]/.test(model) && !model.startsWith("-") && !model.includes("/");
}

/** The efforts this model takes, or null when discovery can't say. */
export function modelEfforts(options: DelegateOptions | undefined, backend: DelegateBackendId, model: string): string[] | null {
  const models = backendModels(options, backend);
  if (models === null) return null;
  return models.find((m) => m.id === model)?.efforts ?? null;
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * The model select: every discovered model by id (policy-denied ones marked, still choosable), plus the
 * current value when discovery didn't list it — so the stored pick is always what the select
 * shows, never silently swapped for the first option.
 */
export function modelSelectOptions(options: DelegateOptions | undefined, choice: DraftChoice): SelectOption[] {
  const models = backendModels(options, choice.backend);
  const listed: SelectOption[] = (models ?? []).map((m) => ({
    value: m.id,
    // The id alone: it is what gets spawned, and "Opus (1M) · opus[1m]" said it twice in a select
    // too narrow for both.
    label: `${m.id}${m.denied ? " — off for subagents" : ""}`,
  }));
  if (choice.model && !listed.some((o) => o.value === choice.model))
    listed.unshift({ value: choice.model, label: `${choice.model} — ${models === null || sessionScoped(options, choice) || unlistedClaudeAlias(choice) ? "not verified" : "not offered"}` });
  return listed;
}

/** The effort select: what the model takes; what the backend accepts when discovery can't say. */
export function effortSelectOptions(info: BackendsInfo, options: DelegateOptions | undefined, choice: DraftChoice): string[] {
  const efforts = modelEfforts(options, choice.backend, choice.model) ?? info.backends.find((b) => b.id === choice.backend)?.efforts ?? [];
  return choice.effort && !efforts.includes(choice.effort) ? [choice.effort, ...efforts] : efforts;
}

export type IssueTone = "error" | "warn" | "muted";
export interface SlotIssue {
  tone: IssueTone;
  text: string;
}

/**
 * What the row says about its pick, or null when there's nothing to say. Mirrors the server's save
 * check. `owner` names what reroutes a policy-denied pick: Delegate, or the spec writer's settings.
 */
export function slotIssue(
  info: BackendsInfo,
  options: DelegateOptions | undefined,
  choice: DraftChoice,
  other: DraftChoice | null,
  slot: Slot,
  owner = "Delegate",
  /** False for a row with no fallback to reroute to (the Overseer's explorer): the denial alone. */
  hasFallback = true,
): SlotIssue | null {
  const label = info.backends.find((b) => b.id === choice.backend)?.label ?? choice.backend;
  if (!choice.model) return { tone: "muted", text: "Choose a model." };
  if (!choice.effort) return { tone: "muted", text: "Choose an effort." };
  if (slot === "fallback" && other && sameChoice(choice, other)) return { tone: "error", text: "Same as the primary. Choose another worker, or no fallback." };
  const backend = options?.backends.find((b) => b.id === choice.backend);
  if (!options) return null; // still asking; nothing is known either way
  if (!backend || backend.models === null)
    // The why is the banner's (one per backend); the row only says what it means for this pick.
    return { tone: "muted", text: `Not verified: ${label} couldn't list its models.` };
  const model = backend.models.find((m) => m.id === choice.model);
  if (!model && sessionScoped(options, choice))
    return { tone: "muted", text: `Not verified: ${choice.model.slice(0, choice.model.indexOf("/"))} models exist only in sessions started with that provider on.` };
  if (!model && unlistedClaudeAlias(choice))
    return { tone: "muted", text: `Not verified: the Claude Code CLI's model list doesn't include ${choice.model} right now (the list varies). It will still be used.` };
  if (!model) return { tone: "error", text: `${label} doesn't offer ${choice.model}.` };
  if (!model.efforts.includes(choice.effort)) return { tone: "error", text: `${choice.model} doesn't take ${choice.effort} effort.` };
  if (model.denied) return { tone: "warn", text: hasFallback ? `${model.denied}. ${owner} uses the fallback, or asks.` : `${model.denied}.` };
  return null;
}

/** Every row has a model and an effort. What the Save button waits for. */
export function draftComplete(draft: DraftSettings): boolean {
  return (Object.values(draft.profiles) as DraftSettings["profiles"][DelegateProfileId][]).every(
    (p) => !!p.primary.model && !!p.primary.effort && (p.fallback === null || (!!p.fallback.model && !!p.fallback.effort)),
  );
}

/** Rows the server would refuse whatever discovery says: a fallback that is its own primary. */
export function draftConflicts(draft: DraftSettings): DelegateProfileId[] {
  return (Object.keys(draft.profiles) as DelegateProfileId[]).filter((id) => {
    const { primary, fallback } = draft.profiles[id];
    return fallback !== null && !!fallback.model && sameChoice(primary, fallback);
  });
}

/** The fallback toggle: on starts from the primary's backend with nothing chosen; off is null. */
export const fallbackFor = (primary: WorkerChoice | DraftChoice, on: boolean): DraftChoice | null =>
  on ? { backend: primary.backend, model: "", effort: "" } : null;
