// Markdown for assistant-text. markdown-it with html:false, so any HTML in
// model output is escaped text, never rendered. Every tag we emit ourselves is built from
// escaped parts. highlight.js runs on its `common` set plus a few extras, never auto-detect.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import hljs from "highlight.js/lib/common";
import type { TmpAttachment } from "../../shared/protocol";
import { findTmpImagePaths } from "../../shared/tmp-paths";
import { chipHtml } from "./path-attachments";
import { groupLinkIndex, resolveAppLink, sessionIndex } from "./session-links";
import type { VisBase } from "../vis/core/grammar";
import { parseVis, visKindWord, type ParseResult } from "../vis/parse";
import { canonicalKind } from "../vis/registry";
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
import { unclosedFence } from "./fences";

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

/** Only these become links; anything else renders as its text. */
const LINKABLE = /^(https?:\/\/|mailto:)/i;
const EXTERNAL_NOTE = '<span class="visually-hidden"> (opens in a new tab)</span>';

interface RenderEnv {
  [key: string | symbol]: unknown;
  /** Raw source of each fenced block, by index, for Copy Code. */
  codes: string[];
  /** Index of a fence that is still open mid-stream: rendered plain, not highlighted. */
  openFence: number | null;
  /** Per link_open: what it rendered (so link_close knows how to close). */
  linkStack: LinkKind[];
  /** The row's /tmp image paths (TranscriptItem.attachments), shown as chips in prose. */
  paths?: Map<string, TmpAttachment>;
  /** Parsed `vis` fences, by the index in their placeholder's data-vis. */
  visuals: RenderedVisual[];
}

/** A `vis` fence that parsed: what the Markdown component mounts into `<div data-vis=i>`. */
export interface RenderedVisual {
  /** The fence's kind word (a key of vis/registry.ts KINDS). */
  kind: string;
  spec: VisBase;
  /** The fence as written, for Copy. */
  fence: string;
  /** Its body, for Source. */
  body: string;
}

/** An external link, an in-app one (same tab, no external note), or nothing. */
type LinkKind = "external" | "internal" | false;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
// A bare `sova://s/<id>` or `sova://g/<id>[/s/<id>]` in prose is an in-app link too (src/lib/session-links.ts).
md.linkify.add("sova:", {
  validate: (text, pos) => /^\/\/(?:s\/[A-Za-z0-9_.:-]+|g\/[A-Za-z0-9_.:-]+(?:\/s\/[A-Za-z0-9_.:-]+)?)/.exec(text.slice(pos))?.[0].length ?? 0,
});

// Parse every link and image so unsafe ones still render as their text ("renders as its
// link text, unlinked"). Safety comes from the renderers below, which emit an href/src only for
// http(s)/mailto links, remote-image links, and data:image thumbnails.
md.validateLink = () => true;

// GFM strikethrough as <del> (markdown-it emits <s>).
md.renderer.rules.s_open = () => "<del>";
md.renderer.rules.s_close = () => "</del>";

