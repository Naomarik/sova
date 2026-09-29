/**
 * EMPHASIS, the one convention every kind shares for "look here": a `mark` line highlights an item
 * and may attach a short note.
 *
 *   mark <target> [tone] ["note"]
 *
 * <target> is whatever names an item in that kind: an id (`srv`), a "quoted label" (`"Merge sort"`),
 * a number (`3`) or a range (`3-5`). The tone defaults to accent. A mark line starts at column 0
 * (so an indented tree item called "mark …" is never one). A kind calls `takeMarks` on its lines,
 * then `resolveMarks` with a function that turns a target into its own item key(s); the result goes
 * in `spec.emphasis`. The figure shell lists the notes under the drawing, numbered; a View puts the
 * matching number badge (and the `vis-em` class) on each marked item via `emphasisMap`.
 *
 * A malformed mark line is an error. A well-formed one that can't apply is dropped with a warning
 * (the figure still draws): a target that names nothing, an item already marked, marks past the 8th.
 * A note over 120 characters is cut, with a warning.
 */

import { clip, fail, isTone, tokenize, warn, type Emphasis, type Line, type Tone } from "./grammar";

export const MAX_MARKS = 8;
export const MAX_NOTE = 120;

export type MarkTarget =
  | { t: "id"; text: string }
  | { t: "label"; text: string }
  | { t: "number"; text: string; value: number }
  | { t: "range"; text: string; from: number; to: number };

export interface RawMark {
  line: number;
  target: MarkTarget;
  tone?: Tone;
  note?: string;
}

/** Split `mark` lines out of a kind's lines. Anything malformed on a mark line is an error. */
export function takeMarks(ls: Line[]): { rest: Line[]; marks: RawMark[] } {
  const rest: Line[] = [];
  const marks: RawMark[] = [];
  for (const line of ls) {
    if (!/^mark(\s|$)/.test(line.raw)) {
      rest.push(line);
      continue;
    }
    const toks = tokenize(line).slice(1);
    const head = toks[0];
    if (!head) fail(line.n, 'mark needs a target: mark <id | "label" | line | from-to> [tone] ["note"]');
    let target: MarkTarget;
    if (head!.t === "str") target = { t: "label", text: head!.v };
    else if (head!.t === "word" && /^\d+$/.test(head!.v)) target = { t: "number", text: head!.v, value: Number(head!.v) };
    else if (head!.t === "word" && /^\d+-\d+$/.test(head!.v)) {
      const [from, to] = head!.v.split("-").map(Number) as [number, number];
      if (to < from) fail(line.n, `mark ${head!.v}: the range runs backwards`);
      target = { t: "range", text: head!.v, from, to };
    } else if (head!.t === "word") target = { t: "id", text: head!.v };
    else return fail(line.n, `mark: unexpected ${head!.v}`);
    const mark: RawMark = { line: line.n, target };
    for (const tok of toks.slice(1)) {
      if (tok.t === "str") {
        if (mark.note !== undefined) fail(line.n, "mark takes one note");
        if (tok.v.length > MAX_NOTE) warn(line.n, `mark note over ${MAX_NOTE} characters, shortened`);
        mark.note = clip(tok.v, MAX_NOTE);
      } else if (tok.t === "word" && isTone(tok.v)) {
        if (mark.tone) fail(line.n, "mark takes one tone");
        mark.tone = tok.v;
      } else fail(line.n, `mark: unexpected ${tok.v} (after the target: a tone and/or a "note")`);
    }
    marks.push(mark);
  }
  if (marks.length > MAX_MARKS) {
    for (const m of marks.slice(MAX_MARKS)) warn(m.line, `mark past the ${MAX_MARKS}th, dropped: emphasis only works when it's rare`);
    marks.length = MAX_MARKS;
  }
  return { rest, marks };
}

/**
 * Resolve marks against a kind's items. `resolve` returns the item key(s) a target names, or null
 * when it names nothing. A mark that names nothing (`what`, e.g. "node", goes in the warning) is
 * dropped; an item already marked keeps its first mark. Both warn.
 */
export function resolveMarks(marks: RawMark[], resolve: (target: MarkTarget) => string | string[] | null, what: string): Emphasis[] {
  const out: Emphasis[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const m of marks) {
    const got = resolve(m.target);
    const named = got === null ? [] : Array.isArray(got) ? got : [got];
    const target = m.target.t === "label" ? `"${m.target.text}"` : m.target.text;
    if (named.length === 0) {
      warn(m.line, `mark: no ${what} ${target}, dropped`);
      continue;
    }
    const keys = named.filter((key) => !seen.has(key));
    if (keys.length < named.length) warn(m.line, keys.length ? `mark ${target}: part of it is already marked, the rest kept` : `mark ${target}: already marked, dropped`);
    if (keys.length === 0) continue;
    const number = m.note !== undefined ? ++n : undefined;
    keys.forEach((key, i) => {
      seen.add(key);
      // A range's note and number belong to its first (unmarked) item; the rest are highlighted only.
      out.push({ key, tone: m.tone ?? "accent", ...(i === 0 && m.note !== undefined ? { note: m.note, n: number } : {}) });
    });
  }
  return out;
}

/** Look up an item's emphasis by key, for a View. */
export function emphasisMap(spec: { emphasis?: Emphasis[] }): Map<string, Emphasis> {
  return new Map((spec.emphasis ?? []).map((e) => [e.key, e]));
}

/** The numbered notes, in order: what the figure shell lists under the drawing. */
export const emphasisNotes = (spec: { emphasis?: Emphasis[] }): { n: number; note: string; tone: Tone }[] =>
  (spec.emphasis ?? []).filter((e) => e.n !== undefined).map((e) => ({ n: e.n!, note: e.note!, tone: e.tone }));

/** Common resolver for kinds whose items are ids or labels: exact id first, then exact label. */
export function byIdOrLabel(items: { key: string; id?: string; label: string }[]) {
  return (t: MarkTarget): string | null => {
    if (t.t === "id") return items.find((i) => i.id === t.text)?.key ?? items.find((i) => i.label === t.text)?.key ?? null;
    if (t.t === "label") return items.find((i) => i.label === t.text)?.key ?? null;
    return null;
  };
}


/** The one call a kind makes after parsing its items: resolve its marks into `spec.emphasis`. */
export function applyMarks(spec: { emphasis?: Emphasis[] }, marks: RawMark[], resolve: (target: MarkTarget) => string | string[] | null, what: string): void {
  if (!marks.length) return;
  const emphasis = resolveMarks(marks, resolve, what);
  if (emphasis.length) spec.emphasis = emphasis;
}
