// Subfolder instruction files (AGENTS.md, CLAUDE.md) that load as the agent works: the first time a
// read, edit or write touches a file in a folder below the chat's cwd, that folder's instruction file
// (and each one between it and the cwd, outermost first) goes along at the end of the tool result, as
// its own text block. The branch itself records what loaded: a compaction or a rewind that removes a
// block lets the file load again. Harness-neutral; the pi hook is server/harness/pi/deeper-context.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HEntry } from "../shared/harness";

/** The names a folder's instruction file may have, in the order the first found wins (pi's own). */
export const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
/** The tools whose touch loads a folder's file. */
export const LOADING_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);
/** How many folders the tab's listing walks at most. */
export const SUBFOLDER_SCAN_CAP = 5000;

const TAG = "sova-instructions";
const HEADER = new RegExp(`^<${TAG} path="([^"\\n]+)">`);
/** A subfolder's skills block (server/subfolder-skills.ts) in the same result: not ours, and no end to the walk. */
const SKILLS_BLOCK = /^<sova-skills dir="[^"\n]+">/;

/** A folder name no walk enters: node_modules and hidden folders. */
export function skippedSegment(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

const posix = (p: string) => p.split(sep).join("/");

/** A tool's path argument as pi resolves it: a leading `@` dropped, `~` the home folder, relative to cwd. */
export function resolveToolPath(cwd: string, p: string): string {
  let s = p.startsWith("@") ? p.slice(1) : p;
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/** The folders strictly below `cwd` down to `file`'s folder, outermost first, less any with a skipped
    segment; none when `file` isn't inside `cwd`. */
export function candidateDirs(cwd: string, file: string): string[] {
  const rel = relative(resolve(cwd), dirname(resolve(file)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const out: string[] = [];
  let at = resolve(cwd);
  for (const seg of rel.split(sep)) {
    if (skippedSegment(seg)) break;
    at = join(at, seg);
    out.push(at);
  }
  return out;
}

/** A folder's instruction file: the first regular file of INSTRUCTION_NAMES, or null. */
export function instructionFileIn(dir: string): string | null {
  for (const name of INSTRUCTION_NAMES) {
    const p = join(dir, name);
    try {
      if (statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
    } catch {
      // unreadable: not this one
    }
  }
  return null;
}

/** The block a loaded file goes in: its relative path in the header, then its text. */
export function markerBlock(rel: string, text: string): string {
  return `<${TAG} path="${rel}">\n${text.replace(/\s+$/, "")}\n</${TAG}>`;
}

/** The one-line block for a file the agent read itself: its text is already in the result. */
export function selfReadMarker(rel: string): string {
  return `<${TAG} path="${rel}">(loaded: this read)</${TAG}>`;
}

/** The relative paths a tool result's own blocks loaded: its trailing text blocks that start with the
    header, never its first block (a tool's own output, which may be a file holding the header text). */
export function markersIn(blocks: readonly { type: string; text?: string }[]): string[] {
  const out: string[] = [];
  for (let k = blocks.length - 1; k >= 1; k--) {
    const b = blocks[k]!;
    if (b.type === "text" && SKILLS_BLOCK.test(b.text ?? "")) continue;
    const m = b.type === "text" ? HEADER.exec(b.text ?? "") : null;
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

/** The part of a branch the model still sees: after the latest compaction, plus that compaction's kept part. */
export function visiblePart(branch: readonly HEntry[]): readonly HEntry[] {
  for (let k = branch.length - 1; k >= 0; k--) {
    const e = branch[k]!;
    if (e.kind !== "compaction") continue;
    const kept = e.firstKeptEntryId ? branch.findIndex((x) => x.id === e.firstKeptEntryId) : -1;
    return branch.slice(kept >= 0 && kept < k ? kept : k + 1);
  }
  return branch;
}

/** The relative paths loaded on a branch, as its model sees it now. */
export function loadedInstructions(branch: readonly HEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of visiblePart(branch)) if (e.kind === "tool-result") for (const p of markersIn(e.blocks)) out.add(p);
  return out;
}

/** Whether a read with this offset and limit returned all of `text`: it starts at line 1 (offset absent or
    at most 1) and its limit, if any, covers every line. Models often send offset 1 and a large limit. */
export function wholeRead(text: string, r: { offset?: unknown; limit?: unknown }): boolean {
  const startsAtTop = r.offset === undefined || r.offset === null || (typeof r.offset === "number" && r.offset <= 1);
  const coversAll = r.limit === undefined || r.limit === null || (typeof r.limit === "number" && r.limit >= text.split("\n").length);
  return startsAtTop && coversAll;
}

export interface AttachOptions {
  /** The path (absolute or as the tool got it) the call touched. */
  path: string;
  /** A read's own path and range: when it is an instruction file read whole, only a marker is added. */
  selfRead?: { path: string; offset?: unknown; limit?: unknown };
  /** What the branch has loaded (read only when a candidate exists). */
  loaded: () => ReadonlySet<string>;
  /** Paths attached in this turn, not yet on the branch; the call's own are added. */
  inFlight: Set<string>;
  /** A file the chat may not be shown (an overseer's confinement and secrets). */
  allow?: (abs: string) => boolean;
}

/** The text blocks to append to a tool result, outermost first; none when nothing new loads. */
export function blocksToAttach(cwd: string, o: AttachOptions): string[] {
  const files = candidateDirs(cwd, resolveToolPath(cwd, o.path)).flatMap((dir) => instructionFileIn(dir) ?? []);
  if (!files.length) return [];
  const loaded = o.loaded();
  const self = o.selfRead ? resolveToolPath(cwd, o.selfRead.path) : undefined;
  const out: string[] = [];
  for (const f of files) {
    const rel = posix(relative(resolve(cwd), f));
    if (loaded.has(rel) || o.inFlight.has(rel) || (o.allow && !o.allow(f))) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    o.inFlight.add(rel);
    out.push(f === self && wholeRead(text, o.selfRead!) ? selfReadMarker(rel) : markerBlock(rel, text));
  }
  return out;
}

export interface SubfolderInstruction {
  /** Relative to the cwd, `/`-separated (api/AGENTS.md). */
  path: string;
  /** Its folder, relative (api). */
  dir: string;
  abs: string;
  chars: number;
  /** Whether its block is on the branch now. */
  loaded: boolean;
}

/** Every instruction file below `cwd` (its own excluded), outermost first, each loaded or not on `branch`;
    `incomplete` when the walk stopped at `cap` folders. */
export function listSubfolderInstructions(cwd: string, branch: readonly HEntry[], opts: { cap?: number } = {}): { files: SubfolderInstruction[]; incomplete: boolean } {
  const cap = opts.cap ?? SUBFOLDER_SCAN_CAP;
  const root = resolve(cwd);
  const loaded = loadedInstructions(branch);
  const files: SubfolderInstruction[] = [];
  const queue: string[] = [root];
  let seen = 0;
  let incomplete = false;
  while (queue.length) {
    const dir = queue.shift()!;
    if (dir !== root) {
      const f = instructionFileIn(dir);
      if (f) {
        let chars = 0;
        try {
          chars = readFileSync(f, "utf8").length;
        } catch {
          // unreadable: no size
        }
        const path = posix(relative(root, f));
        files.push({ path, dir: posix(relative(root, dir)), abs: f, chars, loaded: loaded.has(path) });
      }
    }
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !skippedSegment(d.name)).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (++seen > cap) {
        incomplete = true;
        queue.length = 0;
        break;
      }
      queue.push(join(dir, n));
    }
  }
  return { files, incomplete };
}
