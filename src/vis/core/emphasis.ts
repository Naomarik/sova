/**
 * EMPHASIS, the one convention every kind shares for "look here": a `mark` line highlights an item
 * and may attach a short note.
 *
 *   mark <target>[, <target>…] [tone] ["note"]
 *
 * <target> is whatever names an item in that kind: an id (`srv`), a "quoted label" (`"Merge sort"`),
 * a number (`3`) or a range (`3-5`). Commas outside quotes separate several targets of one mark:
 * one note, its number on the first item of each target. The tone defaults to accent. A mark line
 * starts at column 0 (so an indented tree item called "mark …" is never one). A kind calls `takeMarks` on its lines,
 * then `resolveMarks` with a function that turns a target into its own item key(s); the result goes
 * in `spec.emphasis`. The figure shell lists the notes under the drawing, numbered; a View puts the
 * matching number badge (and the `vis-em` class) on each marked item via `emphasisMap`.
 *
 * Bare words after a target, up to a comma, a tone word or a string, are one run with it
 * (`mark Sep 30 "note"`): the item the joined phrase names ("Sep 30", as a quoted label), else each
 * word as its own target when every one names an item, else the mark is dropped with a warning that
 * quotes the fix. No mark line is an error: one that can't be read (a stray comma, two notes, a word
 * after the note) is dropped with a warning saying what it couldn't read, and so is a well-formed one
 * that can't apply (the figure still draws): a target that names nothing (its line's other targets
 * stay), an item already marked, marks past the 8th.
 * A note over 120 characters is cut, with a warning.
 */

import { clip, fail, isTone, tokenize, VisError, warn, type Emphasis, type Line, type Token, type Tone } from "./grammar";

export const MAX_MARKS = 8;
export const MAX_NOTE = 120;

export type MarkTarget =
  | { t: "id"; text: string }
  | { t: "label"; text: string }
  | { t: "number"; text: string; value: number }
  | { t: "range"; text: string; from: number; to: number };

/** Bare words written as one target (`mark Sep 30`): `text` is them joined by one space. */
export interface RunTarget {
  t: "run";
  text: string;
  words: MarkTarget[];
}

export interface RawMark {
  line: number;
  /** The first target; `targets` holds all of them (`mark a, b, c`), this one first. */
  target: MarkTarget | RunTarget;
  targets: (MarkTarget | RunTarget)[];
  tone?: Tone;
  note?: string;
}

function markTarget(head: Token, n: number): MarkTarget {
  if (head.t === "str") return { t: "label", text: head.v };
  if (head.t === "word" && /^\d+$/.test(head.v)) return { t: "number", text: head.v, value: Number(head.v) };
  if (head.t === "word" && /^\d+-\d+$/.test(head.v)) {
    const [from, to] = head.v.split("-").map(Number) as [number, number];
    if (to < from) fail(n, `mark ${head.v}: the range runs backwards`);
    return { t: "range", text: head.v, from, to };
  }
  if (head.t === "word") return { t: "id", text: head.v };
  return fail(n, `mark: unexpected ${head.v}`);
}

function readMark(line: Line): RawMark {
  // Commas outside quotes separate targets: `a, b` and `a,b` are two, a "quoted, label" is one.
  const toks: (Token | { t: "comma" })[] = tokenize(line)
    .slice(1)
    .flatMap((tok): (Token | { t: "comma" })[] => (tok.t === "word" && tok.v.includes(",") ? tok.v.split(/(,)/).filter(Boolean).map((v) => (v === "," ? { t: "comma" as const } : { t: "word" as const, v })) : [tok]));
  if (!toks[0]) fail(line.n, 'mark needs a target: mark <id | "label" | line | from-to>[, more] [tone] ["note"]');
  const targets: (MarkTarget | RunTarget)[] = [];
  let k = 0;
  for (;;) {
    const head = toks[k++];
    if (!head || head.t === "comma") return fail(line.n, "mark: a comma needs a target on each side (mark a, b, c)");
    const words = [markTarget(head, line.n)];
    // Bare words after a bare target, up to a tone word, are one run with it (`mark Sep 30`).
    for (let tok = toks[k]; head.t === "word" && tok?.t === "word" && !isTone(tok.v); tok = toks[++k]) words.push(markTarget(tok, line.n));
    targets.push(words.length === 1 ? words[0]! : { t: "run", text: words.map((w) => w.text).join(" "), words });
    if (toks[k]?.t !== "comma") break;
    k++;
  }
  const mark: RawMark = { line: line.n, target: targets[0]!, targets };
  for (const tok of toks.slice(k) as Token[]) {
    if (tok.t === "str") {
      if (mark.note !== undefined) fail(line.n, "mark takes one note");
      mark.note = tok.v;
    } else if (tok.t === "word" && isTone(tok.v)) {
      if (mark.tone) fail(line.n, "mark takes one tone");
      mark.tone = tok.v;
    } else fail(line.n, `mark: unexpected ${"v" in tok ? tok.v : ","} (after the target: a tone and/or a "note")`);
  }
  return mark;
}

