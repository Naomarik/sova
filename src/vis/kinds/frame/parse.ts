/**
 * `vis html` / `vis svg`: the free-form fallback. Model-written documents, kept verbatim for the
 * sandboxed frame (srcdoc.ts). Limits: a source budget in characters (aim under 8K, drawn with a
 * warning up to 16K, over that the source is shown), and no autoplay — the frame holds
 * every animation until the reader's first click or key press (srcdoc.ts's motion gate). Leading
 * `title:` / `caption:` lines are ours; `mark` lines don't apply here.
 */

import { fail, text, warn, type VisBase } from "../../core/grammar";

export interface FrameSpec extends VisBase {
  kind: "html" | "svg";
  source: string;
}
/**
 * The free-form budget, in characters (code points) of the document after the title/caption lines:
 * small enough to read in Source, and to keep the model from writing an app. Over the soft budget
 * the figure still draws, with a "large" warning; over the hard one it is an error.
 */
export const FRAME_SOFT_CHARS = 8 * 1024;
export const FRAME_HARD_CHARS = 16 * 1024;
const kilo = (n: number) => `${(n / 1024).toFixed(1).replace(/\.0$/, "")}K`;

function parseFrameBody(kind: "html" | "svg", body: string): FrameSpec {
  const spec: FrameSpec = { kind, source: body };
  // Leading title:/caption: lines are ours; the rest is the document.
  const all = body.split("\n");
  let k = 0;
  while (k < all.length) {
    const t = all[k]!.trim();
    const m = /^(title|caption):\s+(.*)$/.exec(t);
    if (t === "") {
      k++;
      continue;
    }
    if (!m) break;
    spec[m[1] as "title" | "caption"] = text(m[2]!.replace(/^"(.*)"$/, "$1"), k + 1);
    k++;
  }
  spec.source = all.slice(k).join("\n").trim();
  if (!spec.source) fail(0, `empty ${kind}`);
  const chars = [...spec.source].length;
  if (chars > FRAME_HARD_CHARS) fail(0, `${kilo(chars)} characters of ${kind}; at most ${kilo(FRAME_HARD_CHARS)} (aim under ${kilo(FRAME_SOFT_CHARS)}): draw less, or use a structured kind`);
  if (chars > FRAME_SOFT_CHARS) warn(0, `large: ${kilo(chars)} characters of ${kind} (aim under ${kilo(FRAME_SOFT_CHARS)})`);
  if (kind === "svg" && !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(spec.source)) fail(k + 1, "vis svg must start with <svg");
  return spec;
}

export const parseHtml = (body: string) => parseFrameBody("html", body);
export const parseSvg = (body: string) => parseFrameBody("svg", body);
