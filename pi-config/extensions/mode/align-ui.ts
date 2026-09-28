/**
 * TUI for the align minor mode: the read-only viewer overlay (one alignment at a time, ←/→
 * between them; an older session's markdown doc when it has only that), the widget line, and the
 * `align` tool's call and result renderers. The host (index.ts) owns the state, the overlay, and
 * closing.
 *
 * Every rendered line is exactly `width` cells; render never throws.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type OverlayOptions,
} from "@earendil-works/pi-tui";
import {
	alignStatus,
	alignStatusWord,
	clampScroll,
	docLine,
	legacyLine,
	normalizeAlignDetails,
	openQuestionsOf,
	openText,
	toMarkdown,
	viewport,
	type AlignDocument,
	type LegacyAlignDoc,
} from "./align.ts";

/** What the viewer shows: the branch's alignments, and an older session's markdown doc. */
export interface AlignViewState {
	docs: AlignDocument[];
	legacy: LegacyAlignDoc | null;
}

export interface AlignViewerHost {
	theme: Theme;
	markdownTheme: MarkdownTheme;
	/** Read once at construction; later changes arrive through setState. */
	getState: () => AlignViewState;
	/** Total rows the overlay may use, header and footer included. */
	height: () => number;
	requestRender: () => void;
	close: () => void;
	keyHint: string;
}

export type AlignViewer = Component & Focusable & { setState(state: AlignViewState): void; dispose(): void };

export const ALIGN_OVERLAY_OPTIONS: OverlayOptions = { anchor: "center", width: "80%", minWidth: 40, margin: 1 };

