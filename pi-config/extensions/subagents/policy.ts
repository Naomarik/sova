/** Subagent model policy: which models and providers may not be picked for workers.
 *
 * One JSON file, `~/.pi/agent/model-policy.json`, edited by Sova's Settings → Models tab and
 * read here by every session (TUI and webapp alike). It carries two dimensions:
 *
 *     {"version":1, "disabledProviders":["anthropic"], "disabledModels":["openai/gpt-5.2"],
 *      "subagentDisabledProviders":["zai"], "subagentDisabledModels":["ollama/qwen3-coder"]}
 *
 * The bare keys are GLOBAL: those providers and models may not be used anywhere, by anyone. The
 * `subagent*` keys narrow what is still globally allowed down to what a worker may pick. Workers
 * therefore obey both, which is what this module returns: one effective deny list per kind, with
 * the global entries remembered separately so a denial can say which rule it was.
 *
 * A file holding only the two bare keys is the pre-Models-tab file (`subagents/settings.json`),
 * whose lists always meant "not for workers"; it parses as subagent-only, and is read as a
 * fallback while the unified file does not exist, so an install that has not opened the new tab
 * keeps the restrictions it had. The contract is documented in
 * `pi-config/extensions/model-policy/policy.ts`; this module stays self-contained on purpose —
 * worker spawning must not depend on another extension being installed.
 *
 * A disabled provider blocks all of its models; a disabled model blocks that exact ref. For non-pi
 * backends the backend id doubles as the provider name, and "backend/model" entries block single
 * backend models. Enforcement lives in index.ts: discovery hides disabled choices, and spawnBatch
 * rejects a disabled pick — explicit, agentType-defined, or inherited from the parent — with a
 * reason the caller can act on. */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const POLICY_FILE = path.join(getAgentDir(), "model-policy.json");
/** Where this policy lived before the unified Models tab. Read only when POLICY_FILE is absent. */
export const LEGACY_POLICY_FILE = path.join(getAgentDir(), "subagents", "settings.json");

export interface SubagentModelPolicy {
	version: 1;
	/** Effective worker deny list: globally disabled providers and worker-only ones together. */
	disabledProviders: string[];
	/** Effective worker deny list of "provider/modelId" refs. */
	disabledModels: string[];
	/** Of the above, those disabled everywhere rather than only for workers. Wording only. */
	globalProviders?: string[];
	globalModels?: string[];
}

export const EMPTY_POLICY: SubagentModelPolicy = { version: 1, disabledProviders: [], disabledModels: [] };

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

/** Tolerant parse: anything missing, corrupt, or of a foreign shape/version reads as
 * "nothing disabled". A bad file must never take worker spawning down with it. */
export function parsePolicy(raw: unknown): SubagentModelPolicy {
	if (typeof raw !== "object" || raw === null) return EMPTY_POLICY;
	const data = raw as Record<string, unknown>;
	if (data.version !== 1) return EMPTY_POLICY;
	// Which shape: the unified file names its subagent lists, so its bare keys are the global ones.
	const unified = "subagentDisabledProviders" in data || "subagentDisabledModels" in data;
	const globalProviders = unified ? strings(data.disabledProviders) : [];
	const globalModels = unified ? strings(data.disabledModels) : [];
	const ownProviders = unified ? strings(data.subagentDisabledProviders) : strings(data.disabledProviders);
	const ownModels = unified ? strings(data.subagentDisabledModels) : strings(data.disabledModels);
	const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
	return {
		version: 1,
		disabledProviders: merge(globalProviders, ownProviders),
		disabledModels: merge(globalModels, ownModels),
		...(globalProviders.length ? { globalProviders } : {}),
		...(globalModels.length ? { globalModels } : {}),
	};
}

let cache: { file: string; mtimeMs: number; policy: SubagentModelPolicy } | undefined;