// ---- /tmp image paths in prose → chips ------------------------
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
  // In-app links first: a session link or a `#/` route opens in this tab.
  const app = resolveAppLink(href, sessionIndex(), groupLinkIndex());
  if (app?.kind === "text") {
    env.linkStack.push(false);
    return "";
  }
  if (app) {
    env.linkStack.push("internal");
    // A bare `sova://…` in prose reads as the session's (or group's) title, not its id.
    const text = tokens[idx + 1];
    if (tokens[idx]!.markup === "linkify" && app.title && text?.type === "text") text.content = app.title;
    return `<a class="md-app-link" href="${esc(app.href)}"${app.title ? ` title="${esc(app.title)}"` : ""}>`;
  }
  const ok = LINKABLE.test(href);
  env.linkStack.push(ok && "external");
  return ok ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">` : "";
};
md.renderer.rules.link_close = (_tokens, _idx, _opts, e) => {
  const kind = (e as unknown as RenderEnv).linkStack.pop();
  if (kind === "external") return `${EXTERNAL_NOTE}</a>`;
  if (kind === "internal") return "</a>";
  return "";
};

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
const renderCode = (source: string, info: string, env: RenderEnv, plain: boolean, head?: string, extra = "") => {
  const label = head ?? info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const lang = resolveLanguage(label);
  const index = env.codes.push(source) - 1;
  const known = !plain && highlightable(lang);
  const body = known ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value : esc(source);
  const cls = known ? ` class="hljs language-${esc(lang)}"` : "";
  return (
    `<div class="md-code${extra}"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(label || "text")}</span>` +
    `<button class="button button-sm button-ghost md-code-copy" type="button" data-code-index="${index}">` +
    `<span class="icon icon-sm" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>` +
    `<span class="md-code-copy-label">Copy Code</span></button></div>` +
    `<pre><code${cls}>${body}</code></pre></div>\n`
  );
};
// ---- Visuals: `vis <kind>` fences ---------------------------------------------------------
// A closed fence that parses becomes a placeholder the Markdown component mounts a drawing into;
// one that doesn't is the ordinary code block plus one line saying why. A fence still open
// mid-stream is a quiet "Drawing" line: half a diagram is never drawn.
const visCache = new Map<string, ParseResult>();
/** FNV-1a, hex: a placeholder's identity. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
function parseCached(kind: string, body: string): ParseResult {
  const key = `${kind}\0${body}`;
  let r = visCache.get(key);
  if (!r) {
    r = parseVis(kind, body);
    if (visCache.size > 200) visCache.clear();
    visCache.set(key, r);
  }
  return r;
}
const renderVis = (t: { content: string; info: string; markup: string }, kind: string, env: RenderEnv, open: boolean) => {
  if (open) {
    const lines = t.content.split("\n").length - 1;
    // A fixed-height box, not a one-line note: the drawing that replaces it is usually about this
    // tall, so the text streaming in below it doesn't leap when the fence closes.
    return `<div class="md-vis-pending"><p class="md-vis-pending-line"><span class="md-vis-pending-dot" aria-hidden="true"></span>Drawing ${esc(kind || "a visual")}… <span class="md-vis-pending-count">${lines} ${lines === 1 ? "line" : "lines"}</span></p></div>\n`;
  }
  const r = parseCached(kind, t.content);
  if (!r.ok) {
    const where = r.line > 0 ? `line ${r.line}: ` : "";
    return renderCode(t.content, t.info, env, true, kind ? `vis ${kind}` : "vis", " md-vis-source") + `<p class="md-vis-error">Couldn't draw this ${esc(kind ? `vis ${kind}` : "vis")} block (${esc(where + r.message)}), so here is its source.</p>\n`;
  }
  const fence = `${t.markup}${t.info}\n${t.content}${t.markup}`;
  // An alias (`vis flowchart`) mounts its kind's View.
  const i = env.visuals.push({ kind: canonicalKind(kind), spec: r.spec, fence, body: t.content }) - 1;
  // The key changes with the content, so a re-render never keeps a drawing of an older text.
  return `<div class="md-vis" data-vis="${i}" data-vis-key="${hash(fence)}"></div>\n`;
};

let fenceCounter = 0;
md.renderer.rules.fence = (tokens, idx, _opts, e) => {
  const env = e as unknown as RenderEnv;
  const t = tokens[idx]!;
  const n = fenceCounter++;
  const kind = visKindWord(t.info);
  if (kind !== null) return renderVis(t, kind, env, env.openFence === n);
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


export interface RenderedMarkdown {
  html: string;
  /** Raw source of each code block, in order, for Copy Code. */
  codes: string[];
  /** Parsed `vis` fences, by placeholder index. */
  visuals: RenderedVisual[];
}

/**
 * Renders model markdown to safe HTML. `streaming`: an unclosed fence renders as an open code
 * block (a closing fence is appended for rendering only) and stays unhighlighted until it closes.
 */
export function renderMarkdown(text: string, streaming = false, attachments?: TmpAttachment[]): RenderedMarkdown {
  const env: RenderEnv = { codes: [], openFence: null, linkStack: [], visuals: [] };
  if (attachments?.length) env.paths = new Map(attachments.map((a) => [a.path, a]));
  let source = text;
  const open = streaming ? unclosedFence(text) : null;
  if (open) {
    source = `${text}${text.endsWith("\n") ? "" : "\n"}${open.marker}`;
    env.openFence = open.index;
  }
  fenceCounter = 0;
  return { html: md.render(source, env), codes: env.codes, visuals: env.visuals };
}
