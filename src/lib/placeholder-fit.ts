/**
 * Fitting a placeholder into its box.
 *
 * A placeholder is one line that may not fit: a composer's is a sentence plus a key hint
 * ("Steer the current turn… Enter sends"), and a phone's box is narrower than both together. It
 * may not wrap — the box would change height under the caret — and a `<textarea>` will not
 * ellipsize its own placeholder, so the string shown is chosen here from measured widths: the
 * whole string at the body size, the whole string at the caption size, the string without its
 * last part, that at the caption size, and last the string cut back to a whole word with an
 * ellipsis (§chat.composer/behavior; the group composer uses the same rule).
 *
 * The choice is pure — every width arrives as a callback — so the rule is testable without a
 * DOM. `fitPlaceholderNow` is the browser side of it, measuring the element's own font.
 */

/** The two sizes a placeholder may take: the body size, and one step down to `--fs-caption`. */
export type PlaceholderSize = "body" | "caption";

/** What a box shows: the string, and the size it is shown at. */
export type FittedPlaceholder = { text: string; size: PlaceholderSize };

export type FitInput = {
  /** The placeholder in reading order: the string itself, then the key hint. Empty parts drop. */
  parts: string[];
  /** What joins the parts when they are all shown, " " or "—". */
  join?: string;
  /** The width the box has for text, in px. */
  avail: number;
  /** The width of a string at a size, in px. */
  measure: (text: string, size: PlaceholderSize) => number;
};

/** The ellipsis a cut string ends in. */
const ELLIPSIS = "…";

/**
 * Slack under the measured width. A canvas measurement of a string is not the layout of that
 * string: half a pixel either way decides whether the last glyph is inside the box, so a string
 * that measures within one pixel of the box is treated as too wide and steps down instead —
 * cheaper than a clipped glyph, and invisible at these widths.
 */
const SLACK = 1;

/**
 * The placeholder to show in a box of `avail` px. The key hint is what goes first: it is the part
 * a narrow box can spare, so what a phone keeps is the whole sentence at full size rather than a
 * shrunken or half-said line.
 */
export function fitPlaceholder({ parts, join = " ", avail, measure }: FitInput): FittedPlaceholder {
  const kept = parts.filter((part) => part.length > 0);
  const fits = (text: string, size: PlaceholderSize) => measure(text, size) + SLACK <= avail;
  const whole = kept.join(join);
  if (fits(whole, "body")) return { text: whole, size: "body" };
  if (fits(whole, "caption")) return { text: whole, size: "caption" };
  // One part is the whole string, already known not to fit at either size.
  const main = kept[0] ?? "";
  if (kept.length > 1 && fits(main, "body")) return { text: main, size: "body" };
  if (kept.length > 1 && fits(main, "caption")) return { text: main, size: "caption" };
  return { text: ellipsize(main, avail, (text) => measure(text, "caption")), size: "caption" };
}

/**
 * The longest prefix of `text` that fits with an ellipsis, cut back to the last whole word when
 * that keeps at least half of what fits: "Ask all 4 members…" is worth more than "Ask all 4
 * memb…", and the ellipsis alone is the floor when nothing else is. A cut too early for a whole
 * word keeps its half word — half a word is still more than none.
 */
function ellipsize(text: string, avail: number, width: (text: string) => number): string {
  // trimEnd: a cut that lands just after a space reads "Ask all…", not "Ask all …".
  const cut = (n: number) => text.slice(0, n).trimEnd() + ELLIPSIS;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(cut(mid)) + SLACK <= avail) lo = mid;
    else hi = mid - 1;
  }
  const space = text.lastIndexOf(" ", lo);
  return cut(space > 0 && space >= Math.ceil(lo / 2) ? space : lo);
}

/** The text width inside an element: its content box, minus the padding the text avoids. */
export function innerTextWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

let context: CanvasRenderingContext2D | null = null;

/**
 * A measurer in an element's own fonts: its computed family and weight, at its own size and at
 * `--fs-caption`. Returns null where there is no canvas to measure with, which leaves the caller
 * showing the strings as written.
 */
export function placeholderMeasure(el: HTMLElement): FitInput["measure"] | null {
  const style = getComputedStyle(el);
  if (context === null) context = document.createElement("canvas").getContext("2d");
  if (context === null) return null;
  const canvas = context;
  const body = parseFloat(style.fontSize);
  // The caption the CSS will use; without the token there is nothing to step down to.
  const caption = parseFloat(style.getPropertyValue("--fs-caption")) || body;
  const font = (px: number) => `${style.fontWeight} ${px}px ${style.fontFamily}`;
  const widths = new Map<string, number>();
  return (text, size) => {
    const px = size === "caption" ? caption : body;
    const key = `${px}\u0000${text}`;
    const hit = widths.get(key);
    if (hit !== undefined) return hit;
    canvas.font = font(px);
    const width = canvas.measureText(text).width;
    widths.set(key, width);
    return width;
  };
}

/**
 * The fitted placeholder for an element's current strings, or null where they cannot be measured
 * (then the caller keeps them as they are).
 */
export function fitPlaceholderNow(el: HTMLElement, parts: string[], join = " "): FittedPlaceholder | null {
  const measure = placeholderMeasure(el);
  if (!measure) return null;
  return fitPlaceholder({ parts, join, avail: innerTextWidth(el), measure });
}
