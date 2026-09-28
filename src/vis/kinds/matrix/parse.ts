/** `vis matrix`: `columns:` then `label | cell | cell` rows; cells are yes/no/partial marks or text. */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { commaList, fail, fields, lines, takeSettings, unquote, type VisBase } from "../../core/grammar";

export type CellMark = "yes" | "no" | "partial";
export interface MatrixCell {
  mark?: CellMark;
  text?: string;
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
  spec.columns = commaList(cols!.value, cols!.n);
  if (spec.columns.length < 1 || spec.columns.length > MAX_COLUMNS) fail(cols!.n, `1 to ${MAX_COLUMNS} columns`);
  for (const line of rest) {
    const fs = fields(line);
    if (fs.length !== spec.columns.length + 1) fail(line.n, `${fs.length - 1} cells; expected ${spec.columns.length} (label | ${spec.columns.join(" | ")})`);
    const [label, ...cells] = fs as [string, ...string[]];
    if (!label) fail(line.n, "empty row label");
    spec.rows.push({
      label,
      cells: cells.map((c) => {
        const m = /^(yes|no|partial)\b\s*(.*)$/.exec(c);
        if (!m) return c === "" || c === "-" ? {} : { text: c };
        const rest = m[2]!.trim();
        const note = rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"') ? unquote(rest.slice(1, -1)) : rest;
        return { mark: MARKS[m[1]!]!, ...(note ? { text: note } : {}) };
      }),
    });
  }
  if (spec.rows.length === 0) fail(0, "nothing to draw: add rows like Label | yes | no");
  if (spec.rows.length > MAX_ROWS) fail(0, `${spec.rows.length} rows; at most ${MAX_ROWS}`);
  applyMarks(spec, marks, byIdOrLabel(spec.rows.map((r, i) => ({ key: String(i), label: r.label }))), "row");
  return spec;
}
