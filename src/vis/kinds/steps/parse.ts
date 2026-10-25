/**
 * `vis steps`: scenario chains, one row per line: `"Label" [tone] | step -> step -> step [| outcome]`.
 * A step is a "quoted label" (optionally toned) or bare words, or `^` (the step at this position in
 * the row above, same lane) or `_` (nothing at this position); `== lane ==` lines group the rows
 * under a heading. No ids, no layout: layout.ts picks how the rows are drawn.
 */

import { applyMarks, byIdOrLabel, takeMarks, type MarkTarget } from "../../core/emphasis";
import { divider, fail, isTone, lines, takeSettings, text, tokenize, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface StepsOutcome {
  text: string;
  tone?: Tone;
}
/**
 * A row. The optional fields appear only when the row uses them, so a fence written before them
 * parses to the very same spec (golden.test.ts).
 */
export interface StepsRow {
  type: "row";
  label: string;
  tone?: Tone;
  /** Each step's text; "" at a position written `_` (listed in `gaps`). */
  steps: string[];
  /** Each step's own tone, null for none: only when some step has one. */
  stepTones?: (Tone | null)[];
  /** The positions written `_`: nothing happens there. */
  gaps?: number[];
  /** The row's result or cost, after a second `|`. */
  outcome?: StepsOutcome;
}
export type StepsItem = StepsRow | { type: "lane"; label: string };
export interface StepsSpec extends VisBase {
  kind: "steps";
  items: StepsItem[];
}

const MAX_ROWS = 16;
const MAX_STEPS = 10;
const MAX_LANES = 6;
const SHAPE = 'a row is: "Label" [tone] | step -> step -> step';

/** The line split at its first (or `last`) `|` outside quotes, or null when it has none. */
function splitBar(line: Line, last = false): [Line, Line] | null {
  const s = line.text;
  let quoted = false;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && quoted) i++;
    else if (c === '"') quoted = !quoted;
    else if (c === "|" && !quoted) {
      at = i;
      if (!last) break;
    }
  }
  if (at < 0) return null;
  const part = (t: string): Line => ({ n: line.n, raw: t, text: t.trim() });
  return [part(s.slice(0, at)), part(s.slice(at + 1))];
}

/**
 * The row's head: a "quoted label" or bare words, then at most one tone. A head mixing quotes and
 * words (`'"all"'`, `"Pi" sibling`) is its text as written, quotes and all.
 */
function head(line: Line): { label: string; tone?: Tone } {
  const toks = tokenize(line);
  let tone: Tone | undefined;
  const last = toks[toks.length - 1];
  if (toks.length > 1 && last?.t === "word" && isTone(last.v)) {
    tone = last.v;
    toks.pop();
  }
  if (toks.length === 0) fail(line.n, `${SHAPE} (the label is missing)`);
  if (toks.some((t) => t.t === "arrow")) fail(line.n, `${SHAPE} (the steps go after the |)`);
  const label = toks.length > 1 && toks.some((t) => t.t === "str") ? literal(line, tone) : toks.map((t) => t.v).join(" ");
  return { label: text(label, line.n), ...(tone ? { tone } : {}) };
}

/** The head as written (it ends at the row's |), less its trailing tone word. */
const literal = (line: Line, tone: Tone | undefined): string => (tone ? line.text.slice(0, -tone.length).trimEnd() : line.text);

/** Where a row's `^` reads from: the row above in its lane, and whether a lane head came between. */
interface Above {
  row: StepsRow | null;
  /** A row exists above, but in another lane. */
  crossed: boolean;
}

interface Chain {
  steps: string[];
  stepTones: (Tone | null)[];
  gaps: number[];
  tone?: Tone;
}

/**
 * `a -> "b c" -> d e`: steps between `->`s, each a quoted label or bare words; one of each is kept as
 * written, as a head is (`error "invalid audience"`). A tone word after a quoted step tones that step;
 * with no row tone yet (`toned` false), the last step's tone is the row's too
 * (§chat.markdown/vis-lenience-content). `^` is the step at this position in the row above, `_` an
 * empty position.
 */
