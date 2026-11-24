import { DEFAULT_PROFILE_ID, KEEPS_OWN_MODEL, keyOf, OFF_ID, OFF_KEY, type JoinedProfile, type ListedProfile } from "../shared/profiles";
import type { SubagentProfile } from "../shared/subagent-profiles";
import {
  helperProfileOf, loadSubagentProfiles, profileWorkers, shortModel, workerProvider, type ProfilesState,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import {
  BUILTIN_PROFILE_IDS, builtinsFor, isBuiltinProfileId, readConnectedAccounts, shadowOf, type ConnectedAccounts,
} from "../pi-config/extensions/subagents/builtin-profiles.ts";
import { agentRoot } from "./state-root";
import { profileSources, readHidden, type ProfileSources } from "./profile-sources";

/**
 * The one list of profiles (§chat.profiles/joined), built from the two saved lists, which stay as
 * they are: the session profiles (yours, Sova's built-in ones and the session's project) and the
 * helper library (`subagent-profiles.json`). A session profile whose `subagents` names a library
 * profile (or a built-in one's helpers) is one row with both parts; a library profile no listed session
 * profile links is a row of its own (Models part only); a session profile with no link is a row with
 * no helpers. The built-in Claude, OpenAI and DeepSeek profiles are listed when their account is
 * connected (Claude alone when none is), unless a row of yours takes their place (`replaces`): same id,
 * same name, or the seeded starter for Claude, which is then named Claude. There is no Off row. Nothing
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
  /** The accounts connected here, which say which built-in profiles are listed; absent: none (Claude alone). */
  connected?: ConnectedAccounts;
}

