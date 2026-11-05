/**
 * The `src/` files the server and the chat processes load at runtime, found by walking the import graph from every
 * non-test file under `server/` and `shared/` (test support, golden fixtures, type-only imports and a `src/` file's own
 * lazy import() left out). The
 * test of `server/restart-paths.ts` holds its list to this walk. Node builtins only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.test\.[cm]?[jt]sx?$|\.fixture\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "testing", "golden", "tests", "fixtures"]);

function sources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(n)) sources(p, out);
    } else if (CODE.test(n) && !TEST.test(n) && !n.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The relative specifiers a file loads at runtime: static imports and re-exports that aren't type-only, bare
 *  side-effect imports and (with `dynamic`) import() of a string literal. */
export function runtimeSpecifiers(text: string, dynamic = true): string[] {
  const out: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[2]) continue;
    out.push(m[4]!);
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push(m[1]!);
  if (dynamic) for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out.filter((s) => s.startsWith("."));
}

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const tries = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const t of tries) {
    try {
      if (existsSync(t) && statSync(t).isFile()) return t;
    } catch {
      /* go on */
    }
  }
  return null;
}

/** The repo-relative `src/` files reachable at runtime from `server/` and `shared/`, sorted. */
export function serverImportedSrc(repo: string): string[] {
  const src = join(repo, "src") + "/";
  const seen = new Set<string>();
  const found = new Set<string>();
  const stack = [...sources(join(repo, "server")), ...sources(join(repo, "shared"))];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith(src)) found.add(relative(repo, f));
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // The server's own lazy imports run; a src/ file's lazy ones are the page's (a vis kind's Solid View), never the server's.
    for (const s of runtimeSpecifiers(text, !f.startsWith(src))) {
      const r = resolveSpec(f, s);
      // Only Sova's own code: what the walk reaches under server/, shared/ and src/ (pi-config counts whole already).
      if (r && !r.includes("/node_modules/") && (r.startsWith(src) || r.startsWith(join(repo, "server") + "/") || r.startsWith(join(repo, "shared") + "/"))) stack.push(r);
    }
  }
  return [...found].sort();
}
