// A folder viewer group read through Sova's read-only folder routes (shared/folder-read.ts): any
// registered project's folder at a ref, or a folder Sova ships. The viewer itself knows nothing of this.
import type { FolderSource } from "../../shared/folder-read";
import { listFolder, readFolderFile } from "./api";
import type { FolderGroup } from "./folder-viewer";

/** Where a source's files come from, in one line: `.sova/playbooks/review at 97927e0`, "Shipped with Sova". */
export function sourceCaption(src: FolderSource): string {
  if (src.kind === "builtin") return "Shipped with Sova";
  return src.ref ? `${src.dir} at ${/^[0-9a-f]{40}$/.test(src.ref) ? src.ref.slice(0, 7) : src.ref}` : src.dir;
}

/** One group of the viewer, listed and read through the folder routes. */
export function folderGroup(o: { id: string; label: string; source: FolderSource; caption?: string }): FolderGroup {
  return {
    id: o.id,
    label: o.label,
    caption: o.caption ?? sourceCaption(o.source),
    list: async () => (await listFolder(o.source)).files,
    read: async (path) => {
      const f = await readFolderFile(o.source, path);
      return { text: f.text, ...(f.truncated ? { truncated: true } : {}) };
    },
  };
}
