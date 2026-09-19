/**
 * Statusband code folding for main-thread assistant messages (Proposal E in
 * ../CODEFOLD-PROPOSALS.md). Pure logic: fence scanning, band layout and the
 * markdown rewrite. No pi imports; width measurement and colours are injected
 * so tests can pass pi-tui's real helpers or plain stand-ins.
 *
 *   folded     ▕ python ▕ def load_config(path: str) -> Config:   ▕ 30 lines ▕ alt+o ▕
 *   expanded   the same band ("expanded" … "fold") above pi's native fence
 *   streaming  ▕ python ▕ ● writing                                ▕ 14 lines… ▕
 *              plus the last TAIL_LINES code lines, 2-space indent
 *
 * Every band and tail row is emitted as a single markdown codespan so pi's
 * markdown pipeline prints it literally (`*`, `_`, `[a](b)`, leading spaces).
 * `target: "text"` emits bare rows instead, for surfaces that render plain
 * lines (the subagents /agents and /team modals).
 */

/** Blocks with more body lines than this fold. */
export const FOLD_THRESHOLD = 12;
export const TAIL_LINES = 2;
/** Below this width only the count is shown (shared width rule, tier 4). */
export const COUNT_ONLY_BELOW = 16;
/** Smallest signature cell worth showing before degrading to the next tier. */
const MIN_SIGNATURE = 8;
const BAR = "▕";
const CACHE_LIMIT = 256;
const ZWSP = "​";

export interface Metrics {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string;
}

/** Colour functions. `fill` wraps the whole finished row (background). */
export interface BandStyle {
	fill(text: string): string;
	frame(text: string): string;
	lang(text: string): string;
	signature(text: string): string;
	meta(text: string): string;
	tail(text: string): string;
}

export const plainStyle: BandStyle = {
	fill: (s) => s,
	frame: (s) => s,
	lang: (s) => s,
	signature: (s) => s,
	meta: (s) => s,
	tail: (s) => s,
};

// ---------------------------------------------------------------------------
// Fence scanner

export interface Fence {
	/** Line index of the opening fence. */
	start: number;
	/** Line index of the closing fence, or -1 when unclosed. */
	end: number;
	char: "`" | "~";
	len: number;
	lang: string;
	/** Body lines, CR stripped, excluding a streamed partial closing fence. */
	body: string[];
	/** Column-0 fence outside any list/quote: the only kind we fold. */
	foldable: boolean;
	/** Trailing line is a half-typed closing fence (streaming only). */
	partialClose: boolean;
}

const OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** Fence opened inside a list item or blockquote: tracked only so its body isn't scanned. */
const CONTAINER_OPEN_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)+(?:>[ \t]?)*(`{3,}|~{3,})(.*)$/;
const CONTAINER_PREFIX_RE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t>]*/;

function stripCR(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isClosing(line: string, char: string, len: number, foldable: boolean): boolean {
	const s = foldable ? /^ {0,3}(.*)$/.exec(line)![1] : line.replace(CONTAINER_PREFIX_RE, "");
	const t = s.trimEnd();
	if (t.length < len || t[0] !== char) return false;
	for (let i = 1; i < t.length; i++) if (t[i] !== char) return false;
	return true;
}

/**
 * CommonMark-ish fence scan: fence char and length tracked, closing fence must
 * be the same char and at least as long, backtick info strings may not contain
 * backticks. With `streaming`, a trailing line of fewer fence chars than the
 * opener is a closing fence still being typed: it stays open and is not counted.
 */
export function scanFences(lines: string[], streaming: boolean): Fence[] {
	const fences: Fence[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = stripCR(lines[i]);
		let marker: string;
		let info: string;
		let foldable: boolean;
		const open = OPEN_RE.exec(line);
		if (open) {
			[, , marker, info] = open;
			foldable = open[1] === "";
		} else {
			const nested = CONTAINER_OPEN_RE.exec(line);
			if (!nested) continue;
			[, marker, info] = nested;
			foldable = false;
		}
		const char = marker[0] as "`" | "~";
		if (char === "`" && info.includes("`")) continue;
		const len = marker.length;
		let end = -1;
		let j = i + 1;
		for (; j < lines.length; j++) {
			if (isClosing(stripCR(lines[j]), char, len, foldable)) {
				end = j;
				break;
			}
		}
		const body = lines.slice(i + 1, end === -1 ? lines.length : end).map(stripCR);
		let partialClose = false;
		if (end === -1 && streaming && body.length > 0) {
			const last = body[body.length - 1].trim();
			if (last.length > 0 && last.length < len && last === char.repeat(last.length)) {
				body.pop();
				partialClose = true;
			}
		}
		fences.push({ start: i, end, char, len, lang: info.trim().split(/\s+/)[0] ?? "", body, foldable, partialClose });
		if (end === -1) break;
		i = end;
	}
	return fences;
}

