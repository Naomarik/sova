// Highlighted HTML split into lines, and word marks nested inside its syntax spans.

import type { Range } from "./intraline";

const HTML_TOKEN = /<[^>]*>|&[#\w]+;|\n|[^<&\n]+|[<&]/g;

/**
 * Splits highlight.js output at its newlines, closing the open spans at each line end and reopening
 * them on the next line, so every line is well-formed on its own (a multi-line comment keeps its
 * colour on every line). Always returns one entry per line of the source.
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of html.matchAll(HTML_TOKEN)) {
    const t = m[0];
    if (t === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (t.startsWith("</")) {
      open.pop();
      cur += t;
    } else if (t.startsWith("<") && t.length > 1) {
      if (!t.endsWith("/>")) open.push(t);
      cur += t;
    } else cur += t;
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

/**
 * Wraps the characters of `ranges` (offsets into the line's TEXT, an entity counting as one) in
 * `<tag class="diff-word">`. A mark never spans a tag: it closes before one and reopens after,
 * so it nests inside the syntax spans and the HTML stays well-formed.
 */
export function markRanges(lineHtml: string, ranges: readonly Range[], tag: "ins" | "del"): string {
  if (ranges.length === 0) return lineHtml;
  const openTag = `<${tag} class="diff-word">`;
  const closeTag = `</${tag}>`;
  let out = "";
  let pos = 0;
  let r = 0;
  let marking = false;
  const inRange = () => {
    while (r < ranges.length && pos >= ranges[r]![1]) r++;
    return r < ranges.length && pos >= ranges[r]![0];
  };
  for (const m of lineHtml.matchAll(HTML_TOKEN)) {
    const t = m[0];
    if (t.startsWith("<") && t.length > 1) {
      if (marking) {
        out += closeTag;
        marking = false;
      }
      out += t;
      continue;
    }
    // Text: an entity is one character; a run is walked a character (code unit) at a time.
    const chars = t.startsWith("&") && t.length > 1 ? [t] : [...t];
    for (const c of chars) {
      const want = inRange();
      if (want && !marking) out += openTag;
      else if (!want && marking) out += closeTag;
      marking = want;
      out += c;
      pos += c.length === 1 || c.startsWith("&") ? 1 : c.length;
    }
  }
  if (marking) out += closeTag;
  return out;
}
