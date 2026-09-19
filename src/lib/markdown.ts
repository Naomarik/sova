// Markdown for assistant-text (DESIGN_NOTES §4e). markdown-it with html:false, so any HTML in
// model output is escaped text, never rendered. Every tag we emit ourselves is built from
// escaped parts. highlight.js runs on a curated language set, never auto-detect.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml); // also html, svg
hljs.registerLanguage("yaml", yaml);
// tsx/jsx highlight as TypeScript/JavaScript; the xml language covers embedded markup.
hljs.registerAliases(["tsx"], { languageName: "typescript" });
hljs.registerAliases(["jsx"], { languageName: "javascript" });

const esc = (s: string) => MarkdownIt().utils.escapeHtml(s);

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
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Parse every link and image so unsafe ones still render as their text (§4e: "renders as its
// link text, unlinked"). Safety comes from the renderers below, which emit an href/src only for
// http(s)/mailto links, remote-image links, and data:image thumbnails.
md.validateLink = () => true;

// GFM strikethrough as <del> (markdown-it emits <s>).
md.renderer.rules.s_open = () => "<del>";
md.renderer.rules.s_close = () => "</del>";

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
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const index = env.codes.push(source) - 1;
  const known = !plain && lang !== "" && !!hljs.getLanguage(lang);
  const body = known ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value : esc(source);
  const cls = known ? ` class="hljs language-${esc(lang)}"` : "";
  return (
    `<div class="md-code"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(lang || "text")}</span>` +
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
export function renderMarkdown(text: string, streaming = false): RenderedMarkdown {
  const env: RenderEnv = { codes: [], openFence: null, linkStack: [] };
  let source = text;
  const open = streaming ? unclosedFence(text) : null;
  if (open) {
    source = `${text}${text.endsWith("\n") ? "" : "\n"}${open.marker}`;
    env.openFence = open.index;
  }
  fenceCounter = 0;
  return { html: md.render(source, env), codes: env.codes };
}
