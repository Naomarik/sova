/**
 * Split highlight.js output into one HTML string per source line. hljs highlights the whole
 * snippet at once (so a block comment or template string spanning lines keeps its colour), and its
 * spans can cross a newline: each line closes the spans still open at its end and the next line
 * reopens them. hljs output is only `<span class="…">`, `</span>` and escaped text, so a tag scan
 * is exact.
 */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  const re = /<span[^>]*>|<\/span>|[^<\n]+|\n|</g;
  for (const m of html.matchAll(re)) {
    const t = m[0];
    if (t === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (t.startsWith("<span")) open.push(t);
      else if (t === "</span>") open.pop();
      line += t;
    }
  }
  out.push(line);
  return out;
}
