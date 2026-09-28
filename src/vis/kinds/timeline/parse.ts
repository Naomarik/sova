/** `vis timeline`: `when | label | note | tone` rows and `== section ==` lines. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export type TimelineItem = { type: "event"; when: string; label: string; note?: string; tone?: Tone } | { type: "section"; label: string };
export interface TimelineSpec extends VisBase {
  kind: "timeline";
  items: TimelineItem[];
}


const MAX_ROWS = 40;

// ---- timeline ----------------------------------------------------------------------------

export function parseTimeline(body: string): TimelineSpec {
  const ls = lines(body);
  const spec: TimelineSpec = { kind: "timeline", items: [] };
  const { rest } = takeSettings(ls, [], spec);
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      spec.items.push({ type: "section", label: div });
      continue;
    }
    const fs = fields(line);
    const tone = popTone(fs);
    if (fs.length < 2 || fs.length > 3) fail(line.n, "a row is: when | label | note (optional) | tone (optional)");
    const [when, label, note] = fs as [string, string, string | undefined];
    if (!when || !label) fail(line.n, "when and label can't be empty");
    spec.items.push({ type: "event", when, label, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
  }
  const events = spec.items.filter((i) => i.type === "event").length;
  if (events === 0) fail(0, "nothing to draw: add rows like 2015 | React 0.14 | note");
  if (spec.items.length > MAX_ROWS) fail(0, `${spec.items.length} rows; at most ${MAX_ROWS}`);
  return spec;
}
