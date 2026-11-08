import { DEFAULT_PROFILE, profileKey, type JoinedProfile, type ListedProfile } from "../shared/profiles";
import { loadSubagentProfiles, profilesDefaultOf, readProfilesDefault } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { buildJoined, findJoined } from "./joined-profiles";
import { defaultAmong, readDefaultProfileFile } from "./default-profile";
import { readHidden } from "./profile-sources";
import { readProfiles } from "./profiles-store";
import { agentRoot } from "./state-root";

/**
 * This computer's default profile as a project's coding sessions take it (§app.project-overseer/coding-mode),
 * read synchronously, for the project overseer's prompt and the project page's line: the joined list of yours and
 * the helper library (a coding session outside every project's own profiles), and the default the same way new
 * chats read it (default-profile.json, else the pair linking the saved default helpers, else Off). A default that
 * names a project's profile reads as Off here, as it does outside its project.
 */
export function codingDefaultProfile(dir = agentRoot()): JoinedProfile {
  const read = readProfiles();
  const yours: ListedProfile[] = read.ok ? read.file.profiles.map((p) => ({ ...p, source: "user" as const, key: profileKey({ source: "user", id: p.id }) })) : [];
  const off: ListedProfile = { ...DEFAULT_PROFILE, source: "sova", key: profileKey({ source: "sova", id: DEFAULT_PROFILE.id }) };
  const library = loadSubagentProfiles(dir);
  const rows = buildJoined({ sources: { builtins: [off], yours, project: { state: "none", profiles: [] } as never }, library, hidden: readHidden() });
  return defaultAmong(rows, readDefaultProfileFile(), profilesDefaultOf(library, readProfilesDefault(dir)).id).row;
}

/** What a coding session takes from a profile (§app.project-overseer/coding-mode): its mode and add-ons, its This
    chat model and effort, and its helpers' id. Never its tools, powers, One at a time or first message: a coding
    session gets what the three older defaults gave it, and no more, so no profile widens what one can do. */
export interface CodingTakes {
  id: string;
  name: string;
  mode?: "normal" | "delegate";
  minorModes?: string[];
  model?: string;
  thinking?: string;
  /** The library id, or "off"; absent: the session follows this computer's default helpers. */
  subagents?: string;
}

export function codingTakesOf(row: JoinedProfile): CodingTakes {
  const s = row.session;
  return {
    id: row.id,
    name: row.name,
    ...(s?.mode === "normal" || s?.mode === "delegate" ? { mode: s.mode } : {}),
    ...(s?.minorModes ? { minorModes: [...s.minorModes] } : {}),
    ...(s?.model ? { model: s.model } : {}),
    ...(s?.thinking ? { thinking: s.thinking } : {}),
    ...(row.kind === "off" ? { subagents: "off" } : row.libraryId ? { subagents: row.libraryId } : {}),
  };
}

/** Why a profile named for a coding session's start can't be its start (null: it can): one that changes tools or
    session powers, since a coding session takes only a profile's models and modes, and one awaiting approval. */
export function codingStartRefusal(row: JoinedProfile): string | null {
  if (row.approval === "needed") return `${row.name} needs the operator's approval in Settings → Profiles first.`;
  if (row.unusable) return `${row.name} can't be used here: ${row.unusable}`;
  if (row.linkMissing) return `${row.name} can't be used here: ${row.linkMissing}`;
  const s = row.session;
  if (s && (s.remove.length || s.grant.length || s.singleton || (s.firstMessage ?? "").trim()))
    return `${row.name} changes tools or session powers, which a coding session never takes from a profile. Name one that sets only models and modes, or use subagent_profile for its helpers.`;
  return null;
}

/**
 * The profile an Overseer names for a coding session in `cwd`, or the refusal sentence, checked before anything is
 * created or sent. `start`: for a start, which takes its modes too, so one that changes tools or powers is refused;
 * a switch of a running session moves only its Models part, which the switch itself checks again.
 */
export async function namedCodingProfile(id: string, cwd: string | null, start: boolean): Promise<{ takes: CodingTakes } | { error: string }> {
  const row = await findJoined(id, cwd);
  if (!row) return { error: `Unknown profile: ${id}. sova_list_profiles lists them.` };
  const bad = start ? codingStartRefusal(row) : row.approval === "needed" ? `${row.name} needs the operator's approval in Settings → Profiles first.` : null;
  return bad ? { error: bad } : { takes: codingTakesOf(row) };
}
