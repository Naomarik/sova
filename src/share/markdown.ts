import MarkdownIt from "markdown-it";
import { unclosedFence } from "../lib/fences";
import type { VisBase } from "../vis/core/grammar";
import { parseVis, visKindWord } from "../vis/parse";
import { canonicalKind } from "../vis/registry";

// The share page's renderer: plain CommonMark, raw HTML off (markdown-it escapes it), links
// autodetected. Nothing of the operator app's renderer (session links, path chips, highlighting):
// a reply here is prose for a person, and every link opens outside the page with no referrer.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer nofollow");
  return defaultLink(tokens, idx, options, env, self);
};
// No images: a reply could otherwise make the reader's browser fetch any URL.
md.disable("image");

/** The drawings a share or owner page draws (§app.baton/outsider-view): the business kinds. */
export const SHARE_VIS_KINDS: ReadonlySet<string> = new Set(["flow", "chart", "matrix", "timeline", "tree", "steps", "wireframe", "layers"]);
export const BROKEN_DRAWING = "A drawing couldn't be shown here.";

/** The drawings a session share draws (§app/session-share/content): the business kinds plus the
    technical ones that draw safely under the share page's CSP. `svg` draws as an image (no script,
    no network); `code` and `html` show as their source, since the highlighter isn't in this build
    and the page's CSP runs no frame's script. */
export const SESSION_VIS_KINDS: ShareVisKinds = {
  drawn: new Set([...SHARE_VIS_KINDS, "sequence", "state"]),
  image: new Set(["svg"]),
  source: new Set(["code", "html"]),
};
/** Which fences a page draws: `drawn` mounts a figure, `image` draws an svg as an <img>, `source`
    shows the parsed document as escaped text. Any other kind is the one quiet line. */
export interface ShareVisKinds {
  drawn: ReadonlySet<string>;
  image?: ReadonlySet<string>;
  source?: ReadonlySet<string>;
}
const BATON_KINDS: ShareVisKinds = { drawn: SHARE_VIS_KINDS };
const SOURCE_CAPTION: Record<string, string> = { html: "An interactive drawing, shown as its source.", code: "Code" };

export interface ShareVisual {
  kind: string;
  spec: VisBase;
}
interface Env {
  kinds: ShareVisKinds;
  visuals: ShareVisual[];
  openFence: number | null;
  fences: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** FNV-1a, hex: a placeholder's identity, so an unchanged drawing survives a streaming frame. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// A `vis` fence of a kind drawn here becomes a placeholder the page mounts the figure into. Any
// other kind, and one that doesn't parse, is one quiet line: never its source, which to the person
// is code-like junk. Still open while the reply streams: the chat's "Drawing…" box.
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, e, self) => {
  const env = e as unknown as Env;
  const t = tokens[idx]!;
  const n = env.fences++;
  let kind = visKindWord(t.info);
  if (kind === null) return defaultFence(tokens, idx, options, e, self);
  if (env.openFence === n) {
    const lines = t.content.split("\n").length - 1;
    return `<div class="md-vis-pending"><p class="md-vis-pending-line"><span class="md-vis-pending-dot" aria-hidden="true"></span>Drawing ${esc(kind || "a visual")}… <span class="md-vis-pending-count">${lines} ${lines === 1 ? "line" : "lines"}</span></p></div>\n`;
  }
  const { drawn, image, source } = env.kinds;
  // The word as written parses (an alias reads as its kind); the kind it draws as decides the rest.
  const word = kind;
  kind = canonicalKind(word);
  const r = drawn.has(kind) || image?.has(kind) || source?.has(kind) ? parseVis(word, t.content) : null;
  if (!r?.ok) return `<p class="share-vis-broken">${BROKEN_DRAWING}</p>\n`;
  const title = (r.spec as { title?: string }).title;
  if (image?.has(kind)) {
    const svg = (r.spec as unknown as { source: string }).source;
    const alt = esc(title ?? "A drawing");
    return `<figure class="share-vis-image">${title ? `<figcaption class="share-vis-caption">${esc(title)}</figcaption>` : ""}<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" alt="${alt}"></figure>\n`;
  }
  if (source?.has(kind)) {
    const spec = r.spec as unknown as { source?: string; lines?: string[] };
    const text = spec.lines ? spec.lines.join("\n") : (spec.source ?? "");
    const caption = title ?? SOURCE_CAPTION[kind] ?? "Source";
    return `<figure class="share-vis-source"><figcaption class="share-vis-caption">${esc(caption)}</figcaption><pre><code>${esc(text)}</code></pre></figure>\n`;
  }
  const i = env.visuals.push({ kind, spec: r.spec }) - 1;
  return `<div class="md-vis" data-vis="${i}" data-vis-key="${hash(`${kind}\0${t.content}`)}"></div>\n`;
};

/** `streaming`: the reply is still being written, so an unclosed fence is one still open.
    `kinds`: the fences drawn (the business kinds unless a page says otherwise). */
export function renderShareMarkdown(text: string, streaming = false, kinds: ShareVisKinds = BATON_KINDS): { html: string; visuals: ShareVisual[] } {
  const env: Env = { kinds, visuals: [], openFence: null, fences: 0 };
  const open = streaming ? unclosedFence(text) : null;
  let source = text;
  if (open) {
    source = `${text}${text.endsWith("\n") ? "" : "\n"}${open.marker}`;
    env.openFence = open.index;
  }
  return { html: md.render(source, env as unknown as Record<string, unknown>), visuals: env.visuals };
}
