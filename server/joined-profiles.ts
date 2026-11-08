import { DEFAULT_PROFILE_ID, KEEPS_OWN_MODEL, keyOf, OFF_ID, OFF_KEY, type JoinedProfile, type ListedProfile } from "../shared/profiles";
import type { SubagentProfile } from "../shared/subagent-profiles";
import {
  loadSubagentProfiles, profileWorkers, shortModel, workerProvider, type ProfilesState,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { agentRoot } from "./state-root";
import { profileSources, readHidden, type ProfileSources } from "./profile-sources";

/**
 * The one list of profiles (§chat.profiles/joined), built from the two saved lists, which stay as
 * they are: the session profiles (yours, Sova's shipped files and the session's project) and the
 * helper library (`subagent-profiles.json`). A session profile whose `subagents` names a library
 * profile is one row with both parts; a library profile no listed session profile links is a row
 * of its own (Models part only); a session profile with no link is a row with no helpers. Nothing
 * is written here.
 */

/** What the list is built from: the session profiles and the library as read now. */
export interface JoinInputs {
  sources: Pick<ProfileSources, "builtins" | "yours" | "project">;
  library: ProfilesState;
  hidden?: readonly string[];
  running?: Record<string, { id: string; path: string; title: string }>;
  unusable?: Record<string, string>;
  /** Model display names by ref (models.ts modelNames), for the footprints. */
  names?: ReadonlyMap<string, string>;
}

/** The roles a library profile sets: Delegate's four kinds, the coordinator and monitor, members, spec writer, reviewer. */
export function helperRoles(lib: SubagentProfile | undefined): number {
  if (!lib) return 0;
  return 4 + (lib.teams ? 2 : 0) + (lib.members ? 1 : 0) + (lib.specWriter ? 1 : 0) + (lib.reviewer ? 1 : 0);
}

/** The footprint (§chat.profiles/joined): distinct models, the chat's own first, " + ", at most 3 then "+N". */
export function joinedFootprint(model: string | undefined, lib: SubagentProfile | undefined, max = 3, known: ReadonlyMap<string, string> = new Map()): string {
  const names: string[] = [];
  const add = (m: string) => {
    // A Claude model by its catalog name; another by the name pi's registry gives it, else its id.
    const short = shortModel(m);
    const n = short !== (m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m) ? short : (known.get(m) ?? short);
    if (!names.includes(n)) names.push(n);
  };
  if (model) add(model);
  if (lib) for (const w of profileWorkers(lib, false)) add(w.model);
  if (!names.length) return KEEPS_OWN_MODEL;
  return names.length > max ? `${names.slice(0, max).join(" + ")} +${names.length - max}` : names.join(" + ");
}

/** Every provider both parts spend, fallbacks included. */
export function joinedProviders(model: string | undefined, lib: SubagentProfile | undefined): string[] {
  const out = new Set<string>();
  if (model) out.add(workerProvider({ backend: "pi", model }));
  if (lib) for (const w of profileWorkers(lib)) out.add(workerProvider(w));
  return [...out];
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** The library id a session profile links, or undefined (none, or "off"). */
export const linkOf = (p: { subagents?: string }): string | undefined => (p.subagents && p.subagents !== OFF_ID ? p.subagents : undefined);

/** Build the list. Pure: the tests drive it with plain values. */
export function buildJoined(input: JoinInputs): JoinedProfile[] {
  const lib = input.library.state === "ok" ? input.library.value.profiles : [];
  const libError = input.library.state === "malformed" ? `the helper library can't be read (${input.library.errors.join("; ")})` : null;
  const hidden = new Set(input.hidden ?? []);
  const running = input.running ?? {};
  const unusable = input.unusable ?? {};
  const fromSession = (p: ListedProfile, kind: JoinedProfile["kind"], group: JoinedProfile["group"]): JoinedProfile => {
    const libraryId = linkOf(p);
    const library = libraryId ? lib.find((l) => l.id === libraryId) : undefined;
    const key = p.key ?? keyOf(p);
    return {
      key,
      id: p.id,
      kind: kind === "session" && libraryId ? "pair" : kind,
      group,
      name: p.label,
      session: p,
      ...(libraryId ? { libraryId } : {}),
      ...(library ? { library } : {}),
      ...(libraryId && !library
        ? { linkMissing: libError ? `Its helpers can't be shown: ${libError}.` : `Its helpers ("${libraryId}") aren't on this device yet.` }
        : {}),
      footprint: joinedFootprint(p.model, library, 3, input.names),
      providers: joinedProviders(p.model, library),
      helperRoles: helperRoles(library),
      ...(hidden.has(key) ? { hidden: true as const } : {}),
      ...(unusable[key] ? { unusable: unusable[key] } : {}),
      ...(p.approval ? { approval: p.approval } : {}),
      ...(running[key] ? { running: running[key] } : {}),
    };
  };
  const off: JoinedProfile = {
    key: OFF_KEY, id: OFF_ID, kind: "off", group: "builtin", name: "Off", footprint: KEEPS_OWN_MODEL, providers: [], helperRoles: 0,
  };
  const yoursSession = input.sources.yours.map((p) => fromSession(p, "session", "yours"));
  const shipped = input.sources.builtins.filter((p) => p.id !== DEFAULT_PROFILE_ID).map((p) => fromSession(p, "builtin", "builtin"));
  const project = input.sources.project.profiles.map((p) => fromSession(p, "project", "project"));
  // A library profile any listed session profile links (yours, shipped or this project's) is that profile's Models part, never a row of its own.
  const linked = new Set([...yoursSession, ...shipped, ...project].map((r) => r.libraryId).filter((x): x is string => !!x));
  const libraryOnly: JoinedProfile[] = lib
    .filter((l) => !linked.has(l.id))
    .map((l) => {
      const key = `library:${l.id}`;
      return {
        key, id: l.id, kind: "library", group: "yours", name: l.name, libraryId: l.id, library: l,
        footprint: joinedFootprint(undefined, l, 3, input.names), providers: joinedProviders(undefined, l), helperRoles: helperRoles(l),
        ...(hidden.has(key) ? { hidden: true as const } : {}),
      };
    });
  const yours = [...yoursSession, ...libraryOnly].sort(byName);
  const rows = [off, ...yours, ...shipped, ...project];
  // Shared library halves: each linker names the others.
  const linkers = new Map<string, JoinedProfile[]>();
  for (const r of rows) if (r.libraryId) linkers.set(r.libraryId, [...(linkers.get(r.libraryId) ?? []), r]);
  for (const r of rows) {
    const others = r.libraryId ? (linkers.get(r.libraryId) ?? []).filter((o) => o !== r).map((o) => o.name) : [];
    if (others.length) r.alsoUsedBy = others;
  }
  return rows;
}

/** The list as a session in `cwd` sees it now (hidden marks included; running and unusable are the listing's). */
export async function joinedProfiles(cwd?: string | null, extra: Pick<JoinInputs, "running" | "unusable"> = {}, dir = agentRoot()): Promise<JoinedProfile[]> {
  const sources = await profileSources(cwd);
  return buildJoined({ sources, library: loadSubagentProfiles(dir), hidden: readHidden(), ...extra });
}

/**
 * One row by its key, or by its id as the Overseer and the default file name it: a bare id is yours
 * (a pair or a session profile), then a library profile no session profile links, then a shipped
 * one, then this project's. "off" (and Off's key) is Off.
 */
export function pickJoined(rows: readonly JoinedProfile[], idOrKey: string): JoinedProfile | null {
  const byKey = rows.find((r) => r.key === idOrKey);
  if (byKey) return byKey;
  if (idOrKey === OFF_ID) return rows.find((r) => r.kind === "off") ?? null;
  for (const kinds of [["pair", "session"], ["library"], ["builtin"], ["project"]] as const) {
    const hit = rows.find((r) => (kinds as readonly string[]).includes(r.kind) && r.id === idOrKey);
    if (hit) return hit;
  }
  return null;
}

/** findJoined: pickJoined over the list a session in `cwd` sees now. */
export async function findJoined(idOrKey: string, cwd?: string | null): Promise<JoinedProfile | null> {
  return pickJoined(await joinedProfiles(cwd), idOrKey);
}
