import { DEFAULT_PROFILE, profileKey, type JoinedProfile, type ListedProfile } from "../shared/profiles";
import { builtinFallback, loadSubagentProfiles, profilesDefaultOf, readProfilesDefault } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { BUILTIN_PROFILE_IDS, readConnectedAccounts } from "../pi-config/extensions/subagents/builtin-profiles.ts";
import { buildJoined, findJoined } from "./joined-profiles";
import { builtinAccountConnected, defaultAmong, readDefaultProfileFile } from "./default-profile";
import { builtinSessionProfile, readHidden } from "./profile-sources";
import { readProfiles } from "./profiles-store";
import { agentRoot } from "./state-root";

/**
 * This computer's default profile as a project's coding sessions take it (§app.project-overseer/coding-mode),
 * read synchronously, for the project overseer's prompt and the project page's line: the joined list of yours and
 * the helper library (a coding session outside every project's own profiles), and the default the same way new
 * chats read it (default-profile.json, else the pair linking the saved default helpers, else the built-in profile the
 * connected accounts give). A default that names a project's profile reads as not chosen here, as it does outside its
 * project.
 */
export function codingDefaultProfile(dir = agentRoot()): JoinedProfile {
  const read = readProfiles();
  const yours: ListedProfile[] = read.ok ? read.file.profiles.map((p) => ({ ...p, source: "user" as const, key: profileKey({ source: "user", id: p.id }) })) : [];
  const off: ListedProfile = { ...DEFAULT_PROFILE, source: "sova", key: profileKey({ source: "sova", id: DEFAULT_PROFILE.id }) };
  const library = loadSubagentProfiles(dir);
  const builtins = [off, ...BUILTIN_PROFILE_IDS.filter((id) => !yours.some((y) => y.id === id)).map((id) => ({ ...builtinSessionProfile(id), source: "sova" as const, key: profileKey({ source: "sova", id }) }))];
  const rows = buildJoined({ sources: { builtins, yours, project: { state: "none", profiles: [] } as never }, library, hidden: readHidden(), connected: readConnectedAccounts(dir) });
  const fallback = builtinFallback(dir);
  const d = defaultAmong(rows, readDefaultProfileFile(), profilesDefaultOf(library, readProfilesDefault(dir), null).id, fallback);
  // A default nobody chose (the built-in profile the accounts give) is taken whole, as a new chat takes it: its model
  // after the project's coding model. Only its helpers when its account isn't connected (Claude with none connected).
  return d.fromAccounts && !builtinAccountConnected(d.row, dir) ? helpersOnly(d.row) : d.row;
}

/** A default nobody chose that can't run here: a coding session takes only its helpers, as a new chat does. */
const helpersOnly = (row: JoinedProfile): JoinedProfile => {
  const { session: _session, ...rest } = row;
  return rest;
};

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
  /** The library or built-in helper profile's id; absent: the session follows this computer's default helpers. */
  subagents?: string;
  /** Its session half, when it grants a session power: a named start writes it whole (by the Overseer). */
  grants?: { source: string; id: string };
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
    ...(row.libraryId ? { subagents: row.libraryId } : {}),
    ...(s && s.grant.length ? { grants: { source: s.source, id: s.id } } : {}),
  };
}

/** Why a profile named for a coding session's start can't be its start (null: it can). Its Models part and modes
    always fit. Tool removals, a first message or One at a time don't: a coding session needs its tools, sends its own
    brief and is counted by its build. Session powers come only with the mark "The Overseer may start it", which counts
    for both Overseers' coding starts, and the operator's approval of a project's profile. */
export function codingStartRefusal(row: JoinedProfile): string | null {
  if (row.unusable) return `${row.name} can't be used here: ${row.unusable}`;
  if (row.linkMissing) return `${row.name} can't be used here: ${row.linkMissing}`;
  const s = row.session;
  if (!s) return null;
  if (s.remove.length || s.singleton || (s.firstMessage ?? "").trim()) return `Coding sessions need their tools and send their own brief, so ${row.name} can't start one.`;
  if (s.grant.length && !s.overseerMayStart) return `${row.name} grants session powers and isn't marked "The Overseer may start it", so it can't start a coding session.`;
  if (s.grant.length && (row.approval === "needed" || s.approval === "needed")) return `${row.name} needs the operator's approval in Settings → Profiles first.`;
  return null;
}

/** An organization's sessions never take a profile's session powers (they show no picker, and what they may read
    and message is the organization's), so a start there naming one that grants them is refused before anything. */
export const orgPowersRefusal = (name: string) => `${name} grants session powers, which an organization's coding sessions never take, so it can't start one.`;

/**
 * The profile an Overseer names for a coding session in `cwd`, or the refusal sentence, checked before anything is
 * created or sent. `start`: for a start, which takes its modes too, so one that changes tools or powers is refused;
 * a switch of a running session moves only its Models part, which the switch itself checks again.
 */
export async function namedCodingProfile(id: string, cwd: string | null, start: boolean, inOrg = false): Promise<{ takes: CodingTakes } | { error: string }> {
  const row = await findJoined(id, cwd);
  if (!row) return { error: `Unknown profile: ${id}. sova_list_profiles lists them.` };
  const bad = start ? (codingStartRefusal(row) ?? (inOrg && row.session?.grant.length ? orgPowersRefusal(row.name) : null)) : row.approval === "needed" ? `${row.name} needs the operator's approval in Settings → Profiles first.` : null;
  return bad ? { error: bad } : { takes: codingTakesOf(row) };
}
