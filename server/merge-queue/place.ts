import { homedir } from "node:os";
import { type BranchPlace } from "../../shared/merge-queue";
import { shortestTail } from "../../shared/tell-apart";
import { servedKey } from "../../pi-config/extensions/worktrees/served.ts";
import { folderMatcher } from "../project-folder";
import type { ProjectOf } from "../project-root";

/**
 * A branch's place (§chat.worktrees/place): which project it belongs to and where it merges. One rule for every
 * surface, so the name a row shows is the one Land follows: the repository's main checkout matched on the Projects
 * list as ServedRule matches it.
 */

/** A project as the list holds it, archived ones too: an archived project's folder is still the repository's. */
export interface PlaceProject {
  root: string;
  name?: string;
  archived?: unknown;
}

export interface PlaceDeps {
  listed: () => PlaceProject[];
  projectOf: (path: string) => Promise<ProjectOf>;
  exists: (path: string) => boolean;
  /** A remote session's placeholder folder, read as its target and its folder there; null: a folder of this computer. */
  remote?: (path: string) => { target: string; remoteCwd: string } | null;
  /** What a repository's branches merge into now; undefined: not known. Absent: the place carries no target. */
  targetOf?: (root: string) => Promise<string | undefined>;
  home?: string;
}

const fromHome = (p: string, home: string): string => (home && p === home ? "~" : home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const nameOf = (p: PlaceProject): string => (typeof p.name === "string" ? p.name.trim() : "");

/** The words for repository `root`: its project's name when it is listed, not archived and named, with just enough of
 *  its folder when another listed project has that name; else its folder from home. */
export function placeLabel(root: string, listed: readonly PlaceProject[], home: string = homedir()): string {
  const key = servedKey(root);
  const named = listed.filter((p) => !p.archived && typeof p.root === "string" && p.root);
  const own = named.find((p) => servedKey(p.root) === key);
  const name = own ? nameOf(own) : "";
  if (!own || !name) return fromHome(root, home);
  const namesakes = [...new Set(named.filter((p) => nameOf(p) === name).map((p) => fromHome(servedKey(p.root), home)))];
  return namesakes.length < 2 ? name : `${name} · ${shortestTail(namesakes, fromHome(key, home))}`;
}

/** The repository `path` belongs to: git's answer while its folder is there, else what the Projects list can still
 *  work out; null when neither knows. */
async function rootOf(d: PlaceDeps, path: string, listed: readonly PlaceProject[]): Promise<string | null> {
  if (d.exists(path)) {
    const p = await d.projectOf(path).catch(() => null);
    if (p?.state === "ok" && p.git) return p.root;
  }
  const at = folderMatcher(listed.map((p, i) => ({ id: String(i), root: p.root })), undefined, { husks: true })(path);
  return at === null ? null : listed[Number(at)]!.root;
}

function listedOf(d: PlaceDeps): PlaceProject[] {
  try {
    return d.listed().filter((p) => typeof p.root === "string" && p.root);
  } catch {
    return [];
  }
}

/** The place of the branch whose folder is (or was) `path`. A repository nothing can work out reads the folder as
 *  last recorded, with no root and no target; so does a remote session's folder, never matched on this computer's list. */
export async function branchPlace(d: PlaceDeps, path: string): Promise<BranchPlace> {
  const away = d.remote?.(path);
  if (away) return { label: `${away.target}:${away.remoteCwd}` };
  const home = d.home ?? homedir();
  const listed = listedOf(d);
  const root = await rootOf(d, path, listed);
  if (root === null) return { label: fromHome(path, home) };
  const target = await d.targetOf?.(root).catch(() => undefined);
  return { label: placeLabel(root, listed, home), root, ...(target ? { target } : {}) };
}
