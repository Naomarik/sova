/**
 * Accordion folding for code-heavy transcript items (shared by AgentsModal and
 * TeamModal): a thin TranscriptItem adapter over the main-thread Statusband
 * engine in ../codefold/fold.ts, so both surfaces fold into the same band.
 * Folding is purely a render concern: TranscriptItem text is never rewritten,
 * so agent_transcript output keeps full fidelity.
 *
 *   write/edit calls   one line: `✎ write ~/src/a.ts  +212` / `✎ edit … +34 −12`
 *   long tool/system   `▕ bash ▕ npm test ▕ 42 lines ▕ o ▕`
 *   assistant prose    stays visible; only long fenced code blocks fold
 *   task/steer/error   never folded
 *
 * Claude-code workers push tool items as JSON-encoded input, so their
 * write/edit summaries are recovered by parsing the item text; pi workers only
 * carry a one-line path, so the pi runner stores `summary` at push time.
 */

import * as os from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildBand, firstMeaningfulLine, foldMarkdown, type Metrics, pickSignature, plainStyle } from "../codefold/fold.ts";
import type { TranscriptItem } from "./runner.ts";

/** Items with more lines than this (or more chars than FOLD_MAX_CHARS) fold; fences fold above this many body lines. */
export const FOLD_MAX_LINES = 6;
export const FOLD_MAX_CHARS = 300;
/** The modals' accordion key, shown in folded bands. */
export const FOLD_KEY = "o";
const metrics: Metrics = { visibleWidth, truncateToWidth };

export interface FoldResult {
	/** Collapsed rendering of the item. */
	text: string;
	/** True when `text` hides content that expanding would reveal. */
	hidesContent: boolean;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function countLines(text: string): number {
	if (!text) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/** Added/removed line counts for one replacement, ignoring shared leading/trailing lines. */
function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
	const a = oldText ? oldText.replace(/\n$/, "").split("\n") : [];
	const b = newText ? newText.replace(/\n$/, "").split("\n") : [];
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** Replacement pairs from pi (`edits[].oldText/newText`, legacy top-level) or claude (`old_string/new_string`, MultiEdit `edits[]`). */
function editPairs(args: Record<string, any>): Array<[string, string]> {
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	// Copy: the caller's args (possibly live tool input) must never be mutated.
	const list: any[] = Array.isArray(edits) ? [...edits] : edits && typeof edits === "object" ? [edits] : [];
	list.push(args);
	const pairs: Array<[string, string]> = [];
	for (const e of list) {
		const oldText = e?.oldText ?? e?.old_string;
		const newText = e?.newText ?? e?.new_string;
		if (typeof oldText === "string" && typeof newText === "string") pairs.push([oldText, newText]);
	}
	return pairs;
}

/**
 * One-line summary for a file-writing tool call, or undefined when the tool is
 * not write/edit or its args are unusable. Accepts pi and claude arg shapes.
 */
export function summarizeFileChange(toolName: string | undefined, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, any>;
	const name = String(toolName ?? "").toLowerCase();
	const path = a.path ?? a.file_path;
	if (typeof path !== "string" || !path) return undefined;
	if (name === "write") {
		if (typeof a.content !== "string") return undefined;
		return `✎ write ${shortenPath(path)}  +${countLines(a.content)}`;
	}
	if (name === "edit" || name === "multiedit") {
		const pairs = editPairs(a);
		if (!pairs.length) return undefined;
		let added = 0;
		let removed = 0;
		for (const [oldText, newText] of pairs) {
			const d = lineDelta(oldText, newText);
			added += d.added;
			removed += d.removed;
		}
		return `✎ edit ${shortenPath(path)}  +${added} −${removed}`;
	}
	return undefined;
}

/** Real newlines plus JSON-escaped `\n` sequences (claude tool input is JSON). */
function logicalLines(text: string): string[] {
	return text.split(/\n|\\n/).map((line) => line.replace(/\\t/g, " "));
}

/** Prefer a well-known arg (command, path, pattern…) over raw JSON for claude tool input. */
function jsonSnippet(text: string): string | undefined {
	const args = parseArgs(text) as Record<string, unknown> | undefined;
	for (const k of ["command", "file_path", "path", "pattern", "description", "url", "query", "prompt"]) {
		const v = args?.[k];
		if (typeof v === "string" && v.trim()) return firstMeaningfulLine(logicalLines(v));
	}
	return undefined;
}

function parseArgs(text: string): unknown {
	if (!text.startsWith("{")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// Clipped or non-JSON text.
		return undefined;
	}
}

function band(lang: string, signature: string, lines: number, chars: number, width: number): string {
	const unit = lines > 1 ? "lines" : "chars";
	const count = unit === "lines" ? lines : chars;
	return buildBand({ lang, signature, count, unit, state: "folded", width, keyLabel: FOLD_KEY }, plainStyle, metrics);
}

function computeFold(item: TranscriptItem, width: number): FoldResult | undefined {
	const text = item.text ?? "";
	switch (item.kind) {
		case "task":
		case "steer":
		case "error":
			return undefined;
		case "assistant": {
			const lines = logicalLines(text);
			// A wall of JSON-escaped code with no real newlines folds whole.
			if (!text.includes("\n") && lines.length > FOLD_MAX_LINES) {
				return { text: band("", pickSignature(lines), lines.length, text.length, width), hidesContent: true };
			}
			const fenced = foldMarkdown(text, {
				width,
				streaming: false,
				expanded: false,
				style: plainStyle,
				metrics,
				keyLabel: FOLD_KEY,
				threshold: FOLD_MAX_LINES,
				target: "text",
			});
			return fenced === text ? undefined : { text: fenced, hidesContent: true };
		}
		default: {
			const lines = logicalLines(text);
			const long = lines.length > FOLD_MAX_LINES || text.length > FOLD_MAX_CHARS;
			const change =
				item.summary ?? (item.kind === "tool" ? summarizeFileChange(item.toolName, parseArgs(text)) : undefined);
			if (change) return { text: change, hidesContent: long };
			if (!long) return undefined;
			const lang = item.toolName?.toLowerCase() || "text";
			const signature = jsonSnippet(text) ?? firstMeaningfulLine(lines);
			return { text: band(lang, signature, lines.length, text.length, width), hidesContent: true };
		}
	}
}

const memo = new WeakMap<TranscriptItem, { text: string; summary?: string; width: number; result: FoldResult | undefined }>();

/**
 * Collapsed form of an item at `width` columns, or undefined when it renders
 * unchanged. Memoized per item and revalidated on text/summary/width, since
 * runners may rewrite items in place (streaming, trim markers).
 */
export function foldTranscriptItem(item: TranscriptItem, width: number): FoldResult | undefined {
	const hit = memo.get(item);
	if (hit && hit.text === item.text && hit.summary === item.summary && hit.width === width) return hit.result;
	const result = computeFold(item, width);
	memo.set(item, { text: item.text, summary: item.summary, width, result });
	return result;
}

/** Text a modal should render for `item` in the current expand/collapse state; bands are exactly `width` wide. */
export function transcriptDisplayText(item: TranscriptItem, expanded: boolean, width: number): string {
	const fold = foldTranscriptItem(item, width);
	if (!fold || (expanded && fold.hidesContent)) return item.text;
	return fold.text;
}
