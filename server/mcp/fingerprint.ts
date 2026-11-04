// The version a person approves: the exact entry, and every file in the folder of any `./`
// path it names. Any change makes a new version. Sync, and read per call: what is on disk now is what counts.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { entryJson, type McpEntry } from "./config";

const SKIP = new Set([".git", "node_modules", ".worktrees", ".agent"]);
/** Above this a file counts by its size and time, not its bytes: a repository's root can be a `./` path's folder. */
const FILE_BYTES = 4 * 1024 * 1024;
const FILES_MAX = 20_000;

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}

const relative = (s: string) => s === "." || s.startsWith("./") || s.startsWith("../");

/** The folders of the entry's `./` paths, resolved from `base`. */
export function namedFolders(e: McpEntry, base: string): string[] {
  const paths = [e.command, ...(e.args ?? []), e.cwd].filter((s): s is string => typeof s === "string" && relative(s));
  return [...new Set(paths.map((p) => (p === "." ? base : dirname(resolve(base, p)))))].sort();
}

function folderLines(root: string, out: string[]): void {
  let count = 0;
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      out.push(`${root}/${rel}\0unreadable`);
      return;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      const path = join(root, child);
      try {
        const st = lstatSync(path);
        if (st.isDirectory()) {
          walk(child);
          continue;
        }
        if (++count > FILES_MAX) {
          out.push(`${root}\0too-many`);
          return;
        }
        if (st.isSymbolicLink()) out.push(`${child}\0link:${readlinkSync(path)}`);
        else if (!st.isFile()) out.push(`${child}\0other`);
        else if (st.size > FILE_BYTES) out.push(`${child}\0big:${st.size}:${st.mtimeMs}`);
        else out.push(`${child}\0${sha(readFileSync(path))}`);
      } catch {
        out.push(`${child}\0unreadable`);
      }
    }
  };
  walk("");
}

/** `base`: the checkout a project entry's `./` paths start from; the agent dir for a computer entry. */
export function versionOf(e: McpEntry, base: string): string {
  const lines = [JSON.stringify(stable({ name: e.name, ...entryJson(e) }))];
  for (const folder of namedFolders(e, base)) {
    lines.push(`# ${folder}`);
    folderLines(folder, lines);
  }
  return sha(lines.join("\n")).slice(0, 32);
}
