import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PROFILE_ID, parseProfile, profileFileError, type Profile, type ProfilesFile } from "../shared/profiles";
import { stateRoot } from "./state-root";

/**
 * Your profiles, `<state root>/session-profiles.json` (§chat.profiles/projects, "Yours"): read on
 * every call. You or an agent edit it; Sova writes it only to add one profile you asked it to save
 * (addProfile: re-read, strict parse, temp + rename). A malformed file lists none of yours, with the
 * reason, and is never overwritten.
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

/** A profile id made from a name, unique among `taken`: "Claude + OpenAI" → "claude-openai", then "-2"… */
export function profileIdFor(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "profile";
  const stem = base === DEFAULT_PROFILE_ID ? "my-default" : base;
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

/** What Save Current As Profile writes: a name and what it sets, nothing else. */
export interface NewProfile {
  label: string;
  icon?: Profile["icon"];
  description?: string;
  model?: string;
  thinking?: Profile["thinking"];
  subagents?: string;
}

/**
 * Add one profile to your file (Save Current As Profile): re-reads the file first, refuses (throws a
 * sentence) when it doesn't parse or the name is already yours, gives the profile an unused id, and
 * replaces the file atomically. The profiles already there are kept exactly as written. Returns the
 * profile as the readers parse it.
 */
export function addProfile(fields: NewProfile, file = profilesFile()): Profile {
  let raw: { version: 1; profiles: unknown[] } & Record<string, unknown>;
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} can't be read (${(err as Error).message}), so nothing was saved.`);
  }
  let current: ProfilesFile;
  try {
    raw = text === null ? { version: 1, profiles: [] } : JSON.parse(text);
    current = parseProfilesFile(raw);
  } catch (err) {
    throw new Error(`${file} can't be read (${err instanceof Error ? err.message : String(err)}), so nothing was saved. Fix or remove it first.`);
  }
  const label = fields.label.trim();
  if (!label) throw new Error("Give the profile a name.");
  if (current.profiles.some((p) => p.label.toLowerCase() === label.toLowerCase())) throw new Error(`You already have a profile named "${label}". Pick another name.`);
  const id = profileIdFor(label, new Set(current.profiles.map((p) => p.id)));
  const entry: Record<string, unknown> = { id, label, icon: fields.icon ?? "wrench" };
  if (fields.description?.trim()) entry.description = fields.description.trim();
  if (fields.model) entry.model = fields.model;
  if (fields.thinking) entry.thinking = fields.thinking;
  if (fields.subagents) entry.subagents = fields.subagents;
  const error = profileFileError(entry);
  if (error) throw new Error(error);
  const next = { ...raw!, profiles: [...raw!.profiles, entry] };
  const parsed = parseProfilesFile(next); // the file as the readers (and the mesh) will check it
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return parsed.profiles.at(-1)!;
}
