// Explicit http(s) addresses in the share page's plain text (§app.baton/outsider-view): split into
// text and link segments the page renders as DOM nodes, never as HTML. Built on markdown-it's own
// linkify-it (the one the replies' renderer uses), so both find the same addresses. Pure, so it
// runs under tsx --test.

import MarkdownIt from "markdown-it";

const linkify = new MarkdownIt({ linkify: true }).linkify;
// Only addresses written with their scheme: no bare "www.x.com", no e-mail addresses.
linkify.set({ fuzzyLink: false, fuzzyEmail: false });

export type LinkSegment = { text: string } | { href: string; text: string };

/** http: and https: only, checked on the parsed address as well as on linkify-it's own schema. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function linkSegments(text: string): LinkSegment[] {
  const matches = linkify.match(text) ?? [];
  const out: LinkSegment[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.schema !== "http:" && m.schema !== "https:") continue;
    const href = safeHref(m.url);
    if (!href) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ href, text: m.text });
    at = m.lastIndex;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) });
  return out;
}
