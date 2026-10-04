// Which runtime the server runs on, Node or Bun (§app.server-runtime).
//
// One module for the launcher (scripts/start-server.sh runs it as a script: plain `node`, no tsx,
// so it stays erasable TypeScript with node builtins only), the dev watcher
// (scripts/dev-server.mjs imports it) and the server (/api/health, the boot counter reset).
//
//   node server/runtime-choice.ts launch   # prints "node" or "bun\n<bun path>"; may fall back

import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type RuntimeName = "node" | "bun";
export interface RuntimeFallback { at: string; reason: string }
export interface RuntimeInfo { name: RuntimeName; version: string; chosen: RuntimeName; fallback?: RuntimeFallback }

/** Bun boots in a row that never reached listening before the launcher gives up on Bun. */
export const MAX_FAILED_BUN_BOOTS = 3;

type Env = Record<string, string | undefined>;

/** `<agent dir>/sova`, the agent dir read like pi's getAgentDir (a leading `~` expanded). */
export function runtimeStateRoot(env: Env = process.env): string {
  let dir = env.PI_CODING_AGENT_DIR;
  if (dir === "~") dir = homedir();
  else if (dir?.startsWith("~/")) dir = join(homedir(), dir.slice(2));
  return join(dir || join(homedir(), ".pi", "agent"), "sova");
}

export const runtimeFile = (root: string) => join(root, "runtime.json");
export const fallbackFile = (root: string) => join(root, "runtime-fallback.json");
export const bootsFile = (root: string) => join(root, "runtime-bun-boots");

const isRuntime = (v: unknown): v is RuntimeName => v === "node" || v === "bun";

/** The runtime.json text → its choice; anything but a well-formed `{"runtime": "node"|"bun"}` is node. */
export function parseRuntimeSetting(text: string | null | undefined): RuntimeName {
  if (!text) return "node";
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const r = (v as { runtime?: unknown }).runtime;
      if (isRuntime(r)) return r;
    }
  } catch {
    /* malformed: node */
  }
  return "node";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** SOVA_RUNTIME when it names a runtime, else the state root's runtime.json. */
export function chosenRuntime(env: Env = process.env, root = runtimeStateRoot(env)): RuntimeName {
  const forced = env.SOVA_RUNTIME?.trim();
  if (isRuntime(forced)) return forced;
  return parseRuntimeSetting(readText(runtimeFile(root)));
}

/** The boot counter's value; missing or garbage is 0. */
export function readBunBoots(root: string): number {
  const n = Number.parseInt(readText(bootsFile(root))?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

export type LaunchDecision =
  | { runtime: "node"; resetBoots: boolean; fallback?: string }
  | { runtime: "bun"; bun: string; boots: number };

/** The launcher's pure decision: what to start, and whether that is a fallback (with its reason). */
export function decideLaunch(chosen: RuntimeName, bun: { path: string } | { missing: string }, failedBoots: number): LaunchDecision {
  if (chosen === "node") return { runtime: "node", resetBoots: true };
  if ("missing" in bun) return { runtime: "node", resetBoots: false, fallback: `bun chosen but not found: ${bun.missing}` };
  if (failedBoots >= MAX_FAILED_BUN_BOOTS)
    return { runtime: "node", resetBoots: false, fallback: `bun started ${failedBoots} times in a row without the server listening; delete runtime-bun-boots in the state root to retry bun` };
  return { runtime: "bun", bun: bun.path, boots: failedBoots + 1 };
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Decide, then apply the side effects: the boot counter and the fallback record. */
export function launch(env: Env = process.env, root = runtimeStateRoot(env)): LaunchDecision {
  const chosen = chosenRuntime(env, root);
  const decision = decideLaunch(chosen, chosen === "bun" ? resolveBun(env) : { missing: "" }, readBunBoots(root));
  try {
    mkdirSync(root, { recursive: true });
    if (decision.runtime === "bun") writeAtomic(bootsFile(root), `${decision.boots}\n`);
    else {
      if (decision.resetBoots) rmSync(bootsFile(root), { force: true });
      if (decision.fallback) writeAtomic(fallbackFile(root), `${JSON.stringify({ at: new Date().toISOString(), reason: decision.fallback } satisfies RuntimeFallback)}\n`);
    }
  } catch (err) {
    console.error(`[runtime] could not write the runtime state in ${root}: ${(err as Error).message}`);
  }
  return decision;
}

/** This process's runtime. */
export function currentRuntime(): { name: RuntimeName; version: string } {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node };
}

/** The fallback record, when it parses. */
export function readFallback(root: string): RuntimeFallback | undefined {
  try {
    const v = JSON.parse(readText(fallbackFile(root)) ?? "") as Partial<RuntimeFallback>;
    if (typeof v?.at === "string" && typeof v.reason === "string") return { at: v.at, reason: v.reason };
  } catch {
    /* none */
  }
  return undefined;
}

/** /api/health's runtime block, read once at start. */
export function runtimeInfo(env: Env = process.env, root = runtimeStateRoot(env)): RuntimeInfo {
  const cur = currentRuntime();
  const chosen = chosenRuntime(env, root);
  const info: RuntimeInfo = { ...cur, chosen };
  if (cur.name !== chosen) {
    const fallback = readFallback(root);
    if (fallback) info.fallback = fallback;
  }
  return info;
}

/** Called once the server listens: a Bun boot reached healthy, so the failed-boot count starts over. */
export function markListening(root = runtimeStateRoot()): void {
  if (currentRuntime().name !== "bun") return;
  try {
    rmSync(bootsFile(root), { force: true });
  } catch {
    /* best effort */
  }
}

// `node server/runtime-choice.ts launch`: the launcher's half. Line 1 is the runtime, line 2 the
// bun binary when it is bun. A fallback's reason goes to stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === "launch") {
  const d = launch();
  if (d.runtime === "node" && d.fallback) console.error(`[runtime] falling back to node: ${d.fallback}`);
  process.stdout.write(d.runtime === "bun" ? `bun\n${d.bun}\n` : "node\n");
}
