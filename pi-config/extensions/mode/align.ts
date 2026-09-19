/**
 * The align minor mode's alignment doc: parser for the agent's heading-anchored block,
 * status/summary derivation, session-entry (de)serialization, and viewer scroll math.
 * No imports: unit-testable, and nothing here throws on odd model output.
 */

/** customType of the session entry (`pi.appendEntry`). */
export const ALIGN_ENTRY_TYPE = "align-doc";
/** Key for `ctx.ui.setWidget`. */
export const ALIGN_WIDGET_KEY = "mode-align";

export type AlignStatus = "aligning" | "questions-open" | "ready" | "confirmed" | "implementing";

export interface AlignQuestion {
	/** Number as written by the agent; falls back to 1-based position. */
	n: number;
	/** Single line, list and checkbox markers stripped. */
	text: string;
	checked: boolean;
}

export interface AlignDoc {
	version: 1;
	/** Text after "Alignment:" on the anchor heading; "" when absent. */
	title: string;
	/** The block verbatim, anchor heading to block end, trailing whitespace trimmed. */
	markdown: string;
	questions: AlignQuestion[];
	explicitStatus?: "confirmed" | "implementing" | "aligning";
	/** 1..n, increments per accepted capture. */
	revision: number;
	/** ISO timestamp. */
	capturedAt: string;
}

/** Persisted payload of an `align-doc` entry; `doc: null` means cleared. */
export interface AlignEntryData {
	version: 1;
	doc: AlignDoc | null;
}

export interface AlignSummary {
	status: AlignStatus;
	lines: number;
	open: number;
	settled: number;
	total: number;
	revision: number;
	title: string;
}

type ParsedDoc = Omit<AlignDoc, "revision" | "capturedAt">;
type ExplicitStatus = NonNullable<AlignDoc["explicitStatus"]>;
type Section = "findings" | "approach" | "questions" | "rejected" | "status" | "other";