function chain(line: Line, toned: boolean, above: Above): Chain {
  // `→`, `=>` and the like join steps as `->` does (§chat.markdown/vis-lenience-content).
  const toks = tokenize(line, { wide: true });
  if (toks.length === 0) fail(line.n, `${SHAPE} (no steps after the |)`);
  const out: Chain = { steps: [], stepTones: [], gaps: [] };
  let cur: typeof toks = [];
  const push = (step: string, tone: Tone | null) => {
    out.steps.push(step);
    out.stepTones.push(tone);
  };
  const end = (last: boolean) => {
    if (cur.length === 0) fail(line.n, "an empty step: write step -> step, with something on both sides of every ->");
    const written = cur.map((t) => (t.t === "str" ? `"${t.v}"` : t.v)).join(" ");
    if (cur.filter((t) => t.t === "str").length > 1) fail(line.n, `a step is one "quoted label" or bare words, not two labels: ${written} (join steps with ->)`);
    const [a, b] = cur;
    const k = out.steps.length;
    if (cur.length === 1 && a!.t === "word" && a!.v === "^") {
      const up = above.row;
      if (!up) {
        if (above.crossed) fail(line.n, `^ repeats the step above in the same lane, and a lane head comes between: write step ${k + 1} out`);
        fail(line.n, `^ repeats the step at this position in the row above, but there is no row above: write step ${k + 1} out`);
      }
      if (k >= up!.steps.length) fail(line.n, `^ is step ${k + 1}, but the row above has no step ${k + 1}: write it out`);
      if (up!.gaps?.includes(k)) fail(line.n, `^ is step ${k + 1}, but the row above leaves step ${k + 1} empty (_): write it out`);
      const tone = up!.stepTones?.[k] ?? null;
      if (last && !toned && tone) out.tone = tone;
      push(up!.steps[k]!, tone);
    } else if (cur.length === 1 && a!.t === "word" && a!.v === "_") {
      // A row of only `_` ends in one, so this also refuses a row with no real step.
      if (last) fail(line.n, "_ leaves a position empty, so it can't end a row: end the row with a step");
      out.gaps.push(k);
      push("", null);
    } else if (cur.length === 2 && a!.t === "str" && b!.t === "word" && isTone(b!.v)) {
      if (last && !toned) out.tone = b!.v;
      push(text(a!.v, line.n), b!.v);
    } else push(text(cur.length > 1 && cur.some((t) => t.t === "str") ? written : cur.map((t) => t.v).join(" "), line.n), null);
    cur = [];
  };
  for (const t of toks) {
    if (t.t === "arrow") {
      if (t.v !== "->") fail(line.n, `steps join with ->, not ${t.v}`);
      end(false);
    } else cur.push(t);
  }
  end(true);
  if (out.steps.length > MAX_STEPS) fail(line.n, `${out.steps.length} steps; at most ${MAX_STEPS}: summarise, or split the row`);
  return out;
}

/** `| "3 tries" [tone]`: a row's outcome, a quoted label or bare words, then at most one tone. */
function outcomeOf(line: Line): StepsOutcome {
  const toks = tokenize(line);
  if (toks.length === 0) fail(line.n, 'an empty outcome: write its result in a few words after the last |, like | "3 tries", or drop that |');
  if (toks.some((t) => t.t === "arrow")) fail(line.n, "an outcome has no ->: the steps go before the last |, the outcome after it");
  let tone: Tone | undefined;
  const last = toks[toks.length - 1]!;
  if (toks.length > 1 && last.t === "word" && isTone(last.v)) {
    tone = last.v;
    toks.pop();
  }
  if (toks.length === 1 && toks[0]!.t === "word" && toks[0]!.v === "^") fail(line.n, '^ stands for a step, not an outcome: write the outcome out, like | "3 tries"');
  const written = toks.map((t) => (t.t === "str" ? `"${t.v}"` : t.v)).join(" ");
  const value = toks.length > 1 && toks.some((t) => t.t === "str") ? written : toks.map((t) => t.v).join(" ");
  return { text: text(value, line.n), ...(tone ? { tone } : {}) };
}

