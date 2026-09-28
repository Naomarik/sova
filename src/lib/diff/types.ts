// The diff model every source is parsed into: files → hunks → rows. Pure data, no DOM.

export type RowKind = "ctx" | "add" | "del";

/** One line of a hunk. `oldNo` is null on an added row, `newNo` on a removed one. */
export interface DiffRow {
  kind: RowKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** The patch said "\ No newline at end of file" after this row. */
  noEol?: boolean;
}

export interface Hunk {
  /** As in the `@@ -oldStart,oldLines +newStart,newLines @@` header. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text git puts after the second `@@` (the enclosing function, usually); "" if none. */
  heading: string;
  rows: DiffRow[];
}

/** M modified, A added, D deleted, R renamed (maybe also modified). */
export type FileStatus = "M" | "A" | "D" | "R";

export interface FileDiff {
  /** null for an added file. */
  oldPath: string | null;
  /** null for a deleted file. */
  newPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  added: number;
  removed: number;
  /** Git said "Binary files … differ": no hunks to show. */
  binary?: boolean;
  /** Whole texts, when the source had them: folds can then expand, and highlighting sees the whole file. */
  oldText?: string;
  newText?: string;
  /** false when row numbers count from the start of a snippet, not the file: the view hides them. */
  numbered: boolean;
}

/** The path a file is shown under: the new one, or the old one for a deletion. */
export const filePath = (f: FileDiff): string => f.newPath ?? f.oldPath ?? "";

/** The first old/new line a hunk covers, and the line after it. A zero-length side's start is the line before. */
export function hunkSpan(h: Hunk): { oldFirst: number; oldEnd: number; newFirst: number; newEnd: number } {
  const oldFirst = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
  const newFirst = h.newLines === 0 ? h.newStart + 1 : h.newStart;
  return { oldFirst, oldEnd: oldFirst + h.oldLines, newFirst, newEnd: newFirst + h.newLines };
}

/** Counts added and removed rows. */
export function countRows(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const r of h.rows) r.kind === "add" ? added++ : r.kind === "del" && removed++;
  return { added, removed };
}

/** A text as lines: a final newline ends the last line rather than starting an empty one. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
