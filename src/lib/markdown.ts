// Markdown for assistant-text (spec/04e-markdown.md §4e). markdown-it with html:false, so any HTML in
// model output is escaped text, never rendered. Every tag we emit ourselves is built from
// escaped parts. highlight.js runs on its `common` set plus a few extras, never auto-detect.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import hljs from "highlight.js/lib/common";
import type { TmpAttachment } from "../../shared/protocol";
import { findTmpImagePaths } from "../../shared/tmp-paths";
import { chipHtml } from "./path-attachments";
import clojure from "highlight.js/lib/languages/clojure";
import cmake from "highlight.js/lib/languages/cmake";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import haskell from "highlight.js/lib/languages/haskell";
import http from "highlight.js/lib/languages/http";
import latex from "highlight.js/lib/languages/latex";
import nix from "highlight.js/lib/languages/nix";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";

// Languages models often emit that `common` lacks. Everything else stays plain text.
hljs.registerLanguage("clojure", clojure);
hljs.registerLanguage("cmake", cmake);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("elixir", elixir);
hljs.registerLanguage("erlang", erlang);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("http", http);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("nix", nix);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("protobuf", protobuf);
hljs.registerLanguage("scala", scala);

const esc = (s: string) => MarkdownIt().utils.escapeHtml(s);

/**
 * Fence words and file extensions → hljs language names. hljs knows many aliases itself (py, rb,
 * cs, hpp, …); this table pins the common spellings to one canonical name, fixes the ones hljs
 * gets wrong for model output (`shell` there means a `$ ` prompt transcript, not a script), and
 * sends every "no language" spelling to plaintext. toml → ini: hljs has no toml, and its ini
 * grammar (which aliases toml itself) covers keys, sections, strings and comments.
 */
const LANGUAGE_ALIASES = new Map<string, string>([
  ["c++", "cpp"], ["cc", "cpp"], ["cxx", "cpp"], ["hpp", "cpp"], ["hh", "cpp"], ["hxx", "cpp"], ["h", "cpp"],
  ["c#", "csharp"], ["cs", "csharp"],
  ["objc", "objectivec"], ["objective-c", "objectivec"], ["mm", "objectivec"],
  ["yml", "yaml"],
  ["sh", "bash"], ["zsh", "bash"], ["shell", "bash"], ["shellscript", "bash"],
  ["console", "shell"], ["shell-session", "shell"], ["shellsession", "shell"],
  ["py", "python"], ["pyi", "python"], ["rb", "ruby"], ["rs", "rust"], ["golang", "go"],
  ["kt", "kotlin"], ["kts", "kotlin"],
  ["ps1", "powershell"], ["psm1", "powershell"], ["ps", "powershell"], ["pwsh", "powershell"],
  ["make", "makefile"], ["mk", "makefile"], ["gnumake", "makefile"],
  ["docker", "dockerfile"], ["containerfile", "dockerfile"],
  ["html", "xml"], ["htm", "xml"], ["xhtml", "xml"], ["svg", "xml"], ["vue", "xml"], ["svelte", "xml"],
  ["md", "markdown"], ["mkd", "markdown"], ["mdx", "markdown"],
  ["toml", "ini"],
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["patch", "diff"],
  ["jsonc", "json"], ["json5", "json"],
  ["clj", "clojure"], ["cljs", "clojure"], ["cljc", "clojure"], ["edn", "clojure"],
  ["ex", "elixir"], ["exs", "elixir"], ["erl", "erlang"], ["hs", "haskell"], ["proto", "protobuf"],
  ["tex", "latex"], ["gql", "graphql"],
  ["", "plaintext"], ["text", "plaintext"], ["txt", "plaintext"], ["plain", "plaintext"],
]);

/** Fence info (or a bare extension) → hljs language name; unknown words pass through as-is. */
export function resolveLanguage(info: string): string {
  const word = (info.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/^\.+/, "");
  return LANGUAGE_ALIASES.get(word) ?? word;
}

