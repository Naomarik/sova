/** `vis timeline`: `when | label | note | tone` rows and `== section ==` lines. */

import { applyMarks, takeMarks } from "../../core/emphasis";
import { divider, fail, fields, hasBar, lines, notATone, popTone, swapToneNote, tableRow, takeSettings, text, type Tone, type VisBase } from "../../core/grammar";

export type TimelineItem = { type: "event"; when: string; label: string; note?: string; tone?: Tone } | { type: "section"; label: string };
export interface TimelineSpec extends VisBase {
  kind: "timeline";
  items: TimelineItem[];
}

const MAX_ROWS = 40;


/** A row without `|`: split once at its first `: `, or at ` — `, ` – ` or ` - ` (twice: when, label, note). */
function noBar(t: string, n: number): string[] {
  const colon = /^(.+?):\s+(.+)$/.exec(t);
  const dash = /\s[—–-]\s/.exec(t);
  if (colon && (!dash || colon.index + colon[1]!.length < dash.index)) return [colon[1]!.trim(), colon[2]!.trim()].map((f) => text(f, n));
  if (!dash) return [t];
  const parts = t.split(/\s[—–-]\s/);
  return [parts[0]!, parts[1]!, ...(parts.length > 2 ? [parts.slice(2).join(" — ")] : [])].map((f) => text(f.trim(), n));
}

export function parseTimeline(body: string): TimelineSpec {
  const ls = lines(body);
  const spec: TimelineSpec = { kind: "timeline", items: [] };
  const { rest: settled } = takeSettings(ls, [], spec, { caseless: true });
  const { rest, marks } = takeMarks(settled, { indented: true });
  for (const written of rest) {
    const div = divider(written);
    if (div !== null) {
      spec.items.push({ type: "section", label: div });
      continue;
    }
    // A Markdown table's row (`| 2013 | React |`); its `|---|` rule is skipped.
    const line = tableRow(written);
    if (!line) continue;
    // No `|` at all: `2013: React`, `2013 — React — note` (§chat.markdown/vis-lenience-content).
    const fs = hasBar(line.text) ? fields(line) : noBar(line.text, line.n);
    swapToneNote(fs, 4);
    const tone = popTone(fs);
    const shape = "a row is: when | label | note (optional) | tone (optional)";
    if (fs.length < 2 || fs.length > 3) fail(line.n, notATone(fs, 4, shape) ?? shape);
    const [when, label, note] = fs as [string, string, string | undefined];
    if (!when || !label) fail(line.n, "when and label can't be empty");
    spec.items.push({ type: "event", when, label, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
  }
  const events = spec.items.filter((i) => i.type === "event").length;
  if (events === 0) fail(0, "nothing to draw: add rows like 2015 | React 0.14 | note");
  if (spec.items.length > MAX_ROWS) fail(0, `${spec.items.length} rows; at most ${MAX_ROWS}`);
  applyMarks(spec, marks, (t) => {
    if (t.t !== "id" && t.t !== "label" && t.t !== "number") return null;
    const i = spec.items.findIndex((it) => it.type === "event" && (it.when === t.text || it.label === t.text));
    return i < 0 ? null : String(i);
  }, "row");
  return spec;
}
