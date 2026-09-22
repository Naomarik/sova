import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelPolicy } from "../shared/protocol";

/**
 * The unified model policy (spec/12-settings-dialog.md §12): which providers and models may be
 * used at all, and which of the still-allowed ones subagents may be given.
 *
 * The FILE SHAPE is a contract with `pi-config/extensions/model-policy/policy.ts` (the TUI's
 * enforcement, the command palette, topic-outline, vision-delegate) and
 * `pi-config/extensions/subagents/policy.ts` (discovery and spawn), which read it per model change,
 * per turn and per spawn, in every session, TUI and webapp alike:
 *
 *     {"version":1, "disabledProviders":[], "disabledModels":[],
 *      "subagentDisabledProviders":[], "subagentDisabledModels":[]}
 *
 * The bare keys are the global prohibition; the `subagent*` keys narrow what is still allowed.
 * This module owns pi-web's side: read tolerantly, write atomically and canonically (lowercase,
 * deduped, sorted), never importing the extension (server files stay pi-config-free except the
 * four documented imports).
 *
 * Migration: while the file does not exist, the policy is read out of the Subagent models tab's
 * old file, `subagents/settings.json`, whose two lists always meant "not for workers". They become
 * the subagent dimension and nothing becomes globally disabled — every model a user has today
 * keeps working, in every session, until they turn one off here. The old file is left where it is:
 * it is never written again, and the unified file wins from the first save.
 */
const FILE = join(getAgentDir(), "model-policy.json");
const LEGACY_FILE = join(getAgentDir(), "subagents", "settings.json");
/** A policy is a hand-curated list, not a log; past this it's a bug, not a preference. */
const MAX_ENTRIES = 200;

export const EMPTY_POLICY: ModelPolicy = {
  disabledProviders: [],
  disabledModels: [],
  subagentDisabledProviders: [],
  subagentDisabledModels: [],
};

const cleanList = (value: unknown, kind: "provider" | "model"): string[] | null => {
  if (value === undefined) return []; // an absent key disables nothing
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const v = entry.trim().toLowerCase();
    if (!v) continue; // blank entries are nothing, not an error
    if (kind === "provider" ? v.includes("/") : !v.includes("/")) return null;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_ENTRIES) return null;
  return out.sort();
};

/** Tolerant parse of either file shape. A foreign shape reads as "nothing disabled", matching the
    extensions' own parse: a policy file nobody can understand must not take model use down. */
function parse(data: Record<string, unknown>): ModelPolicy {
  if (data.version !== 1) return EMPTY_POLICY;
  // The legacy file carries the two bare keys and means them as subagent restrictions; the unified
  // file names its subagent lists, so its bare keys are the global ones.
  const unified = "subagentDisabledProviders" in data || "subagentDisabledModels" in data;
  const providers = cleanList(data.disabledProviders, "provider");
  const models = cleanList(data.disabledModels, "model");
  const subProviders = cleanList(data.subagentDisabledProviders, "provider");
  const subModels = cleanList(data.subagentDisabledModels, "model");
  if (!providers || !models || !subProviders || !subModels) return EMPTY_POLICY;
  return unified
    ? { disabledProviders: providers, disabledModels: models, subagentDisabledProviders: subProviders, subagentDisabledModels: subModels }
    : { ...EMPTY_POLICY, subagentDisabledProviders: providers, subagentDisabledModels: models };
}

function read(file: string): ModelPolicy | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? parse(data) : EMPTY_POLICY;
  } catch {
    return null; // missing or corrupt
  }
}

export function readModelPolicy(): ModelPolicy {
  return read(FILE) ?? read(LEGACY_FILE) ?? EMPTY_POLICY;
}

/** Validate, canonicalize and persist the whole policy (tmp + rename, like web-sessions.json). */
export function writeModelPolicy(raw: unknown): ModelPolicy | { error: string } {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: shapeError() };
  const providers = cleanList(data.disabledProviders, "provider");
  const models = cleanList(data.disabledModels, "model");
  const subProviders = cleanList(data.subagentDisabledProviders, "provider");
  const subModels = cleanList(data.subagentDisabledModels, "model");
  if (!providers || !models || !subProviders || !subModels) return { error: shapeError() };
  const policy: ModelPolicy = {
    disabledProviders: providers,
    disabledModels: models,
    subagentDisabledProviders: subProviders,
    subagentDisabledModels: subModels,
  };
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...policy }, null, "\t")}\n`);
  renameSync(tmp, FILE);
  return policy;
}

const shapeError = () =>
  `Expected { disabledProviders, subagentDisabledProviders: string[] (no "/"), disabledModels, subagentDisabledModels: string[] ("provider/modelId") }, at most ${MAX_ENTRIES} entries each`;

const listed = (entries: string[], value: string) => entries.some((e) => e.toLowerCase() === value.toLowerCase());
const providerOf = (ref: string) => {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash).toLowerCase() : "";
};

/** May this "provider/modelId" be used at all? An unparseable ref is nobody's business here: it
    fails the registry lookup it is on its way to, which says something more useful. */
export function modelAllowed(policy: ModelPolicy, ref: string): boolean {
  const provider = providerOf(ref);
  if (provider && listed(policy.disabledProviders, provider)) return false;
  return !listed(policy.disabledModels, ref);
}

/** Why this model can't be used, or null when it can. What the chat socket answers with, so it
    names the switch that has to move and never suggests one we'd pick for you. */
export function modelDenial(policy: ModelPolicy, ref: string): string | null {
  const provider = providerOf(ref);
  if (provider && listed(policy.disabledProviders, provider))
    return `Provider ${provider} is turned off in Settings → Models, so ${ref} can't be used. Pick a model from another provider, or turn the provider back on.`;
  if (listed(policy.disabledModels, ref))
    return `${ref} is turned off in Settings → Models and can't be used. Pick another model, or turn this one back on.`;
  return null;
}
