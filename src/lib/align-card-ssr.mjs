// SSR for one component test, not for the app: compiles a src/components/*.tsx and every component
// it imports with the same solid preset the vite build uses, in SSR mode (babel-preset-solid,
// generate: "ssr"), after esbuild strips TypeScript (jsx preserved for the preset to compile), into
// a temp dir, and imports the result. A .css import becomes an empty module. No module hooks, so it
// works the same under node and bun (bun has no node:module hooks and compiles JSX React-style).
// Every specifier in the compiled files is rewritten to an absolute URL: bare ones resolve from the
// caller (the default conditions, so Solid's server build, the one renderToString needs), .ts
// modules stay the originals the runtime compiles itself. Nothing in the app imports this.
//
// esbuild travels with tsx, babel and the solid preset with vite-plugin-solid; reaching them
// through their dependents keeps the lockfile the only thing pinning their versions.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const req = createRequire(import.meta.url);
const esbuild = req(req.resolve("esbuild", { paths: [dirname(req.resolve("tsx"))] }));
const viteSolid = dirname(req.resolve("vite-plugin-solid"));
const babel = req(req.resolve("@babel/core", { paths: [viteSolid] }));
const solid = req(req.resolve("babel-preset-solid", { paths: [viteSolid] }));

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const EXTS = ["", ".tsx", ".ts", ".mjs", ".js", "/index.tsx", "/index.ts"];

/**
 * The module `entry` (a .tsx URL) compiled for SSR, imported. `resolveBare` resolves a bare
 * specifier as the caller would (pass the caller's `import.meta.resolve`).
 */
export async function importSsr(entry, resolveBare) {
  const out = mkdtempSync(join(tmpdir(), "sova-ssr-"));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
  const stub = join(out, "empty.mjs");
  writeFileSync(stub, "export default {};\n");
  const done = new Map(); // source path → compiled path
  let n = 0;
  const compile = (file) => {
    if (done.has(file)) return done.get(file);
    const target = join(out, `${n++}-${file.split("/").pop().replace(/\.tsx$/, "")}.mjs`);
    done.set(file, target);
    const ts = esbuild.transformSync(readFileSync(file, "utf8"), { loader: "tsx", jsx: "preserve", target: "es2022" });
    const code = babel.transformSync(ts.code, { sourceType: "module", presets: [[solid, { generate: "ssr" }]], filename: file }).code;
    writeFileSync(target, code.replace(SPECIFIER, (_m, head, q, spec) => `${head}${q}${locate(spec, file)}${q}`));
    return target;
  };
  const locate = (spec, from) => {
    if (spec.endsWith(".css")) return pathToFileURL(stub).href;
    if (!spec.startsWith(".")) return resolveBare(spec);
    const base = join(dirname(from), spec);
    const file = EXTS.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile());
    if (!file) throw new Error(`align-card-ssr: ${spec} from ${from} not found`);
    return pathToFileURL(file.endsWith(".tsx") ? compile(file) : file).href;
  };
  return import(pathToFileURL(compile(fileURLToPath(entry))).href);
}
