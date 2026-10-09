/**
 * The memory view message (Sova's memory minor mode, §chat.memory/turn): the declared request shape the
 * bridge sends as-is instead of folding (§app.claude-code-provider/continuity). Imports nothing: Sova's
 * server builds the message with `memoryViewContent`, and session-bridge.ts reads it with
 * `readMemoryView`.
 *
 * A user message is a memory view when its content is two or three text blocks:
 *   0. the memory guide, opening with MEMORY_VIEW_MARK on its own first line;
 *   1. the view's stable prefix, `<chat>\n…lines…\n</chat>` (no lines: `<chat>\n</chat>`);
 *   2. optionally its newer lines, `<chat> (continued: the newest lines)\n…\n</chat>`.
 * The guide and the prefix change only when the view rebases, so the bridge appends them to the system
 * prompt the CLI is given (cached under Claude Code's own mark); the newer lines go in the child's
 * first user message. Any other provider sends the message as written, the same three blocks in order.
 */

export const MEMORY_VIEW_MARK = "# Memory";
export const MEMORY_CHAT_OPEN = "<chat>";
export const MEMORY_TAIL_OPEN = "<chat> (continued: the newest lines)";
export const MEMORY_CHAT_CLOSE = "</chat>";

export interface MemoryViewParts {
	/** Block 0, whole. */
	guide: string;
	/** Block 1, whole (`<chat>…</chat>`). */
	prefix: string;
	/** Block 2, whole, when there are newer lines. */
	tail?: string;
}

type TextBlock = { type: "text"; text: string };

const chatBlock = (open: string, lines: readonly string[]): string => `${open}\n${lines.length ? `${lines.join("\n")}\n` : ""}${MEMORY_CHAT_CLOSE}`;

/** The content of a memory view message: the guide (which must open with MEMORY_VIEW_MARK), the prefix's
    lines, and the newer lines (none: no third block). */
export function memoryViewContent(guide: string, prefix: readonly string[], tail: readonly string[]): TextBlock[] {
	if (!guide.startsWith(`${MEMORY_VIEW_MARK}\n`)) throw new Error(`a memory guide opens with "${MEMORY_VIEW_MARK}"`);
	const out: TextBlock[] = [
		{ type: "text", text: guide },
		{ type: "text", text: chatBlock(MEMORY_CHAT_OPEN, prefix) },
	];
	if (tail.length) out.push({ type: "text", text: chatBlock(MEMORY_TAIL_OPEN, tail) });
	return out;
}

const isText = (b: unknown): b is TextBlock => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string";

/** The parts of a memory view message's content, or undefined for any other content. */
export function readMemoryView(content: unknown): MemoryViewParts | undefined {
	if (!Array.isArray(content) || content.length < 2 || content.length > 3 || !content.every(isText)) return undefined;
	const [guide, prefix, tail] = content as TextBlock[];
	if (!guide!.text.startsWith(`${MEMORY_VIEW_MARK}\n`)) return undefined;
	if (!prefix!.text.startsWith(`${MEMORY_CHAT_OPEN}\n`) || !prefix!.text.endsWith(MEMORY_CHAT_CLOSE)) return undefined;
	if (tail && (!tail.text.startsWith(`${MEMORY_TAIL_OPEN}\n`) || !tail.text.endsWith(MEMORY_CHAT_CLOSE))) return undefined;
	return { guide: guide!.text, prefix: prefix!.text, ...(tail ? { tail: tail.text } : {}) };
}
