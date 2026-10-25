/**
 * The extension a /btw hidden chat loads last (`./chat.ts`). Inert anywhere else: it acts only when
 * the parent set `PI_BTW_SYSTEM_PROMPT_FILE`. Each turn's whole system prompt is that file's text:
 * the main thread's prompt plus the aside instructions (or, for a summary, the summary
 * instructions alone), so pi's own prompt, context files and skills never reach the side thread.
 * The file is re-read each turn; one that can't be read leaves pi's prompt as it is.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The environment variable naming the system-prompt file: a path, never the text (env values go through a systemd env file). */
export const BTW_PROMPT_ENV = "PI_BTW_SYSTEM_PROMPT_FILE";

export default function btwChild(pi: ExtensionAPI): void {
	const file = process.env[BTW_PROMPT_ENV];
	if (!file) return;
	pi.on("before_agent_start", () => {
		try {
			return { systemPrompt: readFileSync(file, "utf8") };
		} catch {
			return undefined;
		}
	});
}
