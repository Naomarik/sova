/** `vis layers`: layers top to bottom, `label | item, item | note | tone`. */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { commaList, fail, hasBar, lines, notATone, popTone, swapToneNote, tableRow, takeSettings, text, unquote, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface Layer {
  label: string;
  items: string[];
  note?: string;
  tone?: Tone;
}
export interface LayersSpec extends VisBase {
  kind: "layers";
  layers: Layer[];
}

const MAX_LAYERS = 10;
const MAX_ITEMS = 12;

/** The `|` fields as written (trimmed, `\|` kept as `|`), quotes and all. */
function rawFields(line: Line): string[] {
  const parts: string[] = [];
  let cur = "";
  const s = line.text;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      parts.push(cur);
      cur = "";
    } else cur += s[i];
  }
  parts.push(cur);
  return parts.map((p) => text(p.trim(), line.n));
}

/** A label or note loses its quotes only when it is one whole quoted string. */
const whole = (t: string, n: number) => text(/^"(?:[^"\\]|\\.)*"$/.test(t) ? unquote(t.slice(1, -1)) : t, n);

export function parseLayers(body: string): LayersSpec {
  const ls = lines(body);
  const spec: LayersSpec = { kind: "layers", layers: [] };
  const { rest: settled } = takeSettings(ls, [], spec, { caseless: true });
  const { rest, marks } = takeMarks(settled, { indented: true });
  for (const written of rest) {
    // A Markdown table's row (`| Server | Hono |`); its `|---|` rule is skipped.
    const line = tableRow(written);
    if (!line) continue;
    // No `|` but a `: `: `Browser: React, Redux` is `Browser | React, Redux`.
    const colon = hasBar(line.text) ? null : /^([^:]+?):\s+(.+)$/.exec(line.text);
    const fs = colon ? [text(colon[1]!.trim(), line.n), text(colon[2]!.trim(), line.n)] : rawFields(line);
    swapToneNote(fs, 4);
    const tone = popTone(fs);
    const shape = "a layer is: label | item, item, … | note (optional) | tone (optional)";
    if (fs.length < 2 || fs.length > 3) fail(line.n, notATone(fs, 4, shape) ?? shape);
    const [rawLabel, items, rawNote] = fs as [string, string, string | undefined];
    const label = whole(rawLabel, line.n);
    const note = rawNote === undefined ? undefined : whole(rawNote, line.n);
    if (!label) fail(line.n, "empty layer label");
    // The items stay as written, so commaList sees each item's own quotes: `"a, b", "c"`.
    const list = items ? commaList(items, line.n) : [];
    if (list.length > MAX_ITEMS) fail(line.n, `${list.length} items; at most ${MAX_ITEMS}`);
    spec.layers.push({ label, items: list, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
  }
  if (spec.layers.length === 0) fail(0, "nothing to draw: add layers like Server | Hono, ws");
  if (spec.layers.length > MAX_LAYERS) fail(0, `${spec.layers.length} layers; at most ${MAX_LAYERS}`);
  applyMarks(spec, marks, byIdOrLabel(spec.layers.map((l, i) => ({ key: String(i), label: l.label }))), "layer");
  return spec;
}
