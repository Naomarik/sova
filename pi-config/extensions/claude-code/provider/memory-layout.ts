/**
 * How a memory view (memory-view.ts, Sova's memory minor mode) is laid out for the Claude CLI so it
 * caches: the guide and stable prefix go into the initialize `systemPrompt` past SYSTEM_PROMPT_BOUNDARY
 * (their own cached system block), and only the newer lines and the turn's messages go in the message.
 * Pure: it imports memory-view.ts and pi's types alone, so `pnpm test` runs its test with no pi runtime.
 * session-bridge.ts re-exports all of it.
 */
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { readMemoryView, type MemoryViewParts } from "./memory-view.ts";

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: unknown): b is TextContent => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("");
}

export function imagesOf(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b: unknown): b is ImageContent =>
		!!b && typeof b === "object" && (b as { type?: unknown }).type === "image");
}

/** The memory view a request's history opens with, or undefined. */
export function memoryViewOf(messages: readonly Message[]): MemoryViewParts | undefined {
	const first = messages.find((m) => m.role !== "system");
	return first?.role === "user" ? readMemoryView(first.content) : undefined;
}

/**
 * CLI 2.1.295's split mark in an initialize `systemPrompt` (its own default prompt's static/dynamic boundary).
 * On the first-party API the CLI sends the elements before it as one system block and the elements after it
 * as another, each under its own cache mark (in place of the mark on its agent line: no extra mark).
 * Elsewhere it drops the element and joins the rest with a blank line, the same text as without it.
 */
export const SYSTEM_PROMPT_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/** The initialize `systemPrompt` a child is given: the session's, then past the boundary a memory view's
    guide and stable prefix, which change only when the view rebases. Both are read from the prompt cache,
    and a rebase re-writes the view's block alone where the CLI splits at the boundary. */
export function memorySystemPrompt(systemPrompt: string, view: MemoryViewParts | undefined): string[] {
	return view ? [systemPrompt, SYSTEM_PROMPT_BOUNDARY, `${view.guide}\n\n${view.prefix}`] : [systemPrompt];
}

/**
 * A restart's first user message when the history is a memory view followed by user messages only (a
 * turn's start): the view's newer lines, then each message as written, with no restart preamble and
 * nothing folded. undefined for any other history.
 */
export function memoryViewFrame(messages: readonly Message[]): { text: string; images: ImageContent[] } | undefined {
	const rest = messages.filter((m) => m.role !== "system");
	const view = rest[0]?.role === "user" ? readMemoryView(rest[0].content) : undefined;
	if (!view || rest.length < 2 || rest.slice(1).some((m) => m.role !== "user")) return undefined;
	const texts = [view.tail ?? "", ...rest.slice(1).map((m) => textOf(m.content))].filter((t) => t.length > 0);
	return { text: texts.join("\n\n"), images: rest.slice(1).flatMap((m) => imagesOf(m.content)) };
}

/** The history with a memory view reduced to its newer lines: its guide and prefix ride the system prompt,
    so a fold (a restart mid-turn) never sends them twice. */
export function withoutMemoryPrefix(messages: readonly Message[]): Message[] {
	const at = messages.findIndex((m) => m.role !== "system");
	const view = at >= 0 && messages[at]!.role === "user" ? readMemoryView(messages[at]!.content) : undefined;
	if (!view) return [...messages];
	const out = [...messages];
	const reduced: TextContent = { type: "text", text: view.tail ?? "(Your memory view is in the system prompt.)" };
	out[at] = { ...(messages[at] as Extract<Message, { role: "user" }>), content: [reduced] };
	return out;
}

/**
 * A request's declared layout: how its history reaches a new child when it is not a plain
 * conversation. The memory view (memory-view.ts) is its one producer today. `systemPrompt` is the
 * initialize prompt (the session's, then past the boundary what the layout keeps stable); `asIs` is
 * the first user message when the history goes as written instead of folded; `rebuilds`: the history
 * is rebuilt on purpose, so a resume record is never used for it.
 */
export interface RequestLayout {
	systemPrompt(systemPrompt: string): string[];
	asIs?: { text: string; images: ImageContent[] };
	rebuilds: boolean;
}

export function requestLayoutOf(messages: readonly Message[]): RequestLayout {
	const view = memoryViewOf(messages);
	const asIs = view ? memoryViewFrame(messages) : undefined;
	return { systemPrompt: (systemPrompt) => memorySystemPrompt(systemPrompt, view), ...(asIs ? { asIs } : {}), rebuilds: !!view };
}