function readFile(file: string): SubagentModelPolicy | undefined {
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

/** The policy as it stands, re-read only when the file's mtime moves — Sova writes
 * it live, and spawns/discovery must see the change without a reload. A missing or
 * unreadable file is "nothing disabled", and is not negatively cached: the next call
 * stats again, so the moment the file appears it is picked up. With no argument the
 * unified file wins over the legacy one; an explicit path is read as given (either shape). */
export function readPolicy(file?: string): SubagentModelPolicy {
	if (file !== undefined) return readFile(file) ?? EMPTY_POLICY;
	return readFile(POLICY_FILE) ?? readFile(LEGACY_POLICY_FILE) ?? EMPTY_POLICY;
}

/** The provider a worker model belongs to: the ref's own prefix for pi ("provider/id"),
 * the backend id for everything else (a backend IS one provider's surface). */
const providerOf = (backend: string, ref: string): string =>
	(backend === "pi" ? ref.slice(0, ref.indexOf("/")) : backend).toLowerCase();

const listed = (entries: string[] | undefined, value: string): boolean =>
	!!entries?.some((e) => e.toLowerCase() === value);

/** Provider-wide block, case-insensitive (Sova normalizes to lowercase on write). */
export function providerDisabled(policy: SubagentModelPolicy, backend: string, ref: string): boolean {
	const provider = providerOf(backend, ref);
	return provider !== "" && listed(policy.disabledProviders, provider);
}

/** Exact-model block. Pi refs are "provider/id" as given; a backend model matches its
 * bare id or its "backend/id" form, so both spellings disable it. */
export function modelDisabled(policy: SubagentModelPolicy, backend: string, ref: string): boolean {
	const lower = ref.toLowerCase();
	const candidates = backend === "pi" ? [lower] : [lower, `${backend.toLowerCase()}/${lower}`];
	return policy.disabledModels.some((m) => candidates.includes(m.toLowerCase()));
}

/** "everywhere" when the rule that caught this model is the global one, so a denial can say what a
 * user would have to change; "for subagents" when the model is only out of bounds for workers. */
function scope(entries: string[] | undefined, value: string): string {
	return listed(entries, value) ? "everywhere" : "for subagents";
}

/** Denial message for a concrete worker model, or null when it is allowed. */
export function policyDenial(policy: SubagentModelPolicy, backend: string, ref: string): string | null {
	if (providerDisabled(policy, backend, ref)) {
		const provider = providerOf(backend, ref);
		const where = scope(policy.globalProviders, provider);
		return backend === "pi"
			? `Provider ${provider} is disabled ${where} by user settings. Choose a model from another provider; agent_models lists the allowed ones.`
			: `Backend ${backend} is disabled ${where} by user settings. Spawn pi workers instead; agent_models lists the allowed models.`;
	}
	if (modelDisabled(policy, backend, ref)) {
		const candidates = backend === "pi" ? [ref.toLowerCase()] : [ref.toLowerCase(), `${backend.toLowerCase()}/${ref.toLowerCase()}`];
		const global = candidates.some((c) => listed(policy.globalModels, c));
		return global
			? `${ref} is disabled everywhere by user settings. Choose another model; agent_models lists the allowed ones.`
			: `${ref} is disabled as a subagent model by user settings. Choose another model; agent_models lists the allowed ones.`;
	}
	return null;
}

/** Denial message for a backend spawn that named no model (the backend's own default
 * would run), or null when the backend is allowed. Only the provider-wide rule can
 * apply here: which model the default resolves to is not known at spawn time. */
export function backendDenial(policy: SubagentModelPolicy, backend: string): string | null {
	if (backend === "pi") return null; // a parentless pi spawn keeps the child's own default
	const id = backend.toLowerCase();
	if (listed(policy.disabledProviders, id))
		return `Backend ${backend} is disabled ${scope(policy.globalProviders, id)} by user settings. Spawn pi workers instead; agent_models lists the allowed models.`;
	return null;
}
