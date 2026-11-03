// The read-only folder viewer's model: labelled groups of files from any source (a project folder
// at a commit, a folder Sova ships), each listed and read by functions its caller hands in. Nothing
// here knows who calls it or which route serves it. Pure (no DOM, no Solid), so it tests under tsx.

/** One file in a group: its path inside the group's folder, forward slashes. `kind`: what the source
    already knows (a file over its size cap is listed but never read). */
export interface FolderItem {
  path: string;
  size?: number;
  kind?: "markdown" | "text" | "binary" | "too-large";
  /** A plain name to show instead of the path (no file icon, not monospace): an item that isn't a
      file, such as a tool. `path` stays its key. */
  label?: string;
  /** Shown beside the label in place of the size ("≈1.2k tokens"). */
  detail?: string;
}

/** A file's contents as read: always text. `truncated`: the source cut it at its size cap. */
export interface FolderText {
  text: string;
  truncated?: boolean;
}

/** One labelled group of files ("Sova's method", "This project's playbook"). */
export interface FolderGroup {
  /** Unique among the viewer's groups. */
  id: string;
  label: string;
  /** One line under the label: where the files come from (`.sova/playbooks/review at 97927e0`). */
  caption?: string;
  list(): Promise<FolderItem[]>;
  read(path: string): Promise<FolderText>;
}

const MARKDOWN = /\.(?:md|markdown|mdx)$/i;

export type FileKind = "markdown" | "text" | "binary" | "too-large";

/** How a file is shown: markdown rendered, anything else as plain text, never run. The source's own
    word wins when it gave one. Pure. */
export function fileKind(path: string, text?: string, said?: FolderItem["kind"]): FileKind {
  if (said === "binary" || said === "too-large") return said;
  if (text !== undefined && text.includes("\u0000")) return "binary";
  return MARKDOWN.test(path) ? "markdown" : "text";
}

/** Files in reading order: a folder's own files before its subfolders', the playbook or readme first, then by name. Pure. */
export function sortFiles(files: readonly FolderItem[]): FolderItem[] {
  const depth = (p: string) => p.split("/").length - 1;
  const lead = (p: string) => (/^(?:playbook|readme|skill)\.md$/i.test(p) ? 0 : 1);
  return [...files].sort((a, b) => depth(a.path) - depth(b.path) || lead(a.path) - lead(b.path) || a.path.localeCompare(b.path));
}

/** The file a viewer opens on: the first group's first file in reading order (or as listed, with `keepOrder`), or null when every group is empty. Pure. */
export function firstFile(lists: readonly { group: string; files: readonly FolderItem[] }[], keepOrder = false): { group: string; path: string } | null {
  for (const l of lists) {
    const f = (keepOrder ? l.files : sortFiles(l.files))[0];
    if (f) return { group: l.group, path: f.path };
  }
  return null;
}

/** "3 files" — the count a caller's row shows beside a folder. Pure. */
export const fileCount = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;

/** A file's size for the list, when the source said it ("2.1 KB"). Pure. */
export function sizeWords(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
