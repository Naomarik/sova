import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FolderListing } from "../shared/protocol";

/** Most entries one listing returns (the first ones in sort order); the rest set `truncated`. */
export const MAX_FOLDER_ENTRIES = 500;

export type FoldersResult =
  | { ok: true; listing: FolderListing }
  | { ok: false; status: 400 | 403 | 404; error: string };

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/**
 * GET /api/folders: the subdirectories of one folder, for the New Session folder picker.
 * Returns directory names only, never files. A symlink counts when its target is a directory
 * (flagged `symlink`); entries that can't be stat'ed (dangling, EACCES) are skipped. Dot folders
 * are hidden unless `hidden`. No `raw` path means $HOME.
 */
export async function listFolders(
  raw: string | undefined,
  opts: { hidden?: boolean; cap?: number } = {},
): Promise<FoldersResult> {
  if (raw !== undefined && raw !== "" && !isAbsolute(raw)) return { ok: false, status: 400, error: "path must be an absolute path" };
  const path = resolve(raw || homedir());
  try {
    if (!(await stat(path)).isDirectory()) return { ok: false, status: 404, error: "Not a folder" };
  } catch (err) {
    if (code(err) === "EACCES" || code(err) === "EPERM") return { ok: false, status: 403, error: "pi-web can't read this folder" };
    return { ok: false, status: 404, error: "Folder not found" };
  }
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (code(err) === "EACCES" || code(err) === "EPERM") return { ok: false, status: 403, error: "pi-web can't read this folder" };
    return { ok: false, status: 404, error: "Folder not found" };
  }
  const entries: FolderListing["entries"] = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (!opts.hidden && d.name.startsWith(".")) return;
      const full = join(path, d.name);
      if (d.isDirectory()) entries.push({ name: d.name, path: full });
      else if (d.isSymbolicLink()) {
        try {
          if ((await stat(full)).isDirectory()) entries.push({ name: d.name, path: full, symlink: true });
        } catch {
          // dangling or unreadable target: not a folder we can offer
        }
      }
    }),
  );
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : 1));
  const cap = opts.cap ?? MAX_FOLDER_ENTRIES;
  const parent = dirname(path);
  return {
    ok: true,
    listing: {
      path,
      parent: parent === path ? null : parent,
      entries: entries.slice(0, cap),
      truncated: entries.length > cap,
    },
  };
}
