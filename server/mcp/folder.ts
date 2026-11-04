// Where a folder's `.mcp.json` lives, from the disk alone, so a chat's process can tell it has nothing to ask.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { readComputerList, projectListPath } from "./config";

export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The top of the checkout a folder is in, by its `.git`; null when it is in none. */
export function checkoutRootOf(cwd: string): string | null {
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Neither this computer nor the folder's checkout declares a server: a chat here has nothing to ask the server. */
export function nothingDeclared(cwd: string): boolean {
  return readComputerList().entries.length === 0 && !existsSync(projectListPath(checkoutRootOf(cwd) ?? real(cwd)));
}
