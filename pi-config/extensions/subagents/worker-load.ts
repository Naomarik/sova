// What a server-started worker's loadout needs of the subagents extension: pi-free, so the server can import it.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeModel } from "../claude-code/catalog.ts";

/**
 * The claude-code extension's pi provider (claude-code/provider/index.ts: CLAUDE_PROVIDER_ID and
 * CLAUDE_PROVIDER_FLAG; the literals are repeated here so this extension loads without that one).
 * The provider is registered at the worker's session_start, and only under `--claude-code-provider`.
 */
export const CLAUDE_CODE_CLI_PROVIDER = "claude-code-cli";
export const CLAUDE_CODE_PROVIDER_FLAG = "claude-code-provider";
/**
 * The provider's flag naming one more model to register (claude-code/provider/index.ts
 * CLAUDE_MODEL_FLAG): a Claude id Sova's catalog doesn't know yet is still used.
 */
export const CLAUDE_CODE_MODEL_FLAG = "claude-code-model";
/** The provider/model of a `claude-code-cli/<id>` ref, or undefined for every other model (argv as today). */
export function rpcScopedModel(model: string | undefined): { provider: string; modelId: string } | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash < 1 || slash === model.length - 1) return undefined;
	const provider = model.slice(0, slash);
	return provider === CLAUDE_CODE_CLI_PROVIDER ? { provider, modelId: model.slice(slash + 1) } : undefined;
}

/**
 * The claude-code extension (a sibling directory of subagents/), resolved through this file's real
 * path so the ~/.pi/agent/extensions symlinks find it in the checkout.
 */
const CLAUDE_CODE_DIR = realpathOr(path.join(path.dirname(realpathOr(fileURLToPath(import.meta.url))), "..", "claude-code"));
export const CLAUDE_CODE_EXTENSION = path.join(CLAUDE_CODE_DIR, "index.ts");
function realpathOr(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}
/**
 * A pi child on a `claude-code-cli/<id>` model loads the claude-code extension (last) with
 * `--claude-code-provider`, so the provider exists when the worker's model is set; an id
 * the catalog doesn't know is named with `--claude-code-model`, so the provider registers it too.
 * Every other model gets the inputs back unchanged.
 */
export function claudeCodeProviderLoad(
	model: string | undefined,
	extensions: string[],
	flags: Record<string, string | true> | undefined,
): { extensions: string[]; flags: Record<string, string | true> | undefined } {
	const scoped = rpcScopedModel(model);
	if (!scoped) return { extensions, flags };
	const unknown: Record<string, string> = claudeModel(scoped.modelId) ? {} : { [CLAUDE_CODE_MODEL_FLAG]: scoped.modelId };
	return { extensions: [...extensions, CLAUDE_CODE_EXTENSION], flags: { ...(flags ?? {}), [CLAUDE_CODE_PROVIDER_FLAG]: true, ...unknown } };
}

/** pi's own session directory name for a cwd (session-manager.js getDefaultSessionDirPath). */
export function sessionDirName(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
