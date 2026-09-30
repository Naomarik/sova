import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE_ID, parseProfile, profileFileError, type Profile, type ProfilesFile } from "../shared/profiles";
import { stateRoot } from "./state-root";

/**
 * Your profiles, `<state root>/session-profiles.json` (§chat.profiles/projects, "Yours"): read on
 * every call and never written by Sova. You or an agent edit it. A malformed file lists none of
 * yours, with the reason.
 */

export const profilesFile = () => join(stateRoot(), "session-profiles.json");

export type ProfilesRead = { ok: true; file: ProfilesFile } | { ok: false; error: string };

export function readProfiles(file = profilesFile()): ProfilesRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: true, file: { version: 1, profiles: [] } };
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
  for (const [i, p] of o.profiles.entries()) {
    const error = profileFileError(p);
    if (error) throw new Error(`profiles[${i}]: ${error}`);
    const parsed = parseProfile(p) as Profile;
    if (parsed.id === DEFAULT_PROFILE_ID) throw new Error(`"${DEFAULT_PROFILE_ID}" is Default's id`);
    if (profiles.some((x) => x.id === parsed.id)) throw new Error(`two profiles have the id "${parsed.id}"`);
    if (profiles.some((x) => x.label.toLowerCase() === parsed.label.toLowerCase())) throw new Error(`two profiles are named "${parsed.label}"`);
    profiles.push(parsed);
  }
  return { version: 1, profiles };
}
