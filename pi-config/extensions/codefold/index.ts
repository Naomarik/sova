/**
 * codefold — Statusband folding for long fenced code blocks in main-thread
 * assistant messages (Proposal E, ../CODEFOLD-PROPOSALS.md).
 *
 * Display-only: a markdown transformer rewrites what pi renders; session text
 * is never touched, so copy (app.message.copy) and the model see the original.
 * `TOGGLE_KEY` (or /codefold) toggles all bands between folded and expanded.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BandStyle, foldMarkdown, type Metrics, plainStyle } from "./fold.ts";

const PROBE_WIDGET = "codefold-statusband-probe";
/** Also registered by topic-outline; pi keeps whichever extension loads last and warns. */
// topic-outline owns alt+o; sessions takes alt+s/alt+shift+s; codefold takes ctrl+alt+o
// (alt+shift+letter never reaches pi: terminals can't report shift with alt on letters).
const TOGGLE_KEY = "ctrl+alt+o";
const metrics: Metrics = { visibleWidth, truncateToWidth };

interface ResolvedStyle {
	style: BandStyle;
	key: string;
}

/** fg SGR → matching bg SGR (`38;…` → `48;…`, `3N` → `4N`, `9N` → `10N`); undefined for the default colour. */
function fgToBg(ansi: string): string | undefined {
	const m = /^\x1b\[(.*)m$/.exec(ansi);
	if (!m) return undefined;
	const p = m[1];
	if (p.startsWith("38;")) return `\x1b[48;${p.slice(3)}m`;
	if (/^3[0-7]$/.test(p)) return `\x1b[4${p[1]}m`;
	if (/^9[0-7]$/.test(p)) return `\x1b[10${p[1]}m`;
	return undefined;
}

/**
 * Band fill: `customMessageBg`; else `mdCodeBlock` (a foreground token, so its
 * colour is converted to a background); else no fill, all segments `dim`.
 * A token resolving to the terminal default (`\x1b[49m`) counts as missing.
 */
function bandFill(theme: Theme): string | undefined {
	try {
		const bg = theme.getBgAnsi("customMessageBg");
		if (bg && bg !== "\x1b[49m") return bg;
	} catch {
		// Token missing in this theme.
	}
	try {
		return fgToBg(theme.getFgAnsi("mdCodeBlock"));
	} catch {
		return undefined;
	}
}

const styles = new WeakMap<Theme, ResolvedStyle>();

function resolveStyle(theme: Theme): ResolvedStyle {
	const hit = styles.get(theme);
	if (hit) return hit;
	const fill = bandFill(theme);
	const fg = (token: ThemeColor) => (s: string) => theme.fg(token, s);
	const dim = fg("dim");
	const style: BandStyle = fill
		? {
				fill: (s) => `${fill}${s}\x1b[49m`,
				frame: dim,
				lang: fg("accent"),
				signature: fg("muted"),
				meta: dim,
				tail: fg("mdCodeBlock"),
			}
		: { fill: (s) => s, frame: dim, lang: dim, signature: dim, meta: dim, tail: fg("mdCodeBlock") };
	const resolved = { style, key: `${fill ?? "nofill"}${theme.getFgAnsi("accent")}${theme.getFgAnsi("muted")}` };
	styles.set(theme, resolved);
	return resolved;
}

export default function codefold(pi: ExtensionAPI) {
	let expanded = false;
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	/** A transform ran before the theme was reachable; repaint once it is. */
	let renderedUnstyled = false;
	const cache = new Map<string, string[]>();

	function repaint() {
		if (!tui) return;
		tui.invalidate();
		tui.requestRender();
	}

	function toggle(c: ExtensionContext) {
		if (c.mode !== "tui") return;
		expanded = !expanded;
		repaint();
		c.ui.notify(`Code blocks: ${expanded ? "expanded" : "folded"}`, "info");
	}

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming, availableWidth }) => {
		if (messageType !== "assistant") return markdown;
		try {
			let resolved: ResolvedStyle | undefined;
			try {
				if (ctx) resolved = resolveStyle(ctx.ui.theme);
			} catch {
				resolved = undefined;
			}
			if (!resolved) renderedUnstyled = true;
			return foldMarkdown(markdown, {
				width: availableWidth,
				streaming: isStreaming,
				expanded,
				style: resolved?.style ?? plainStyle,
				styleKey: resolved?.key ?? "plain",
				metrics,
				cache,
				keyLabel: TOGGLE_KEY,
			});
		} catch {
			return markdown;
		}
	});

	pi.registerShortcut(TOGGLE_KEY, { description: "Fold/expand long code blocks", handler: toggle });
	pi.registerCommand("codefold", {
		description: `Fold/expand long code blocks in assistant messages (same as ${TOGGLE_KEY})`,
		handler: async (_args, c) => toggle(c),
	});

	pi.on("session_start", (_event, c) => {
		cache.clear();
		if (c.mode !== "tui") return;
		ctx = c;
		try {
			// Interactive mode hands widget factories its TUI; keep it, drop the widget.
			c.ui.setWidget(PROBE_WIDGET, (t) => {
				tui = t;
				return { render: () => [], invalidate() {} };
			});
			c.ui.setWidget(PROBE_WIDGET, undefined);
		} catch {
			tui = undefined;
		}
		if (renderedUnstyled) {
			renderedUnstyled = false;
			repaint();
		}
	});

	pi.on("session_shutdown", () => {
		try {
			ctx?.ui.setWidget(PROBE_WIDGET, undefined);
		} catch {
			// UI already gone.
		}
		ctx = undefined;
		tui = undefined;
		cache.clear();
	});
}
