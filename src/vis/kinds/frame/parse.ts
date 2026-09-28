/** `vis html` / `vis svg`: model-written documents, kept verbatim for the sandboxed frame. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface FrameSpec extends VisBase {
  kind: "html" | "svg";
  source: string;
}


const MAX_BYTES = 80_000;

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
  if (new TextEncoder().encode(spec.source).length > MAX_BYTES) fail(0, `more than ${MAX_BYTES / 1000} kB of ${kind}`);
  if (kind === "svg" && !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(spec.source)) fail(k + 1, "vis svg must start with <svg");
  return spec;
}

export const parseHtml = (body: string) => parseFrameBody("html", body);
export const parseSvg = (body: string) => parseFrameBody("svg", body);
