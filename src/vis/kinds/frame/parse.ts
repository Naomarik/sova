/**
 * `vis html` / `vis svg`: the free-form fallback. Model-written documents, kept verbatim for the
 * sandboxed frame (srcdoc.ts). Limits: at most 8 KB of source, and no autoplay — the frame holds
 * every animation until the reader's first click or key press (srcdoc.ts's motion gate). Leading
 * `title:` / `caption:` lines are ours; `mark` lines don't apply here.
 */

import { fail, text, type VisBase } from "../../core/grammar";

export interface FrameSpec extends VisBase {
  kind: "html" | "svg";
  source: string;
}
/** The free-form budget: small enough to read in Source, and to keep the model from writing an app. */
export const MAX_FRAME_BYTES = 8 * 1024;

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
  const bytes = new TextEncoder().encode(spec.source).length;
  if (bytes > MAX_FRAME_BYTES) fail(0, `${(bytes / 1024).toFixed(1)} KB of ${kind}; at most 8 KB: draw less, or use a structured kind`);
  if (kind === "svg" && !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(spec.source)) fail(k + 1, "vis svg must start with <svg");
  return spec;
}

export const parseHtml = (body: string) => parseFrameBody("html", body);
export const parseSvg = (body: string) => parseFrameBody("svg", body);
