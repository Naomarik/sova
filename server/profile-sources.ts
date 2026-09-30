import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_ID,
  parseProfile,
  profileFileError,
  profileKey,
  type ListedProfile,
  type Profile,
  type ProfileProblem,
  type ProfileRef,
  type ProfileSource,
  type ProfilesListing,
} from "../shared/profiles";
import { approvalOf, readTrust } from "./profile-trust";
import { profilesFile, readProfiles } from "./profiles-store";
import { projectOf, type ProjectDeps } from "./project-root";
import { stateRoot } from "./state-root";

/**
 * Where profiles come from (§chat.profiles/projects): Default in code, the shipped `profiles/` at
 * the repo root ("Built in"), yours (`<state root>/session-profiles.json`) and the session's
 * project (`<project root>/.sova/profiles/<id>.json`). Read on every call, no cache, like
 * server/playbooks.ts; never written. A file that can't be read is a problem, never a failure.
 */

const SHIPPED_DIR = fileURLToPath(new URL("../profiles/", import.meta.url));
/** Where a project keeps its profiles, relative to its root. */
export const PROJECT_PROFILES = join(".sova", "profiles");

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface ProfileSourcesDeps extends ProjectDeps {
  shippedDir?: string;
  yoursFile?: string;
}

const listed = (p: Profile, source: ProfileSource, extra: Partial<ListedProfile> = {}): ListedProfile => ({
  ...p,
  source,
  key: profileKey({ source, id: p.id, ...(extra.project ? { project: extra.project } : {}) }),
  ...extra,
});

/** One profile per `<id>.json` in `dir`. A missing folder is empty. */
async function readDir(dir: string, source: ProfileSource, project?: { root: string; name: string }): Promise<{ profiles: ListedProfile[]; problems: ProfileProblem[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { profiles: [], problems: [] };
    return { profiles: [], problems: [{ source, file: dir, error: `Sova couldn't read this folder: ${(err as Error).message}` }] };
  }
  const profiles: ListedProfile[] = [];
  const problems: ProfileProblem[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = join(dir, name);
    const fail = (error: string) => problems.push({ source, file, error });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      fail(err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : `Sova couldn't read it: ${(err as Error).message}`);
      continue;
    }
    const error = profileFileError(raw);
    if (error) {
      fail(error);
      continue;
    }
    const p = parseProfile(raw) as Profile;
    const stem = name.slice(0, -".json".length);
    if (p.id !== stem) {
      fail(`Its id is "${p.id}", but the file is named ${name}. They must match.`);
      continue;
    }
    if (p.id === DEFAULT_PROFILE_ID) {
      fail(`"${DEFAULT_PROFILE_ID}" is Default's id; Default can't be replaced.`);
      continue;
    }
    profiles.push(listed(p, source, { file, ...(project ? { project: project.root, projectName: project.name } : {}) }));
  }
  return { profiles, problems };
}

const byLabel = (a: Profile, b: Profile) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

export interface ProfileSources {
  builtins: ListedProfile[];
  yours: ListedProfile[];
  yoursFile: string;
  yoursError?: string;
  project: ProfilesListing["project"];
  problems: ProfileProblem[];
}

/** Every profile a session in `cwd` can use, with approvals marked. */
export async function profileSources(cwd?: string | null, deps: ProfileSourcesDeps = {}): Promise<ProfileSources> {
  const yoursFile = deps.yoursFile ?? profilesFile();
  const read = readProfiles(yoursFile);
  const yours = read.ok ? read.file.profiles.map((p) => listed(p, "user", { file: yoursFile })).sort(byLabel) : [];
  const shipped = await readDir(deps.shippedDir ?? SHIPPED_DIR, "sova");
  // Yours replace a shipped profile of the same id, as a playbook of yours does.
  const builtins = [listed(DEFAULT_PROFILE, "sova"), ...shipped.profiles.filter((p) => !yours.some((y) => y.id === p.id)).sort(byLabel)];
  const where = await projectOf(cwd, deps);
  let project: ProfilesListing["project"];
  const problems = [...shipped.problems];
  if (where.state === "ok") {
    const dir = join(where.root, PROJECT_PROFILES);
    const found = await readDir(dir, "project", where);
    const trust = readTrust();
    for (const p of found.profiles) {
      const a = approvalOf(p, trust);
      if (a) p.approval = a;
    }
    project = { state: "ok", root: where.root, name: where.name, dir, profiles: found.profiles.sort(byLabel) };
    problems.push(...found.problems);
  } else project = { state: where.state, ...("message" in where ? { message: where.message } : {}), profiles: [] };
  return { builtins, yours, yoursFile, ...(read.ok ? {} : { yoursError: read.error }), project, problems };
}

/** A pick as it names a profile: a bare id, or `{source, id}`. */
export type ProfilePick = string | Pick<ProfileRef, "source" | "id">;

/**
 * The profile `pick` names for a session in `cwd` (§chat.profiles/projects): a bare id is looked
 * up in the project first, then yours, then built in; a source names its group. Null: none.
 */
export async function findProfile(pick: ProfilePick, cwd?: string | null, deps: ProfileSourcesDeps = {}): Promise<ListedProfile | null> {
  const src = await profileSources(cwd, deps);
  const groups: Record<ProfileSource, ListedProfile[]> = { project: src.project.profiles, user: src.yours, sova: src.builtins };
  if (typeof pick === "string") {
    for (const g of [groups.project, groups.user, groups.sova]) {
      const p = g.find((x) => x.id === pick);
      if (p) return p;
    }
    return null;
  }
  return groups[pick.source]?.find((x) => x.id === pick.id) ?? null;
}

// ---- hidden from the pickers ---------------------------------------------------------------------

export const hiddenFile = () => join(stateRoot(), "profile-hidden.json");

export function readHidden(file = hiddenFile()): string[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; hidden?: unknown };
    return raw?.version === 1 && Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter((x): x is string => typeof x === "string" && x !== `sova:${DEFAULT_PROFILE_ID}`))] : [];
  } catch {
    return [];
  }
}

/** Hide or show one profile, by identity. Default can't be hidden. */
export function setHidden(key: string, hidden: boolean, file = hiddenFile()): string[] {
  if (key === `sova:${DEFAULT_PROFILE_ID}`) throw new Error("Default can't be hidden.");
  const now = readHidden(file).filter((k) => k !== key);
  const next = hidden ? [...now, key] : now;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, hidden: next }, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}
