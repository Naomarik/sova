/**
 * A `vis svg` drawn as a still image (share and owner pages, the Share sheet's Preview): the parsed
 * document as an `<img>`'s data URL, never in the page's DOM, so none of its script runs and it
 * fetches nothing. Before encoding, the page's colour tokens and the frame's font become the
 * drawing's defaults, so it reads as the chat's frame draws it. DOM-free: the View passes the tokens
 * in; tests run it as is.
 */

/** The font the chat's frame draws text in (srcdoc.ts's body). An image can't load Inter, so a
    machine without it gets the system sans-serif. */
export const SVG_IMAGE_FONT = `Inter,system-ui,-apple-system,"Segoe UI",sans-serif`;

// The root tag: `<?xml …?>` allowed before it, attribute values may hold `>`.
const ROOT = /^(\s*(?:<\?xml[^>]*\?>\s*)?)<svg((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/i;

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/** The width an svg draws at: its viewBox's width when it has no `width` of its own, else none
    (the image's own size rules). */
export function svgNaturalWidth(svg: string): number | undefined {
  const m = ROOT.exec(svg);
  if (!m || attr(m[2]!, "width") !== undefined) return undefined;
  const box = attr(m[2]!, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  const w = box?.length === 4 ? box[2]! : NaN;
  return Number.isFinite(w) && w > 0 ? w : undefined;
}

/** The defaults put first in the drawing: the tokens (`tokens`, tokenCss's `:root{…}`), and a font,
    size and text colour for a root that doesn't set its own. Zero specificity, so the drawing's own
    `<style>` and attributes win. */
export const svgDefaultsCss = (tokens: string): string =>
  `${tokens}:where(svg:not([font-family])){font-family:${SVG_IMAGE_FONT}}:where(svg:not([font-size])){font-size:14px}:where(svg:not([color])){color:var(--color-ink)}`;

/**
 * The document the image shows: `svg` with its namespace (else the image is broken) and a first
 * `<style>` of `svgDefaultsCss(tokens)`. `tokens` must hold no `<` or `&` (tokenCss filters values).
 * A document whose root tag this can't read is returned with only its namespace added: it draws as
 * the browser can.
 */
export function svgImageDocument(svg: string, tokens: string): string {
  const css = svgDefaultsCss(tokens).replace(/[<&]/g, "");
  const m = ROOT.exec(svg);
  if (!m) return svg;
  let attrs = m[2]!;
  if (!/\sxmlns\s*=/.test(attrs)) attrs = ` xmlns="http://www.w3.org/2000/svg"${attrs}`;
  const style = `<style>${css}</style>`;
  const open = `${m[1]}<svg${attrs}>${style}`;
  return m[3] ? `${open}</svg>${svg.slice(m[0].length)}` : `${open}${svg.slice(m[0].length)}`;
}

/** The `<img>` source for a drawing: the document above as a data URL. */
export const svgImageSrc = (svg: string, tokens: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageDocument(svg, tokens))}`;
