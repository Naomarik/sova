// Which runtime the server runs on: Bun, or Node when asked for (§app.server-runtime).
//
// One module for the launcher (scripts/start-server.sh runs it as a script: plain `node`, no tsx,
// so it stays erasable TypeScript with node builtins only), the dev watcher and the test runner
// (scripts/dev-server.mjs and scripts/run-tests.mjs import it) and the server (/api/health).
//
//   node server/runtime-choice.ts launch [--node]   # prints "node" or "bun\n<bun path>"; exits 1 when bun is missing

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type RuntimeName = "node" | "bun";
export interface RuntimeInfo { name: RuntimeName; version: string; chosen: RuntimeName }

type Env = Record<string, string | undefined>;

/** Node only when SOVA_RUNTIME=node (or the launcher's --node, which sets it); anything else is bun. */
export function chosenRuntime(env: Env = process.env): RuntimeName {
  return env.SOVA_RUNTIME?.trim() === "node" ? "node" : "bun";
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The Bun binary: $SOVA_BUN (only it, when set), else `bun` on PATH, else `mise which bun`. */
export function resolveBun(env: Env = process.env, mise: () => string | null = () => miseWhichBun(env)): { path: string } | { missing: string } {
  const pinned = env.SOVA_BUN;
  if (pinned) return isExecutableFile(pinned) ? { path: pinned } : { missing: `SOVA_BUN=${pinned} is not an executable file` };
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "bun");
    if (isExecutableFile(candidate)) return { path: candidate };
  }
  const viaMise = mise();
  if (viaMise && isExecutableFile(viaMise)) return { path: viaMise };
  return { missing: "no bun on PATH and `mise which bun` found none" };
}

function miseWhichBun(env: Env): string | null {
  try {
    const out = execFileSync("mise", ["which", "bun"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export type LaunchDecision = { runtime: "node" } | { runtime: "bun"; bun: string } | { runtime: "error"; error: string };

/** What to start. Bun wanted but not found is an error, never Node. */
export function launch(env: Env = process.env, mise: () => string | null = () => miseWhichBun(env)): LaunchDecision {
  if (chosenRuntime(env) === "node") return { runtime: "node" };
  const bun = resolveBun(env, mise);
  if ("missing" in bun) return { runtime: "error", error: `bun not found: ${bun.missing}; install it (mise install) or ask for node with SOVA_RUNTIME=node or --node` };
  return { runtime: "bun", bun: bun.path };
}

/** This process's runtime. */
export function currentRuntime(): { name: RuntimeName; version: string } {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node };
}

/** /api/health's runtime block, read once at start. */
export function runtimeInfo(env: Env = process.env): RuntimeInfo {
  return { ...currentRuntime(), chosen: chosenRuntime(env) };
}

// `node server/runtime-choice.ts launch [--node]`: the launcher's half. Line 1 is the runtime, line
// 2 the bun binary when it is bun. Bun missing: the reason on stderr, exit 1.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === "launch") {
  const d = launch(process.argv[3] === "--node" ? { ...process.env, SOVA_RUNTIME: "node" } : process.env);
  if (d.runtime === "error") {
    console.error(`[runtime] ${d.error}`);
    process.exit(1);
  }
  process.stdout.write(d.runtime === "bun" ? `bun\n${d.bun}\n` : "node\n");
}
