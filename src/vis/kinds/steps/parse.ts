/**
 * `vis steps`: scenario chains, one row per line: `"Label" [tone] | step -> step -> step`. A step is
 * a "quoted label" or bare words; `== lane ==` lines group the rows under a heading. No ids, no
 * layout: each row is its label and its steps as chips joined by arrows.
 */

import { applyMarks, byIdOrLabel, takeMarks, type MarkTarget } from "../../core/emphasis";
import { divider, fail, isTone, lines, takeSettings, text, tokenize, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface StepsRow {
  type: "row";
  label: string;
  tone?: Tone;
  steps: string[];
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

/**
 * `a -> "b c" -> d e`: steps between `->`s, each a quoted label or bare words; one of each is kept as
 * written, as a head is (`error "invalid audience"`). With no tone yet (`toned` false), a tone word
 * after the last step's quoted label is the row's (§chat.markdown/vis-lenience-content).
 */
function chain(line: Line, toned: boolean): { steps: string[]; tone?: Tone } {
  // `→`, `=>` and the like join steps as `->` does (§chat.markdown/vis-lenience-content).
  const toks = tokenize(line, { wide: true });
  if (toks.length === 0) fail(line.n, `${SHAPE} (no steps after the |)`);
  const steps: string[] = [];
  let tone: Tone | undefined;
  let cur: typeof toks = [];
  const end = (last: boolean) => {
    if (cur.length === 0) fail(line.n, "an empty step: write step -> step, with something on both sides of every ->");
    const written = cur.map((t) => (t.t === "str" ? `"${t.v}"` : t.v)).join(" ");
    if (cur.filter((t) => t.t === "str").length > 1) fail(line.n, `a step is one "quoted label" or bare words, not two labels: ${written} (join steps with ->)`);
    const [a, b] = cur;
    if (last && !toned && cur.length === 2 && a!.t === "str" && b!.t === "word" && isTone(b!.v)) {
      tone = b!.v;
      steps.push(text(a!.v, line.n));
    } else steps.push(text(cur.length > 1 && cur.some((t) => t.t === "str") ? written : cur.map((t) => t.v).join(" "), line.n));
    cur = [];
  };
  for (const t of toks) {
    if (t.t === "arrow") {
      if (t.v !== "->") fail(line.n, `steps join with ->, not ${t.v}`);
      end(false);
    } else cur.push(t);
  }
  end(true);
  if (steps.length > MAX_STEPS) fail(line.n, `${steps.length} steps; at most ${MAX_STEPS}: summarise, or split the row`);
  return { steps, ...(tone ? { tone } : {}) };
}

export function parseSteps(body: string): StepsSpec {
  const spec: StepsSpec = { kind: "steps", items: [] };
  const { rest: settled } = takeSettings(lines(body), [], spec, { caseless: true });
  const { rest, marks } = takeMarks(settled, { indented: true });
  const lanes: Line[] = [];
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      if (!div) fail(line.n, "a lane needs a label: == Asking people ==");
      const prev = spec.items[spec.items.length - 1];
      if (prev?.type === "lane") fail(lanes[lanes.length - 1]!.n, `lane "${prev.label}" is empty: give it rows, or drop the line`);
      lanes.push(line);
      spec.items.push({ type: "lane", label: div });
      continue;
    }
    const parts = splitBar(line);
    if (!parts) fail(line.n, SHAPE);
    const [h, c] = parts!;
    const hd = head(h);
    // A status written last, as layers and timeline rows end (`… -> done | ok`), when the label has none.
    const tail = hd.tone ? null : splitBar(c, true);
    if (tail && isTone(tail[1].text)) spec.items.push({ type: "row", ...hd, tone: tail[1].text, steps: chain(tail[0], true).steps });
    else spec.items.push({ type: "row", ...hd, ...chain(c, !!hd.tone) });
  }
  const last = spec.items[spec.items.length - 1];
  if (last?.type === "lane") fail(lanes[lanes.length - 1]!.n, `lane "${last.label}" is empty: give it rows, or drop the line`);
  const rows = spec.items.filter((i) => i.type === "row").length;
  if (rows === 0) fail(0, 'nothing to draw: add rows like "Simple question" ok | You -> "Maria answers"');
  if (rows > MAX_ROWS) fail(0, `${rows} rows; at most ${MAX_ROWS}`);
  if (lanes.length > MAX_LANES) fail(lanes[MAX_LANES]!.n, `${lanes.length} lanes; at most ${MAX_LANES}`);
  const byRow = byIdOrLabel(spec.items.flatMap((it, i) => (it.type === "row" ? [{ key: String(i), label: it.label }] : [])));
  // A target that names no row but a step of exactly one row marks that row (§chat.markdown/vis-lenience-content).
  const byStep = (t: MarkTarget): string | null => {
    const at = spec.items.flatMap((it, i) => (it.type === "row" && it.steps.includes(t.text) ? [String(i)] : []));
    return at.length === 1 ? at[0]! : null;
  };
  applyMarks(spec, marks, (t) => byRow(t) ?? (t.t === "id" || t.t === "label" ? byStep(t) : null), "row");
  return spec;
}
