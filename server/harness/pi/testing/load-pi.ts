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
const PI_NAME = "@earendil-works/pi-coding-agent";
export const piPackageDir = realpathSync(process.env.PI_PACKAGE_DIR ?? join(REPO, "node_modules", PI_NAME));
/** Whether the caller named a pi (a canary run): read at load, before a test sets PI_PACKAGE_DIR itself. */
const callerPi = process.env.PI_PACKAGE_DIR !== undefined;

/**
 * Throws unless the checkout's pi is the one package.json pins, so a node_modules from another checkout
 * fails as that, never as behaviour diffs. A caller-set PI_PACKAGE_DIR (a canary run) is exempt.
 */
export function assertPinnedPi(): void {
  if (callerPi) return;
  const pinned = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).dependencies?.[PI_NAME] as string | undefined;
  const pkg = join(REPO, "node_modules", PI_NAME, "package.json");
  const found = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")).version as string) : "none";
  if (found !== pinned) throw new Error(`node_modules has pi ${found}, package.json pins ${pinned}: run pnpm install --frozen-lockfile (is node_modules from another checkout?)`);
}

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
    assertPinnedPi();
    const agent: PiAgent = process.env.PI_PACKAGE_DIR ? await import(entryOf(piPackageDir)) : await import("@earendil-works/pi-coding-agent");
    const ai = await import(entryOf(packageDirFrom(piPackageDir, "@earendil-works/pi-ai")));
    const typebox = await import(entryOf(packageDirFrom(piPackageDir, "typebox")));
    const version = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8")).version as string;
    return { agent, ai, typebox, version, dir: piPackageDir };
  })();
  return loaded;
}