// ---------------------------------------------------------------------------
// Signature

const DEFINITION_RES: RegExp[] = [
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/, // js/ts
	/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/, // js/ts/python/java/kotlin
	/^export\s+(?:const|let|var|interface|type|enum|default)\b/, // ts
	/^(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=/, // `const X =`
	/^(?:interface|type|enum)\s+[\w$]+/, // ts
	/^(?:async\s+)?def\s+\w+/, // python/ruby
	/^(?:module|struct|trait|impl|object)\s+\w/, // ruby/rust/scala
	/^func\b/, // go
	/^type\s+\w+\s+(?:struct|interface)\b/, // go
	/^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|trait|impl|mod)\b/, // rust
	/^(?:(?:public|private|protected|internal|open|override|suspend|inline|data)\s+)*fun\b/, // kotlin
	/^sub\s+\w+/, // perl
	// C/C++/Java/C#-style `type name(args) {`
	/^(?!(?:return|else|elif|new|await|throw|raise|delete|case|when|if|while|for|switch|do|typeof|yield|assert|print|puts|echo|not|with|defer|go)\b)[A-Za-z_][\w:<>,*&\s]*[\s*&]\*?[A-Za-z_][\w:~]*\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/,
];

const IMPORT_RE =
	/^(?:import\b|from\s+\S+\s+import\b|using\b|#\s*include\b|#\s*import\b|@import\b|require\b|use\s|package\s|extern\s+crate\b|library\(|(?:const|let|var)\s+[\w${},\s]+=\s*require\(|["']use strict["']|#!)/;

export function isTrivialLine(line: string): boolean {
	return /^[\s{}[\](),;:"'`~]*$/.test(line);
}

function cleanLine(line: string): string {
	return line.replace(/\s+/g, " ").trim();
}

/**
 * Text for the signature segment: the first definition line; else the first
 * non-trivial line after skipping import-like lines; else the first
 * non-trivial line at all (e.g. an `#include`-only block shows its first include).
 */
export function pickSignature(body: string[]): string {
	let firstReal: string | undefined;
	let firstNonImport: string | undefined;
	for (const raw of body) {
		if (isTrivialLine(raw)) continue;
		const line = raw.trim();
		if (DEFINITION_RES.some((re) => re.test(line))) return cleanLine(line);
		firstReal ??= line;
		if (firstNonImport === undefined && !IMPORT_RE.test(line)) firstNonImport = line;
	}
	return cleanLine(firstNonImport ?? firstReal ?? "");
}

/** Signature for logs and plain output: the first non-trivial line, whitespace collapsed. */
export function firstMeaningfulLine(body: string[]): string {
	return cleanLine(body.find((line) => !isTrivialLine(line)) ?? "");
}

// ---------------------------------------------------------------------------
// Band layout

const ALIASES: Record<string, string> = {
	python: "py",
	python3: "py",
	javascript: "js",
	typescript: "ts",
	typescriptreact: "tsx",
	javascriptreact: "jsx",
	rust: "rs",
	golang: "go",
	ruby: "rb",
	bash: "sh",
	shell: "sh",
	shellscript: "sh",
	zsh: "sh",
	console: "sh",
	powershell: "ps",
	markdown: "md",
	yaml: "yml",
	kotlin: "kt",
	csharp: "cs",
	"c#": "cs",
	"c++": "cpp",
	haskell: "hs",
	elixir: "ex",
	erlang: "erl",
	clojure: "clj",
	perl: "pl",
	text: "txt",
	plaintext: "txt",
	code: "txt",
	dockerfile: "dkr",
	makefile: "mk",
};

/** Short language label for narrow bands: alias map, else ≤3 chars as-is, else first 2 chars. */
export function langAlias(lang: string): string {
	const key = lang.toLowerCase();
	return ALIASES[key] ?? (lang.length <= 3 ? lang : lang.slice(0, 2));
}

export type BandState = "folded" | "expanded" | "streaming";

export interface BandSpec {
	lang: string;
	/** Middle-segment text for the folded state. */
	signature: string;
	count: number;
	state: BandState;
	width: number;
	/** Key hint shown in the folded band (e.g. "ctrl+alt+o"). Defaults to "alt+o". */
	keyLabel?: string;
	/** What `count` measures. Defaults to "lines"; "chars" suits one long unbroken line. */
	unit?: "lines" | "chars";
}

type Cell = { text: string; style: keyof BandStyle; flex?: boolean };

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Plain-text truncation. pi-tui appends `\x1b[0m` resets, which would end the row's background. */
function fit(text: string, width: number, m: Metrics): string {
	if (width <= 0) return "";
	if (m.visibleWidth(text) <= width) return text;
	return m.truncateToWidth(text, width, "…").replace(ANSI_RE, "");
}

function renderCells(cells: Cell[], width: number, style: BandStyle, m: Metrics): string | undefined {
	// "▕ a ▕ b ▕" → each cell costs its width + 3 (space, space, bar), plus the leading bar.
	let fixed = 1;
	let flex: Cell | undefined;
	for (const c of cells) {
		fixed += 3;
		if (c.flex) flex = c;
		else fixed += m.visibleWidth(c.text);
	}
	const room = width - fixed;
	if (room < 0) return undefined;
	if (flex && flex.text && room < Math.min(MIN_SIGNATURE, m.visibleWidth(flex.text))) return undefined;
	// Adjacent frame pieces (bars, gaps, padding) share one colour span.
	let out = "";
	let frame = BAR;
	for (const c of cells) {
		let text = c.text;
		let pad = 0;
		if (c.flex) {
			text = fit(text, room, m);
			pad = room - m.visibleWidth(text);
		}
		frame += " ";
		if (text) {
			out += style.frame(frame) + style[c.style](text);
			frame = "";
		}
		frame += `${" ".repeat(pad + 1)}${BAR}`;
	}
	return out + style.frame(frame);
}

/** One band row, exactly `spec.width` columns wide (visible), degrading per the shared width rule. */
export function buildBand(spec: BandSpec, style: BandStyle, m: Metrics): string {
	const { lang: rawLang, count, state, width } = spec;
	const lang = rawLang || "code";
	const middle = state === "streaming" ? "● writing" : state === "expanded" ? "expanded" : spec.signature;
	const more = state === "streaming" ? "…" : "";
	const hint = state === "expanded" ? "fold" : state === "folded" ? (spec.keyLabel ?? "alt+o") : undefined;
	const chars = spec.unit === "chars";
	const long: Cell = { text: `${count} ${chars ? "chars" : "lines"}${more}`, style: "meta" };
	const short: Cell = { text: `${count}${chars ? "ch" : "L"}${more}`, style: "meta" };
	const bare: Cell = { text: `${count}${more}`, style: "meta" };
	const mid: Cell = { text: middle, style: "signature", flex: true };
	const empty: Cell = { text: "", style: "signature", flex: true };
	const full: Cell = { text: lang, style: "lang" };
	const alias: Cell = { text: langAlias(lang), style: "lang" };
	const tiers: Cell[][] = [
		hint ? [full, mid, long, { text: hint, style: "meta" }] : [full, mid, long],
		[full, mid, short],
		[alias, mid, short],
	];
	if (width >= COUNT_ONLY_BELOW) tiers.push([alias, empty, bare]);
	tiers.push([empty, bare]);
	for (const cells of tiers) {
		const row = renderCells(cells, width, style, m);
		if (row !== undefined) return style.fill(row);
	}
	const text = fit(bare.text, width, m);
	return style.fill(style.meta(text) + style.frame(" ".repeat(Math.max(0, width - m.visibleWidth(text)))));
}

// ---------------------------------------------------------------------------
// Markdown rewrite

/** Wrap one rendered line as a codespan so markdown prints it verbatim. */
export function codespan(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(longest + 1);
	// ZWSP guards stop marked stripping edge spaces or merging edge backticks into the fence.
	const guard = text === "" || /^[ `]|[ `]$/.test(text) ? ZWSP : "";
	return `${fence}${guard}${text}${guard}${fence}`;
}

export interface FoldOptions {
	width: number;
	streaming: boolean;
	expanded: boolean;
	style: BandStyle;
	metrics: Metrics;
	/** Identifies `style` (theme + fill choice) in cache keys. */
	styleKey?: string;
	/** Replacement cache keyed by block hash, width, state and styleKey. */
	cache?: Map<string, string[]>;
	/** Key hint label for folded bands (pass the extension's actual shortcut). */
	keyLabel?: string;
	/** Fold fences whose body has more lines than this. Defaults to FOLD_THRESHOLD. */
	threshold?: number;
	/**
	 * "markdown" (default) wraps rows in codespans and keeps bands in their own
	 * paragraphs for pi's markdown renderer. "text" replaces each fence with bare
	 * rows in place, for callers that print lines verbatim.
	 */
	target?: "markdown" | "text";
}

/** FNV-1a over lines[from, to) without joining them. */
function hashLines(lines: string[], from: number, to: number): string {
	let h = 0x811c9dc5;
	for (let l = from; l < to; l++) {
		const s = lines[l];
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		h ^= 10;
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function tailRows(body: string[], width: number, style: BandStyle, m: Metrics, wrap: (row: string) => string): string[] {
	return body.slice(-TAIL_LINES).map((line) => {
		const text = fit(`  ${line.replace(/\t/g, "   ")}`, width, m);
		return wrap(style.tail(text));
	});
}

const verbatim = (row: string) => row;

/** Replacement markdown lines for one fence (a paragraph, plus the native fence when expanded). */
function replacement(fence: Fence, lines: string[], live: boolean, opts: FoldOptions): string[] {
	const { width, expanded, style, metrics } = opts;
	const state: BandState = live ? "streaming" : expanded ? "expanded" : "folded";
	const text = opts.target === "text";
	const wrap = text ? verbatim : codespan;
	const band = wrap(
		buildBand(
			{ lang: fence.lang, signature: pickSignature(fence.body), count: fence.body.length, state, width, keyLabel: opts.keyLabel },
			style,
			metrics,
		),
	);
	if (expanded) return [band, ...lines.slice(fence.start, fence.end === -1 ? lines.length : fence.end + 1)];
	if (!live) return [band];
	const rows = [band, ...tailRows(fence.body, width, style, metrics, wrap)];
	return text ? rows : [rows.join("\\\n")];
}

/**
 * Rewrite long column-0 fences into bands. Returns the input string itself
 * when nothing folds. Finalized blocks fold when their body exceeds
 * `opts.threshold` (FOLD_THRESHOLD); a still-open trailing fence during streaming shows the
 * `● writing` band plus tail once it passes the same threshold.
 */
export function foldMarkdown(markdown: string, opts: FoldOptions): string {
	if (!markdown.includes("```") && !markdown.includes("~~~")) return markdown;
	const lines = markdown.split("\n");
	const fences = scanFences(lines, opts.streaming);
	const threshold = opts.threshold ?? FOLD_THRESHOLD;
	const text = opts.target === "text";
	let folding = false;
	for (const f of fences) if (f.foldable && f.body.length > threshold) folding = true;
	if (!folding) return markdown;

	const out: string[] = [];
	let cursor = 0;
	/** out index of the last folded band paragraph, while only blank lines follow it. */
	let lastBand = -1;
	for (const f of fences) {
		if (!f.foldable || f.body.length <= threshold) continue;
		for (let i = cursor; i < f.start; i++) {
			out.push(lines[i]);
			if (lines[i].trim() !== "") lastBand = -1;
		}
		const live = opts.streaming && f.end === -1;
		const stop = f.end === -1 ? lines.length : f.end + 1;
		const key = `${hashLines(lines, f.start, stop)}:${f.body.length}:${opts.width}:${opts.expanded ? 1 : 0}:${live ? 1 : 0}:${opts.styleKey ?? ""}${text ? ":t" : ""}`;
		let rep = opts.cache?.get(key);
		if (!rep) {
			rep = replacement(f, lines, live, opts);
			if (opts.cache) {
				// Streaming adds a key per delta; drop everything rather than track recency.
				if (opts.cache.size >= CACHE_LIMIT) opts.cache.clear();
				opts.cache.set(key, rep);
			}
		}
		if (text) {
			// Plain lines: no paragraphs to separate or merge.
			out.push(...rep);
		} else if (lastBand !== -1 && !opts.expanded) {
			// Consecutive folded blocks stack as one paragraph, like tabs (mockup d).
			out.length = lastBand + 1;
			out[lastBand] += `\\\n${rep[0]}`;
		} else {
			// Blank lines keep the band out of a neighbouring paragraph, list or quote.
			if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
			out.push(...rep);
			lastBand = opts.expanded ? -1 : out.length - 1;
		}
		cursor = stop;
		if (!text && cursor < lines.length && lines[cursor].trim() !== "") {
			out.push("");
			lastBand = -1;
		}
	}
	for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
	return out.join("\n");
}
