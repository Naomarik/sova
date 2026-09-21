/** Subagent model policy: which models and providers may not be picked for workers.
 *
 * One JSON file, edited by pi-web's Settings dialog and read here by every session
 * (TUI and webapp alike): {version:1, disabledProviders:["anthropic"],
 * disabledModels:["openai/gpt-5.2"]}. A disabled provider blocks all of its models;
 * a disabled model blocks that exact ref. For non-pi backends the backend id doubles
 * as the provider name, and "backend/model" entries block single backend models.
 * Enforcement lives in index.ts: discovery hides disabled choices, and spawnBatch
 * rejects a disabled pick — explicit, agentType-defined, or inherited from the
 * parent — with a reason the caller can act on. */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const POLICY_FILE = path.join(getAgentDir(), "subagents", "settings.json");

export interface SubagentModelPolicy {
	version: 1;
	disabledProviders: string[];
	disabledModels: string[];
}

export const EMPTY_POLICY: SubagentModelPolicy = { version: 1, disabledProviders: [], disabledModels: [] };

/** Tolerant parse: anything missing, corrupt, or of a foreign shape/version reads as
 * "nothing disabled". A bad file must never take worker spawning down with it. */
export function parsePolicy(raw: unknown): SubagentModelPolicy {
	if (typeof raw !== "object" || raw === null) return EMPTY_POLICY;
	const { version, disabledProviders, disabledModels } = raw as Record<string, unknown>;
	if (version !== 1) return EMPTY_POLICY;
	const providers = Array.isArray(disabledProviders) ? disabledProviders.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
	const models = Array.isArray(disabledModels) ? disabledModels.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
	return { version: 1, disabledProviders: providers, disabledModels: models };
}

let cache: { file: string; mtimeMs: number; policy: SubagentModelPolicy } | undefined;

/** The policy as it stands, re-read only when the file's mtime moves — pi-web writes
 * it live, and spawns/discovery must see the change without a reload. A missing or
 * unreadable file is "nothing disabled", and is not negatively cached: the next call
 * stats again, so the moment the file appears it is picked up. */
export function readPolicy(file: string = POLICY_FILE): SubagentModelPolicy {
	try {
		const stat = fs.statSync(file);
		if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.policy;
		const policy = parsePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
		cache = { file, mtimeMs: stat.mtimeMs, policy };
		return policy;
	} catch {
		return EMPTY_POLICY;
	}
}

/** The provider a worker model belongs to: the ref's own prefix for pi ("provider/id"),
 * the backend id for everything else (a backend IS one provider's surface). */
const providerOf = (backend: string, ref: string): string =>
	(backend === "pi" ? ref.slice(0, ref.indexOf("/")) : backend).toLowerCase();

/** Provider-wide block, case-insensitive (pi-web normalizes to lowercase on write). */
export function providerDisabled(policy: SubagentModelPolicy, backend: string, ref: string): boolean {
	const provider = providerOf(backend, ref);
	return provider !== "" && policy.disabledProviders.some((p) => p.toLowerCase() === provider);
}

/** Exact-model block. Pi refs are "provider/id" as given; a backend model matches its
 * bare id or its "backend/id" form, so both spellings disable it. */
export function modelDisabled(policy: SubagentModelPolicy, backend: string, ref: string): boolean {
	const lower = ref.toLowerCase();
	const candidates = backend === "pi" ? [lower] : [lower, `${backend.toLowerCase()}/${lower}`];
	return policy.disabledModels.some((m) => candidates.includes(m.toLowerCase()));
}

/** Denial message for a concrete worker model, or null when it is allowed. */
export function policyDenial(policy: SubagentModelPolicy, backend: string, ref: string): string | null {
	if (providerDisabled(policy, backend, ref)) {
		return backend === "pi"
			? `Provider ${providerOf(backend, ref)} is disabled for subagents by user settings. Choose a model from another provider; agent_models lists the allowed ones.`
			: `Backend ${backend} is disabled for subagents by user settings. Spawn pi workers instead; agent_models lists the allowed models.`;
	}
	if (modelDisabled(policy, backend, ref))
		return `${ref} is disabled as a subagent model by user settings. Choose another model; agent_models lists the allowed ones.`;
	return null;
}

/** Denial message for a backend spawn that named no model (the backend's own default
 * would run), or null when the backend is allowed. Only the provider-wide rule can
 * apply here: which model the default resolves to is not known at spawn time. */
export function backendDenial(policy: SubagentModelPolicy, backend: string): string | null {
	if (backend === "pi") return null; // a parentless pi spawn keeps the child's own default
	if (policy.disabledProviders.some((p) => p.toLowerCase() === backend.toLowerCase()))
		return `Backend ${backend} is disabled for subagents by user settings. Spawn pi workers instead; agent_models lists the allowed models.`;
	return null;
}
