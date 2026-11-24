import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFF_ID, OFF_KEY, type DefaultProfileInfo, type JoinedProfile } from "../shared/profiles";
import {
  builtinFallback, loadSubagentProfiles, profilesDefaultOf, readProfilesDefault, writeProfilesDefault,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { joinedProfiles, pickJoined } from "./joined-profiles";
import { readMode, writeMode, type ModePatch } from "./mode-state";
import { agentRoot, stateRoot } from "./state-root";
import { loadDefaults, saveDefaults } from "./web-defaults";

/**
 * This computer's one default profile (§chat.profiles/default): `<state root>/default-profile.json`,
 * `{"version": 1, "profile": <id>}`, never synced. Choosing one also keeps the three older default files
 * written for what the profile sets (mode.json's default, defaults.json, and subagent-profiles-default.json),
 * so pi-config's extensions and an older Sova read the same default. Before one is chosen, the default is
 * read from the older files, else worked out from the accounts connected here (the built-in Claude, then
 * OpenAI, then DeepSeek), and nothing is written. An older build's "off" reads as not chosen.
 */

export const DEFAULT_PROFILE_FILE_NAME = "default-profile.json";
export const defaultProfileFile = () => join(stateRoot(), DEFAULT_PROFILE_FILE_NAME);

export type DefaultFileState = { state: "absent" } | { state: "ok"; profile: string } | { state: "malformed"; error: string };

export function readDefaultProfileFile(file = defaultProfileFile()): DefaultFileState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "malformed", error: (err as Error).message };
  }
  try {
    const o = JSON.parse(raw) as { version?: unknown; profile?: unknown };
    if (o?.version === 1 && typeof o.profile === "string" && o.profile.trim()) return { state: "ok", profile: o.profile };
    return { state: "malformed", error: 'expected {"version": 1, "profile": <profile id>}' };
  } catch (err) {
    return { state: "malformed", error: (err as Error).message };
  }
}

