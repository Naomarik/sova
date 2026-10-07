// `run-tests.mjs --changed`: which test files a change may break. Builtins only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The root-relative files changed since the merge base of `base` and HEAD: committed, uncommitted and untracked. Throws when there's no merge base. */
export function changedSince(root, base) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const from = git("merge-base", base, "HEAD").trim();
  const list = (out) => out.split("\n").filter(Boolean);
  return [...new Set([...list(git("diff", "--name-only", from)), ...list(git("ls-files", "--others", "--exclude-standard"))])];
}

// Static and dynamic imports, re-exports and requires of a relative path (a package import can't name a changed file).
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](\.{1,2}\/[^"'`$]+)["'`]/g;

/** The root-relative file a relative import names, as the runtimes resolve it (extensionless, .js for .ts, index files); null when none. */
export function resolveImport(root, fromFile, spec) {
  const base = path.resolve(path.dirname(path.join(root, fromFile)), spec.replace(/[?#].*$/, ""));
  const tries = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const hit = tries.find((p) => p.startsWith(root + path.sep) && fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  return hit ? path.relative(root, hit) : null;
}

/** Of `files` (root-relative test files), those a change to `changed` may break: their import closure holds a changed file, or they share a changed file's folder. */
export function affected(root, files, changed) {
  const changedSet = new Set(changed);
  const changedDirs = new Set(changed.map((f) => path.dirname(f)));
  const imports = new Map();
  const importsOf = (f) => {
    if (!imports.has(f)) {
      let text = "";
      try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { /* deleted: imports nothing */ }
      imports.set(f, [...text.matchAll(IMPORT_RE)].map((m) => resolveImport(root, f, m[1])).filter(Boolean));
    }
    return imports.get(f);
  };
  const reaches = (start) => {
    const seen = new Set([start]);
    const todo = [start];
    while (todo.length) {
      const f = todo.pop();
      if (changedSet.has(f)) return true;
      for (const g of importsOf(f)) if (!seen.has(g)) { seen.add(g); todo.push(g); }
    }
    return false;
  };
  return files.filter((f) => changedDirs.has(path.dirname(f)) || reaches(f));
}
