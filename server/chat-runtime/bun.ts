// The Bun a worker chat's process runs on (al_3 stage 4, §app.chat-processes/workers): the server's
// own runtime when it is Bun, else `$SOVA_BUN`, else `bun` on the server's PATH, a mise shim resolved
// from Sova's own folder (never a worker's cwd, whose mise config must not pick the runtime). Found
// once, and kept.
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

/** What a worker start answers on a server that has no Bun to run the chat runtime. */
export const NO_BUN = "Workers need Bun to run Sova's chat runtime";

const REPO = resolve(import.meta.dirname, "..", "..");

export interface BunHost {
  env: NodeJS.ProcessEnv;
  execPath: string;
  /** `process.versions.bun`. */
  bunVersion: string | undefined;
  /** Where a mise shim is resolved (Sova's own folder). */
  cwd: string;
  /** `mise which bun` run in `cwd`; undefined when it fails. */
  miseWhich?: (mise: string, cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const realpath = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

function defaultMiseWhich(mise: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const out = execFileSync(mise, ["which", "bun"], { cwd, env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out && isAbsolute(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The Bun binary by the rules above, or null when there is none. */
export function resolveBun(host: BunHost): string | null {
  if (host.bunVersion) return host.execPath;
  const configured = host.env.SOVA_BUN;
  if (configured && isExecutable(configured)) return resolve(configured);
  for (const dir of (host.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, "bun");
    if (!isExecutable(file)) continue;
    if (!/^mise$/.test(basename(realpath(file)))) return file;
    const real = (host.miseWhich ?? defaultMiseWhich)(realpath(file), host.cwd, host.env);
    return real && isExecutable(real) ? real : null;
  }
  return null;
}

let cached: string | null | undefined;

/** This server's Bun for chat processes, found once. */
export function chatBun(): string | null {
  if (cached === undefined) cached = resolveBun({ env: process.env, execPath: process.execPath, bunVersion: process.versions.bun, cwd: REPO });
  return cached;
}
