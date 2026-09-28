/** `vis stack`: layers top to bottom, `label | item, item | note | tone`. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface StackLayer {
  label: string;
  items: string[];
  note?: string;
  tone?: Tone;
}
export interface StackSpec extends VisBase {
  kind: "stack";
  layers: StackLayer[];
}


const MAX_LAYERS = 10;
const MAX_ITEMS = 12;

// ---- stack -------------------------------------------------------------------------------

export function parseStack(body: string): StackSpec {
  const ls = lines(body);
  const spec: StackSpec = { kind: "stack", layers: [] };
  const { rest } = takeSettings(ls, [], spec);
  for (const line of rest) {
    const fs = fields(line);
    const tone = popTone(fs);
    if (fs.length < 2 || fs.length > 3) fail(line.n, "a layer is: label | item, item, … | note (optional) | tone (optional)");
    const [label, items, note] = fs as [string, string, string | undefined];
    if (!label) fail(line.n, "empty layer label");
    const list = items ? commaList(items, line.n) : [];
    if (list.length > MAX_ITEMS) fail(line.n, `${list.length} items; at most ${MAX_ITEMS}`);
    spec.layers.push({ label, items: list, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
  }
  if (spec.layers.length === 0) fail(0, "nothing to draw: add layers like Server | Hono, ws");
  if (spec.layers.length > MAX_LAYERS) fail(0, `${spec.layers.length} layers; at most ${MAX_LAYERS}`);
  return spec;
}