/** Split `mark` lines out of a kind's lines. A line that can't be read is dropped with a warning. */
export function takeMarks(ls: Line[]): { rest: Line[]; marks: RawMark[] } {
  const rest: Line[] = [];
  const marks: RawMark[] = [];
  for (const line of ls) {
    if (!/^mark(\s|$)/.test(line.raw)) {
      rest.push(line);
      continue;
    }
    try {
      const mark = readMark(line);
      if (mark.note !== undefined && mark.note.length > MAX_NOTE) {
        warn(line.n, `mark note over ${MAX_NOTE} characters, shortened`);
        mark.note = clip(mark.note, MAX_NOTE);
      }
      marks.push(mark);
    } catch (e) {
      if (!(e instanceof VisError)) throw e;
      warn(line.n, `${e.message}; mark dropped`);
    }
  }
  if (marks.length > MAX_MARKS) {
    for (const m of marks.slice(MAX_MARKS)) warn(m.line, `mark past the ${MAX_MARKS}th, dropped: emphasis only works when it's rare`);
    marks.length = MAX_MARKS;
  }
  return { rest, marks };
}

/**
 * Resolve marks against a kind's items. `resolve` returns the item key(s) a target (written on
 * `line`) names, or null when it names nothing. A mark that names nothing (`what`, e.g. "node", goes
 * in the warning) is dropped; an item already marked keeps its first mark. Both warn. A run of words
 * is its joined phrase as a label, else each word as its own target when every one names something.
 */
export function resolveMarks(marks: RawMark[], resolve: (target: MarkTarget, line: number) => string | string[] | null, what: string): Emphasis[] {
  const out: Emphasis[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const m of marks) {
    // Each target resolves on its own; one that names nothing is dropped (the others kept).
    const perTarget: string[][] = [];
    const named: string[] = [];
    const keysOf = (t: MarkTarget): string[] => {
      const got = resolve(t, m.line);
      return got === null ? [] : Array.isArray(got) ? got : [got];
    };
    for (const t of m.targets) {
      let groups: string[][];
      if (t.t === "run") {
        const joined = keysOf({ t: "label", text: t.text });
        const each = t.words.map(keysOf);
        groups = joined.length ? [joined] : each.every((keys) => keys.length) ? each : [];
        if (!groups.length) warn(m.line, `mark: no ${what} "${t.text}", dropped (quote a target with spaces: mark "${t.text}"${m.note !== undefined ? ' "…"' : ""})`);
      } else {
        groups = [keysOf(t)];
        if (!groups[0]!.length) warn(m.line, `mark: no ${what} ${t.t === "label" ? `"${t.text}"` : t.text}, dropped`);
      }
      for (const keys of groups) {
        const fresh = keys.filter((key) => !named.includes(key));
        named.push(...fresh);
        if (fresh.length) perTarget.push(fresh);
      }
    }
    const target = m.targets.map((t) => (t.t === "label" ? `"${t.text}"` : t.text)).join(", ");
    if (named.length === 0) continue;
    const keys = named.filter((key) => !seen.has(key));
    if (keys.length < named.length) warn(m.line, keys.length ? `mark ${target}: part of it is already marked, the rest kept` : `mark ${target}: already marked, dropped`);
    if (keys.length === 0) continue;
    const number = m.note !== undefined ? ++n : undefined;
    for (const group of perTarget) {
      // A target's note and number sit on its first unmarked item (a range's other lines are
      // highlighted only); every target of one mark line carries the same number.
      group.filter((key) => !seen.has(key)).forEach((key, i) => {
        seen.add(key);
        out.push({ key, tone: m.tone ?? "accent", ...(i === 0 && m.note !== undefined ? { note: m.note, n: number } : {}) });
      });
    }
  }
  return out;
}

/** Look up an item's emphasis by key, for a View. */
export function emphasisMap(spec: { emphasis?: Emphasis[] }): Map<string, Emphasis> {
  return new Map((spec.emphasis ?? []).map((e) => [e.key, e]));
}

/** The numbered notes, in order, each once (one mark may badge several items): what the figure shell lists under the drawing. */
export const emphasisNotes = (spec: { emphasis?: Emphasis[] }): { n: number; note: string; tone: Tone }[] => {
  const seen = new Set<number>();
  return (spec.emphasis ?? []).filter((e) => e.n !== undefined && !seen.has(e.n) && seen.add(e.n)).map((e) => ({ n: e.n!, note: e.note!, tone: e.tone }));
};

/** Common resolver for kinds whose items are ids or labels: exact id first, then exact label. */
export function byIdOrLabel(items: { key: string; id?: string; label: string }[]) {
  return (t: MarkTarget): string | null => {
    if (t.t === "id") return items.find((i) => i.id === t.text)?.key ?? items.find((i) => i.label === t.text)?.key ?? null;
    if (t.t === "label") return items.find((i) => i.label === t.text)?.key ?? null;
    return null;
  };
}


/** The one call a kind makes after parsing its items: resolve its marks into `spec.emphasis`. */
export function applyMarks(spec: { emphasis?: Emphasis[] }, marks: RawMark[], resolve: (target: MarkTarget, line: number) => string | string[] | null, what: string): void {
  if (!marks.length) return;
  const emphasis = resolveMarks(marks, resolve, what);
  if (emphasis.length) spec.emphasis = emphasis;
}
