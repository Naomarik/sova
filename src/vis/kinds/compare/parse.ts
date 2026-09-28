/** `vis compare`: `columns:` then `label | cell | cell` rows; cells are yes/no/partial marks or text. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export type Mark = "yes" | "no" | "partial";
export interface CompareCell {
  mark?: Mark;
  text?: string;
}
export interface CompareSpec extends VisBase {
  kind: "compare";
  columns: string[];
  rows: { label: string; cells: CompareCell[] }[];
}


const MAX_COLUMNS = 6;
const MAX_ROWS = 24;

// ---- compare -----------------------------------------------------------------------------

const MARKS: Record<string, Mark> = { yes: "yes", no: "no", partial: "partial" };

export function parseCompare(body: string): CompareSpec {
  const ls = lines(body);
  const spec: CompareSpec = { kind: "compare", columns: [], rows: [] };
  const { rest, values } = takeSettings(ls, ["columns"], spec);
  const cols = values.get("columns");
  if (!cols) fail(0, "compare needs columns: A, B, C");
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
  return spec;
}