/** Rows taken by the title bar, rule, and footer. */
const CHROME_ROWS = 3;
const TASK_MARKER = /^(\s*(?:[-*+•]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
const FENCE = /^\s*(```|~~~)/;

/** GFM task markers → ☐/☑ before Markdown parses them (it would otherwise print "[ ] "); code fences untouched. */
export function checklistGlyphs(markdown: string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (FENCE.test(line)) inFence = !inFence;
			if (inFence) return line;
			return line.replace(TASK_MARKER, (_match, prefix: string, mark: string) => `${prefix}${mark === " " ? "☐" : "☑"}`);
		})
		.join("\n");
}

/** Truncate and pad to exactly `width` cells. */
function fit(line: string, width: number): string {
	return truncateToWidth(line, width, "…", true);
}

/** The pages the viewer steps through: open alignments first (newest last), then the finished ones; the legacy doc only when there is nothing else. */
function pagesOf(state: AlignViewState): ({ kind: "doc"; doc: AlignDocument } | { kind: "legacy"; doc: LegacyAlignDoc })[] {
	const open = state.docs.filter((d) => d.phase !== "done" && d.phase !== "dropped");
	const closed = state.docs.filter((d) => d.phase === "done" || d.phase === "dropped");
	const pages = [...open, ...closed].map((doc) => ({ kind: "doc" as const, doc }));
	if (pages.length === 0 && state.legacy) return [{ kind: "legacy", doc: state.legacy }];
	return pages;
}

class AlignViewerComponent implements Component, Focusable {
	focused = true;
	private state: AlignViewState;
	private page = 0;
	private readonly markdown: Markdown;
	private scroll = 0;
	/** From the last render; key handling pages and clamps against these. */
	private bodyRows = 1;
	private totalRows = 0;
	private readonly host: AlignViewerHost;

	constructor(host: AlignViewerHost) {
		this.host = host;
		let state: AlignViewState = { docs: [], legacy: null };
		try {
			state = host.getState();
		} catch {
			// An unreadable state shows as empty.
		}
		this.state = state;
		// Open on the newest open alignment.
		const pages = pagesOf(state);
		const openCount = state.docs.filter((d) => d.phase !== "done" && d.phase !== "dropped").length;
		this.page = openCount > 0 ? openCount - 1 : 0;
		this.markdown = new Markdown(this.sourceOf(pages[this.page]), 0, 0, host.markdownTheme, undefined, {
			transform: (source) => checklistGlyphs(source),
		});
	}

	private sourceOf(page: ReturnType<typeof pagesOf>[number] | undefined): string {
		if (!page) return "";
		return page.kind === "doc" ? toMarkdown(page.doc) : page.doc.markdown;
	}

	private showPage(next: number): void {
		const pages = pagesOf(this.state);
		if (pages.length === 0) return;
		this.page = ((next % pages.length) + pages.length) % pages.length;
		this.scroll = 0;
		this.markdown.setText(this.sourceOf(pages[this.page]));
		this.host.requestRender();
	}

	setState(state: AlignViewState): void {
		const current = pagesOf(this.state)[this.page];
		this.state = state;
		const pages = pagesOf(state);
		// Stay on the same document when it is still there.
		const same = current ? pages.findIndex((p) => p.kind === current.kind && (p.kind === "legacy" || p.doc.id === (current.doc as AlignDocument).id)) : -1;
		this.page = same >= 0 ? same : Math.min(this.page, Math.max(0, pages.length - 1));
		this.markdown.setText(this.sourceOf(pages[this.page]));
		this.host.requestRender();
	}

	dispose(): void {}

	invalidate(): void {
		this.markdown.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.host.close();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) return this.showPage(this.page - 1);
		if (matchesKey(data, "right") || matchesKey(data, "l")) return this.showPage(this.page + 1);
		const page = Math.max(1, this.bodyRows - 2);
		let next = this.scroll;
		if (matchesKey(data, "up") || matchesKey(data, "k")) next -= 1;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) next += 1;
		else if (matchesKey(data, "pageUp")) next -= page;
		else if (matchesKey(data, "pageDown")) next += page;
		else if (matchesKey(data, "home") || data === "g") next = 0;
		else if (matchesKey(data, "end") || data === "G" || matchesKey(data, "shift+g")) next = this.totalRows;
		else return;
		next = clampScroll(next, this.totalRows, this.bodyRows);
		if (next === this.scroll) return;
		this.scroll = next;
		this.host.requestRender();
	}

	render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		if (width === 0) return [""];
		try {
			return this.renderLines(width);
		} catch {
			return [fit(this.host.theme.fg("error", "alignment viewer failed to render · q/esc close"), width)];
		}
	}

	private headerText(): string {
		const pages = pagesOf(this.state);
		const page = pages[this.page];
		if (!page) return "◇ Alignments";
		const position = pages.length > 1 ? ` · ${this.page + 1}/${pages.length}` : "";
		if (page.kind === "legacy") return `◇ Alignment${page.doc.title ? `: ${page.doc.title}` : ""} · ${legacyLine(page.doc)} · read-only${position}`;
		return `◇ ${docLine(page.doc)} · v${page.doc.rev}${position}`;
	}

	private renderLines(width: number): string[] {
		const { theme } = this.host;
		const rawHeight = Number(this.host.height());
		const height = Math.max(CHROME_ROWS + 1, Number.isFinite(rawHeight) ? Math.floor(rawHeight) : 0);
		this.bodyRows = height - CHROME_ROWS;

		const pages = pagesOf(this.state);
		const body = pages.length > 0 ? this.markdown.render(width) : [theme.fg("dim", "No alignments on this branch")];
		this.totalRows = body.length;
		this.scroll = clampScroll(this.scroll, this.totalRows, this.bodyRows);
		const visible = viewport(body, this.scroll, this.bodyRows);

		const lines = [
			fit(theme.fg("accent", theme.bold(this.headerText())), width),
			fit(theme.fg("dim", "─".repeat(width)), width),
			...visible.map((line) => fit(line, width)),
		];
		while (lines.length < height - 1) lines.push(fit("", width));
		const from = this.totalRows === 0 ? 0 : this.scroll + 1;
		const to = Math.min(this.totalRows, this.scroll + this.bodyRows);
		const switcher = pages.length > 1 ? " · ←/→ alignment" : "";
		lines.push(fit(theme.fg("dim", `[${from}-${to}/${this.totalRows}] ↑↓ j/k · pgup/pgdn · g/G${switcher} · q/esc`), width));
		return lines;
	}
}

/** A fresh viewer per open; the host passes it to `ctx.ui.custom` with ALIGN_OVERLAY_OPTIONS. */
export function createAlignViewer(host: AlignViewerHost): AlignViewer {
	return new AlignViewerComponent(host);
}

/** The single widget line (align.ts widgetText); accent while a question is open, dim otherwise. */
export function alignWidget(theme: Theme, getLine: () => { text: string; open: boolean }): Component {
	return {
		render(width: number): string[] {
			width = Math.max(0, Math.floor(width));
			if (width === 0) return [""];
			try {
				const { text, open } = getLine();
				return [truncateToWidth(theme.fg(open ? "accent" : "dim", text), width, "…")];
			} catch {
				return [""];
			}
		},
		invalidate(): void {},
	};
}

// ── The tool row ─────────────────────────────────────────────────────────────

function opWord(op: Record<string, unknown>): string {
	const q = op.q ?? op.qs;
	const qs = Array.isArray(q) ? q.join(",") : typeof q === "string" ? q : "";
	switch (op.op) {
		case "create":
			// An older session's call imported with create + fromFile.
			return op.fromFile !== undefined ? `import ${String(op.fromFile)}` : `create "${String(op.title ?? "")}"`;
		case "import":
			return `import ${String(op.path ?? "")}`;
		case "status":
			return `→ ${String(op.to ?? "?")}`;
		case "edit":
		case "edit_rejected":
			return `edit ${typeof op.id === "string" ? op.id : "title"}`;
		case "edit_question":
			return `edit ${qs}`;
		case "edit_doc":
			return `edit ${["title", "summary"].filter((k) => op[k] !== undefined).join(",") || "title"}`;
		case "remove":
			return `remove ${Array.isArray(op.ids) ? op.ids.join(",") : ""}`;
		case "accept_all":
			return "accept all";
		case "drop_question":
			return `drop ${qs}`;
		case "drop":
		case "drop_alignment":
			return qs ? `drop ${qs}` : "drop";
		default:
			return qs ? `${String(op.op)} ${qs}` : String(op.op ?? "?");
	}
}

/** One dim line: "◇ align al_3 · decide q3 · accept all · → implementing". */
export function renderAlignCall(args: unknown, theme: Theme): Component {
	const a = (args ?? {}) as { doc?: unknown; ops?: unknown };
	const ops = Array.isArray(a.ops) ? a.ops.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null) : [];
	const target = typeof a.doc === "string" ? ` ${a.doc}` : "";
	const words = ops.map(opWord).join(" · ");
	return new Text(theme.fg("dim", `◇ align${target}${words ? ` · ${words}` : ""}`), 0, 0);
}

/**
 * The result: the document's line and what changed, then its open questions with the
 * recommendations (the whole document when expanded). An exemption is one line; anything
 * unreadable falls back to the result's text.
 */
export function renderAlignResult(result: { content?: unknown; details?: unknown }, expanded: boolean, theme: Theme): Component {
	const details = normalizeAlignDetails(result.details);
	const fallback = Array.isArray(result.content)
		? result.content
				.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
				.join("\n")
		: "";
	if (!details) return new Text(theme.fg("dim", fallback), 0, 0);
	if (details.exempt) return new Text(theme.fg("dim", `No alignment needed: ${details.exempt.why}`), 0, 0);
	const doc = details.doc;
	if (!doc) return new Text(theme.fg("dim", expanded ? fallback : fallback.split("\n")[0] ?? ""), 0, 0);
	if (expanded) return new Text(toMarkdown(doc), 0, 0);
	const status = alignStatus(doc);
	const tone = status === "aligning" ? "accent" : status === "dropped" ? "dim" : "success";
	const lines = [
		`${theme.fg(tone, theme.bold(`${doc.id} ${doc.title}`))} ${theme.fg("dim", `· ${alignStatusWord(status)} · ${openText(doc)} · v${doc.rev}${details.line ? ` · ${details.line}` : ""}`)}`,
		...openQuestionsOf(doc).map((q) => `  ${theme.fg("accent", q.id)} ${q.topic}: ${q.ask} ${theme.fg("dim", `(rec: ${q.recommendation.choice})`)}`),
	];
	return new Text(lines.join("\n"), 0, 0);
}