/** The roles a library profile sets: Delegate's four kinds, the coordinator and monitor, spec writer, reviewer. */
export function helperRoles(lib: SubagentProfile | undefined): number {
  if (!lib) return 0;
  return 4 + (lib.teams ? 2 : 0) + (lib.specWriter ? 1 : 0) + (lib.reviewer ? 1 : 0);
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

/** The library id a session profile links, or undefined (none, or an older build's "off", which reads as none). */
export const linkOf = (p: { subagents?: string }): string | undefined => (p.subagents && p.subagents !== OFF_ID ? p.subagents : undefined);

const NO_ACCOUNTS: ConnectedAccounts = { claude: false, openai: false, ollamaCloud: false };

/** Build the list. Pure: the tests drive it with plain values. */
export function buildJoined(input: JoinInputs): JoinedProfile[] {
  const lib = input.library.state === "ok" ? input.library.value.profiles : [];
  const libError = input.library.state === "malformed" ? `the helper library can't be read (${input.library.errors.join("; ")})` : null;
  const hidden = new Set(input.hidden ?? []);
  const running = input.running ?? {};
  const unusable = input.unusable ?? {};
  // A link's helper half: the library's (named as screens show it), else a built-in one's (or the profile taking its place).
  const helperOf = (id: string): SubagentProfile | undefined => (libError ? undefined : helperProfileOf(id, lib));
  const fromSession = (p: ListedProfile, kind: JoinedProfile["kind"], group: JoinedProfile["group"]): JoinedProfile => {
    const libraryId = linkOf(p);
    const library = libraryId ? helperOf(libraryId) : undefined;
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
  const listedBuiltins = new Set<string>(builtinsFor(input.connected ?? NO_ACCOUNTS));
  const yoursSession = input.sources.yours.map((p) => fromSession(p, "session", "yours"));
  const project = input.sources.project.profiles.map((p) => fromSession(p, "project", "project"));
  const shippedAll = input.sources.builtins.filter((p) => p.id !== DEFAULT_PROFILE_ID).map((p) => fromSession(p, "builtin", "builtin"));
  // A library profile a listed session profile links is that profile's Models part, never a row of its own.
  const libraryRows = (linkers: readonly JoinedProfile[]): JoinedProfile[] => {
    const linked = new Set(linkers.map((r) => r.libraryId).filter((x): x is string => !!x));
    return lib
      .filter((l) => !linked.has(l.id))
      .map((l) => {
        const key = `library:${l.id}`;
        const named = helperOf(l.id) ?? l;
        return {
          key, id: l.id, kind: "library", group: "yours", name: named.name, libraryId: l.id, library: named,
          footprint: joinedFootprint(undefined, l, 3, input.names), providers: joinedProviders(undefined, l), helperRoles: helperRoles(l),
          ...(hidden.has(key) ? { hidden: true as const } : {}),
        } satisfies JoinedProfile;
      });
  };
  // Which built-in rows a row of yours takes the place of, worked out over yours with every built-in listed.
  const yoursFirst = [...yoursSession, ...libraryRows([...yoursSession, ...shippedAll, ...project])];
  const replaced = new Map<string, JoinedProfile>();
  for (const id of BUILTIN_PROFILE_IDS) {
    const by = shadowOf(id, yoursFirst);
    if (by) replaced.set(id, by);
  }
  const shipped = shippedAll.filter((r) => !isBuiltinProfileId(r.id) || (listedBuiltins.has(r.id) && !replaced.has(r.id)));
  // Listed with no account of its own: the fallback Claude when none is connected.
  const connected = input.connected ?? NO_ACCOUNTS;
  for (const r of shipped) {
    if (isBuiltinProfileId(r.id) && !(r.id === "claude" ? connected.claude : r.id === "openai" ? connected.openai : connected.ollamaCloud)) r.notConnected = true;
  }
  const libraryOnly = libraryRows([...yoursSession, ...shipped, ...project]);
  const yours = [...yoursSession, ...libraryOnly].sort(byName);
  for (const [id, by] of replaced) {
    const row = yours.find((r) => r.key === by.key);
    if (row) row.replaces = `sova:${id}`;
  }
  const rows = [...yours, ...shipped, ...project];
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
  return buildJoined({ sources, library: loadSubagentProfiles(dir), hidden: readHidden(), connected: readConnectedAccounts(dir), ...extra });
}

/**
 * One row by its key, or by its id as the Overseer and the default file name it: a bare id is yours
 * (a pair or a session profile), then a library profile no session profile links, then a built-in
 * one, then this project's. A built-in profile a row of yours takes the place of finds that row; a
 * "library:<id>" key with no row of its own finds the row that carries that helper half. An
 * older build's "off" (and Off's key) names no row: callers read it as this computer's default.
 */
export function pickJoined(rows: readonly JoinedProfile[], idOrKey: string): JoinedProfile | null {
  const byKey = rows.find((r) => r.key === idOrKey);
  if (byKey) return byKey;
  if (idOrKey === OFF_ID || idOrKey === OFF_KEY) return null;
  for (const kinds of [["pair", "session"], ["library"], ["builtin"], ["project"]] as const) {
    const hit = rows.find((r) => (kinds as readonly string[]).includes(r.kind) && r.id === idOrKey);
    if (hit) return hit;
  }
  // Helpers alone, by their library key, when another row carries that half (a chat on a pair's helpers alone).
  if (idOrKey.startsWith("library:")) {
    const id = idOrKey.slice("library:".length);
    const carrying = rows.filter((r) => r.libraryId === id);
    const hit = carrying.find((r) => r.group === "yours") ?? carrying[0];
    if (hit) return hit;
  }
  const builtin = idOrKey.startsWith("sova:") ? idOrKey.slice("sova:".length) : idOrKey;
  return isBuiltinProfileId(builtin) ? (rows.find((r) => r.replaces === `sova:${builtin}`) ?? null) : null;
}

/** findJoined: pickJoined over the list a session in `cwd` sees now. */
export async function findJoined(idOrKey: string, cwd?: string | null): Promise<JoinedProfile | null> {
  return pickJoined(await joinedProfiles(cwd), idOrKey);
}
