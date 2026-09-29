// Unified patch text (git's, or the jsdiff patch in a pi edit result's details.patch) and Claude
// Code's structuredPatch, parsed into FileDiff. Tolerant: an unknown line outside a hunk is skipped.

import { countRows, type DiffRow, type FileDiff, type FileStatus, type Hunk } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Git's C-style quoted path ("a/sp\303\244ce") → its text; bare paths pass through. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A `---`/`+++` path: tab-separated timestamp dropped, /dev/null → null, git's a/ b/ prefix dropped. */
function headerPath(raw: string, prefix: "a/" | "b/", git: boolean): string | null {
  const p = unquote(raw.split("\t")[0]!.trimEnd());
  if (p === "/dev/null") return null;
  return git && p.startsWith(prefix) ? p.slice(2) : p;
}

/** `diff --git a/x b/x` → the two paths; for unquoted paths with spaces, the split that makes them equal. */
function gitHeaderPaths(rest: string): [string, string] | null {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted && (quoted[1]!.startsWith('"') || quoted[2]!.startsWith('"'))) {
    const a = unquote(quoted[1]!);
    const b = unquote(quoted[2]!);
    return [a.replace(/^a\//, ""), b.replace(/^b\//, "")];
  }
  if (rest.startsWith("a/") && rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (b.startsWith("b/") && a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)];
  }
  const m = rest.match(/^a\/(.*) b\/(.*)$/);
  return m ? [m[1]!, m[2]!] : null;
}

interface Building {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus | null;
  hunks: Hunk[];
  binary: boolean;
  git: boolean;
}

function finish(b: Building): FileDiff {
  const status: FileStatus = b.status ?? (b.oldPath === null ? "A" : b.newPath === null ? "D" : b.oldPath !== b.newPath ? "R" : "M");
  return { oldPath: b.oldPath, newPath: b.newPath, status, hunks: b.hunks, binary: b.binary || undefined, numbered: true, ...countRows(b.hunks) };
}

/** Every file in a unified patch, in order. */
export function parseUnifiedPatch(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let cur: Building | null = null;
  const start = (git: boolean): Building => {
    if (cur) files.push(finish(cur));
    cur = { oldPath: null, newPath: null, status: null, hunks: [], binary: false, git };
    return cur;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      const b = start(true);
      const paths = gitHeaderPaths(line.slice(11));
      if (paths) [b.oldPath, b.newPath] = paths;
      i++;
      continue;
    }
    // A plain `--- x` + `+++ y` pair starts a file unless git's own header already did.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const b: Building = cur && (cur as Building).git && (cur as Building).hunks.length === 0 ? cur : start(false);
      const oldP = headerPath(line.slice(4), "a/", b.git);
      const newP = headerPath(lines[i + 1]!.replace(/\r$/, "").slice(4), "b/", b.git);
      b.oldPath = oldP;
      b.newPath = newP;
      if (oldP === null) b.status = "A";
      else if (newP === null) b.status = "D";
      i += 2;
      continue;
    }
    const b = cur as Building | null;
    if (b && line.startsWith("@@")) {
      const m = line.match(HUNK_HEADER);
      if (!m) {
        i++;
        continue;
      }
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        heading: m[5] ?? "",
        rows: [],
      };
      i = readHunkBody(lines, i + 1, hunk);
      b.hunks.push(hunk);
      continue;
    }
    if (b && b.hunks.length === 0) {
      if (line.startsWith("new file mode")) b.status = "A";
      else if (line.startsWith("deleted file mode")) b.status = "D";
      else if (line.startsWith("rename from ")) b.oldPath = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) {
        b.newPath = unquote(line.slice(10));
        b.status = "R";
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") b.binary = true;
    }
    if (b?.status === "A") b.oldPath = null;
    if (b?.status === "D") b.newPath = null;
    i++;
  }
  if (cur) files.push(finish(cur));
  return files;
}

/** Reads one hunk's rows by its header's counts (a removed "-- x" line is a row, not a header). */
function readHunkBody(lines: string[], i: number, hunk: Hunk): number {
  let oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newNo = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  while (i < lines.length) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.startsWith("\\")) {
      const last = hunk.rows[hunk.rows.length - 1];
      if (last) last.noEol = true;
      i++;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) break;
    const sign = line[0];
    const text = line.slice(1);
    if ((sign === " " || line === "") && oldLeft > 0 && newLeft > 0) {
      hunk.rows.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
      oldLeft--;
      newLeft--;
    } else if (sign === "-" && oldLeft > 0) {
      hunk.rows.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
      oldLeft--;
    } else if (sign === "+" && newLeft > 0) {
      hunk.rows.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
      newLeft--;
    } else break;
    i++;
  }
  return i;
}

/** One hunk of Claude Code's `structuredPatch` (its `toolUseResult`, also the `diff` package's shape). */
export interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Whether `v` looks like a structuredPatch array. */
export function isStructuredPatch(v: unknown): v is StructuredHunk[] {
  return (
    Array.isArray(v) &&
    v.every(
      (h) =>
        typeof h === "object" &&
        h !== null &&
        typeof h.oldStart === "number" &&
        typeof h.newStart === "number" &&
        typeof h.oldLines === "number" &&
        typeof h.newLines === "number" &&
        Array.isArray(h.lines) &&
        h.lines.every((l: unknown) => typeof l === "string"),
    )
  );
}

/** A structuredPatch as one file; `created` marks a new file (Write of a path that didn't exist). */
export function fromStructuredPatch(path: string, patch: StructuredHunk[], created = false): FileDiff {
  const hunks: Hunk[] = patch.map((h) => {
    const hunk: Hunk = { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, heading: "", rows: [] };
    readHunkBody(h.lines, 0, hunk);
    return hunk;
  });
  return { oldPath: created ? null : path, newPath: path, status: created ? "A" : "M", hunks, numbered: true, ...countRows(hunks) };
}

/** +n −m of a patch text without parsing it: header lines (`+++`, `---` before a hunk) aren't counted. */
export function patchStats(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git ")) inHunk = false;
    else if (!inHunk) continue;
    else if (line[0] === "+") added++;
    else if (line[0] === "-") removed++;
  }
  return { added, removed };
}