/** The row as the spec keeps it: the optional fields only when used. */
function row(hd: { label: string; tone?: Tone }, tone: Tone | undefined, c: Chain, outcome: StepsOutcome | undefined): StepsRow {
  return {
    type: "row",
    label: hd.label,
    ...(tone ? { tone } : {}),
    steps: c.steps,
    ...(c.stepTones.some((t) => t) ? { stepTones: c.stepTones } : {}),
    ...(c.gaps.length ? { gaps: c.gaps } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

export function parseSteps(body: string): StepsSpec {
  const spec: StepsSpec = { kind: "steps", items: [] };
  const { rest: settled } = takeSettings(lines(body), [], spec, { caseless: true });
  const { rest, marks } = takeMarks(settled, { indented: true });
  const lanes: Line[] = [];
  let above: Above = { row: null, crossed: false };
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      if (!div) fail(line.n, "a lane needs a label: == Asking people ==");
      const prev = spec.items[spec.items.length - 1];
      if (prev?.type === "lane") fail(lanes[lanes.length - 1]!.n, `lane "${prev.label}" is empty: give it rows, or drop the line`);
      lanes.push(line);
      spec.items.push({ type: "lane", label: div });
      above = { row: null, crossed: above.crossed || above.row !== null };
      continue;
    }
    const parts = splitBar(line);
    if (!parts) fail(line.n, SHAPE);
    const [h, c] = parts!;
    const hd = head(h);
    // A second |: a lone tone word is a status written last, as layers and timeline rows end
    // (`… -> done | ok`), when the label has none; after a toned label it stays in the last step, as
    // it always read. Anything else after it is the row's outcome.
    const tail = splitBar(c, true);
    let r: StepsRow;
    if (tail && isTone(tail[1].text)) {
      r = hd.tone ? row(hd, hd.tone, chain(c, true, above), undefined) : row(hd, tail[1].text, chain(tail[0], true, above), undefined);
    } else if (tail) {
      const outcome = outcomeOf(tail[1]);
      const ch = chain(tail[0], !!hd.tone, above);
      r = row(hd, hd.tone ?? ch.tone, ch, outcome);
    } else {
      const ch = chain(c, !!hd.tone, above);
      r = row(hd, hd.tone ?? ch.tone, ch, undefined);
    }
    spec.items.push(r);
    above = { row: r, crossed: above.crossed };
  }
  const last = spec.items[spec.items.length - 1];
  if (last?.type === "lane") fail(lanes[lanes.length - 1]!.n, `lane "${last.label}" is empty: give it rows, or drop the line`);
  const rows = spec.items.filter((i) => i.type === "row").length;
  if (rows === 0) fail(0, 'nothing to draw: add rows like "Simple question" ok | You -> "Maria answers"');
  if (rows > MAX_ROWS) fail(0, `${rows} rows; at most ${MAX_ROWS}`);
  if (lanes.length > MAX_LANES) fail(lanes[MAX_LANES]!.n, `${lanes.length} lanes; at most ${MAX_LANES}`);
  const byRow = byIdOrLabel(spec.items.flatMap((it, i) => (it.type === "row" ? [{ key: String(i), label: it.label }] : [])));
  // A target that names no row but a step marks every row with that step, written out the same or
  // through ^ (§chat.markdown/vis-lenience-content).
  const byStep = (t: MarkTarget): string[] | null => {
    const at = spec.items.flatMap((it, i) => (it.type === "row" && it.steps.some((s, k) => s === t.text && !it.gaps?.includes(k)) ? [String(i)] : []));
    return at.length ? at : null;
  };
  applyMarks(spec, marks, (t) => byRow(t) ?? (t.t === "id" || t.t === "label" ? byStep(t) : null), "row");
  return spec;
}
