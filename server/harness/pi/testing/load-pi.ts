// Loads the pi a test pins (§app.harness/boundary): the repo's copy, or the one PI_PACKAGE_DIR names (e.g.
// the global pi the TUI runs), so one suite proves either. Only server/harness/pi/ tests import pi, and they
// do it through here, never statically. pi-ai and typebox are resolved from the package's real path, the way
// Node would from inside it: under pnpm they sit beside it, in an npm global install under it (CLAUDE.md
// "pi SDK facts"; the sandbox suites' harness.mjs does the same with jiti).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type PiAgent = typeof import("@earendil-works/pi-coding-agent");

const REPO = resolve(import.meta.dirname, "../../../..");
export const piPackageDir = realpathSync(process.env.PI_PACKAGE_DIR ?? join(REPO, "node_modules/@earendil-works/pi-coding-agent"));

/** `name`'s directory as Node resolves it from inside `from`: each ancestor's node_modules, nearest first. */
function packageDirFrom(from: string, name: string): string {
  for (let d = from; ; d = dirname(d)) {
    const c = join(d, "node_modules", name);
    if (!d.endsWith("/node_modules") && existsSync(join(c, "package.json"))) return realpathSync(c);
    if (dirname(d) === d) throw new Error(`${name} not found from ${from}`);
  }
}

/** A package's ESM entry: exports["."] import/default, else main. */
function entryOf(dir: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const dot = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  const rel = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? pkg.main ?? "index.js");
  return pathToFileURL(join(dir, rel)).href;
}

export interface LoadedPi {
  /** @earendil-works/pi-coding-agent, as the test should use it. */
  agent: PiAgent;
  /** @earendil-works/pi-ai, untyped here: Sova's tsconfig can't see it (pnpm keeps it beside the package). */
  ai: Record<string, any>;
  /** typebox, the schema builder pi's tools take. */
  typebox: Record<string, any>;
  version: string;
  dir: string;
}

let loaded: Promise<LoadedPi> | undefined;
export function loadPi(): Promise<LoadedPi> {
  loaded ??= (async () => {
    const agent: PiAgent = process.env.PI_PACKAGE_DIR ? await import(entryOf(piPackageDir)) : await import("@earendil-works/pi-coding-agent");
    const ai = await import(entryOf(packageDirFrom(piPackageDir, "@earendil-works/pi-ai")));
    const typebox = await import(entryOf(packageDirFrom(piPackageDir, "typebox")));
    const version = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8")).version as string;
    return { agent, ai, typebox, version, dir: piPackageDir };
  })();
  return loaded;
}
