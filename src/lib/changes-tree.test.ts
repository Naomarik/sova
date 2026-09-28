import assert from "node:assert/strict";
import { test } from "node:test";
import { allDirs, buildTree, treeOrder, visibleRows } from "./changes-tree";

const f = (path: string, added = 1, removed = 0) => ({ path, added, removed });
const files = [f("src/lib/format.ts", 3, 2), f("src/lib/dates.ts", 2), f("server/git-stats.ts", 4, 1), f("README.md"), f("pi-config/extensions/show/index.ts", 10)];

test("folders first, sums per folder, single-folder chains merge", () => {
  const rows = visibleRows(buildTree(files), new Set());
  assert.deepEqual(
    rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? `${r.name}/ ${r.files} +${r.added} −${r.removed}` : r.name}`),
    [
      "pi-config/extensions/show/ 1 +10 −0",
      "  index.ts",
      "server/ 1 +4 −1",
      "  git-stats.ts",
      "src/lib/ 2 +5 −2",
      "  dates.ts",
      "  format.ts",
      "README.md",
    ],
  );
});

test("a folded folder shows its row and hides its contents; Collapse all folds every folder", () => {
  const tree = buildTree(files);
  const rows = visibleRows(tree, new Set(["src/lib"]));
  const lib = rows.find((r) => r.path === "src/lib");
  assert.equal(lib?.kind === "dir" && lib.folded, true);
  assert.equal(rows.some((r) => r.path === "src/lib/dates.ts"), false);
  assert.deepEqual(visibleRows(tree, new Set(allDirs(tree))).map((r) => r.name), ["pi-config/extensions/show", "server", "src/lib", "README.md"]);
});

test("nested folders keep their own fold, and tree order walks files as drawn", () => {
  const tree = buildTree([f("a/b/one.ts"), f("a/two.ts"), f("a/b/c/three.ts")]);
  assert.deepEqual(allDirs(tree), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(treeOrder(tree).map((x) => x.path), ["a/b/c/three.ts", "a/b/one.ts", "a/two.ts"]);
  assert.deepEqual(visibleRows(tree, new Set(["a/b"])).map((r) => r.path), ["a", "a/b", "a/two.ts"]);
});
