// The changes viewer's file tree (§chat.changes/tree): folders from the changed paths, each
// summing what it holds, flattened into the rows a list draws given which folders are folded.
// Pure: the viewer owns the folded set.

export interface TreeFile {
  path: string;
  added: number;
  removed: number;
}

export interface DirRow<F extends TreeFile> {
  kind: "dir";
  /** Full folder path, the fold key ("src/lib"). */
  path: string;
  /** What the row says: one folder, or a chain of single-folder folders ("pi-config/extensions"). */
  name: string;
  depth: number;
  folded: boolean;
  files: number;
  added: number;
  removed: number;
  /** For fold tests and Expand/Collapse all. */
  children: (DirRow<F> | FileRow<F>)[];
}

export interface FileRow<F extends TreeFile> {
  kind: "file";
  path: string;
  name: string;
  depth: number;
  file: F;
}

export type TreeRow<F extends TreeFile> = DirRow<F> | FileRow<F>;

interface Node<F extends TreeFile> {
  dirs: Map<string, Node<F>>;
  files: F[];
}

/** The tree of `files`, folders before files, both by name; single-child folder chains merge. */
export function buildTree<F extends TreeFile>(files: F[]): TreeRow<F>[] {
  const root: Node<F> = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) node.dirs.set(seg, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(f);
  }
  const walk = (node: Node<F>, prefix: string, depth: number): TreeRow<F>[] => {
    const rows: TreeRow<F>[] = [];
    for (const [seg, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = seg;
      let path = prefix ? `${prefix}/${seg}` : seg;
      let n = child;
      while (n.files.length === 0 && n.dirs.size === 1) {
        const [s, only] = [...n.dirs][0]!;
        name += `/${s}`;
        path += `/${s}`;
        n = only;
      }
      const children = walk(n, path, depth + 1);
      const leaves = collectFiles(children);
      rows.push({
        kind: "dir",
        path,
        name,
        depth,
        folded: false,
        files: leaves.length,
        added: leaves.reduce((s, f) => s + f.added, 0),
        removed: leaves.reduce((s, f) => s + f.removed, 0),
        children,
      });
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", path: f.path, name: f.path.split("/").pop()!, depth, file: f });
    }
    return rows;
  };
  return walk(root, "", 0);
}

function collectFiles<F extends TreeFile>(rows: TreeRow<F>[]): F[] {
  return rows.flatMap((r) => (r.kind === "file" ? [r.file] : collectFiles(r.children)));
}

/** Every folder path in the tree: what "Collapse all" folds. */
export function allDirs<F extends TreeFile>(rows: TreeRow<F>[]): string[] {
  return rows.flatMap((r) => (r.kind === "dir" ? [r.path, ...allDirs(r.children)] : []));
}

/** The rows to draw: a folded folder shows, its contents don't. */
export function visibleRows<F extends TreeFile>(rows: TreeRow<F>[], folded: ReadonlySet<string>): TreeRow<F>[] {
  const out: TreeRow<F>[] = [];
  for (const r of rows) {
    if (r.kind === "file") {
      out.push(r);
      continue;
    }
    const isFolded = folded.has(r.path);
    out.push({ ...r, folded: isFolded });
    if (!isFolded) out.push(...visibleRows(r.children, folded));
  }
  return out;
}

/** The files in tree order (folders first at each level): the order next/previous file walk. */
export function treeOrder<F extends TreeFile>(rows: TreeRow<F>[]): F[] {
  return collectFiles(rows);
}
