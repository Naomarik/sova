/**
 * Pure helpers shared by the look_at_image tool and the automatic hooks:
 * prompt construction, conversation excerpting and result formatting.
 */

import type { PickableModel } from "./picker.ts";

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type ContentBlock = { type?: string; text?: string; data?: string; mimeType?: string };

/** Image formats pi-ai passes through to providers. */
export const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

export function mimeForPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? undefined : IMAGE_MIME[path.slice(dot).toLowerCase()];
}

/** Images per event. Beyond this an automatic describe costs more than it is worth. */
export const MAX_IMAGES = 3;

export function isImageBlock(block: unknown): block is ImageBlock {
	const candidate = block as ContentBlock | undefined;
	return Boolean(candidate && candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string");
}

export function imageBlocks(content: readonly unknown[] | undefined): ImageBlock[] {
	return (content ?? []).filter(isImageBlock);
}

export function ref(model: PickableModel): string {
	return `${model.provider}/${model.id}`;
}

export const AUTO_DESCRIBE_PROMPT =
	"Describe this image precisely and completely (text, UI layout, charts, code, errors) so a text-only assistant can work with it.";

export function buildQuestionPrompt(question: string, context?: string): string {
	return [
		"Answer this question about the attached image factually and concretely.",
		"Describe only what is actually visible; say so when the image does not show the answer.",
		"",
		`Question: ${question}`,
		...(context ? ["", "This is the conversation the question came from, for context only:", "<conversation>", context, "</conversation>"] : []),
	].join("\n");
}

/** Attribution for an automatic description, and the header for an explicit answer. */
export function describedBy(model: PickableModel, index?: number, total?: number): string {
	const which = total && total > 1 ? ` ${index! + 1}/${total}` : "";
	return `[image${which} described by ${ref(model)}]`;
}

export function viaLine(model: PickableModel, pick: { overBudget: boolean; usedPct?: number }): string {
	const budget = pick.overBudget ? ` (every vision fallback is over budget; used anyway at ${pick.usedPct}%)` : "";
	return `[via ${ref(model)}]${budget}`;
}

export function skippedNote(count: number): string {
	return count > 0 ? `\n[${count} further image(s) in this message were not described; ask about them with look_at_image.]` : "";
}

type SessionEntry = { type?: string; message?: { role?: string; content?: unknown } };

function entryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object")
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text!.trim())
		.filter(Boolean)
		.join("\n");
}

/**
 * Recent conversation as plain text, newest-first budget: the tail is what the
 * question is about, so entries are taken from the end until maxChars is spent.
 */
export function conversationExcerpt(entries: readonly unknown[] | undefined, maxChars: number): string {
	if (!entries?.length || maxChars <= 0) return "";
	const lines: string[] = [];
	let used = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as SessionEntry;
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = entryText(entry.message?.content);
		if (!text) continue;
		const line = `${role === "user" ? "User" : "Assistant"}: ${text}`;
		const remaining = maxChars - used;
		if (remaining <= 0) break;
		// The oldest kept entry is truncated rather than dropped whole.
		const kept = line.length <= remaining ? line : `…${line.slice(line.length - remaining)}`;
		lines.push(kept);
		used += kept.length + 1;
	}
	return lines.reverse().join("\n");
}

export function answerText(content: readonly unknown[] | undefined): string {
	return (content ?? [])
		.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object")
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text!)
		.join("\n")
		.trim();
}
