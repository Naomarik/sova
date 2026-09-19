/**
 * Tests for Statusband code folding.
 *
 * Uses node:test + node:assert/strict only; pi-tui supplies the real width helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import codefold from "./index.ts";
import {
	type BandStyle,
	buildBand,
	codespan,
	firstMeaningfulLine,
	FOLD_THRESHOLD,
	foldMarkdown,
	type FoldOptions,
	langAlias,
	pickSignature,
	plainStyle,
	scanFences,
} from "./fold.ts";

const metrics = { visibleWidth, truncateToWidth };
const code = (n: number, prefix = "x") => Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i}`);
const fence = (lang: string, body: string[], open = "```", close = open) => [open + lang, ...body, close].join("\n");
const opts = (p: Partial<FoldOptions> = {}): FoldOptions => ({
	width: 78,
	streaming: false,
	expanded: false,
	style: plainStyle,
	metrics,
	...p,
});
/** Bands are codespans; unwrap them for readable assertions. */
const unspan = (s: string) => s.replace(/^(`+)​?([\s\S]*?)​?\1$/, "$2");
const ansi = /\x1b\[[0-9;]*m/g;
// Real SGR codes in the same shapes pi's Theme emits.
const colorStyle: BandStyle = {
	fill: (s) => `\x1b[48;2;45;40;56m${s}\x1b[49m`,
	frame: (s) => `\x1b[38;2;102;102;102m${s}\x1b[39m`,
	lang: (s) => `\x1b[38;2;138;190;183m${s}\x1b[39m`,
	signature: (s) => `\x1b[38;2;128;128;128m${s}\x1b[39m`,
	meta: (s) => `\x1b[38;2;102;102;102m${s}\x1b[39m`,
	tail: (s) => `\x1b[32m${s}\x1b[39m`,
};

// ---------------------------------------------------------------- scanner

test("scanFences: backtick and tilde fences with lang", () => {
	const lines = ["prose", "```python", "a", "b", "```", "", "~~~ js extra", "c", "~~~"];
	const f = scanFences(lines, false);
	assert.equal(f.length, 2);
	assert.deepEqual([f[0].start, f[0].end, f[0].char, f[0].len, f[0].lang, f[0].body], [1, 4, "`", 3, "python", ["a", "b"]]);
	assert.deepEqual([f[1].char, f[1].lang, f[1].body, f[1].foldable], ["~", "js", ["c"], true]);
});

test("scanFences: closing fence must be same char and at least as long", () => {
	const lines = ["````md", "```", "~~~~", "`````", "after"];
	const [f] = scanFences(lines, false);
	assert.equal(f.end, 3, "``` (shorter) and ~~~~ (other char) do not close ````");
	assert.deepEqual(f.body, ["```", "~~~~"]);
	assert.equal(scanFences(["```", "a", "``` x"], false)[0].end, -1, "closing fence takes no info string");
	assert.equal(scanFences(["``` a`b", "x"], false).length, 0, "backtick info with backticks is not a fence");
});

test("scanFences: indentation, lists and quotes are tracked but not foldable", () => {
	const lines = ["  ```js", "  a", "  ```", "- ```py", "  b", "  ```", "> ```", "> c", "> ```", "```sh", "d", "```"];
	const f = scanFences(lines, false);
	assert.deepEqual(
		f.map((x) => [x.start, x.end, x.foldable]),
		[
			[0, 2, false],
			[3, 5, false],
			[6, 8, false],
			[9, 11, true],
		],
	);
});

test("scanFences: unclosed fence runs to the end; CRLF stripped", () => {
	const [f] = scanFences(["```py\r", "a\r", "b\r"], false);
	assert.deepEqual([f.end, f.lang, f.body], [-1, "py", ["a", "b"]]);
	const [g] = scanFences(["```py\r", "a\r", "```\r", "tail"], false);
	assert.equal(g.end, 2);
});

test("scanFences: streaming trailing 1-2 fence chars are a half-typed close", () => {
	for (const partial of ["`", "``"]) {
		const [f] = scanFences(["```py", "a", partial], true);
		assert.deepEqual([f.end, f.body, f.partialClose], [-1, ["a"], true]);
	}
	const [four] = scanFences(["````", "a", "```"], true);
	assert.deepEqual([four.end, four.body, four.partialClose], [-1, ["a"], true], "``` is partial for a ```` opener");
	const [done] = scanFences(["```py", "a", "`"], false);
	assert.deepEqual([done.body, done.partialClose], [["a", "`"], false], "finalized: a lone backtick is code");
});

// -------------------------------------------------------------- signature

test("pickSignature: first definition line, skipping imports", () => {
	assert.equal(pickSignature(["import yaml", "from x import y", "", "@dataclass", "class Config:", "def f():"]), "class Config:");
	assert.equal(pickSignature(["import fs from 'fs';", "export async function main() {"]), "export async function main() {");
	assert.equal(pickSignature(["package main", 'import "fmt"', "func main() {"]), "func main() {");
	assert.equal(pickSignature(["use std::io;", "pub fn run(x: u8) -> u8 {"]), "pub fn run(x: u8) -> u8 {");
	assert.equal(pickSignature(["#include <stdio.h>", "int main(void) {"]), "int main(void) {");
	assert.equal(pickSignature(["export const handler = async () => {"]), "export const handler = async () => {");
	assert.equal(pickSignature(["sub greet {"]), "sub greet {");
	assert.equal(pickSignature(["fun main() {"]), "fun main() {");
});

test("pickSignature: fallbacks and whitespace collapse", () => {
	assert.equal(pickSignature(["import a", "{", "  print(a)  ,   b"]), "print(a) , b", "first non-trivial non-import line");
	assert.equal(pickSignature(["#include <stdio.h>", "#include <x.h>"]), "#include <stdio.h>", "include-only block → first include");
	assert.equal(pickSignature(["}", "  ", "];"]), "");
	assert.equal(pickSignature(["return foo(x)"]), "return foo(x)", "not a C-style def, still the fallback");
});

// ------------------------------------------------------------------- band

test("langAlias: map, short names as-is, else first 2 chars", () => {
	assert.equal(langAlias("python"), "py");
	assert.equal(langAlias("TypeScript"), "ts");
	assert.equal(langAlias("bash"), "sh");
	assert.equal(langAlias("sql"), "sql");
	assert.equal(langAlias("fortran"), "fo");
});

const spec = { lang: "python", signature: "def load_config(path: str) -> Config:", count: 30, state: "folded" as const };

test("buildBand: exact width at 20/40/80/140 for every state, plain and coloured", () => {
	for (const style of [plainStyle, colorStyle])
		for (const state of ["folded", "expanded", "streaming"] as const)
			for (const width of [1, 3, 5, 8, 12, 15, 16, 20, 30, 40, 60, 78, 80, 140]) {
				const band = buildBand({ ...spec, state, width }, style, metrics);
				assert.equal(visibleWidth(band), width, `${state} @${width}`);
				assert.ok(!band.includes("\n"));
			}
});

test("buildBand: full-width layout matches the mockup", () => {
	const band = buildBand({ ...spec, width: 78 }, plainStyle, metrics);
	assert.match(band, /^▕ python ▕ def load_config\(path: str\) -> Config: +▕ 30 lines ▕ alt\+o ▕$/);
	const exp = buildBand({ ...spec, state: "expanded", width: 78 }, plainStyle, metrics);
	assert.match(exp, /^▕ python ▕ expanded +▕ 30 lines ▕ fold ▕$/);
	const live = buildBand({ ...spec, count: 14, state: "streaming", width: 78 }, plainStyle, metrics);
	assert.match(live, /^▕ python ▕ ● writing +▕ 14 lines… ▕$/);
});

test("buildBand: width degradation tiers in order", () => {
	const at = (width: number) => buildBand({ ...spec, width }, plainStyle, metrics);
	assert.match(at(50), /^▕ python ▕ def load_con[^▕]*… ▕ 30 lines ▕ alt\+o ▕$/, "1: signature truncates");
	assert.match(at(36), /^▕ python ▕ def load_con[^▕]*… ▕ 30L ▕$/, "2: NL, hint dropped");
	assert.match(at(24), /^▕ py ▕ def load… ▕ 30L ▕$/, "3: alias");
	assert.match(at(20), /^▕ py ▕ +▕ 30 ▕$/, "signature dropped");
	assert.match(at(15), /^▕ +▕ 30 ▕$/, "4: count only below 16");
	assert.equal(at(3), "30 ");
	const cjk = buildBand({ ...spec, signature: "def 日本語日本語日本語日本語日本語()", width: 41 }, plainStyle, metrics);
	assert.equal(visibleWidth(cjk), 41);
});

test("buildBand: fill wraps the whole row and truncation adds no resets", () => {
	const band = buildBand({ ...spec, width: 30 }, colorStyle, metrics);
	assert.ok(band.startsWith("\x1b[48;2;45;40;56m") && band.endsWith("\x1b[49m"));
	assert.ok(!band.includes("\x1b[0m"), "a full reset would end the background early");
	assert.ok(!/\x1b\[49m./.test(band), "background never reset mid-row");
	assert.ok(band.replace(ansi, "").includes("…"));
});

// -------------------------------------------------------------- markdown

test("codespan: fence longer than any backtick run; guards edge spaces/backticks", () => {
	assert.equal(codespan("a `b` c"), "``a `b` c``");
	assert.equal(codespan("x``y"), "```x``y```");
	assert.equal(codespan("  indented"), "`​  indented​`");
	assert.equal(codespan("`edge"), "``​`edge​``");
	assert.equal(codespan("\x1b[32m  x\x1b[39m"), "`\x1b[32m  x\x1b[39m`", "coloured lines need no guard");
	assert.equal(codespan(""), "`​​`");
});

test("foldMarkdown: threshold — ≤12 lines and non-col-0 fences pass through unchanged (same string)", () => {
	const short = `Intro\n\n${fence("py", code(FOLD_THRESHOLD))}\n\nOutro`;
	assert.equal(foldMarkdown(short, opts()), short);
	const listed = `- item\n  \`\`\`py\n${code(30).map((l) => `  ${l}`).join("\n")}\n  \`\`\``;
	assert.equal(foldMarkdown(listed, opts()), listed);
	const quoted = `> \`\`\`py\n${code(30).map((l) => `> ${l}`).join("\n")}\n> \`\`\``;
	assert.equal(foldMarkdown(quoted, opts()), quoted);
	assert.equal(foldMarkdown("no fences here", opts()), "no fences here");
});

test("foldMarkdown: long block → one band paragraph separated from prose", () => {
	const md = `Here's a loader:\n${fence("python", ["import yaml", "def load_config(path: str) -> Config:", ...code(28)])}\nCall it once.`;
	const out = foldMarkdown(md, opts()).split("\n");
	assert.equal(out.length, 5);
	assert.deepEqual([out[0], out[1], out[3], out[4]], ["Here's a loader:", "", "", "Call it once."]);
	assert.match(unspan(out[2]), /^▕ python ▕ def load_config\(path: str\) -> Config: +▕ 30 lines ▕ alt\+o ▕$/);
	assert.equal(visibleWidth(unspan(out[2])), 78);
});

test("foldMarkdown: tilde and long-backtick fences fold; inner shorter fences stay in the body", () => {
	const body = ["```", ...code(20), "```"];
	const md = fence("md", body, "````");
	const out = foldMarkdown(md, opts());
	assert.match(unspan(out), /▕ md ▕ .*▕ 22 lines ▕/);
	assert.match(unspan(foldMarkdown(fence("js", code(13), "~~~"), opts())), /▕ js ▕ .*▕ 13 lines ▕/);
});

test("foldMarkdown: consecutive folded blocks stack as one paragraph (hard breaks)", () => {
	const md = `${fence("python", ["def a():", ...code(20)])}\n\n${fence("python", ["def test_b(tmp_path):", ...code(17)])}`;
	const out = foldMarkdown(md, opts());
	const rows = out.split("\\\n").map(unspan);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /def a\(\):.*21 lines/);
	assert.match(rows[1], /def test_b\(tmp_path\):.*18 lines/);
});

test("foldMarkdown: expanded keeps band as title bar above the verbatim native fence", () => {
	const block = fence("python", code(30));
	const out = foldMarkdown(`Intro\n\n${block}\n\nOutro`, opts({ expanded: true }));
	const lines = out.split("\n");
	assert.match(unspan(lines[2]), /^▕ python ▕ expanded +▕ 30 lines ▕ fold ▕$/);
	assert.equal(lines.slice(3, 35).join("\n"), block);
	assert.deepEqual(lines.slice(35), ["", "Outro"]);
});

test("foldMarkdown: streaming open fence shows ● writing band + protected 2-line tail", () => {
	const body = [...code(12), "  if *a* and _b_: # <div> | x |", "    return `raw`"];
	const md = `Writing:\n\n\`\`\`python\n${body.join("\n")}\n\`\``;
	const out = foldMarkdown(md, opts({ streaming: true }));
	const para = out.split("\n\n")[1];
	const rows = para.split("\\\n");
	assert.equal(rows.length, 3);
	assert.match(unspan(rows[0]), /^▕ python ▕ ● writing +▕ 14 lines… ▕$/);
	assert.equal(rows[1], "`​    if *a* and _b_: # <div> | x |​`", "one codespan per tail line, leading spaces kept");
	assert.equal(rows[2], "``​      return `raw`​``");
	// Closed while still streaming → finalized fold; short open fences stay native.
	assert.match(foldMarkdown(`${fence("python", code(14))}\nmore`, opts({ streaming: true })), /14 lines ▕ alt\+o/);
	const shortOpen = "```py\na\nb";
	assert.equal(foldMarkdown(shortOpen, opts({ streaming: true })), shortOpen);
	// Expanded while streaming: band + native (unclosed) fence, no tail.
	const exp = foldMarkdown(md, opts({ streaming: true, expanded: true })).split("\n");
	assert.match(unspan(exp[2]), /● writing/);
	assert.equal(exp[3], "```python");
});

test("foldMarkdown: streaming tail rows fit the width and are coloured", () => {
	const md = `\`\`\`js\n${[...code(12), `const s = "${"y".repeat(200)}";`].join("\n")}`;
	const rows = foldMarkdown(md, opts({ streaming: true, width: 40, style: colorStyle })).split("\\\n");
	for (const r of rows) assert.ok(visibleWidth(unspan(r)) <= 40);
	assert.ok(rows[2].includes("…"));
	assert.equal(visibleWidth(unspan(rows[0])), 40);
});

test("foldMarkdown: CRLF input folds", () => {
	const md = fence("py", ["def f():", ...code(20)]).replace(/\n/g, "\r\n");
	assert.match(unspan(foldMarkdown(md, opts())), /▕ py ▕ def f\(\): +▕ 21 lines/);
});

test("foldMarkdown: cache hits return identical replacement; key includes width and state", () => {
	const cache = new Map<string, string[]>();
	const md = fence("py", code(20));
	const a = foldMarkdown(md, opts({ cache }));
	assert.equal(cache.size, 1);
	assert.equal(foldMarkdown(md, opts({ cache })), a);
	assert.equal(cache.size, 1);
	foldMarkdown(md, opts({ cache, width: 40 }));
	foldMarkdown(md, opts({ cache, expanded: true }));
	assert.equal(cache.size, 3);
});

test("foldMarkdown: threshold option lowers the fold point", () => {
	const md = fence("py", code(7));
	assert.equal(foldMarkdown(md, opts()), md);
	assert.match(unspan(foldMarkdown(md, opts({ threshold: 6 }))), /▕ 7 lines ▕/);
	assert.equal(foldMarkdown(fence("py", code(6)), opts({ threshold: 6 })), fence("py", code(6)));
});

test("foldMarkdown: text target replaces fences in place with bare rows", () => {
	const md = `Intro\n${fence("python", ["def a():", ...code(20)])}\n${fence("js", code(15), "~~~")}\nOutro`;
	const lines = foldMarkdown(md, opts({ target: "text", keyLabel: "o" })).split("\n");
	assert.equal(lines.length, 4, "no blank separators, no paragraph stacking");
	assert.equal(lines[0], "Intro");
	assert.match(lines[1], /^▕ python ▕ def a\(\): +▕ 21 lines ▕ o ▕$/);
	assert.match(lines[2], /^▕ js ▕ .* ▕ 15 lines ▕ o ▕$/);
	assert.equal(lines[3], "Outro");
	assert.equal(visibleWidth(lines[1]), 78);
	const live = foldMarkdown(`\`\`\`py\n${code(14).join("\n")}`, opts({ target: "text", streaming: true })).split("\n");
	assert.deepEqual(live.slice(1), ["  x12 = 12", "  x13 = 13"], "tail rows are plain lines");
	const exp = foldMarkdown(fence("py", code(20)), opts({ target: "text", expanded: true })).split("\n");
	assert.match(exp[0], /▕ expanded +▕ 20 lines ▕ fold ▕$/);
	assert.equal(exp.slice(1).join("\n"), fence("py", code(20)));
});

test("buildBand: chars unit and firstMeaningfulLine", () => {
	const band = buildBand({ lang: "text", signature: "xxx", count: 400, unit: "chars", state: "folded", width: 60, keyLabel: "o" }, plainStyle, metrics);
	assert.match(band, /▕ 400 chars ▕ o ▕$/);
	assert.match(buildBand({ lang: "text", signature: "xxxxxxxxxxxx", count: 400, unit: "chars", state: "folded", width: 30 }, plainStyle, metrics), /▕ text ▕ .* ▕ 400ch ▕$/);
	assert.equal(firstMeaningfulLine(["", "{", "  row   0 ", "row 1"]), "row 0");
	assert.equal(firstMeaningfulLine(["}", ""]), "");
});

// ------------------------------------------------------------- extension

function load() {
	let transformer: ((md: any, c: any) => string) | undefined;
	const shortcuts = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		registerMarkdownTransformer: (t: any) => (transformer = t),
		registerShortcut: (k: string, o: any) => shortcuts.set(k, o),
		registerCommand: () => {},
		on: (e: string, h: any) => handlers.set(e, h),
	};
	codefold(pi);
	return { transform: transformer!, shortcuts, handlers };
}

test("extension: assistant-only, try/catch passthrough", () => {
	const { transform } = load();
	const md = fence("py", code(20));
	const ctx = { messageType: "assistant", isStreaming: false, availableWidth: 60 };
	assert.notEqual(transform(md, ctx), md);
	assert.equal(transform(md, { ...ctx, messageType: "user" }), md);
	assert.equal(transform(md, { ...ctx, messageType: "assistant-thinking" }), md);
	const hostile = {
		includes() {
			throw new Error("boom");
		},
	};
	assert.equal(transform(hostile, ctx), hostile, "errors return the input unchanged");
});

test("extension: session_start captures the TUI; ctrl+alt+o toggles, repaints and notifies", () => {
	const { transform, shortcuts, handlers } = load();
	const calls: string[] = [];
	const fakeTui = { invalidate: () => calls.push("invalidate"), requestRender: () => calls.push("render") };
	const widgets: Array<[string, unknown]> = [];
	const theme = {
		getBgAnsi: () => "\x1b[48;2;1;2;3m",
		getFgAnsi: () => "\x1b[38;2;9;9;9m",
		fg: (_t: string, s: string) => `\x1b[38;2;9;9;9m${s}\x1b[39m`,
	};
	const ctx: any = {
		mode: "tui",
		ui: {
			theme,
			notify: (m: string) => calls.push(m),
			setWidget: (k: string, f: any) => {
				widgets.push([k, f]);
				if (typeof f === "function") f(fakeTui, theme);
			},
		},
	};
	handlers.get("session_start")({}, ctx);
	assert.deepEqual(widgets.map(([k, f]) => [k, typeof f]), [
		["codefold-statusband-probe", "function"],
		["codefold-statusband-probe", "undefined"],
	]);
	const md = fence("py", code(20));
	const tctx = { messageType: "assistant", isStreaming: false, availableWidth: 50 };
	assert.ok(transform(md, tctx).includes("\x1b[48;2;1;2;3m"), "band uses customMessageBg");
	shortcuts.get("ctrl+alt+o").handler(ctx);
	assert.deepEqual(calls, ["invalidate", "render", "Code blocks: expanded"]);
	assert.match(transform(md, tctx), /expanded[\s\S]*```py/);
	shortcuts.get("ctrl+alt+o").handler(ctx);
	assert.equal(calls.at(-1), "Code blocks: folded");
	handlers.get("session_shutdown")({}, ctx);
	calls.length = 0;
	shortcuts.get("ctrl+alt+o").handler({ ...ctx, mode: "print" });
	assert.deepEqual(calls, [], "non-tui toggles are ignored");
});

test("extension: bg fallback — default bg → mdCodeBlock as bg → no fill", () => {
	const run = (theme: any) => {
		const { transform, handlers } = load();
		handlers.get("session_start")({}, { mode: "tui", ui: { theme, setWidget: () => {}, notify: () => {} } });
		return transform(fence("py", code(20)), { messageType: "assistant", isStreaming: false, availableWidth: 40 });
	};
	const fg = (_t: string, s: string) => `\x1b[2m${s}\x1b[22m`;
	const viaCode = run({ getBgAnsi: () => "\x1b[49m", getFgAnsi: () => "\x1b[38;5;71m", fg });
	assert.ok(viaCode.includes("\x1b[48;5;71m"), "mdCodeBlock fg converted to bg");
	const none = run({
		getBgAnsi: () => {
			throw new Error("missing");
		},
		getFgAnsi: (t: string) => (t === "mdCodeBlock" ? "\x1b[39m" : "\x1b[2m"),
		fg,
	});
	assert.ok(!/\x1b\[4\d|\x1b\[48;/.test(none), "no background at all");
	assert.equal(visibleWidth(none.replace(/^`|`$/g, "")), 40);
});
