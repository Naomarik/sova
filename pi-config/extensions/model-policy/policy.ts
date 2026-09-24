/** The unified model policy: which providers and models may be used at all, and which of the
 * still-allowed ones may additionally be picked for subagents.
 *
 * One JSON file, `~/.pi/agent/model-policy.json`, written by Sova's Settings → Models tab and
 * read by everything that picks a model:
 *
 *     {
 *       "version": 1,
 *       "disabledProviders": ["anthropic"],              // globally off: nothing may use them
 *       "disabledModels": ["openai/gpt-5.2"],            // globally off, exact refs
 *       "subagentDisabledProviders": ["zai"],            // usable by you, never by a worker
 *       "subagentDisabledModels": ["ollama/qwen3-coder"]
 *     }
 *
 * Two dimensions, one file. GLOBAL is a prohibition: a globally disabled model is refused in web
 * chats, in the TUI's own model selection, at the next turn of a session already sitting on it,
 * and for every subagent and team member. SUBAGENT is a narrowing of what is still globally
 * allowed: a model can be yours to drive by hand and out of bounds for workers. Turning a model
 * off globally therefore covers subagents too, and the subagent entry is kept rather than folded
 * in, so turning the model back on restores the worker preference the user had before.
 *
 * Absent keys mean "nothing disabled", and so does a file that is missing, unreadable, of another
 * version, or of a foreign shape: a policy file that cannot be understood must never take model
 * selection down with it. Lists are compared case-insensitively; Sova writes them lowercase,
 * deduped and sorted.
 *
 * Providers are bare names ("anthropic", "zai") — for non-pi worker backends the backend id IS the
 * provider name, which is what makes `claude-code` one row in the settings list and one switch over
 * every Claude worker, its default model included. Models are "provider/modelId" refs; a backend
 * model also matches its bare id, so both spellings disable it.
 *
 * Readers: this module (the TUI enforcement extension, the command palette, topic-outline,
 * vision-delegate), `pi-config/extensions/subagents/policy.ts` (discovery and spawn), and Sova's
 * `server/model-policy.ts`, which is the only writer. Keep the four in step — the file shape is the
 * contract, not this file.
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const POLICY_FILE = path.join(getAgentDir(), "model-policy.json");
/** Where the subagent dimension lived before the Models tab (Sova ≤ the Subagent models tab).
 * Read only when POLICY_FILE is absent, so an install that never opened the new tab keeps the
 * worker restrictions it already had. */
export const LEGACY_SUBAGENT_FILE = path.join(getAgentDir(), "subagents", "settings.json");

export interface ModelPolicy {
	version: 1;
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
	version: 1,
	disabledProviders: [],
	disabledModels: [],
	subagentDisabledProviders: [],
	subagentDisabledModels: [],
};

const list = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

/** Tolerant parse. Anything missing, corrupt, of another version or of a foreign shape reads as
 * "nothing disabled"; a file holding only the legacy two keys parses as a subagent-only policy,
 * which is exactly what it was. */
export function parsePolicy(raw: unknown): ModelPolicy {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_POLICY;
	const data = raw as Record<string, unknown>;
	if (data.version !== 1) return EMPTY_POLICY;
	// The legacy file (subagents/settings.json) carries the two bare keys and means them as
	// subagent restrictions; the unified file names its subagent lists, so the bare keys there are
	// the global ones. "Has either subagent key" is what tells the two shapes apart.
	const unified = "subagentDisabledProviders" in data || "subagentDisabledModels" in data;
	return {
		version: 1,
		disabledProviders: unified ? list(data.disabledProviders) : [],
		disabledModels: unified ? list(data.disabledModels) : [],
		subagentDisabledProviders: unified ? list(data.subagentDisabledProviders) : list(data.disabledProviders),
		subagentDisabledModels: unified ? list(data.subagentDisabledModels) : list(data.disabledModels),
	};
}

let cache: { file: string; mtimeMs: number; policy: ModelPolicy } | undefined;

function readFile(file: string): ModelPolicy | undefined {
	try {
		const stat = fs.statSync(file);
		if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.policy;
		const policy = parsePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
		cache = { file, mtimeMs: stat.mtimeMs, policy };
		return policy;
	} catch {
		return undefined;
	}
}

