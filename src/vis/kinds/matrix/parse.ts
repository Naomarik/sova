/**
 * `vis matrix`: `columns:` then `label | cell | cell` rows; cells are yes/no/partial marks or text,
 * and a text cell may end in a tone word (`72% warn`).
 * `mark` names a row by its label, or a column by its name.
 */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { commaList, fail, fields, isTone, lines, takeSettings, unquote, type Tone, type VisBase } from "../../core/grammar";

export type CellMark = "yes" | "no" | "partial";
export interface MatrixCell {
  mark?: CellMark;
  text?: string;
  /** A text cell's status: its last word, when that is a tone (`72% warn`). Drawn with an icon, never hue alone. */
  tone?: Tone;
}
export interface MatrixSpec extends VisBase {
  kind: "matrix";
  columns: string[];
  rows: { label: string; cells: MatrixCell[] }[];
}

const MAX_COLUMNS = 6;
const MAX_ROWS = 24;


const MARKS: Record<string, CellMark> = { yes: "yes", no: "no", partial: "partial" };

export function parseMatrix(body: string): MatrixSpec {
  const ls = lines(body);
  const spec: MatrixSpec = { kind: "matrix", columns: [], rows: [] };
  const { rest: settled, values } = takeSettings(ls, ["columns"], spec);
  const { rest, marks } = takeMarks(settled);
  const cols = values.get("columns");
  if (!cols) fail(0, "matrix needs columns: A, B, C");
  spec.columns = commaList(cols!.raw, cols!.n);
  if (spec.columns.length < 1 || spec.columns.length > MAX_COLUMNS) fail(cols!.n, `1 to ${MAX_COLUMNS} columns`);
  for (const line of rest) {
    const fs = fields(line);
    // Which cells were one quoted string (fields() unquotes them): those stay text, tone word or not.
    const quoted = line.text.split(/(?<!\\)\|/).map((p) => /^"(?:[^"\\]|\\.)*"$/.test(p.trim()));
    if (fs.length !== spec.columns.length + 1) fail(line.n, `${fs.length - 1} cells; expected ${spec.columns.length} (label | ${spec.columns.join(" | ")})`);
    const [label, ...cells] = fs as [string, ...string[]];
    if (!label) fail(line.n, "empty row label");
    spec.rows.push({
      label,
      cells: cells.map((c, ci) => {
        const m = /^(yes|no|partial)\b\s*(.*)$/.exec(c);
        if (!m) return c === "" || c === "-" ? {} : (quoted[ci + 1] ? { text: c } : textCell(c));
        const rest = m[2]!.trim();
        const note = rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"') ? unquote(rest.slice(1, -1)) : rest;
        return { mark: MARKS[m[1]!]!, ...(note ? { text: note } : {}) };
      }),
    });
  }
  if (spec.rows.length === 0) fail(0, "nothing to draw: add rows like Label | yes | no");
  if (spec.rows.length > MAX_ROWS) fail(0, `${spec.rows.length} rows; at most ${MAX_ROWS}`);
  // A mark names a row (key: its index) or, failing that, a column (key: `c<index>`).
  const byRow = byIdOrLabel(spec.rows.map((r, i) => ({ key: String(i), label: r.label })));
  const byColumn = byIdOrLabel(spec.columns.map((c, i) => ({ key: `c${i}`, label: c })));
  applyMarks(spec, marks, (t) => byRow(t) ?? byColumn(t), "row or column");
  return spec;
}

/**
 * A text cell: `72% warn` is the text "72%" with the tone warn; `"works ok"` (quoted) stays text, and
 * so does a lone tone word (`ok`). fields() already unquoted a cell that is one quoted string.
 */
function textCell(c: string): MatrixCell {
  const q = /^"((?:[^"\\]|\\.)*)"\s+([a-z]+)$/.exec(c);
  if (q && isTone(q[2]!)) return { text: unquote(q[1]!), tone: q[2] };
  const m = /^(.*\S)\s+([a-z]+)$/.exec(c);
  if (m && isTone(m[2]!) && !/^".*"$/.test(c)) return { text: m[1]!, tone: m[2] };
  return { text: c };
}
