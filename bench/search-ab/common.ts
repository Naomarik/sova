// Shared paths and small helpers for bench/search-ab (plan.md). Nothing here is imported by Sova.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");

/** `--name value` from argv, else the default. */
export function opt(args: readonly string[], name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

/** The frozen copy (an agent-dir layout): `--copy`, SEARCH_AB_COPY, else <worktree>/.cache/search-ab/agent. */
export const copyDir = (args: readonly string[]): string =>
  resolve(opt(args, "copy") ?? process.env.SEARCH_AB_COPY ?? join(ROOT, ".cache", "search-ab", "agent"));

/** The private folder (queries, labels, grades, per-query ranks): `--private`, SEARCH_AB_PRIVATE,
    else ~/.pi/agent/sova/research/search-ab. Never inside the repo's tracked tree. */
export const privateDir = (args: readonly string[]): string => {
  const d = resolve(opt(args, "private") ?? process.env.SEARCH_AB_PRIVATE ?? join(homedir(), ".pi", "agent", "sova", "research", "search-ab"));
  if ((d + "/").startsWith(ROOT + "/") && !(d + "/").startsWith(join(ROOT, ".cache") + "/")) throw new Error(`refusing a private folder inside the repo's tracked tree: ${d}`);
  return d;
};

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
export function writeJson(p: string, v: unknown): void {
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
}

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** The session id of a `<ts>_<uuid>.jsonl` file name (sessions-index idOf). */
export const idOfFile = (name: string): string => name.replace(/\.jsonl$/, "").split("/").pop()!.split("_").pop() ?? "";

/** dev or heldout, by the sha256 of a key (plan.md, Split). */
export const splitOf = (key: string): "dev" | "heldout" => (parseInt(sha256(key).slice(-1), 16) % 2 === 0 ? "dev" : "heldout");

/** pi's folder name for the Overseer's cwd (the real one: the copy keeps the real folder names). */
export const OVERSEER_DIR = `--${join(homedir(), ".pi", "agent", "sova", "overseer").slice(1).replace(/\//g, "-")}--`;