/**
 * The policy as it stands, re-read only when the file's mtime moves — Sova writes it live and
 * every check here must see the change without a reload. A missing file is not negatively cached:
 * the next call stats again, so the moment it appears it is picked up.
 *
 * With no argument: the unified file, falling back to the legacy subagent file while the unified
 * one does not exist. With an explicit path (tests, `--policy-file`): that file only, either shape.
 */
export function readPolicy(file?: string): ModelPolicy {
	if (file !== undefined) return readFile(file) ?? EMPTY_POLICY;
	return readFile(POLICY_FILE) ?? readFile(LEGACY_SUBAGENT_FILE) ?? EMPTY_POLICY;
}

/** The provider a model belongs to: the ref's own prefix for pi ("provider/id"), the backend id for
 * everything else (a backend IS one provider's surface). Lower-case; "" when a pi ref has none. */
export const providerOf = (backend: string, ref: string): string =>
	(backend === "pi" ? ref.slice(0, ref.indexOf("/")) : backend).toLowerCase();

const listed = (entries: string[], value: string): boolean => entries.some((e) => e.toLowerCase() === value);

/** Provider-wide match, case-insensitive. */
export function providerListed(entries: string[], backend: string, ref: string): boolean {
	const provider = providerOf(backend, ref);
	return provider !== "" && listed(entries, provider);
}

/** Exact-model match. Pi refs are "provider/id" as given; a backend model matches its bare id and
 * its "backend/id" form, so both spellings disable it. */
export function modelListed(entries: string[], backend: string, ref: string): boolean {
	const lower = ref.trim().toLowerCase();
	if (!lower) return false;
	const candidates = backend === "pi" ? [lower] : [lower, `${backend.toLowerCase()}/${lower}`];
	return entries.some((e) => candidates.includes(e.toLowerCase()));
}

/** Is this model allowed to run at all? `backend` is "pi" for a pi provider/model ref. */
export function globallyEnabled(policy: ModelPolicy, backend: string, ref: string): boolean {
	return !providerListed(policy.disabledProviders, backend, ref) && !modelListed(policy.disabledModels, backend, ref);
}

/** Is this model allowed for a subagent or team member? Globally disabled models never are. */
export function subagentEnabled(policy: ModelPolicy, backend: string, ref: string): boolean {
	return (
		globallyEnabled(policy, backend, ref) &&
		!providerListed(policy.subagentDisabledProviders, backend, ref) &&
		!modelListed(policy.subagentDisabledModels, backend, ref)
	);
}

/** Why this model can't be used at all, or null when it can. One sentence of fact, one of remedy —
 * it is read by a person in a TUI notification and by a model in a tool error alike. */
export function globalDenial(policy: ModelPolicy, backend: string, ref: string): string | null {
	if (providerListed(policy.disabledProviders, backend, ref)) {
		const provider = providerOf(backend, ref);
		return backend === "pi"
			? `Provider ${provider} is turned off in Settings → Models, so none of its models can be used. Switch with /model, or turn the provider back on there.`
			: `Backend ${backend} is turned off in Settings → Models, so none of its models can be used. Use a pi model instead, or turn the backend back on there.`;
	}
	if (modelListed(policy.disabledModels, backend, ref))
		return `${ref} is turned off in Settings → Models. Switch with /model, or turn it back on there.`;
	return null;
}

/** Why a backend spawn that named no model can't run (its own default would), or null. Only the
 * provider-wide rule can apply: which model the default resolves to is not known at spawn time. */
export function globalBackendDenial(policy: ModelPolicy, backend: string): string | null {
	if (backend === "pi") return null; // a parentless pi spawn keeps the child's own default
	return listed(policy.disabledProviders, backend.toLowerCase())
		? `Backend ${backend} is turned off in Settings → Models, so none of its models can be used. Use a pi model instead, or turn the backend back on there.`
		: null;
}

/** The effective subagent deny lists — the global ones and the subagent-only ones together. What a
 * reader that only knows the legacy two-key shape needs in order to agree with this one. */
export function effectiveSubagentLists(policy: ModelPolicy): { disabledProviders: string[]; disabledModels: string[] } {
	const merge = (a: string[], b: string[]) => [...new Set([...a, ...b].map((x) => x.toLowerCase()))].sort();
	return {
		disabledProviders: merge(policy.disabledProviders, policy.subagentDisabledProviders),
		disabledModels: merge(policy.disabledModels, policy.subagentDisabledModels),
	};
}
