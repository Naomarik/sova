/**
 * The Claude Code settings every `claude` process Sova or its extensions start is given, whatever
 * the user's own settings say. Imports nothing, so the server's one-shots (decisions, titles, model
 * discovery) use the same object as the extension's chat children and workers.
 *
 * `--setting-sources ""` keeps the user's own settings out; these ride on `--settings`, which applies
 * regardless. The CLI takes one `--settings` (a repeat overwrites), so a caller's JSON is merged
 * under them (fixedSettingsJson) and they win.
 */

/** No "Co-Authored-By" commit trailer, no "Generated with Claude Code" PR footer. */
export const NO_ATTRIBUTION = { attribution: { commit: "", pr: "" } } as const;
/**
 * Auto-memory off: the CLI neither reads a project's memory folder (`<config dir>/projects/<key>/memory/`,
 * MEMORY.md and its notes) into a request nor writes to it. Probed with CLI 2.1.295: on by default.
 */
export const NO_AUTO_MEMORY = { autoMemoryEnabled: false } as const;
export const SOVA_FIXED_SETTINGS = { ...NO_ATTRIBUTION, ...NO_AUTO_MEMORY } as const;

/** The one `--settings` value: `settings` (a caller's, e.g. the sandbox's) with the fixed settings merged over it. */
export function fixedSettingsJson(settings: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...settings, ...SOVA_FIXED_SETTINGS });
}