/** Whether `lang` (already resolved) gets syntax spans. Plaintext never does. */
const highlightable = (lang: string) => lang !== "" && lang !== "plaintext" && !!hljs.getLanguage(lang);

/** Escaped HTML for `source`: highlighted when `lang` (a fence word) is known, plain otherwise. */
export function highlight(source: string, lang: string): string {
  const resolved = resolveLanguage(lang);
  return highlightable(resolved) ? hljs.highlight(source, { language: resolved, ignoreIllegals: true }).value : esc(source);
}

/** Whole file names that say their language without an extension. */
const FILENAME_LANGUAGES = new Map<string, string>([
  ["dockerfile", "dockerfile"], ["containerfile", "dockerfile"],
  ["makefile", "makefile"], ["gnumakefile", "makefile"],
  ["cmakelists.txt", "cmake"],
  [".env", "ini"], [".gitconfig", "ini"], [".editorconfig", "ini"],
  [".bashrc", "bash"], [".zshrc", "bash"], [".profile", "bash"],
  [".gitignore", "plaintext"], [".dockerignore", "plaintext"],
]);

/** A file path → hljs language name, or "plaintext" when nothing better is known. */
export function languageForPath(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = FILENAME_LANGUAGES.get(base) ?? (base.startsWith(".env.") ? "ini" : base.startsWith("dockerfile.") ? "dockerfile" : undefined);
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  const lang = resolveLanguage(base.slice(dot + 1));
  return highlightable(lang) ? lang : "plaintext";
}

/** Highlights file content by its path. `lang` is "" when the result is plain escaped text. */
export function highlightByPath(source: string, path: string): { html: string; lang: string } {
  const lang = languageForPath(path);
  return highlightable(lang)
    ? { html: hljs.highlight(source, { language: lang, ignoreIllegals: true }).value, lang }
    : { html: esc(source), lang: "" };
}

/** Only these become links (§4e); anything else renders as its text. */
const LINKABLE = /^(https?:\/\/|mailto:)/i;
const EXTERNAL_NOTE = '<span class="visually-hidden"> (opens in a new tab)</span>';

interface RenderEnv {
  [key: string | symbol]: unknown;
  /** Raw source of each fenced block, by index, for Copy Code. */
  codes: string[];
  /** Index of a fence that is still open mid-stream: rendered plain, not highlighted. */
  openFence: number | null;
  /** Per link_open: whether it rendered (so link_close knows whether to close). */
  linkStack: boolean[];
  /** The row's /tmp image paths (TranscriptItem.attachments), shown as chips in prose. */
  paths?: Map<string, TmpAttachment>;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Parse every link and image so unsafe ones still render as their text (§4e: "renders as its
// link text, unlinked"). Safety comes from the renderers below, which emit an href/src only for
// http(s)/mailto links, remote-image links, and data:image thumbnails.
md.validateLink = () => true;

// GFM strikethrough as <del> (markdown-it emits <s>).
md.renderer.rules.s_open = () => "<del>";
md.renderer.rules.s_close = () => "</del>";

// ---- /tmp image paths in prose → chips (§4b "Path attachments") ------------------------
// Text tokens never hold code spans or fences, so a path in code stays text. Only paths the
// server listed for this row become chips.
md.renderer.rules.text = (tokens, idx, _opts, e) => {
  const content = tokens[idx]!.content;
  const paths = (e as unknown as RenderEnv).paths;
  if (!paths?.size) return esc(content);
  let html = "";
  let at = 0;
  for (const m of findTmpImagePaths(content)) {
    const a = paths.get(m.path);
    if (!a) continue;
    html += esc(content.slice(at, m.start)) + chipHtml(a);
    at = m.end;
  }
  return html + esc(content.slice(at));
};

// ---- Links -----------------------------------------------------------------------------
md.renderer.rules.link_open = (tokens, idx, _opts, e) => {
  const env = e as unknown as RenderEnv;
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  const ok = LINKABLE.test(href);
  env.linkStack.push(ok);
  return ok ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">` : "";
};
md.renderer.rules.link_close = (_tokens, _idx, _opts, e) => ((e as unknown as RenderEnv).linkStack.pop() ? `${EXTERNAL_NOTE}</a>` : "");

// ---- Images: never fetched remotely --------------------------------------------------------
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx]!;
  const src = String(t.attrGet("src") ?? "");
  const alt = t.content || "";
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) {
    const label = alt || "Image in this reply";
    return (
      `<ul class="message-images message-images-single" aria-label="1 image"><li>` +
      `<button class="thumb" type="button" aria-haspopup="dialog" data-md-image>` +
      `<img src="${esc(src)}" alt="${esc(label)}" loading="lazy" decoding="async"></button></li></ul>`
    );
  }
  if (/^https?:\/\//i.test(src)) {
    return (
      `<a class="md-image-link" href="${esc(src)}" target="_blank" rel="noreferrer noopener">` +
      `<span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>` +
      `Image: ${esc(alt || "untitled")}${EXTERNAL_NOTE}</a>`
    );
  }
  return esc(alt);
};

