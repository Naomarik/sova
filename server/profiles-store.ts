import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID, builtinProfile, parseProfile, type Profile, type ProfilesFile } from "../shared/profiles";
import { stateRoot } from "./state-root";

/**
 * The saved profiles, `<state root>/session-profiles.json` (§chat.profiles/model): read on every
 * call, written whole with a tmp + rename. A malformed file lists none of yours and refuses every
 * write, and is never overwritten.
 */

export const profilesFile = () => join(stateRoot(), "session-profiles.json");

export type ProfilesRead = { ok: true; file: ProfilesFile } | { ok: false; error: string };

export function readProfiles(file = profilesFile()): ProfilesRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: true, file: { version: 1, profiles: [], hiddenBuiltins: [] } };
  }
  try {
    return { ok: true, file: parseProfilesFile(JSON.parse(raw)) };
  } catch (err) {
    return { ok: false, error: `${file} can't be read (${err instanceof Error ? err.message : String(err)}), so your profiles aren't listed. Fix or remove it.` };
  }
}

/** Strict: throws with a sentence on anything that isn't a valid file. */
export function parseProfilesFile(raw: unknown): ProfilesFile {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.version !== 1 || !Array.isArray(o.profiles)) throw new Error("expected {version: 1, profiles: []}");
  const profiles: Profile[] = [];
  for (const p of o.profiles) {
    const parsed = parseProfile(p);
    if ("error" in parsed) throw new Error(parsed.error);
    if (builtinProfile(parsed.id)) throw new Error(`"${parsed.id}" is a built-in profile's id`);
    if (profiles.some((x) => x.id === parsed.id)) throw new Error(`two profiles have the id "${parsed.id}"`);
    if (profiles.some((x) => x.label.toLowerCase() === parsed.label.toLowerCase())) throw new Error(`two profiles are named "${parsed.label}"`);
    profiles.push(parsed);
  }
  const hidden = Array.isArray(o.hiddenBuiltins)
    ? [...new Set((o.hiddenBuiltins as unknown[]).filter((x): x is string => typeof x === "string" && !!builtinProfile(x) && x !== DEFAULT_PROFILE_ID))]
    : [];
  return { version: 1, profiles, hiddenBuiltins: hidden };
}

/** Write the whole file, or throw with the reason (a malformed file on disk is never replaced). */
export function writeProfiles(next: unknown, file = profilesFile()): ProfilesFile {
  const current = readProfiles(file);
  if (!current.ok) throw new Error(current.error);
  const parsed = parseProfilesFile(next);
  for (const p of parsed.profiles)
    if (BUILTIN_PROFILES.some((b) => b.label.toLowerCase() === p.label.toLowerCase())) throw new Error(`"${p.label}" is a built-in profile's name.`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(tmp, file);
  return parsed;
}

/** Add one profile (Save as Profile), refusing a taken name; returns it with its id. */
export function addProfile(raw: unknown, file = profilesFile()): Profile {
  const current = readProfiles(file);
  if (!current.ok) throw new Error(current.error);
  const o = { ...(raw as Record<string, unknown>) };
  const label = typeof o.label === "string" ? o.label.trim() : "";
  let id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "profile";
  const taken = (x: string) => !!builtinProfile(x) || current.file.profiles.some((p) => p.id === x);
  if (taken(id)) {
    let n = 2;
    while (taken(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const parsed = parseProfile({ ...o, id });
  if ("error" in parsed) throw new Error(parsed.error);
  writeProfiles({ ...current.file, profiles: [...current.file.profiles, parsed] }, file);
  return parsed;
}

/** A built-in or saved profile by id (null: none; a malformed file has none of yours). */
export function findProfile(id: string, file = profilesFile()): (Profile & { builtin: boolean }) | null {
  const b = builtinProfile(id);
  if (b) return { ...b, builtin: true };
  const r = readProfiles(file);
  const p = r.ok ? r.file.profiles.find((x) => x.id === id) : undefined;
  return p ? { ...p, builtin: false } : null;
}
