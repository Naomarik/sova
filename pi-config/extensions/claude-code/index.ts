/**
 * The claude-code extension: the Claude Code model provider (provider/), flag-gated
 * (`--claude-code-provider`). A Claude Code worker is a pi worker on this provider
 * (subagents claude-workers.ts); the extension registers no worker backend of its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaudeCodeProvider } from "./provider/index.ts";

/** Exported for offline registration tests. No subprocess starts at extension load. */
export function registerClaudeCode(pi: ExtensionAPI): void {
	registerClaudeCodeProvider(pi);
}
export default registerClaudeCode;