const ANCHOR = /^(#{1,4})\s+alignment\b(?:\s*[:—-]\s*(.*))?$/i;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
/** A line opening with a `**bold**` run: `**text** trailer`. Only a heading when `text` is a known section or the anchor. */
const BOLD = /^\s*\*\*\s*(.+?)\s*\*\*\s*(.*)$/;
const BOLD_ANCHOR = /^alignment\b(?:\s*[:—-]\s*(.*))?$/i;
const FENCE = /^\s*(```|~~~)/;
const SECTION_NAMES = "findings|approach|open questions|questions|rejected(?: alternatives)?|alternatives";
const SECTION = new RegExp(`^(${SECTION_NAMES}|status)\\b`, "i");
/** Bold pseudo-headings must be the bare section name (status may carry its value inline). */
const BOLD_SECTION = new RegExp(`^(?:(?:${SECTION_NAMES})\\s*:?|status\\b(?:\\s*[:—-]\\s*.*)?)$`, "i");
/** Looser shape for the "looks like an alignment doc" heuristic: `Findings:`, `*Approach*`, `__Status__: x`, `### Rejected`. */
const LOOSE_SECTION = new RegExp(`^\\s*(?:#{1,6}\\s+)?(?:(\\*\\*|__|\\*|_)\\s*)?(${SECTION_NAMES}|status)(?![a-z])(.*)$`, "i");
const QUESTION = /^\s*(?:(\d+)[.)]|[-*•])\s+(?:\[([ xX])\]\s*)?(.+)$/;
const STATUS_WORD = /\b(confirmed|implementing|aligning)\b/i;
/** Without an anchor, this many distinct section headings mark a block. */
const MIN_SECTIONS_WITHOUT_ANCHOR = 3;

function sectionOf(headingText: string): Section {
	const match = SECTION.exec(headingText);
	if (!match) return "other";
	const name = match[1].toLowerCase();
	if (name === "findings" || name === "approach" || name === "status") return name;
	if (name === "open questions" || name === "questions") return "questions";
	return "rejected";
}

interface Heading {
	kind: "md" | "bold";
	/** Markdown heading depth; bold pseudo-headings count as level 2. */
	depth: number;
	/** Heading text without markers. */
	text: string;
	/** Prose after a bold run's closing `**` ("" for markdown headings). */
	trailer: string;
	section: Section;
}

/** The line as a heading: a `#` heading, or a `**bold**` run that names a section or the anchor. Anything else is prose. */
function headingOf(line: string): Heading | undefined {
	const md = HEADING.exec(line);
	if (md) {
		const text = md[2].replace(/\s#+$/, "");
		return { kind: "md", depth: md[1].length, text, trailer: "", section: sectionOf(text) };
	}
	const bold = BOLD.exec(line);
	if (!bold) return undefined;
	const text = bold[1];
	if (!BOLD_SECTION.test(text) && !BOLD_ANCHOR.test(text)) return undefined;
	return { kind: "bold", depth: 2, text, trailer: bold[2], section: sectionOf(text) };
}

function anchorOf(line: string): { level: number; title: string } | undefined {
	const md = ANCHOR.exec(line.trimEnd());
	if (md) return { level: md[1].length, title: oneLine((md[2] ?? "").replace(/\s#+$/, "")) };
	const bold = BOLD.exec(line);
	const inner = bold ? BOLD_ANCHOR.exec(bold[1]) : null;
	if (inner) return { level: 2, title: oneLine(inner[1] ?? "") };
	return undefined;
}

/** Lines outside code fences, in order, with their index. */
function unfenced(lines: string[]): { i: number; line: string }[] {
	const out: { i: number; line: string }[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (FENCE.test(lines[i])) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) out.push({ i, line: lines[i] });
	}
	return out;
}

/** Section named by a loosely decorated heading line, or undefined when the line is prose. */
function looseSectionOf(line: string): Section | undefined {
	const match = LOOSE_SECTION.exec(line);
	if (!match) return undefined;
	const marker = match[1];
	const section = sectionOf(match[2]);
	let rest = match[3];
	if (marker !== undefined) {
		const close = rest.indexOf(marker);
		if (close < 0) return undefined;
		rest = rest.slice(0, close);
	}
	const ok = section === "status" ? /^\s*(?:[:—-].*)?$/.test(rest) : /^\s*:?\s*$/.test(rest);
	return ok ? section : undefined;
}

function indentOf(line: string): number {
	return /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function explicitFrom(text: string): ExplicitStatus | undefined {
	const match = STATUS_WORD.exec(text);
	return match ? (match[1].toLowerCase() as ExplicitStatus) : undefined;
}

/**
 * True when `text` has at least three distinct section headings in any loosely
 * heading-shaped form (`### Findings`, `**Approach**`, `*Rejected*`, `__Status__`,
 * a bare `Findings:` line), outside code fences. Broader than what `parseAlignBlock`
 * accepts, so a caller can warn when a block looked like an alignment doc but did
 * not parse. Prose that merely mentions the words does not count. Never throws.
 */
export function looksLikeAlignBlock(text: string): boolean {
	try {
		if (typeof text !== "string") return false;
		const seen = new Set<Section>();
		for (const { line } of unfenced(text.replace(/\r\n?/g, "\n").split("\n"))) {
			const section = looseSectionOf(line);
			if (section !== undefined && section !== "other") seen.add(section);
		}
		return seen.size >= MIN_SECTIONS_WITHOUT_ANCHOR;
	} catch {
		return false;
	}
}

/**
 * The first alignment block in `text`, or undefined when there is none. Never throws.
 *
 * The block is anchored by `## Alignment[: title]` (levels 1–4) or its bold form
 * `**Alignment[: title]**`. Sections are `### Findings` / `### Approach` /
 * `### Open questions` / `### Rejected` / `### Status` headings, or the same names
 * as `**bold**` pseudo-headings (mixed freely; bold status may carry its value inline,
 * `**Status: aligning** — prose`). Without any anchor, a run of at least three
 * distinct section headings (heading-shaped only, never prose mentions) starts a
 * block with an empty title at the first of them. Code fences are skipped.
 */
export function parseAlignBlock(text: string): ParsedDoc | undefined {
	try {
		if (typeof text !== "string") return undefined;
		const lines = text.replace(/\r\n?/g, "\n").split("\n");
		const visible = unfenced(lines);

		let start = -1;
		/** First line parsed for sections: the line after the anchor, or the anchorless block's own first heading. */
		let bodyStart = -1;
		let level = 0;
		let title = "";
		// Loose block ends: a markdown heading at or above the anchor level ends the block
		// unless it is a known section (bold anchors and anchorless blocks have no real level).
		let loose = false;
		for (const { i, line } of visible) {
			const anchor = anchorOf(line);
			if (anchor) {
				start = i;
				bodyStart = i + 1;
				level = anchor.level;
				title = anchor.title;
				loose = line.trimStart().startsWith("*");
				break;
			}
		}
		if (start < 0) {
			const seen = new Set<Section>();
			let first: { i: number; heading: Heading } | undefined;
			for (const { i, line } of visible) {
				const heading = headingOf(line);
				if (!heading || heading.section === "other") continue;
				if (!first) first = { i, heading };
				seen.add(heading.section);
			}
			if (!first || seen.size < MIN_SECTIONS_WITHOUT_ANCHOR) return undefined;
			start = first.i;
			bodyStart = first.i;
			level = first.heading.depth;
			loose = true;
		}

		const questions: AlignQuestion[] = [];
		let explicitStatus: ExplicitStatus | undefined;
		let statusSeen = false;
		let section: Section = "other";
		let current: AlignQuestion | undefined;
		let baseIndent = -1;
		let end = lines.length;
		let inFence = false;

		for (let i = bodyStart; i < lines.length; i++) {
			const line = lines[i];
			if (FENCE.test(line)) {
				inFence = !inFence;
				current = undefined;
				continue;
			}
			if (inFence) continue;
			const heading = headingOf(line);
			if (heading) {
				if (heading.kind === "md" && heading.depth <= level && !(loose && heading.section !== "other")) {
					end = i;
					break;
				}
				section = heading.section;
				current = undefined;
				if (section === "status" && !statusSeen) {
					const inline = oneLine(`${heading.text.replace(/^status\b\s*[:—-]?\s*/i, "")} ${heading.trailer}`);
					if (inline !== "") {
						statusSeen = true;
						explicitStatus = explicitFrom(inline);
					}
				}
				continue;
			}
			if (section === "status") {
				if (!statusSeen && line.trim() !== "") {
					statusSeen = true;
					explicitStatus = explicitFrom(line);
				}
				continue;
			}
			if (section !== "questions" || line.trim() === "") continue;

			const indent = indentOf(line);
			const item = QUESTION.exec(line);
			// Sub-bullets and indented prose under an item fold into it.
			if (current && indent >= baseIndent + 2) {
				const body = item ? item[3] : line;
				current.text = oneLine(`${current.text} ${body}`);
				continue;
			}
			if (item) {
				if (baseIndent < 0) baseIndent = indent;
				const text = oneLine(item[3]);
				current = {
					n: item[1] !== undefined ? Number(item[1]) : questions.length + 1,
					text,
					checked: item[2] === "x" || item[2] === "X",
				};
				questions.push(current);
				continue;
			}
			current = undefined; // Unindented prose ends the item.
		}

		const markdown = lines.slice(start, end).join("\n").trimEnd();
		const doc: ParsedDoc = { version: 1, title, markdown, questions };
		if (explicitStatus !== undefined) doc.explicitStatus = explicitStatus;
		return doc;
	} catch {
		return undefined;
	}
}

export function deriveStatus(doc: AlignDoc): AlignStatus {
	if (doc.explicitStatus === "implementing") return "implementing";
	if (doc.explicitStatus === "confirmed") return "confirmed";
	const total = doc.questions.length;
	const open = doc.questions.filter((question) => !question.checked).length;
	if (open > 0) return "questions-open";
	if (total > 0) return "ready";
	return "aligning";
}

export function summarize(doc: AlignDoc): AlignSummary {
	const total = doc.questions.length;
	const settled = doc.questions.filter((question) => question.checked).length;
	return {
		status: deriveStatus(doc),
		lines: doc.markdown.split("\n").length,
		open: total - settled,
		settled,
		total,
		revision: doc.revision,
		title: doc.title,
	};
}

const STATUS_LABELS: Record<AlignStatus, string> = {
	aligning: "aligning",
	"questions-open": "questions open",
	ready: "ready to confirm",
	confirmed: "confirmed",
	implementing: "implementing",
};

export function statusLabelText(status: AlignStatus): string {
	return STATUS_LABELS[status] ?? String(status);
}

/** Plain text: "◇ align · questions open · 2/5 settled · 41 lines · alt+a view". */
export function widgetLine(summary: AlignSummary, keyHint: string): string {
	const parts = ["◇ align", statusLabelText(summary.status)];
	if (summary.total > 0) parts.push(`${summary.settled}/${summary.total} settled`);
	parts.push(`${summary.lines} ${summary.lines === 1 ? "line" : "lines"}`);
	if (keyHint.trim() !== "") parts.push(`${keyHint.trim()} view`);
	return parts.join(" · ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuestion(value: unknown): AlignQuestion | undefined {
	if (!isRecord(value)) return undefined;
	const { n, text, checked } = value;
	if (typeof n !== "number" || !Number.isFinite(n) || typeof text !== "string" || typeof checked !== "boolean") return undefined;
	return { n, text, checked };
}

function normalizeDoc(value: unknown): AlignDoc | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { title, markdown, questions, explicitStatus, revision, capturedAt } = value;
	if (typeof title !== "string" || typeof markdown !== "string" || typeof capturedAt !== "string") return undefined;
	if (typeof revision !== "number" || !Number.isFinite(revision)) return undefined;
	if (!Array.isArray(questions)) return undefined;
	const normalized: AlignQuestion[] = [];
	for (const question of questions) {
		const ok = normalizeQuestion(question);
		if (!ok) return undefined;
		normalized.push(ok);
	}
	const doc: AlignDoc = { version: 1, title, markdown, questions: normalized, revision, capturedAt };
	if (explicitStatus !== undefined) {
		if (explicitStatus !== "confirmed" && explicitStatus !== "implementing" && explicitStatus !== "aligning") return undefined;
		doc.explicitStatus = explicitStatus;
	}
	return doc;
}

/** Strict shape check of a persisted entry payload; a fresh object without unknown keys, or undefined. */
export function normalizeAlignEntry(data: unknown): AlignEntryData | undefined {
	try {
		if (!isRecord(data) || data.version !== 1 || !("doc" in data)) return undefined;
		if (data.doc === null) return { version: 1, doc: null };
		const doc = normalizeDoc(data.doc);
		return doc ? { version: 1, doc } : undefined;
	} catch {
		return undefined;
	}
}

/** Newest valid `align-doc` custom entry on the branch wins; `doc: null` clears; malformed entries are skipped. */
export function restoreAlignDoc(entries: readonly { type: string; customType?: string; data?: unknown }[]): AlignDoc | null {
	if (!Array.isArray(entries)) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== ALIGN_ENTRY_TYPE) continue;
		const data = normalizeAlignEntry(entry.data);
		if (data) return data.doc;
	}
	return null;
}

export function nextDoc(prev: AlignDoc | null, parsed: ParsedDoc, now: string): AlignDoc {
	const doc: AlignDoc = {
		version: 1,
		title: parsed.title,
		markdown: parsed.markdown,
		questions: parsed.questions.map((question) => ({ ...question })),
		revision: (prev?.revision ?? 0) + 1,
		capturedAt: now,
	};
	if (parsed.explicitStatus !== undefined) doc.explicitStatus = parsed.explicitStatus;
	return doc;
}

/** True when `markdown` re-emits the current block unchanged (no new revision). */
export function sameBlock(prev: AlignDoc | null, markdown: string): boolean {
	return prev !== null && prev.markdown === markdown;
}

/** First visible line index, clamped so the window stays within `total` lines. */
export function clampScroll(scroll: number, total: number, height: number): number {
	const max = Math.max(0, Math.floor(total) - Math.max(1, Math.floor(height)));
	if (!Number.isFinite(scroll)) return 0;
	return Math.max(0, Math.min(Math.floor(scroll), Number.isFinite(max) ? max : 0));
}

export function viewport<T>(lines: T[], scroll: number, height: number): T[] {
	const rows = Math.max(0, Number.isFinite(height) ? Math.floor(height) : 0);
	const start = clampScroll(scroll, lines.length, rows);
	return lines.slice(start, start + rows);
}
