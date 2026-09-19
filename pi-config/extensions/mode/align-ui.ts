/**
 * TUI for the align minor mode: the read-only alignment-doc overlay viewer and the
 * one-line widget. The host (index.ts) owns the doc, the overlay, and closing.
 *
 * Every rendered line is exactly `width` cells; render never throws.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type OverlayOptions,
} from "@earendil-works/pi-tui";
import { clampScroll, statusLabelText, summarize, viewport, widgetLine, type AlignDoc, type AlignSummary } from "./align.ts";

export interface AlignViewerHost {
	theme: Theme;
	markdownTheme: MarkdownTheme;
	/** Read once at construction; later changes arrive through setDoc. */
	getDoc: () => AlignDoc | null;
	/** Total rows the overlay may use, header and footer included. */
	height: () => number;
	requestRender: () => void;
	close: () => void;
	keyHint: string;
}

export type AlignViewer = Component & Focusable & { setDoc(doc: AlignDoc | null): void; dispose(): void };

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

function headerText(doc: AlignDoc | null): string {
	if (!doc) return "◇ Alignment";
	const summary = summarize(doc);
	const parts = [doc.title ? `◇ Alignment: ${doc.title}` : "◇ Alignment", statusLabelText(summary.status)];
	if (summary.total > 0) parts.push(`${summary.settled}/${summary.total} settled`);
	parts.push(`v${summary.revision}`);
	return parts.join(" · ");
}

class AlignViewerComponent implements Component, Focusable {
	focused = true;
	private doc: AlignDoc | null;
	private readonly markdown: Markdown;
	private scroll = 0;
	/** From the last render; key handling pages and clamps against these. */
	private bodyRows = 1;
	private totalRows = 0;
	private readonly host: AlignViewerHost;

	constructor(host: AlignViewerHost) {
		this.host = host;
		let doc: AlignDoc | null = null;
		try {
			doc = host.getDoc();
		} catch {
			doc = null;
		}
		this.doc = doc;
		this.markdown = new Markdown(doc?.markdown ?? "", 0, 0, host.markdownTheme, undefined, {
			transform: (source) => checklistGlyphs(source),
		});
	}

	setDoc(doc: AlignDoc | null): void {
		this.doc = doc;
		this.markdown.setText(doc?.markdown ?? "");
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

	private renderLines(width: number): string[] {
		const { theme } = this.host;
		const rawHeight = Number(this.host.height());
		const height = Math.max(CHROME_ROWS + 1, Number.isFinite(rawHeight) ? Math.floor(rawHeight) : 0);
		this.bodyRows = height - CHROME_ROWS;

		const body = this.doc ? this.markdown.render(width) : [theme.fg("dim", "No alignment doc")];
		this.totalRows = body.length;
		this.scroll = clampScroll(this.scroll, this.totalRows, this.bodyRows);
		const visible = viewport(body, this.scroll, this.bodyRows);

		const lines = [
			fit(theme.fg("accent", theme.bold(headerText(this.doc))), width),
			fit(theme.fg("dim", "─".repeat(width)), width),
			...visible.map((line) => fit(line, width)),
		];
		while (lines.length < height - 1) lines.push(fit("", width));
		const from = this.totalRows === 0 ? 0 : this.scroll + 1;
		const to = Math.min(this.totalRows, this.scroll + this.bodyRows);
		lines.push(fit(theme.fg("dim", `[${from}-${to}/${this.totalRows}] ↑↓ j/k · pgup/pgdn · g/G · q/esc`), width));
		return lines;
	}
}

/** A fresh viewer per open; the host passes it to `ctx.ui.custom` with ALIGN_OVERLAY_OPTIONS. */
export function createAlignViewer(host: AlignViewerHost): AlignViewer {
	return new AlignViewerComponent(host);
}

/** The single widget line; tone follows the status. */
export function alignWidget(theme: Theme, getSummary: () => AlignSummary, keyHint: string): Component {
	return {
		render(width: number): string[] {
			width = Math.max(0, Math.floor(width));
			if (width === 0) return [""];
			try {
				const summary = getSummary();
				const tone = summary.status === "confirmed" ? "success" : summary.status === "implementing" ? "dim" : "accent";
				return [truncateToWidth(theme.fg(tone, widgetLine(summary, keyHint)), width, "…")];
			} catch {
				return [""];
			}
		},
		invalidate(): void {},
	};
}
