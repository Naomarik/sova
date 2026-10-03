// SSR for one component test, not for the app: registers synchronous module hooks
// (node:module's registerHooks, in this thread) that compile src/components/*.tsx with the same
// solid preset the vite build uses, in SSR mode (babel-preset-solid, generate: "ssr"), after
// esbuild strips TypeScript (jsx preserved for the preset to compile), and stub any .css import
// as an empty module. Nothing in the app imports this.
//
// esbuild travels with tsx, babel and the solid preset with vite-plugin-solid; reaching them
// through their dependents keeps the lockfile the only thing pinning their versions. registerHooks
// runs in this thread (unlike module.register's hook worker, whose globalThis this thread cannot
// reach), so the hooks close over the modules directly — no cross-realm globals.
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const req = createRequire(import.meta.url);
const esbuild = req(req.resolve("esbuild", { paths: [dirname(req.resolve("tsx"))] }));
const viteSolid = dirname(req.resolve("vite-plugin-solid"));
const babel = req(req.resolve("@babel/core", { paths: [viteSolid] }));
const solid = req(req.resolve("babel-preset-solid", { paths: [viteSolid] }));

let registered = false;

/** Idempotent: registers the hooks once, so a later import of a component compiles to SSR. */
export function ssrHooks() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith(".css")) return { url: "data:text/javascript,export default {}", shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.endsWith(".tsx") || !url.includes("/src/components/")) return nextLoad(url, context);
      const src = readFileSync(new URL(url), "utf8");
      const ts = esbuild.transformSync(src, { loader: "tsx", jsx: "preserve", target: "es2022" });
      const out = babel.transformSync(ts.code, {
        sourceType: "module",
        presets: [[solid, { generate: "ssr" }]],
      });
      return { format: "module", shortCircuit: true, source: out.code };
    },
  });
}