function writeDefaultProfileFile(profile: string, file = defaultProfileFile()): void {
  const text = `${JSON.stringify({ version: 1, profile }, null, 2)}\n`;
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch { /* absent: written below */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * No default: none chosen, no saved default helpers, and no account connected, so no built-in profile (decision
 * q3). A chat on it has no helper profile and keeps the model new chats open on; nothing names it (an empty name,
 * never "Off"). Its key and id are an older build's Off, which every reader already takes for "no profile".
 */
export const NO_DEFAULT_ROW: JoinedProfile = Object.freeze({ key: OFF_KEY, id: OFF_ID, kind: "builtin", group: "builtin", name: "", footprint: "", providers: [], helperRoles: 0 }) as JoinedProfile;
export const isNoDefault = (row: Pick<JoinedProfile, "key">): boolean => row.key === OFF_KEY;

/**
 * The default among `rows` (pure). `file`: default-profile.json as read; `libraryDefault`: the id
 * subagent-profiles-default.json names (null: none, "off", or one that names nothing here), used while no
 * default was chosen; `fallback`: the built-in profile the connected accounts give, used after that (null: none
 * connected). `fromAccounts`: the default is that fallback, which nobody chose. With neither, NO_DEFAULT_ROW.
 */
export function defaultAmong(rows: readonly JoinedProfile[], file: DefaultFileState, libraryDefault: string | null, fallback: string | null = "claude"): { row: JoinedProfile; info: DefaultProfileInfo; fromAccounts: boolean } {
  let fromAccounts = false;
  const info = (row: JoinedProfile, chosen: boolean, note?: string) => ({ row, fromAccounts, info: { key: row.key, id: row.id, name: row.name, chosen, ...(note ? { note } : {}) } });
  // Not chosen: the pair linking the saved default helpers (yours first, by name), else that helper profile's
  // own row (a library-only one, or a built-in one or the row that takes its place), else the fallback's.
  const derived = (): JoinedProfile => {
    for (const [id, accounts] of [...(libraryDefault === null ? [] : [[libraryDefault, false] as const]), ...(fallback === null ? [] : [[fallback, true] as const])]) {
      const linking = rows.filter((r) => r.libraryId === id && r.kind !== "library");
      const row = linking.find((r) => r.group === "yours") ?? rows.find((r) => r.kind === "library" && r.id === id) ?? pickJoined(rows, id) ?? linking[0];
      fromAccounts = accounts;
      if (row) return row;
    }
    fromAccounts = false;
    return NO_DEFAULT_ROW;
  };
  const startsOn = (row: JoinedProfile) => (isNoDefault(row) ? "no profile" : row.name);
  if (file.state === "ok" && file.profile !== OFF_ID) {
    const row = pickJoined(rows, file.profile);
    if (row) return info(row, true);
    const instead = derived();
    return info(instead, false, `The default, "${file.profile}", isn't a profile here, so new chats start on ${startsOn(instead)}.`);
  }
  if (file.state === "malformed") {
    const instead = derived();
    return info(instead, false, `${DEFAULT_PROFILE_FILE_NAME} can't be read (${file.error}), so new chats start on ${startsOn(instead)}.`);
  }
  return info(derived(), false);
}

/** The default a session in `cwd` starts on now, and how the listing shows it. */
export async function resolveDefaultProfile(cwd?: string | null, rows?: readonly JoinedProfile[], dir = agentRoot()): Promise<{ row: JoinedProfile; info: DefaultProfileInfo; fromAccounts: boolean }> {
  const list = rows ?? (await joinedProfiles(cwd, {}, dir));
  const fallback = builtinFallback(dir);
  return defaultAmong(list, readDefaultProfileFile(), profilesDefaultOf(loadSubagentProfiles(dir), readProfilesDefault(dir), null).id, fallback);
}

/** What choosing `row` writes to each older default file (pure): absent = that file is left as it is. */
export function olderDefaultsOf(row: JoinedProfile): { mode?: ModePatch; model?: string; thinking?: string; subagents?: string } {
  const s = row.session;
  const mode: ModePatch = {};
  if (s?.mode) mode.mode = s.mode as ModePatch["mode"];
  if (s?.minorModes) mode.minorModes = [...s.minorModes];
  return {
    ...(mode.mode || mode.minorModes ? { mode } : {}),
    ...(s?.model ? { model: s.model } : {}),
    ...(s?.thinking ? { thinking: s.thinking } : {}),
    // Its helpers' id where it has them (a built-in one's too, which an older reader takes for a default naming
    // nothing); a profile with no helpers here (none linked, or a link whose half isn't on this device) follows
    // the default helpers as they stand. "off" is never written.
    ...(row.library ? { subagents: row.library.id } : {}),
  };
}

export class DefaultRefusal extends Error {}

/**
 * Make `row` this computer's default: the older files first (only where what the profile sets
 * differs from what they hold, so an untouched file stays byte for byte), then default-profile.json.
 * `extraMode`: what else the mode menu's Make Default saves into mode.json (the chat's strict flag).
 */
export function chooseDefaultProfile(row: JoinedProfile, rows: readonly JoinedProfile[], extraMode: Pick<ModePatch, "strict"> = {}, dir = agentRoot()): DefaultProfileInfo {
  if (row.kind === "project" && rows.some((r) => r.group === "yours" && r.kind !== "library" && r.id === row.id))
    throw new DefaultRefusal(`One of your profiles has the id "${row.id}" too, so this project's profile can't be the default.`);
  if (row.approval === "needed") throw new DefaultRefusal(`${row.name} needs your approval first (Settings → Profiles).`);
  const older = olderDefaultsOf(row);
  const mode: ModePatch = { ...(older.mode ?? {}), ...extraMode };
  if (mode.mode || mode.minorModes || mode.strict !== undefined) {
    const now = readMode();
    const same =
      (mode.mode === undefined || mode.mode === now.mode) &&
      (mode.strict === undefined || mode.strict === now.strict) &&
      (mode.minorModes === undefined || (mode.minorModes.length === now.minorModes.length && mode.minorModes.every((m) => now.minorModes.includes(m))));
    if (!same) writeMode(mode);
  }
  const was = loadDefaults();
  const patch = { ...(older.model && older.model !== was.model ? { model: older.model } : {}), ...(older.thinking && older.thinking !== was.thinking ? { thinking: older.thinking } : {}) };
  if (Object.keys(patch).length) saveDefaults(patch);
  const lib = readProfilesDefault(dir);
  if (older.subagents && !(lib.state === "ok" && lib.value.default === older.subagents)) writeProfilesDefault(dir, { version: 1, default: older.subagents });
  writeDefaultProfileFile(row.id);
  return { key: row.key, id: row.id, name: row.name, chosen: true };
}