// ---- Tables scroll inside a wrapper, never widening the pane ----------------------------
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

// ---- Code blocks: head with language + Copy Code, highlight when known ------------------
const renderCode = (source: string, info: string, env: RenderEnv, plain: boolean) => {
  const label = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const lang = resolveLanguage(label);
  const index = env.codes.push(source) - 1;
  const known = !plain && highlightable(lang);
  const body = known ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value : esc(source);
  const cls = known ? ` class="hljs language-${esc(lang)}"` : "";
  return (
    `<div class="md-code"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(label || "text")}</span>` +
    `<button class="button button-sm button-ghost md-code-copy" type="button" data-code-index="${index}">` +
    `<span class="icon icon-sm" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>` +
    `<span class="md-code-copy-label">Copy Code</span></button></div>` +
    `<pre><code${cls}>${body}</code></pre></div>\n`
  );
};
let fenceCounter = 0;
md.renderer.rules.fence = (tokens, idx, _opts, e) => {
  const env = e as unknown as RenderEnv;
  const t = tokens[idx]!;
  const n = fenceCounter++;
  return renderCode(t.content, t.info, env, env.openFence === n);
};
md.renderer.rules.code_block = (tokens, idx, _opts, e) => renderCode(tokens[idx]!.content, "", e as unknown as RenderEnv, true);

// ---- Task lists: "[ ]" / "[x]" at the start of a list item → static checkbox -----------
md.core.ruler.after("inline", "task-lists", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]!;
    if (inline.type !== "inline" || tokens[i - 1]!.type !== "paragraph_open" || tokens[i - 2]!.type !== "list_item_open") continue;
    const first = inline.children?.[0];
    const m = first?.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
    inline.children!.unshift(box as Token);
  }
});

/** Opening fence lines (``` or ~~~, up to 3 spaces indent) that never got closed. */
function unclosedFence(text: string): { index: number; marker: string } | null {
  let open: { marker: string; index: number } | null = null;
  let count = 0;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (!open) {
      open = { marker: m[1]!, index: count++ };
    } else if (m[1]![0] === open.marker[0] && m[1]!.length >= open.marker.length && line.trim() === m[1]) {
      open = null;
    }
  }
  return open;
}

export interface RenderedMarkdown {
  html: string;
  /** Raw source of each code block, in order, for Copy Code. */
  codes: string[];
}

/**
 * Renders model markdown to safe HTML. `streaming`: an unclosed fence renders as an open code
 * block (a closing fence is appended for rendering only) and stays unhighlighted until it closes.
 */
export function renderMarkdown(text: string, streaming = false, attachments?: TmpAttachment[]): RenderedMarkdown {
  const env: RenderEnv = { codes: [], openFence: null, linkStack: [] };
  if (attachments?.length) env.paths = new Map(attachments.map((a) => [a.path, a]));
  let source = text;
  const open = streaming ? unclosedFence(text) : null;
  if (open) {
    source = `${text}${text.endsWith("\n") ? "" : "\n"}${open.marker}`;
    env.openFence = open.index;
  }
  fenceCounter = 0;
  return { html: md.render(source, env), codes: env.codes };
}
