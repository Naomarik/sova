// Paths as the harness writes them into files under docs/perf: relative to the repo root, or
// `~/`-prefixed outside it, never absolute (the repo is public; home paths stay out of it).
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");

export function shown(p, root = ROOT, home = homedir()) {
  if (p == null || p === "") return p;
  const abs = resolve(root, p);
  const inRepo = relative(root, abs);
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) return inRepo || ".";
  const inHome = relative(home, abs);
  if (!inHome.startsWith("..") && !isAbsolute(inHome)) return inHome ? `~/${inHome}` : "~";
  return abs;
}
