/**
 * `vis code`: an annotated snippet. Settings and `mark` lines first, then a line that is exactly
 * `---`, then the code verbatim (nothing after `---` is parsed: `#` and `mark` there are code).
 * Marks target line numbers or ranges, as displayed: numbering starts at `start:` (default 1).
 *
 *   lang: ts
 *   start: 40
 *   mark 42 "the off-by-one"
 *   mark 44-46 warn "runs once per key"
 *   ---
 *   <code>
 */

import { applyMarks, takeMarks } from "../../core/emphasis";
import { fail, lines, takeSettings, type VisBase } from "../../core/grammar";

export interface CodeSpec extends VisBase {
  kind: "code";
  /** The fence-style language word for highlighting, e.g. "ts"; absent = plain. */
  lang?: string;
  /** The displayed number of the first line. */
  start: number;
  lines: string[];
}

const MAX_LINES = 60;

export function parseCode(body: string): CodeSpec {
  const all = body.replace(/\n$/, "").split("\n");
  const sep = all.findIndex((l) => l.trim() === "---");
  if (sep < 0) fail(0, "put a line with just --- between the settings and marks and the code");
  const spec: CodeSpec = { kind: "code", start: 1, lines: all.slice(sep + 1) };
  const { rest: settled, values } = takeSettings(lines(all.slice(0, sep).join("\n")), ["lang", "start"], spec);
  const { rest, marks } = takeMarks(settled);
  if (rest.length) fail(rest[0]!.n, "before --- only settings (title: caption: lang: start:) and mark lines");
  const lang = values.get("lang");
  if (lang) {
    if (!/^[a-z0-9+#.-]{1,20}$/i.test(lang.value)) fail(lang.n, `lang: is one word like ts, py, rust`);
    spec.lang = lang.value.toLowerCase();
  }
  const start = values.get("start");
  if (start) {
    if (!/^\d{1,6}$/.test(start.value)) fail(start.n, "start: is the first line's number, e.g. start: 40");
    spec.start = Number(start.value);
  }
  while (spec.lines.length && spec.lines[spec.lines.length - 1]!.trim() === "") spec.lines.pop();
  if (spec.lines.length === 0) fail(sep + 1, "no code after ---");
  if (spec.lines.length > MAX_LINES) fail(0, `${spec.lines.length} lines of code; at most ${MAX_LINES}: show the part that matters`);
  const first = spec.start;
  const last = spec.start + spec.lines.length - 1;
  const inRange = (n: number) => n >= first && n <= last;
  applyMarks(
    spec,
    marks,
    (t) => {
      if (t.t === "number") return inRange(t.value) ? String(t.value) : null;
      if (t.t === "range") return inRange(t.from) && inRange(t.to) ? Array.from({ length: t.to - t.from + 1 }, (_, i) => String(t.from + i)) : null;
      return null;
    },
    `line (lines here are ${first}–${last})`,
  );
  return spec;
}
