// Personal minor modes: the user's own modes, offered in every project's mode menu. They live in one folder of
// the user's, `<state root>/minor-modes/<id>/MODE.md` (the state root of the server that started the chat, so a
// worker on its worktree's own agent dir reads the same folder and a hermetic agent dir has its own), in the very
// format of a project's `.sova/minor-modes/<id>/` (project-format.ts, read by project-discovery.ts's
// readProjectMode), so the copy a chat keeps, its sha, its prompt block and its tool names are a project mode's.
//
// "Yours wins": mergeModeListings puts them beside the chat's project modes with one entry per id, and a personal
// mode (or a broken personal folder) replaces the project's mode or broken folder of the same id. Built-in ids
// stay reserved (readProjectMode's `clash`). Approval is once for every project: keyed by the personal folder's
// real path, not the chat's checkout (approvalRootFor).
//
// Node builtins and pi-config's discovery only; no pi, no harness.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkoutRootOf, readProjectMode } from "../../pi-config/extensions/mode/project-discovery.ts";
import { projectRootOfModeDir } from "../../pi-config/extensions/mode/project-tools.ts";
import type { ProjectModeListing, ProjectModeProblem, ProjectModeSnapshot } from "../../shared/project-modes";
import { chatStateRoot } from "../state-root";

/** The personal modes folder: `<state root>/minor-modes`. Read per call (tests move the agent dir). */
export const personalModesDir = (): string => join(chatStateRoot(), "minor-modes");

/**
 * Every personal mode, read now: usable modes and broken folders, each sorted by folder name, under the
 * listing's `root` (the personal folder). No folder, no modes; never throws. `name` is empty: the menu names the
 * group itself.
 */
export function discoverPersonalModes(dir: string = personalModesDir()): ProjectModeListing {
  const listing: ProjectModeListing = { root: dir, name: "", modes: [], problems: [] };
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return listing;
  }
  for (const name of names) {
    const read = readProjectMode(dir, name);
    if ("kind" in read) listing.problems.push(read);
    else listing.modes.push(read);
  }
  return listing;
}

/**
 * A chat's listing with its personal modes merged in: a ProjectModeListing (root and name stay the project's,
 * so every reader of a project listing reads it unchanged), plus where the personal ones came from.
 */
export interface MergedModeListing extends ProjectModeListing {
  /** The personal folder read, or null when none was merged. */
  personalRoot: string | null;
  /** The ids (modes and broken folders) that are personal, sorted. */
  personalIds: string[];
  /** The personal ids that replaced a project mode or broken project folder of the same id, sorted. */
  replacedIds: string[];
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * "Yours wins": one entry per id. A personal mode or broken personal folder replaces the project's mode or broken
 * folder of the same id; every other entry of either is kept. Modes and problems each stay sorted by id.
 * `personal` null (e.g. a remote chat) leaves the project listing as it is.
 */
export function mergeModeListings(project: ProjectModeListing, personal: ProjectModeListing | null): MergedModeListing {
  if (personal === null || (personal.modes.length === 0 && personal.problems.length === 0)) {
    return { ...project, personalRoot: null, personalIds: [], replacedIds: [] };
  }
  const mine = new Set<string>([...personal.modes.map((m) => m.id), ...personal.problems.map((p) => p.id)]);
  const modes: ProjectModeSnapshot[] = [...project.modes.filter((m) => !mine.has(m.id)), ...personal.modes].sort(byId);
  const problems: ProjectModeProblem[] = [...project.problems.filter((p) => !mine.has(p.id)), ...personal.problems].sort(byId);
  const replaced = [...project.modes, ...project.problems].map((m) => m.id).filter((id) => mine.has(id));
  return { root: project.root, name: project.name, modes, problems, personalRoot: personal.root, personalIds: [...mine].sort(), replacedIds: [...new Set(replaced)].sort() };
}

/** Whether `id` in this listing is a personal mode that replaced the project's mode of that id. */
export function replacesProjectMode(listing: ProjectModeListing, id: string): boolean {
  return "replacedIds" in listing && (listing as MergedModeListing).replacedIds.includes(id);
}

/** Whether `id` in this listing is a personal mode. A plain ProjectModeListing has none. */
export function isPersonalId(listing: ProjectModeListing, id: string): boolean {
  return "personalIds" in listing && (listing as MergedModeListing).personalIds.includes(id);
}

/**
 * The key a mode's approvals are kept under: the personal folder for a personal mode (approved once, for every
 * project), else the chat's checkout. Null when the listing has no root for it.
 */
export function approvalRootFor(listing: ProjectModeListing, id: string): string | null {
  return isPersonalId(listing, id) ? (listing as MergedModeListing).personalRoot : listing.root;
}

/**
 * Whether a mode folder (a snapshot's `dir`) is one of the personal folder's: its parent is personalModesDir().
 * A chat's saved copy says where it came from by its folder, so a copy needs no field of its own.
 */
export function isPersonalDir(dir: string, personalDir: string = personalModesDir()): boolean {
  return dir !== "" && dirname(resolve(dir)) === resolve(personalDir);
}

/**
 * The key a saved copy's approvals are kept under, from its folder alone: the personal folder for a personal
 * mode, else the checkout its `.sova/minor-modes/<id>` sits in (what the mode menu keys it by).
 */
export function approvalRootOfDir(dir: string, personalDir: string = personalModesDir()): string {
  if (isPersonalDir(dir, personalDir)) return resolve(personalDir);
  const root = projectRootOfModeDir(dir);
  return checkoutRootOf(root) ?? root;
}

/**
 * The project root a mode's programs are given: the checkout its folder sits in, or, for a personal mode, the
 * checkout the chat runs in (the chat's cwd's, else the cwd itself).
 */
export function projectRootForDir(dir: string, cwd: string, personalDir: string = personalModesDir()): string {
  if (!isPersonalDir(dir, personalDir)) return projectRootOfModeDir(dir);
  return checkoutRootOf(cwd) ?? cwd;
}
